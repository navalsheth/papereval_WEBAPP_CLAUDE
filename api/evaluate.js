// api/evaluate.js
// Vercel Serverless Function (Node.js runtime).
//
// Grades ONE BATCH of answer-sheet pages at a time (the frontend calls this
// once per overlapping page-pair — see public/index.html). Keeping each
// call small is what fixes the "only some questions came back" and
// formatting-consistency problems: a short, focused task leaves the model
// far less likely to run out of its response budget or get sloppy.
//
// GEMINI_API_KEY lives only in Vercel's environment variables — it is never
// sent to, or readable by, the browser.

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' } // see README: Vercel's hard platform cap may be lower on some plans
  }
};

const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Note: no "totals" in this schema anymore — the frontend computes totals
// itself after merging every batch's questions together, which is more
// reliable than asking a partial-view batch to count a whole-paper total.
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'INTEGER' },
          questionNumber: {
            type: 'STRING',
            description: "The question's number/label exactly as the student wrote it next to their answer (e.g. \"1\", \"18\", \"20\", \"2(a)\") — not a re-sequenced count, copy the actual label as written."
          },
          page: {
            type: 'INTEGER',
            description: 'The TRUE page number (as given to you for each image below) where this question is attempted — not a 1/2 index of how many images you were sent.'
          },
          title: { type: 'STRING', description: 'The question text, copied from the question paper.' },
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
              'A bounding box on the answer-sheet PAGE IMAGE (the true page given in "page") in normalized 0-1000 coordinates [ymin, xmin, ymax, xmax], (0,0)=top-left, (1000,1000)=bottom-right. For "wrong"/"partial": your best-effort tight box around the mistake line — always attempt a real estimate, never skip it. For "correct"/"unanswered": set every value to 0.'
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
  required: ['questions']
};

