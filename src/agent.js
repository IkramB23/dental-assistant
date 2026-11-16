// The AI agent: dictation -> structured treatment plan + clarifying questions.
// Claude only picks price-list IDs; prices are always computed here from the clinic list.
const fs = require('fs');
const path = require('path');
const { askClaudeJSON } = require('./claude');
const { askGeminiJSON } = require('./gemini');

// Online (GEMINI_API_KEY set) -> Gemini free tier. Locally without key -> Claude via Claude Code (subscription).
const askAI = opts => (process.env.GEMINI_API_KEY ? askGeminiJSON(opts) : askClaudeJSON(opts));
const AI_NAME = () => (process.env.GEMINI_API_KEY ? 'Gemini' : 'Claude');

const PRICE_LIST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'price_list.json'), 'utf8'))
  .map((p, i) => ({ id: 'P' + (i + 1), ...p }));
const PRICE_BY_ID = new Map(PRICE_LIST.map(p => [p.id, p]));
const PRICE_TABLE = PRICE_LIST.map(p => `${p.id} | ${p.section} | ${p.service} | ${p.price_eur.toFixed(2)} EUR`).join('\n');

const SCHEMA = {
  type: 'object',
  required: ['patient', 'summary', 'stages', 'unmatched', 'questions', 'answered'],
  properties: {
    patient: {
      type: 'object', required: ['name'],
      properties: { name: { type: 'string' }, age: { type: 'string' } },
    },
    summary: { type: 'string', description: 'Short diagnosis / overall goal, patient-friendly' },
    stages: {
      type: 'array',
      items: {
        type: 'object', required: ['title', 'timing', 'items'],
        properties: {
          title: { type: 'string' },
          timing: { type: 'string', description: 'When this stage happens, e.g. "Week 0", "+2 weeks after stage 1", "3-6 months later"' },
          goal: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object', required: ['price_id', 'quantity'],
              properties: {
                price_id: { type: 'string', description: 'ID from the clinic price list, e.g. P42' },
                tooth: { type: 'string', description: 'FDI tooth number(s), e.g. "36" or "11, 21"; empty if not tooth specific' },
                quantity: { type: 'integer', minimum: 1 },
                discount_percent: { type: 'number', minimum: 0, maximum: 100, description: 'Only when the dentist dictated a discount (100 = free of charge)' },
                dentist_price_eur: { type: 'number', description: 'Only when the dentist explicitly dictated a unit price different from the list' },
                note: { type: 'string', description: 'Only extra info (e.g. "to be confirmed", "free under Doluchys programme"). Never repeat the service name. Empty if nothing to add.' },
              },
            },
          },
        },
      },
    },
    unmatched: {
      type: 'array', description: 'Procedures mentioned by the dentist that have no matching line in the price list',
      items: { type: 'object', required: ['description'], properties: { description: { type: 'string' }, reason: { type: 'string' } } },
    },
    questions: {
      type: 'array', description: 'Open clarifying questions. Empty when nothing is ambiguous any more.',
      items: {
        type: 'object', required: ['id', 'question', 'options'],
        properties: { id: { type: 'string' }, question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
      },
    },
    answered: {
      type: 'array', description: 'All questions answered so far by the dentist, with their answers (cumulative).',
      items: { type: 'object', required: ['question', 'answer'], properties: { question: { type: 'string' }, answer: { type: 'string' } } },
    },
  },
};

