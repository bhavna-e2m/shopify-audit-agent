# Shopify Theme Audit Agent

A Shopify-only AI agent that generates a structured audit document from a store URL.

## What it does

- Validates the URL and confirms it appears to be a Shopify storefront.
- Crawls key pages (home, one collection, one product, plus common utility pages).
- Extracts UX/CRO/technical signals (header behavior, CTA visibility, trust elements, typography hints, etc.).
- Sends structured findings to an LLM and produces a polished markdown report similar to your sample audit format.

## Output format

The generated report includes:

- Summary
- Home Page - Shopify Requirements Verification (Section-by-Section)
- Home Page – Key Areas of Improvement
- Collection Page – Key Areas of Improvement
- Product Page – Key Areas of Improvement
- Other Pages – Key Areas of Improvement
- Final Recommendation

By default, each run now creates:
- Markdown report (`.md`)

## Prerequisites

- Node.js 18+
- An OpenRouter API key (recommended), or OpenAI-compatible API key

## Setup

```bash
npm install
cp .env.example .env
```

Set your API key in `.env`:

```env
OPENROUTER_API_KEY=your_key_here
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=openai/gpt-4.1-mini
```

Optional OpenRouter headers:

```env
OPENROUTER_HTTP_REFERER=https://your-site-or-portfolio.com
OPENROUTER_X_TITLE=Shopify Theme Audit Agent
```

## Usage

```bash
npm run audit -- --url https://www.sermanbrands.com/
```

Optional arguments:

- `--out ./reports/serman-audit.md` custom output path
- `--max-pages 3` crawl limit (default `3`, fastest)
- `--docx` optionally generate DOCX as well

## Frontend (URL input + download)

Start the web app:

```bash
npm run dev
```

Open:

- `http://localhost:3000`

Flow:

- Enter Shopify store URL
- Optionally add extra same-domain page URLs under **Additional Pages to Audit**
- Optional: enable **Also create Google Doc automatically**
- Click **Generate Audit Document**
- Download generated `.md` from the UI

## Deploy on Vercel

1. Push this project to GitHub.
2. Import the repo in Vercel.
3. Add environment variables in Vercel Project Settings:
   - `OPENROUTER_API_KEY`
   - `OPENROUTER_BASE_URL`
   - `OPENAI_MODEL`
   - Optional Google Doc vars (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, `GOOGLE_DRIVE_FOLDER_ID`)
4. Deploy.

Notes for Vercel:
- The app runs through `api/index.js` serverless entrypoint.
- Markdown download is returned directly from API response (no persistent `reports/` storage required).
- For reliability in serverless limits, Vercel mode forces:
  - fast mode on
  - benchmark screenshot crawling off
  - local screenshot capture off

## Google Doc Auto-Create (optional)

You can configure either:

- OAuth user auth (recommended)
- Service account auth (fallback)

### Option A: OAuth user auth (recommended)

```env
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REFRESH_TOKEN=
GOOGLE_DRIVE_FOLDER_ID=
GOOGLE_SHARE_WITH_EMAIL=you@example.com
```

### Option B: Service account auth

```env
GOOGLE_SERVICE_ACCOUNT_EMAIL=service-account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_DRIVE_FOLDER_ID=
GOOGLE_SHARE_WITH_EMAIL=you@example.com
```

Notes:
- If credentials are missing, audit still works and returns markdown.
- If enabled and configured, frontend shows an **Open Google Doc** link after generation.
- If service account returns `storageQuotaExceeded`, switch to OAuth user auth or use a Shared Drive.

## Notes for Shopify auditing

- This agent is intentionally constrained to Shopify stores only.
- If a site is not detected as Shopify, it exits with a clear message.
- You can tune scoring and section prompts in `src/auditPrompt.js`.

## Recommended next upgrades

- Add screenshot capture with annotation references.
- Add Lighthouse/PageSpeed measurements and include in report.
- Add a confidence score per recommendation.
- Add multi-store batch mode from CSV.
 