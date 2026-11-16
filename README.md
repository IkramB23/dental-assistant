# Dental Assistant – PoC

AI assistant for a dental clinic. The dentist dictates the work, the agent turns it into a treatment plan PDF, asks clarifying questions, and regenerates the PDF with the answers.

**Flow:** dentist dictates by voice → Claude builds the plan (stages + intervals + prices from the clinic price list) → PDF v1 with questions → dentist answers by voice → PDF v2, v3… → approved final PDF.

## Acceptance criteria – 4/4
- ✅ Understands voice (dictation and answers by microphone)
- ✅ Generates a PDF
- ✅ Asks clarifying questions
- ✅ Regenerates the PDF with the answers

## Run it

Requirements:
- **Node.js 18+**
- **Google Chrome or Microsoft Edge** (voice recognition only works there)
- **Claude Code**, logged in with a Claude account. The app uses the Claude subscription through the CLI, so you don't need an API key. Install it with `npm install -g @anthropic-ai/claude-code`, then run `claude` once to log in.

```
git clone https://github.com/Ikram-code-ai/dental-assistant.git
cd dental-assistant
npm install
npm start
```
Open **http://localhost:3000** in Chrome or Edge and allow the microphone.

## How to test
1. Click **PATIENT 1…5** to load the dentist's sample notes, or click **🎤 Dictate** and speak.
2. Click **Build plan → PDF**: PDF v1 appears, with the assistant's questions.
3. Answer with **🎤 Answer**, or click the suggested options, then click **Update plan → new PDF**: PDF v2 appears.
4. Click **Approve → final PDF**.

Each generation takes about 15–40 s.

## Architecture
| Component | Tech |
|---|---|
| Web app | Node.js + Express, one HTML page |
| Voice input | Web Speech API in the browser (EN / FR) |
| AI agent | Claude Sonnet via the Claude Code CLI in headless mode (`claude -p --json-schema`), using a Claude subscription |
| PDF | HTML template → PDF with puppeteer-core (uses the installed Chrome/Edge) |
| Memory | In-memory session: current plan JSON + every PDF version (`output/`) |

**Key choices**
- Claude only selects price-list items by ID. Prices, discounts and totals are computed by code, so the AI never invents prices. Prices and discounts dictated by the dentist are shown as such in the PDF.
- The agent asks instead of guessing when an answer changes the procedure or the price (implant system, sedation duration, missing discount %…).
- The dentist validates every version.
- Only fake patient data is used. A real deployment would need GDPR-compliant hosting.

## Files
- `server.js` – API: `POST /api/plan`, `POST /api/session/:id/answer`, `POST /api/session/:id/finalize`
- `src/claude.js` – calls the Claude Code CLI and returns schema-validated JSON
- `src/agent.js` – prompt, plan schema, pricing
- `src/pdf.js` – PDF template
- `public/index.html` – dentist interface (voice, questions, PDF viewer)
- `data/price_list.json` – clinic price list · `data/dentist_notes_EN.txt` – dentist's sample notes
