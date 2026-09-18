// api/evaluate.js
// Vercel Serverless Function (Node.js runtime).
// Receives the question paper + answer sheet pages as base64, calls Gemini
// server-side, and returns structured evaluation JSON.
// GEMINI_API_KEY lives only in Vercel's environment variables — it is never
// sent to, or readable by, the browser.

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' } // see README: Vercel's hard platform cap may be lower on some plans
  }
};

const GEMINI_MODEL = 'gemini-3.6-flash'; // reverted: gemini-2.5-flash is being retired early (404s reported ahead of its official Oct 2026 shutdown)
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    totals: {
      type: 'OBJECT',
      properties: {
        total: { type: 'INTEGER' },
        correct: { type: 'INTEGER' },
        wrong: { type: 'INTEGER' },
        partial: { type: 'INTEGER' },
        unanswered: { type: 'INTEGER' }
      },
      required: ['total', 'correct', 'wrong', 'partial', 'unanswered']
    },
    questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'INTEGER' },
          questionNumber: {
            type: 'STRING',
            description: "The question's number/label exactly as the student wrote it next to their answer on the answer sheet (e.g. \"1\", \"18\", \"20\", \"2(a)\") — not a re-sequenced count, copy the actual label as written."
          },
          page: {
            type: 'INTEGER',
            description: '1-based page number within the answer sheet where this question is attempted.'
          },
          title: { type: 'STRING', description: "The question text, copied from the question paper." },
          status: { type: 'STRING', enum: ['correct', 'wrong', 'partial', 'unanswered'] },
          written: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description:
              "Each step exactly as the student wrote it, in order, one string per step. Use LaTeX for math (\\frac, \\sin, \\sqrt{}, ^{}, _{}, etc). Use the literal text <unclear> where handwriting is illegible. Empty array if unanswered."
          },
          mistakeStep: {
            type: 'INTEGER',
            description: '1-based index into written[] where the first mistake appears. Omit if correct or unanswered.'
          },
          mistakeWrong: {
            type: 'STRING',
            description: 'The incorrect line exactly as written, in LaTeX. Omit if correct or unanswered.'
          },
          mistakeCorrect: {
            type: 'STRING',
            description: 'What that line should be, in LaTeX. Omit if correct or unanswered.'
          },
          mistakeBox: {
            type: 'OBJECT',
            properties: {
              ymin: { type: 'INTEGER' },
              xmin: { type: 'INTEGER' },
              ymax: { type: 'INTEGER' },
              xmax: { type: 'INTEGER' }
            },
            required: ['ymin', 'xmin', 'ymax', 'xmax'],
            description:
              'EXPERIMENTAL: a bounding box on the answer-sheet PAGE IMAGE (the page given in "page") in normalized 0-1000 coordinates [ymin, xmin, ymax, xmax], (0,0)=top-left, (1000,1000)=bottom-right. For status "wrong" or "partial": your best-effort tight box around the mistake line — always attempt a real estimate, never skip this. For status "correct" or "unanswered": always set every value to 0.'
          },
          correctSolution: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description:
              'The COMPLETE correct solution as a sequence of steps (same style as written[]) — every step of a proper method, not just the final answer. The last item should state the final answer clearly.'
          }
        },
        required: ['id', 'questionNumber', 'page', 'title', 'status', 'written', 'correctSolution', 'mistakeBox']
      }
    }
  },
  required: ['totals', 'questions']
};

