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
            description: '1-based index into written[] where the first mistake appears. REQUIRED on every question — for "wrong"/"partial" give the real step number (never 0). For "correct"/"unanswered", set it to 0. The app looks up written[mistakeStep-1] itself to show the wrong line — never re-type that line into another field.'
          },
          mistakeCorrect: {
            type: 'STRING',
            description: 'What that line should be, in LaTeX. Omit if correct or unanswered.'
          },
          markPage: {
            type: 'INTEGER',
            description: 'The TRUE page number that "mistakeBox" is drawn on — i.e. the page whose image actually shows the specific content the box points to. For most questions this is identical to "page". They DIFFER only when a question\'s working spans a page break (see CONTINUATIONS ACROSS A PAGE BREAK above): "page" stays the page where the question started, but if the exact content being boxed (the mistake line / final answer / blank space) is physically on the following page instead, set "markPage" to THAT page. Getting this right matters — mistakeBox\'s coordinates are only meaningful on the one page image they were read from; placing them under the wrong page number puts the mark in a visually plausible but wrong spot on a different page.'
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
              'A bounding box, in normalized 0-1000 coordinates [ymin, xmin, ymax, xmax] (0,0)=top-left, (1000,1000)=bottom-right, on the ONE specific page image named in "markPage" (not necessarily the same page as "page" — see markPage). REQUIRED on every question, and it must always be a real best-effort estimate — never all zeros, for any status. What to box: "wrong"/"partial" → the specific mistake line (the same step written[mistakeStep-1] points to) — look at the actual ink of THAT line and box only it, never the question\'s number/label, never the problem statement, and never a different line. "correct" → the final answer/result line of the student\'s working. "unanswered" → the blank space where the student should have written an answer, just below/after the question\'s problem statement — estimate this even though nothing is written there. In every case, look carefully at where that specific content actually sits on the page before answering — a box in the wrong place is worse than a slightly loose one in the right place.'
          },
          correctSolution: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description:
              'The COMPLETE correct solution as a sequence of steps (same style as written[]) — every step of a proper method, not just the final answer. The last item should state the final answer clearly.'
          }
        },
        required: ['id', 'questionNumber', 'page', 'title', 'status', 'written', 'correctSolution', 'mistakeBox', 'mistakeStep', 'markPage']
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
- BLANK / NOT-ATTEMPTED QUESTIONS ARE NOT THE SAME AS PARTIAL ONES — do not apply the skip-for-possible-continuation logic to them. If a question's problem statement is fully visible and there is clearly no solution attempt written under it (empty space, or nothing at all before the next question or the end of the page), that is already the complete picture — there is no partial working that could be "cut off," because nothing was started. Grade it immediately as "unanswered" (see rule 3 below) rather than skipping it. This applies even if the blank space runs all the way to the bottom of the page you can see, and even if you cannot yet see the next question.
- Also skip any question that doesn't appear at all on the pages you were given.
- It is completely normal and expected for you to return only some of the answer sheet's questions in this call — do not try to cover the whole paper.
- CONTINUATIONS ACROSS A PAGE BREAK: a student's working for one question often ends near the bottom of one page and picks back up at the very TOP of the next page with no question number rewritten there — because they never stopped, they just ran out of room. When a page you were given opens with math/working that has no question number above it, no blank gap before it, and clearly carries on the same calculation as whatever was last happening at the bottom of the previous page you can see (same variable, same method, no new question text) — treat that opening content as belonging to that SAME, most recently seen question number. Append it to that question's "written" steps in the correct order. Do NOT invent a new unlabeled question for it, and do NOT silently drop it — an unlabeled continuation you can now see in full is exactly the case this batching is designed to let you complete.
  - IMPORTANT for such spanning questions: "page" still stays the page where the question STARTED (where its number was written). But if the mistake/final-answer/blank line that "mistakeBox" needs to point to is part of the continuation on the LATER page, you must set "markPage" to that later page — not "page". Mixing these up puts the mark in the right-looking spot on the wrong page's image.

