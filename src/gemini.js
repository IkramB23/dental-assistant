// Calls Google Gemini (free tier) through its REST API. Used when GEMINI_API_KEY is set (online deployment).
// The free tier is often overloaded (503): we try each model briefly and fall back to lighter models.
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-3.8-flash',
  'gemini-3.8-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
].filter(Boolean);
const CALL_TIMEOUT_MS = 60000;   // one Gemini call
const TOTAL_BUDGET_MS = 170000;  // whole request, so the dentist never waits forever

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
  return JSON.parse(text.replace(/^```(json)?\s*|\s*```$/g, ''));
}

async function askGeminiJSON({ systemPrompt, userPrompt, schema }) {
  const base = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
  };
  const withSchema = { ...base, generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseJsonSchema: schema } };
  const schemaInPrompt = {
    ...base,
    contents: [{ role: 'user', parts: [{ text: `${userPrompt}\n\nAnswer with ONLY a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}` }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  };

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let lastError = 'unknown error';
  let busy = false;

  // Two rounds over the models: overload spikes are often short.
  for (let round = 0; round < 2; round++) {
    for (const model of MODELS) {
      for (const body of [withSchema, schemaInPrompt]) {
        const left = deadline - Date.now();
        if (left < 5000) break;
        const { status, j } = await call(model, body, Math.min(CALL_TIMEOUT_MS, left));
        if (status === 200) {
          try { return extractJSON(j); } catch { lastError = 'Gemini returned invalid JSON'; continue; }
        }
        lastError = `Gemini ${status}: ${j.error?.message || 'request failed'}`;
        if (status === 400 && body === withSchema) continue;              // schema refused -> retry with schema in prompt
        if (/API key|credential|PERMISSION|unauthori[sz]ed/i.test(lastError)) throw new Error(lastError);
        if (status === 429 || status === 503 || status === 504 || status >= 500) busy = true;
        break;                                                             // 404 / overloaded / timeout -> next model
      }
    }
    if (Date.now() > deadline - 5000) break;
    await sleep(3000);
  }
  throw new Error(/quota/i.test(lastError)
    ? 'Google Gemini free-tier quota reached for today. Please try again later.'
    : busy ? 'Google Gemini (free tier) is overloaded right now. Please try again in a minute.' : lastError);
}

module.exports = { askGeminiJSON };
