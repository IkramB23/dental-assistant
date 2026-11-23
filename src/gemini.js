// Calls Google's free AI models through the Gemini REST API. Used when GEMINI_API_KEY is set (online deployment).
// The free tier is small (≈20 requests/day per Gemini model) and often overloaded, so we:
//  - try each Gemini model briefly, then fall back to Gemma (open model, much larger free daily quota);
//  - remember models whose daily quota is exhausted and skip them until the next day.
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-3.8-flash',
  'gemini-3.8-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
].filter(Boolean);
const GEMMA_MODELS = ['gemma-4-27b-it', 'gemma-3-27b-it', 'gemma-3-12b-it'];
const CALL_TIMEOUT_MS = 60000;
const TOTAL_BUDGET_MS = 170000;

const exhaustedUntil = new Map(); // model -> timestamp
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(model, body, timeoutMs) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => ({}));
    console.log(`[gemini] ${model} -> ${r.status} in ${Date.now() - t0} ms${r.status !== 200 ? ' ' + (j.error?.message || '').slice(0, 160) : ''}`);
    return { status: r.status, j };
  } catch (e) {
    console.log(`[gemini] ${model} -> ${e.name} after ${Date.now() - t0} ms`);
    return { status: 504, j: { error: { message: 'timeout' } } };
  }
}

function extractJSON(j) {
  const text = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON');
  return JSON.parse(text.slice(start, end + 1));
}

function requestBodies(model, { systemPrompt, userPrompt, schema }) {
  const schemaText = `\n\nAnswer with ONLY a JSON object (no markdown) matching this JSON Schema:\n${JSON.stringify(schema)}`;
  if (model.startsWith('gemma')) {
    // Gemma: no system instruction / JSON mode -> everything in the user message.
    return [{
      contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}${schemaText}` }] }],
      generationConfig: { temperature: 0.2 },
    }];
  }
  const base = { systemInstruction: { parts: [{ text: systemPrompt }] } };
  return [
    { ...base, contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseJsonSchema: schema } },
    { ...base, contents: [{ role: 'user', parts: [{ text: userPrompt + schemaText }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } },
  ];
}

async function askGeminiJSON(opts) {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let lastError = 'unknown error';
  let busy = false;

  for (let round = 0; round < 2; round++) {
    for (const model of [...GEMINI_MODELS, ...GEMMA_MODELS]) {
      if ((exhaustedUntil.get(model) || 0) > Date.now()) continue;
      const bodies = requestBodies(model, opts);
      for (const body of bodies) {
        const left = deadline - Date.now();
        if (left < 5000) break;
        const { status, j } = await call(model, body, Math.min(CALL_TIMEOUT_MS, left));
        if (status === 200) {
          try { return extractJSON(j); } catch { lastError = `${model} returned invalid JSON`; continue; }
        }
        const msg = j.error?.message || 'request failed';
        lastError = `Gemini ${status}: ${msg}`;
        if (/API key|credential|PERMISSION|unauthori[sz]ed/i.test(msg)) throw new Error(lastError);
        if (status === 429 && /per ?day|PerDay/i.test(msg)) { exhaustedUntil.set(model, Date.now() + 3 * 3600e3); break; }
        if (status === 400 && body !== bodies.at(-1)) continue; // retry simpler request
        if (status === 429 || status >= 500) busy = true;
        break; // 404 / overloaded / timeout -> next model
      }
    }
    if (Date.now() > deadline - 5000) break;
    await sleep(3000);
  }
  throw new Error(/quota/i.test(lastError) && !busy
    ? 'Google AI free-tier quota reached for today. Please try again later.'
    : busy ? 'Google AI (free tier) is overloaded right now. Please try again in a minute.' : lastError);
}

module.exports = { askGeminiJSON };