Non-negotiable rules for every question you DO include:
1. In "written", reproduce EXACTLY what the student wrote — every step, in their own notation. Do not correct spelling, do not fill in missing steps, do not "clean up" their working. Never invent a step they did not write.
2. If any part of the handwriting is illegible or ambiguous, write the literal string "<unclear>" in place of that part. Never guess at unclear content.
3. If a question's problem statement is visible and there is no solution attempt under it at all, set status to "unanswered" and written to an empty array — include it, do not leave it out (see the blank-question note above; this is the single most common way a real question quietly disappears from the report, so err on the side of including it as unanswered).
4. Formatting: write each field as plain text, and wrap ONLY the mathematical notation in single dollar signs, e.g. "Evaluate $\\int \\frac{1}{\\sqrt{3-4x}}\\,dx$". Keep ordinary words (labels like "Evaluate", "Solve for x", short explanations) as plain text outside the dollar signs — do not put whole sentences inside math mode. Inside the dollar signs use proper LaTeX (\\frac{a}{b}, \\sin, \\sqrt{}, ^{}, _{}, etc). The mathematical content itself must still be an exact copy of what was written, never rewritten or simplified — this formatting rule only affects how it's typeset, never what it says.
5. Grading status:
   - "correct": final answer and method are both correct.
   - "wrong": the final answer is incorrect.
   - "partial": some correct steps followed by an error, or a correct method with a minor slip.
   - "unanswered": left blank.