const SYSTEM_INSTRUCTION = `You are grading a student's handwritten answer sheet against a question paper image-by-image.

Non-negotiable rules:
1. In "written", reproduce EXACTLY what the student wrote — every step, in their own notation. Do not correct spelling, do not fill in missing steps, do not "clean up" their working. Never invent a step they did not write.
2. If any part of the handwriting is illegible or ambiguous, write the literal string "<unclear>" in place of that part. Never guess at unclear content.
3. If a question has no attempt at all, set status to "unanswered" and written to an empty array.
4. Formatting: write each field as plain text, and wrap ONLY the mathematical notation in single dollar signs, e.g. "Evaluate $\\int \\frac{1}{\\sqrt{3-4x}}\\,dx$". Keep ordinary words (labels like "Evaluate", "Solve for x", short explanations) as plain text outside the dollar signs — do not put whole sentences inside math mode. Inside the dollar signs use proper LaTeX (\\frac{a}{b}, \\sin, \\sqrt{}, ^{}, _{}, etc). The mathematical content itself must still be an exact copy of what was written, never rewritten or simplified — this formatting rule only affects how it's typeset, never what it says.
5. Grading status:
   - "correct": final answer and method are both correct.
   - "wrong": the final answer is incorrect.
   - "partial": some correct steps followed by an error, or a correct method with a minor slip.
   - "unanswered": left blank.
6. For "wrong" and "partial", identify the exact step (1-based index into written[]) where the first mistake occurs, quote what was written there in mistakeWrong, and give what it should have been in mistakeCorrect.
7. "mistakeBox" is REQUIRED on every question — never omit it. For "wrong" or "partial": give your best-effort tight box around the mistake line, in normalized 0-1000 coordinates [ymin, xmin, ymax, xmax]; always attempt a real estimate, never skip it. For "correct" or "unanswered": set ymin, xmin, ymax, xmax all to 0.
8. "correctSolution" must be the COMPLETE worked solution, step by step, like a model answer a teacher would write — never just the final result on its own.
9. "questionNumber" must be copied exactly as the student labeled it on the answer sheet (their own numbering, e.g. "18" or "2(a)") — this is what the student sees on their own page, so it must match exactly, not a tidied-up sequence.
10. Page numbers must match the order the answer sheet pages were provided in, starting at 1.
11. You MUST include every single question that appears on the question paper as one entry in "questions" — never stop partway through. "totals.total" must always exactly equal the number of items in "questions".
12. Keep every field strictly to its content — the question, the working, the mistake, the solution. Never include comments about your own output, formatting notes, apologies, or any meta text of any kind in any field.
13. Return ONLY JSON matching the provided schema — no prose, no markdown fences, no commentary outside the JSON.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing GEMINI_API_KEY. Set it in your Vercel project settings.' });
    return;
  }

  const { questionPaperPages, answerSheetPages } = req.body || {};

  if (!Array.isArray(questionPaperPages) || questionPaperPages.length === 0) {
    res.status(400).json({ error: 'questionPaperPages must be a non-empty array.' });
    return;
  }
  if (!Array.isArray(answerSheetPages) || answerSheetPages.length === 0) {
    res.status(400).json({ error: 'answerSheetPages must be a non-empty array.' });
    return;
  }

  const parts = [{ text: SYSTEM_INSTRUCTION }];

  parts.push({ text: `QUESTION PAPER (${questionPaperPages.length} page${questionPaperPages.length > 1 ? 's' : ''}):` });
  questionPaperPages.forEach((page, idx) => {
    parts.push({ text: `Question paper — page ${idx + 1}:` });
    parts.push({ inline_data: { mime_type: page.mimeType, data: page.data } });
  });

  parts.push({ text: `ANSWER SHEET (${answerSheetPages.length} page${answerSheetPages.length > 1 ? 's' : ''}):` });
  answerSheetPages.forEach((page, idx) => {
    parts.push({ text: `Answer sheet — page ${idx + 1} of ${answerSheetPages.length}:` });
    parts.push({ inline_data: { mime_type: page.mimeType, data: page.data } });
  });

  const requestBody = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.1,
      maxOutputTokens: 65536,
      thinkingConfig: { thinkingLevel: 'low' } // gemini-3.6-flash (Gemini 3 family) uses thinkingLevel, not thinkingBudget
    }
  };

  try {
    const geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini API error:', geminiRes.status, errText);
      res.status(502).json({ error: 'The evaluation service returned an error. Please try again.' });
      return;
    }

    const geminiJson = await geminiRes.json();
    const textPart = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!textPart) {
      const blockReason = geminiJson?.promptFeedback?.blockReason;
      res.status(502).json({
        error: blockReason
          ? `The evaluation was blocked (${blockReason}). Try clearer, unambiguous scans.`
          : 'No evaluation was returned. The pages may be unreadable — try clearer scans.'
      });
      return;
    }

    let result;
    try {
      result = JSON.parse(textPart);
    } catch (e) {
      console.error('Failed to parse Gemini JSON output:', textPart);
      res.status(502).json({ error: 'Could not parse the evaluation result. Please try again.' });
      return;
    }

    // Defensive check: flag it if the model didn't finish every question,
    // rather than silently showing a mismatched count.
    const declaredTotal = result?.totals?.total;
    const actualCount = Array.isArray(result?.questions) ? result.questions.length : 0;
    if (typeof declaredTotal === 'number' && declaredTotal !== actualCount) {
      result.incomplete = true;
    }

    // TEMP DEBUG (v1.2 experiment): confirm whether Gemini is actually
    // returning non-zero mistakeBox coordinates. Check this in Vercel → Logs.
    const mistakesTotal = (result.questions || []).filter(q => q.status === 'wrong' || q.status === 'partial').length;
    const boxesReturned = (result.questions || []).filter(q => {
      const b = q.mistakeBox;
      return b && (b.ymin || b.xmin || b.ymax || b.xmax) && (q.status === 'wrong' || q.status === 'partial');
    }).length;
    console.log(`mistakeBox debug: ${boxesReturned}/${mistakesTotal} wrong/partial questions had a non-zero mistakeBox`);

    res.status(200).json(result);
  } catch (err) {
    console.error('Evaluation error:', err);
    res.status(500).json({ error: 'Unexpected server error during evaluation.' });
  }
}
