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
   - `FIREBASE_SERVICE_ACCOUNT_JSON` = the full contents of a Firebase
     service-account key file, pasted in as-is. Get one from the
     [Firebase Console](https://console.firebase.google.com) → your project
     → ⚙️ **Project Settings** → **Service Accounts** tab → **Generate new
     private key** (downloads a `.json` file). Open it, copy the entire
     contents, and paste that as the env var's value. This is what lets the
     server verify who's signed in and enforce the monthly usage caps below
     — if it's missing, grading still works but the caps are skipped
     entirely (the function logs a warning rather than failing).
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
  Cloud Console, especially once real users start uploading. Server-side
  caps are built in (see below) as a backstop, but they're a safety net,
  not a substitute for watching real usage.
- **Usage caps (cost safety).** Enforced in `api/evaluate.js` using
  Gemini's own real per-call token counts (never an estimate), stored per
  calendar month in Firestore:
  - **Per signed-in account:** 5 evaluations OR ₹40 spent, whichever comes
    first.
  - **Per IP address:** 15 evaluations OR ₹150 spent — a shared backstop
    that catches anonymous grading and someone cycling through fresh
    Google accounts on the same network, since both land in the same IP
    bucket. It's deliberately generous (so a household/classroom sharing
    one connection isn't blocked by a couple of legitimate users), not a
    precise anti-abuse system — a determined user on mobile data or a VPN
    can still get around it. If real abuse shows up later, the next step
    up is tying the free trial to a verified phone number instead of just
    a Google account.
  - Whichever cap is hit first blocks further grading with the message
    "Total trials/tokens over for this month. Connect - +91 861 819 7603,
    for more free trials." until the next calendar month. Pricing constants
    (`INR_PER_USD`, the per-million-token rates) and the cap numbers
    themselves are near the top of `api/evaluate.js` — update them there if
    Google's pricing changes or the limits need adjusting.
- **Model name.** The function calls `gemini-3.6-flash`. If Google
  deprecates or renames it, update `GEMINI_MODEL` in `api/evaluate.js`.

## What's real vs. what to build next

Real: file upload, client-side PDF/image handling, the Gemini call, the
strict "exact copy, no hallucination" grading prompt, structured JSON
output, the full report UI reading from that JSON, Google Sign-In with a
per-user evaluation history (Firestore), a one-evaluation free trial before
requiring sign-in, and server-side monthly usage caps (see above).

Not yet built (ideas for later): saving the actual page images to history
(only the graded report is saved today), delete/rename for history entries,
batch upload for a whole class, moving large PDFs to the Gemini File API
instead of inlining them, and phone-number verification if Google-account
cycling ever becomes a real abuse problem.
