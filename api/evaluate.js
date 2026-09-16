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

const GEMINI_MODEL = 'gemini-3.6-flash';
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
          correctSolution: { type: 'STRING', description: 'The fully correct final answer/solution, in LaTeX.' }
        },
        required: ['id', 'page', 'title', 'status', 'written', 'correctSolution']
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
4. Use LaTeX notation for all math (\\frac{a}{b}, \\sin, \\cos, \\sqrt{}, ^{}, _{}, etc.) so it can be typeset legibly — but the mathematical content must still be an exact copy of what was written, never a rewritten, simplified, or "corrected" version.
5. Grading status:
   - "correct": final answer and method are both correct.
   - "wrong": the final answer is incorrect.
   - "partial": some correct steps followed by an error, or a correct method with a minor slip.
   - "unanswered": left blank.
6. For "wrong" and "partial", identify the exact step (1-based index into written[]) where the first mistake occurs, quote what was written there in mistakeWrong, and give what it should have been in mistakeCorrect.
7. Page numbers must match the order the answer sheet pages were provided in, starting at 1.
8. Return ONLY JSON matching the provided schema — no prose, no markdown fences, no commentary.`;

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
      temperature: 0.1
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

    res.status(200).json(result);
  } catch (err) {
    console.error('Evaluation error:', err);
    res.status(500).json({ error: 'Unexpected server error during evaluation.' });
  }
}
