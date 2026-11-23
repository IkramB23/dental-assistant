// Calls Google Gemini (free tier) through its REST API. Used when GEMINI_API_KEY is set (online deployment).
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODELS = [process.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-2.5-flash'].filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(model, body) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const j = await r.json().catch(() => ({}));
    console.log(`[gemini] ${model} -> ${r.status} in ${Date.now() - t0} ms${r.status !== 200 ? ' ' + (j.error?.message || '').slice(0, 200) : ''}`);
    return { status: r.status, j };
  } catch (e) {
    console.log(`[gemini] ${model} -> ${e.name} after ${Date.now() - t0} ms`);
    return { status: 504, j: { error: { message: 'Gemini timeout (' + e.name + ')' } } };
  }
}

async function askGeminiJSON({ systemPrompt, userPrompt, schema }) {
  const withSchema = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseJsonSchema: schema },
  };
  // Fallback if the model refuses the schema: put the schema in the prompt instead.
  const schemaInPrompt = {
    ...withSchema,
    contents: [{ role: 'user', parts: [{ text: `${userPrompt}\n\nAnswer with ONLY a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}` }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  };

  let lastError = 'unknown error';
  for (const model of MODELS) {
    for (const body of [withSchema, schemaInPrompt]) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const { status, j } = await call(model, body);
        if (status === 200) {
          const text = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
          try { return JSON.parse(text.replace(/^```(json)?\s*|\s*```$/g, '')); }
          catch { lastError = 'Gemini returned invalid JSON'; break; }
        }
        lastError = `Gemini ${status}: ${j.error?.message || 'request failed'}`;
        if (status === 504) break; // timed out: don't wait again on the same call
        if (status === 429 || status >= 500) { await sleep(2000 * (attempt + 1)); continue; } // quota / overloaded: retry
        break;
      }
      if (/API key|credential|PERMISSION|unauthori[sz]ed/i.test(lastError)) throw new Error(lastError);
      if (/not found|not supported/i.test(lastError)) break; // try next model
    }
  }
  throw new Error(lastError);
}

module.exports = { askGeminiJSON };