const SYSTEM_INSTRUCTION = `You are grading a student's handwritten answer sheet against a question paper, page by page.

IMPORTANT — you are only being shown SOME of the answer sheet's pages in this call (a small overlapping window of the full paper, described below), not the whole thing. This is intentional:
- Only include a question in your response if its COMPLETE working is fully visible within the pages you were given this time.
- If a question's working clearly starts before the first page you can see, or clearly continues past the last page you can see (cut off at the very edge with no natural ending), SKIP that question entirely — leave it out of "questions" completely. Do not guess, and do not grade a partial view. It will be fully graded in another call that has its full working visible.
- EXCEPTION — read this carefully: if the text below tells you a page you were given is the very FIRST page of the whole answer sheet, there is nothing before it, so never skip a question there for "possibly starting earlier" — grade it normally. Likewise, if a page you were given is the very LAST page of the whole answer sheet, there is nothing after it, so never skip a question there for "possibly continuing further" — grade it normally, exactly as it appears, even if it looks short.
- Being near the top or bottom edge of a page is NOT by itself a reason to skip a question. Only skip for a genuine, visible sign of continuation: the last line trails off abruptly mid-equation/mid-sentence at the very bottom edge with no concluding statement, AND you were not told that page is the last page of the whole sheet.
- Also skip any question that doesn't appear at all on the pages you were given.
- It is completely normal and expected for you to return only some of the answer sheet's questions in this call — do not try to cover the whole paper.

Non-negotiable rules for every question you DO include:
1. In "written", reproduce EXACTLY what the student wrote — every step, in their own notation. Do not correct spelling, do not fill in missing steps, do not "clean up" their working. Never invent a step they did not write.
2. If any part of the handwriting is illegible or ambiguous, write the literal string "<unclear>" in place of that part. Never guess at unclear content.
3. If a question has no attempt at all (and is fully within view — see above), set status to "unanswered" and written to an empty array.
4. Formatting: write each field as plain text, and wrap ONLY the mathematical notation in single dollar signs, e.g. "Evaluate $\\int \\frac{1}{\\sqrt{3-4x}}\\,dx$". Keep ordinary words (labels like "Evaluate", "Solve for x", short explanations) as plain text outside the dollar signs — do not put whole sentences inside math mode. Inside the dollar signs use proper LaTeX (\\frac{a}{b}, \\sin, \\sqrt{}, ^{}, _{}, etc). The mathematical content itself must still be an exact copy of what was written, never rewritten or simplified — this formatting rule only affects how it's typeset, never what it says.
5. Grading status:
   - "correct": final answer and method are both correct.
   - "wrong": the final answer is incorrect.
   - "partial": some correct steps followed by an error, or a correct method with a minor slip.
   - "unanswered": left blank.
6. For "wrong" and "partial", identify the exact step (1-based index into written[]) where the first mistake occurs, quote what was written there in mistakeWrong, and give what it should have been in mistakeCorrect.
7. "mistakeBox" is REQUIRED on every question — never omit it. For "wrong"/"partial": give your best-effort tight box around the mistake line, in normalized 0-1000 coordinates; always attempt a real estimate. For "correct"/"unanswered": set every value to 0.
8. "correctSolution" must be the COMPLETE worked solution, step by step, like a model answer a teacher would write — never just the final result on its own.
9. "questionNumber" must be copied exactly as the student labeled it on the answer sheet, but WITHOUT any leading "Q" — just the number/label itself (e.g. "1", "18", "2(a)"), even if the student wrote a "Q" before it. The app adds its own "Q" prefix when displaying it.
10. "page" must be the TRUE page number given to you for each image below, not a 1/2 count of how many images were in this call.
11. Keep every field strictly to its content. Never include comments about your own output, formatting notes, apologies, or any meta text of any kind in any field.
12. Return ONLY JSON matching the provided schema — no prose, no markdown fences, no commentary outside the JSON.`;

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

  const { questionPaperPages, answerSheetPages, answerSheetTotalPages } = req.body || {};

  if (!Array.isArray(questionPaperPages) || questionPaperPages.length === 0) {
    res.status(400).json({ error: 'questionPaperPages must be a non-empty array.' });
    return;
  }
  if (!Array.isArray(answerSheetPages) || answerSheetPages.length === 0) {
    res.status(400).json({ error: 'answerSheetPages must be a non-empty array.' });
    return;
  }
  if (answerSheetPages.some(p => typeof p.pageNumber !== 'number')) {
    res.status(400).json({ error: 'Every answerSheetPages item needs a numeric pageNumber.' });
    return;
  }

  const totalPages = answerSheetTotalPages || answerSheetPages.length;
  const shownPageNumbers = answerSheetPages.map(p => p.pageNumber).join(', ');

  const parts = [{ text: SYSTEM_INSTRUCTION }];

  parts.push({ text: `QUESTION PAPER (${questionPaperPages.length} page${questionPaperPages.length > 1 ? 's' : ''}), for reference — the full question paper, always shown in every call:` });
  questionPaperPages.forEach((page, idx) => {
    parts.push({ text: `Question paper — page ${idx + 1}:` });
    parts.push({ inline_data: { mime_type: page.mimeType, data: page.data } });
  });

  const shownPageNums = answerSheetPages.map(p => p.pageNumber);
  let boundaryNote = '';
  if (shownPageNums.includes(1)) {
    boundaryNote += ' This includes page 1 — the very FIRST page of the whole answer sheet. Nothing precedes it: never skip a question on it for "possibly starting earlier."';
  }
  if (shownPageNums.includes(totalPages)) {
    boundaryNote += ` This includes page ${totalPages} — the very LAST page of the whole answer sheet. Nothing follows it: never skip a question on it for "possibly continuing further," even if it looks short or incomplete — grade it as-is.`;
  }

  parts.push({
    text: `ANSWER SHEET — you are being shown TRUE page(s) ${shownPageNumbers} out of ${totalPages} total pages in the full answer sheet.${boundaryNote} Remember: only grade questions fully visible within these specific pages.`
  });
  answerSheetPages.forEach(page => {
    parts.push({ text: `Answer sheet — this image is TRUE page ${page.pageNumber} of ${totalPages}:` });
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
      res.status(502).json({ error: `The evaluation service returned an error grading page(s) ${shownPageNumbers}. Please try again.` });
      return;
    }

    const geminiJson = await geminiRes.json();
    const textPart = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!textPart) {
      const blockReason = geminiJson?.promptFeedback?.blockReason;
      res.status(502).json({
        error: blockReason
          ? `Page(s) ${shownPageNumbers} were blocked (${blockReason}). Try clearer, unambiguous scans.`
          : `No evaluation was returned for page(s) ${shownPageNumbers}. Try clearer scans.`
      });
      return;
    }

    let result;
    try {
      result = JSON.parse(textPart);
    } catch (e) {
      console.error('Failed to parse Gemini JSON output:', textPart);
      res.status(502).json({ error: `Could not parse the evaluation result for page(s) ${shownPageNumbers}. Please try again.` });
      return;
    }

    const returnedQs = result.questions || [];
    const qSummary = returnedQs.map(q => `Q${q.questionNumber}(p${q.page},${q.status})`).join(', ') || '(none)';
    console.log(`Batch [pages ${shownPageNumbers}]: returned ${returnedQs.length} question(s): ${qSummary}`);

    res.status(200).json(result);
  } catch (err) {
    console.error('Evaluation error:', err);
    res.status(500).json({ error: `Unexpected server error grading page(s) ${shownPageNumbers}.` });
  }
}
