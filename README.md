# PaperEval — deployment guide

A student/parent uploads a question paper + a handwritten answer sheet.
Gemini grades it question by question and the app shows a report card with
a page-by-page viewer and per-question drill-down (Solution Written /
Mistake / Correct Solution).

## How it's structured

```
papereval-app/
  api/evaluate.js     ← serverless function — the ONLY place the Gemini key is used
  public/index.html   ← the whole frontend (one file, no build step)
  vercel.json          ← gives the function up to 300s to run (needs Fluid Compute on)
  package.json
  .env.example
```

There's no framework and no build step. `public/` is served as static files;
`api/evaluate.js` becomes a serverless endpoint at `/api/evaluate`
automatically — that's Vercel's zero-config convention for this file layout.

The browser never sees the Gemini key. It base64-encodes and compresses the
uploaded pages, POSTs them to `/api/evaluate`, and that function (running on
Vercel's servers) attaches `GEMINI_API_KEY` from an environment variable
before calling Gemini.

## 1. Get a Gemini API key

Create one at [Google AI Studio](https://aistudio.google.com/app/apikey).
Keep it secret — don't put it in any file that gets committed to git.

## 2. Push this folder to GitHub

```bash
cd papereval-app
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin <your-empty-github-repo-url>
git push -u origin main
```

## 3. Deploy on Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and import the GitHub repo.
2. Leave the framework preset as "Other" — no build command needed.
3. Before the first deploy (or right after, then redeploy), go to
   **Project Settings → Environment Variables** and add:
   - `GEMINI_API_KEY` = your key from step 1
4. Deploy. Your app will be live at `https://<project-name>.vercel.app`.

## 4. Test it locally (optional)

```bash
npm i -g vercel
vercel dev
```

This runs the static frontend and the `/api/evaluate` function together on
`localhost`. Create a `.env.local` file (copy `.env.example`) with your real
key for local testing — `.env.local` is already in `.gitignore`.

## Things worth knowing before you scale past a prototype

- **Request size limits.** The frontend compresses each page to a JPEG
  (long edge capped at 1600px, quality ~0.82) before sending it, to stay
  well under typical serverless body-size limits. If you get errors on very
  long answer sheets (10+ pages), it's almost certainly the request size —
  either lower `MAX_DIM`/`JPEG_QUALITY` in `public/index.html`, or move to
  Gemini's **File API** (upload each page once, then reference it by URI)
  instead of inlining base64 — check Vercel's current docs for the exact
  body-size cap on your plan, since it varies and changes over time.
- **Function timeout.** `vercel.json` sets `maxDuration: 300` (the Hobby-plan
  ceiling, available once **Fluid Compute** is turned on in Project Settings
  → Functions). The answer sheet is already graded as overlapping page-pair
  batches rather than one call, and each batch is now resilient: if one
  batch times out or errors, the app still shows a report built from every
  batch that succeeded, with a banner naming the page(s) that failed and a
  "Retry those pages" button.
- **Concurrency / 100–300 users.** Vercel serverless functions scale
  horizontally by default (one instance per concurrent request), so this
  isn't a bottleneck at that volume. Gemini's API has its own rate limits
  per key/tier — check your current quota in AI Studio before a real launch
  and add basic request throttling if needed.
- **Cost.** Each evaluation sends full-page images to Gemini, which costs
  more in tokens than text. Keep an eye on usage in Google AI Studio /
  Cloud Console, especially once real users start uploading.
- **Model name.** The function calls `gemini-3.6-flash`. If Google
  deprecates or renames it, update `GEMINI_MODEL` in `api/evaluate.js`.

## What's real vs. what to build next

Real: file upload, client-side PDF/image handling, the Gemini call, the
strict "exact copy, no hallucination" grading prompt, structured JSON
output, and the full report UI reading from that JSON.

Not yet built (ideas for later): user accounts / saved history, a database
to store past evaluations, batch upload for a whole class, and moving large
PDFs to the Gemini File API instead of inlining them.