const SYSTEM_PROMPT = `You are the treatment-planning assistant of a dental clinic.
The dentist dictates (speech-to-text, so expect transcription errors) and you turn it into a structured, staged treatment plan.

Rules:
- Use ONLY procedures from the clinic price list, referenced by their ID (P1, P2, ...). Never invent prices or IDs.
- If something the dentist mentions has no matching line, put it in "unmatched" instead of forcing a match.
- Organise the plan in logical clinical stages (e.g. hygiene/urgent care -> endodontics -> surgery -> healing -> implant -> prosthetics), each with a realistic timing/interval (e.g. healing 3-4 months after extraction before implant, osseointegration 3-6 months before final crown).
- Discounts: set "discount_percent" ONLY if the dentist dictated one (e.g. "-30% military" -> 30 on the concerned items, "free of charge under X programme" -> 100). If a discount is mentioned without a percentage ("with discount"), ask for the percentage.
- Dentist-dictated prices (e.g. "890 EUR per implant"): set "dentist_price_eur" on the closest list item. If the dentist gives conflicting prices or options, ask which one applies.
- Quantities: one line per procedure with quantity = number of teeth/implants; put tooth numbers in "tooth".
- Non-clinical info (hobbies, lab technician, accommodation, travel) is not billed: mention it in the summary or note if useful; ask about it only if it changes the plan.
- Include obvious associated line items the clinic bills (local anaesthesia, single-use kit, radiograph) only when clearly appropriate.
- ASK instead of guessing when an answer would change the procedure or the price: material/brand choice (e.g. implant system Osstem vs Straumann vs Megagen, zirconia type), tooth number missing, number of teeth/implants, extraction difficulty, sedation, etc. Max 5 questions, the most important first, each with 2-4 short options taken from the price list possibilities.
- While a question is open, still build the best provisional plan using the most common/cheapest reasonable option and mention "to be confirmed" in the item note.
- When the dentist answers, apply the answers, move them to "answered", and only keep questions that are still open (or new ones raised by the answers). If everything is clear, return an empty "questions" array.
- Write all human-readable text (titles, timings, notes, questions, summary) in LANGUAGE (given in the request). Patient name: use what is dictated, else "Patient".`;

function buildUserPrompt({ language, dictation, previousPlan, answers }) {
  let p = `LANGUAGE: ${language}\n\nCLINIC PRICE LIST (ID | section | service | price):\n${PRICE_TABLE}\n\n`;
  p += `DENTIST DICTATION:\n"""${dictation}"""\n`;
  if (previousPlan) {
    p += `\nCURRENT PLAN (JSON):\n${JSON.stringify(stripComputed(previousPlan))}\n`;
    p += `\nDENTIST ANSWERS / CORRECTIONS (dictated):\n"""${answers}"""\n`;
    p += `\nReturn the full updated plan.`;
  } else {
    p += `\nReturn the treatment plan.`;
  }
  return p;
}

function stripComputed(plan) {
  const { total, ...rest } = plan;
  return {
    ...rest,
    stages: plan.stages.map(s => ({ ...s, subtotal: undefined, items: s.items.map(({ price_id, tooth, quantity, discount_percent, dentist_price_eur, note }) => ({ price_id, tooth, quantity, discount_percent, dentist_price_eur, note })) })),
  };
}

// Attach real prices from the price list; reject unknown IDs.
function priceThePlan(plan) {
  let total = 0;
  const unmatched = [...(plan.unmatched || [])];
  const stages = plan.stages.map(stage => {
    const items = [];
    for (const it of stage.items) {
      const ref = PRICE_BY_ID.get(String(it.price_id).trim());
      if (!ref) { unmatched.push({ description: `Unknown price id ${it.price_id}`, reason: it.note || '' }); continue; }
      const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
      const custom = Number(it.dentist_price_eur) > 0 ? Number(it.dentist_price_eur) : null;
      const unit = custom ?? ref.price_eur;
      const disc = Math.min(100, Math.max(0, Number(it.discount_percent) || 0));
      const line = Math.round(unit * qty * (1 - disc / 100) * 100) / 100;
      items.push({ ...it, quantity: qty, discount_percent: disc, service: ref.service, section: ref.section, code: ref.code,
        list_price: ref.price_eur, unit_price: unit, custom_price: custom !== null, line_total: line });
    }
    const subtotal = Math.round(items.reduce((a, b) => a + b.line_total, 0) * 100) / 100;
    total += subtotal;
    return { ...stage, items, subtotal };
  });
  return { ...plan, stages, unmatched, total: Math.round(total * 100) / 100 };
}

async function createPlan({ dictation, language }) {
  const raw = await askAI({ systemPrompt: SYSTEM_PROMPT, userPrompt: buildUserPrompt({ language, dictation }), schema: SCHEMA });
  return priceThePlan(raw);
}

async function updatePlan({ dictation, language, previousPlan, answers }) {
  const raw = await askAI({ systemPrompt: SYSTEM_PROMPT, userPrompt: buildUserPrompt({ language, dictation, previousPlan, answers }), schema: SCHEMA });
  return priceThePlan(raw);
}

module.exports = { createPlan, updatePlan, PRICE_LIST, AI_NAME };