6. "mistakeStep" is REQUIRED on every question. For "wrong"/"partial", set it to the 1-based index into written[] where the first mistake occurs (never 0), and give what that step should have been in mistakeCorrect. For "correct"/"unanswered", set mistakeStep to 0. Do NOT re-type or re-quote the wrong line anywhere else — written[] already has it verbatim, and duplicating it elsewhere is unnecessary.
7. "mistakeBox" is REQUIRED on every question — never omit it, and never use all-zero placeholder values, for ANY status. Always give a real best-effort box in normalized 0-1000 coordinates: for "wrong"/"partial", box the mistake line itself — look at where that exact line of the student's own ink sits on the page, and box only that; NEVER box the question number/label, and never box a different line than the one written[mistakeStep-1] refers to. For "correct", box the final answer/result line. For "unanswered", box the blank space right after the question's problem statement, where the student should have written something — estimate its position even though it's empty. A box in the wrong place is worse than a slightly loose one in the right place — look carefully before answering.
13. NEVER repeat the same character, token, or short phrase more than a few times in a row in any field. If you notice yourself about to repeat something instead of making progress, STOP that field immediately — write "<unclear>" and move on to the next field or question rather than continuing. A field that trails into repetition is worse than a shorter, honest one.
8. "correctSolution" must be the COMPLETE worked solution, step by step, like a model answer a teacher would write — never just the final result on its own.
9. "questionNumber" must be copied exactly as the student labeled it on the answer sheet, but WITHOUT any leading "Q" — just the number/label itself (e.g. "1", "18", "2(a)"), even if the student wrote a "Q" before it. The app adds its own "Q" prefix when displaying it.
10. "page" must be the TRUE page number given to you for each image below, not a 1/2 count of how many images were in this call. "markPage" must be the TRUE page number of whichever image the "mistakeBox" content is actually visible on — equal to "page" unless this is a page-spanning question and the boxed content is on the later page (see CONTINUATIONS above).
11. Keep every field strictly to its content. Never include comments about your own output, formatting notes, apologies, or any meta text of any kind in any field.
12. Return ONLY JSON matching the provided schema — no prose, no markdown fences, no commentary outside the JSON.`;

// Recovers as many COMPLETE question objects as possible from a response
// that broke before the JSON could close (e.g. the model got stuck in a
// repetition loop inside one field and ran until the token limit). This is
// JSON-STRING-AWARE: it tracks whether it's currently inside a quoted string
// so that LaTeX's own braces (like \frac{1}{2}) are never mistaken for JSON
// structure. It finds the last fully-closed question object in the
// "questions" array and discards only the broken tail after it.
function salvagePartialQuestions(text) {
  const arrStart = text.indexOf('[', text.indexOf('"questions"'));
  if (arrStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let lastSafeEnd = -1; // index right after the last fully-closed question object

  for (let i = arrStart; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escapeNext) { escapeNext = false; }
      else if (ch === '\\') { escapeNext = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') { depth++; continue; }
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 1 && ch === '}') { lastSafeEnd = i + 1; } // closed one top-level question object
      if (depth === 0) break; // array closed cleanly — nothing broken to salvage
    }
  }

  if (lastSafeEnd === -1) return null; // couldn't even find one complete question object

  const candidate = text.slice(0, lastSafeEnd) + ']}';
  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed.questions) ? parsed.questions : null;
  } catch (e) {
    return null;
  }
}

// Calls Gemini once and returns { ok, questions, recovered, raw, status, errText }.
// Never throws on a bad/unparseable model response — that's handled here via
// salvage, so the caller can decide whether to retry.
async function gradeOnce(requestBody, apiKey, shownPageNumbers) {
  const geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    console.error('Gemini API error:', geminiRes.status, errText);
    return { ok: false, status: geminiRes.status, errText };
  }

  const geminiJson = await geminiRes.json();
  const textPart = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!textPart) {
    const blockReason = geminiJson?.promptFeedback?.blockReason;
    return { ok: false, status: 502, errText: blockReason ? `blocked (${blockReason})` : 'empty response' };
  }

  try {
    const result = JSON.parse(textPart);
    return { ok: true, questions: result.questions || [], recovered: false };
  } catch (e) {
    const salvaged = salvagePartialQuestions(textPart);
    if (salvaged && salvaged.length > 0) {
      console.warn(`Batch [pages ${shownPageNumbers}]: response broke before closing (${textPart.length} chars) — salvaged ${salvaged.length} complete question(s) from before the break.`);
      return { ok: true, questions: salvaged, recovered: true };
    }
    console.error(`Batch [pages ${shownPageNumbers}]: failed to parse and nothing salvageable. First 500 chars:`, textPart.slice(0, 500));
    return { ok: false, status: 502, errText: 'unparseable response, nothing salvageable' };
  }
}

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
    let attempt = await gradeOnce(requestBody, apiKey, shownPageNumbers);

    if (!attempt.ok) {
      // One retry, at a HIGHER temperature (not lower). A degenerate
      // repetition loop is a near-greedy-decoding failure — the model keeps
      // picking the same most-likely next token — so a low temperature is
      // more likely to reproduce the exact same loop on a retry, not less.
      // Raising temperature gives the retry real odds of not repeating it.
      console.warn(`Batch [pages ${shownPageNumbers}]: first attempt failed (${attempt.status}: ${attempt.errText || 'no detail'}) — retrying once at a higher temperature.`);
      const retryBody = {
        ...requestBody,
        generationConfig: { ...requestBody.generationConfig, temperature: 0.4 }
      };
      attempt = await gradeOnce(retryBody, apiKey, shownPageNumbers);
    }

    if (!attempt.ok) {
      console.error(`Batch [pages ${shownPageNumbers}]: failed after retry too (${attempt.status}: ${attempt.errText || 'no detail'}).`);
      res.status(502).json({ error: `Could not grade page(s) ${shownPageNumbers}, even after a retry. Please try again.` });
      return;
    }

    const qSummary = attempt.questions.map(q => `Q${q.questionNumber}(p${q.page},${q.status})`).join(', ') || '(none)';
    console.log(`Batch [pages ${shownPageNumbers}]: returned ${attempt.questions.length} question(s)${attempt.recovered ? ' [recovered from a broken/looping response]' : ''}: ${qSummary}`);

    res.status(200).json({ questions: attempt.questions });
  } catch (err) {
    console.error('Evaluation error:', err);
    res.status(500).json({ error: `Unexpected server error grading page(s) ${shownPageNumbers}.` });
  }
}
