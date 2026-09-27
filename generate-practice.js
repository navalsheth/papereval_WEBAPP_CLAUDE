// api/generate-practice.js
// Vercel Serverless Function (Node.js runtime).
//
// Phase 6 — practice-paper generation. Deliberately a SEPARATE function
// from api/evaluate.js (own file, own auth helpers duplicated below) rather
// than folded into it, per project convention: these are independent
// "prompt channels" and a change to one must never risk the other. The
// small duplication of ensureAdminInitialized()/verifyUidFromRequest() is
// an accepted tradeoff for that isolation — there's no shared lib/ module
// in this project.
//
// Unlike /api/evaluate, this call sends NO images — only the text of the
// questions the student already got wrong/partial, plus their already-
// decided mistakeType (task #11's classification, reused verbatim, never
// re-derived here). That keeps this endpoint cheap and fast.
//
// Sign-in is REQUIRED (unlike grading, which allows an anonymous free
// trial) — practice papers are always saved to the signed-in user's
// history, so there is nothing useful this endpoint can do for a
// signed-out caller.

import admin from 'firebase-admin';

const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// --- Auth helpers (duplicated from api/evaluate.js on purpose — see note above) ---
let adminReady = null;
function ensureAdminInitialized() {
  if (adminReady !== null) return adminReady;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    console.warn('FIREBASE_SERVICE_ACCOUNT_JSON not set — /api/generate-practice cannot verify sign-in and will reject every request.');
    adminReady = false;
    return adminReady;
  }
  try {
    if (!admin.apps.length) {
      const serviceAccount = JSON.parse(raw);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    adminReady = true;
  } catch (e) {
    console.error('Failed to initialize firebase-admin from FIREBASE_SERVICE_ACCOUNT_JSON:', e.message);
    adminReady = false;
  }
  return adminReady;
}

async function verifyUidFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token || !ensureAdminInitialized()) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.uid;
  } catch (e) {
    console.warn('ID token verification failed:', e.message);
    return null;
  }
}

/* =====================================================================
 * PAPER_CREATION_PROMPT_RULES — the third prompt channel (per project
 * convention — see api/evaluate.js's own PROMPT CHANNELS note). Kept in
 * its own file entirely, so nothing here can ever affect grading or
 * mistake-classification.
 *
 * Hard requirement from the product spec: this is NOT a "similar
 * questions" generator. It must return the SAME questions the student
 * already got wrong/partial, verbatim — only cleaned up for formatting
 * and renumbered 1..N. The model must never invent a new question, never
 * change a question's content or difficulty, and never re-classify
 * mistakeType (it is passed through unchanged, not re-derived).
 * ===================================================================== */
const PAPER_CREATION_PROMPT_RULES = `You are formatting a practice paper for a student, built from questions they previously got wrong or partially wrong.

You will be given a list of questions, each with its original question text exactly as it appeared on the question paper. Your ONLY job is to:
1. Reproduce each question's text faithfully — same content, same numbers, same difficulty. Do NOT invent new questions, do NOT change what a question asks, and do NOT simplify, rephrase, or "improve" it.
2. Clean up formatting only: fix obvious OCR/copy artifacts, present the text clearly, and wrap mathematical notation in single dollar signs for LaTeX (e.g. "Evaluate $\\int \\frac{1}{\\sqrt{3-4x}}\\,dx$"), exactly like the source. Keep ordinary words as plain text outside the dollar signs.
3. Renumber the questions 1, 2, 3, ... in the order given — this is a fresh practice paper, not a copy of the original numbering.
4. Do NOT add a mistakeType of your own and do NOT change the one supplied for each question — copy it through exactly as given (or omit it if none was supplied for that question).
5. Return ONLY JSON matching the provided schema — no prose, no markdown fences, no commentary outside the JSON.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING', description: 'A short title for this practice paper, e.g. "Practice Paper — Based on Past Mistakes".' },
    questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          number: { type: 'INTEGER', description: 'Fresh 1-based number for this practice paper (not the original question number).' },
          questionText: { type: 'STRING', description: 'The question, formatted per the rules above — same content as the source, cleaned up only.' },
          mistakeType: { type: 'STRING', enum: ['silly', 'conceptual', 'both'], description: 'Passed through unchanged from the source question. Omit if the source had none.' }
        },
        required: ['number', 'questionText']
      }
    }
  },
  required: ['title', 'questions']
};

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

  const uid = await verifyUidFromRequest(req);
  if (!uid) {
    res.status(401).json({ error: 'Sign in required to generate a practice paper.' });
    return;
  }

  const { questions, sourceLabel } = req.body || {};
  if (!Array.isArray(questions) || questions.length === 0) {
    res.status(400).json({ error: 'questions must be a non-empty array.' });
    return;
  }
  // Only forward the fields the model actually needs — never trust the
  // client to send extra/unexpected fields straight into the prompt.
  const cleanQuestions = questions
    .filter(q => q && typeof q.title === 'string' && q.title.trim())
    .slice(0, 100) // sane upper bound — a real paper never has this many wrong questions
    .map(q => ({
      questionNumber: String(q.questionNumber ?? ''),
      title: q.title,
      mistakeType: ['silly', 'conceptual', 'both'].includes(q.mistakeType) ? q.mistakeType : undefined
    }));

  if (cleanQuestions.length === 0) {
    res.status(400).json({ error: 'No usable questions were supplied.' });
    return;
  }

  const parts = [
    { text: PAPER_CREATION_PROMPT_RULES },
    { text: `Source evaluation: ${sourceLabel ? String(sourceLabel).slice(0, 200) : '(untitled)'}` },
    { text: `Questions to include (JSON, in original order):\n${JSON.stringify(cleanQuestions, null, 2)}` }
  ];

  const requestBody = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.1,
      maxOutputTokens: 16384,
      thinkingConfig: { thinkingLevel: 'low' }
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
      console.error('Gemini API error (generate-practice):', geminiRes.status, errText);
      res.status(502).json({ error: 'Practice paper generation failed. Please try again.' });
      return;
    }

    const geminiJson = await geminiRes.json();
    const textPart = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textPart) {
      res.status(502).json({ error: 'Practice paper generation returned no content. Please try again.' });
      return;
    }

    let result;
    try {
      result = JSON.parse(textPart);
    } catch (e) {
      console.error('generate-practice: unparseable response. First 500 chars:', textPart.slice(0, 500));
      res.status(502).json({ error: 'Practice paper generation returned malformed content. Please try again.' });
      return;
    }

    if (!Array.isArray(result.questions) || result.questions.length === 0) {
      res.status(502).json({ error: 'Practice paper generation returned no questions. Please try again.' });
      return;
    }

    res.status(200).json({ title: result.title || 'Practice Paper — Based on Past Mistakes', questions: result.questions });
  } catch (e) {
    console.error('generate-practice handler error:', e);
    res.status(500).json({ error: 'Something went wrong generating the practice paper. Please try again.' });
  }
}
