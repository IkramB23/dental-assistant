try { process.loadEnvFile(); } catch {} // optional .env (GEMINI_API_KEY=...), never committed
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createPlan, updatePlan, AI_NAME } = require('./src/agent');
const { generatePdf } = require('./src/pdf');

const app = express();
const PORT = process.env.PORT || 3000;
const OUT = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });

app.use(express.json({ limit: '1mb' }));

// Max 2 Claude calls at the same time.
let running = 0;
app.use('/api', (req, res, next) => {
  if (req.method !== 'POST') return next();
  if (running >= 2) return res.status(429).json({ error: 'The assistant is busy, please retry in a few seconds.' });
  running++;
  res.on('close', () => running--);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/pdf', express.static(OUT));

// Session memory: current plan + every PDF version.
const sessions = new Map();

function publicSession(s) {
  return { id: s.id, language: s.language, dictation: s.dictation, plan: s.plan, versions: s.versions, final: s.final };
}

async function newVersion(s, final = false) {
  const version = s.versions.length + 1;
  const file = `${s.id}_v${version}${final ? '_final' : ''}.pdf`;
  await generatePdf(s.plan, { version, lang: s.language, final }, path.join(OUT, file));
  s.versions.push({ version, url: `/pdf/${file}`, final, questions: s.plan.questions.length, total: s.plan.total, at: new Date().toISOString() });
}

const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message }); });

// 1-3: dictation -> plan -> PDF v1 (+ questions)
app.post('/api/plan', wrap(async (req, res) => {
  const { dictation, language = 'fr' } = req.body;
  if (!dictation?.trim()) return res.status(400).json({ error: 'Empty dictation' });
  const s = { id: crypto.randomBytes(4).toString('hex'), language, dictation, versions: [], final: false };
  console.log(`[${s.id}] building plan…`);
  s.plan = await createPlan({ dictation, language: language === 'fr' ? 'French' : 'English' });
  await newVersion(s);
  sessions.set(s.id, s);
  res.json(publicSession(s));
}));

// 4-5: dentist answers -> updated plan -> PDF v(n+1)
app.post('/api/session/:id/answer', wrap(async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Unknown session' });
  const { answers } = req.body;
  if (!answers?.trim()) return res.status(400).json({ error: 'Empty answer' });
  console.log(`[${s.id}] applying answers…`);
  s.plan = await updatePlan({ dictation: s.dictation, language: s.language === 'fr' ? 'French' : 'English', previousPlan: s.plan, answers });
  await newVersion(s);
  res.json(publicSession(s));
}));

// Dentist validates -> final PDF
app.post('/api/session/:id/finalize', wrap(async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Unknown session' });
  s.final = true;
  await newVersion(s, true);
  res.json(publicSession(s));
}));

// The dentist's sample notes (original file), split per patient, to load into the dictation box.
app.get('/api/sample-notes', (req, res) => {
  const txt = fs.readFileSync(path.join(__dirname, 'data', 'dentist_notes_EN.txt'), 'utf8');
  const blocks = txt.split(/\n=+\n/).map(b => b.trim()).filter(b => /^PATIENT \d/.test(b));
  res.json(blocks.map(b => ({ label: b.match(/^PATIENT \d+/)[0], text: b.replace(/^PATIENT[^\n]*\n-+\n/, '').trim() })));
});

app.get('/api/info', (req, res) => res.json({ ai: AI_NAME() }));

// Diagnostics: tests the AI and the PDF engine separately (no secrets returned).
app.get('/api/diag', async (req, res) => {
  const out = {};
  let t = Date.now();
  try {
    await generatePdf({ patient: { name: 'Diag' }, summary: '', stages: [], unmatched: [], questions: [], answered: [], total: 0 }, { version: 0, lang: 'en' }, path.join(OUT, 'diag.pdf'));
    out.pdf = `OK in ${Date.now() - t} ms`;
  } catch (e) { out.pdf = 'ERROR: ' + e.message; }
  if (req.query.ai !== '0') {
    t = Date.now();
    try {
      const { askGeminiJSON } = require('./src/gemini');
      const r = await askGeminiJSON({ systemPrompt: 'Reply with JSON only.', userPrompt: 'Return {"ok": true}', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } });
      out.ai = `OK in ${Date.now() - t} ms: ${JSON.stringify(r)}`;
    } catch (e) { out.ai = 'ERROR: ' + e.message; }
  }
  res.json(out);
});

app.listen(PORT, () => console.log(`Dental assistant running on http://localhost:${PORT} (AI: ${AI_NAME()})`));
