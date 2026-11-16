// HTML template -> PDF with Puppeteer.
const fs = require('fs');
const puppeteer = require('puppeteer');

const BROWSER_CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

let browserPromise;
function getBrowser() {
  if (!browserPromise) {
    // Locally: installed Edge/Chrome. On the server: the Chrome downloaded by puppeteer at install time.
    const executablePath = BROWSER_CANDIDATES.find(p => fs.existsSync(p));
    browserPromise = puppeteer.launch({
      executablePath, headless: true,
      args: process.platform === 'linux' ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : [],
    });
    browserPromise.catch(() => { browserPromise = null; });
  }
  return browserPromise;
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const eur = n => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

const L = {
  fr: { title: 'Plan de traitement', patient: 'Patient', date: 'Date', version: 'Version', draft: 'BROUILLON – questions en attente', final: 'VALIDÉ PAR LE PRATICIEN', stage: 'Étape', when: 'Quand', tooth: 'Dent', act: 'Acte', code: 'Code', qty: 'Qté', unit: 'Prix unit.', amount: 'Montant', subtotal: 'Sous-total', total: 'Total estimé', questions: 'Points à clarifier par le praticien', answered: 'Précisions apportées', unmatched: 'Actes mentionnés hors grille tarifaire (à chiffrer)', custom: 'prix indiqué par le praticien', free: 'offert', foot: 'Prix issus de la grille tarifaire du cabinet (sauf prix/remises indiqués par le praticien). Devis indicatif – données patient fictives (PoC).' },
  en: { title: 'Treatment plan', patient: 'Patient', date: 'Date', version: 'Version', draft: 'DRAFT – open questions', final: 'APPROVED BY THE DENTIST', stage: 'Stage', when: 'When', tooth: 'Tooth', act: 'Procedure', code: 'Code', qty: 'Qty', unit: 'Unit price', amount: 'Amount', subtotal: 'Subtotal', total: 'Estimated total', questions: 'Open questions for the dentist', answered: 'Clarifications provided', unmatched: 'Procedures not in the price list (to be quoted)', custom: 'price set by dentist', free: 'free of charge', foot: 'Prices from the clinic price list (except prices/discounts set by the dentist). Indicative estimate – fake patient data (PoC).' },
};

function renderHtml(plan, { version, lang, final }) {
  const t = L[lang] || L.en;
  const status = final ? t.final : (plan.questions.length ? t.draft : '');
  const stages = plan.stages.map((s, i) => `
    <section class="stage">
      <div class="stage-head"><span class="n">${t.stage} ${i + 1}</span> <b>${esc(s.title)}</b><span class="when">${t.when} : ${esc(s.timing)}</span></div>
      ${s.goal ? `<p class="goal">${esc(s.goal)}</p>` : ''}
      <table>
        <thead><tr><th>${t.tooth}</th><th>${t.act}</th><th>${t.code}</th><th class="r">${t.qty}</th><th class="r">${t.unit}</th><th class="r">${t.amount}</th></tr></thead>
        <tbody>${s.items.map(it => `<tr><td>${esc(it.tooth)}</td><td>${esc(it.service)}${it.note ? `<div class="note">${esc(it.note)}</div>` : ''}</td><td>${esc(it.code)}</td><td class="r">${it.quantity}</td><td class="r">${eur(it.unit_price)}${it.custom_price ? `<div class="note">${t.custom}</div>` : ''}${it.discount_percent ? `<div class="disc">${it.discount_percent === 100 ? t.free : '-' + it.discount_percent + ' %'}</div>` : ''}</td><td class="r">${eur(it.line_total)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="5" class="r">${t.subtotal}</td><td class="r">${eur(s.subtotal)}</td></tr></tfoot>
      </table>
    </section>`).join('');

  const list = (title, cls, rows) => rows.length ? `<section class="box ${cls}"><h3>${title}</h3><ul>${rows.join('')}</ul></section>` : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{color-scheme:light} html,body{background:#fff}
    body{font-family:"Segoe UI",Arial,sans-serif;color:#1d2433;font-size:11px;margin:0}
    header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #0e9aa7;padding-bottom:10px;margin-bottom:14px}
    h1{margin:0;font-size:22px;color:#0b5560} .clinic{font-size:12px;color:#0e9aa7;font-weight:600}
    .meta{text-align:right;line-height:1.6} .status{display:inline-block;margin-top:4px;padding:2px 8px;border-radius:10px;font-weight:700;font-size:10px}
    .status.draft{background:#fff3cd;color:#8a6100} .status.final{background:#d4f5e6;color:#0b6b3a}
    .summary{background:#f1f7f8;border-left:4px solid #0e9aa7;padding:8px 12px;margin-bottom:14px}
    .stage{margin-bottom:14px;page-break-inside:avoid} .stage-head{font-size:13px;margin-bottom:4px}
    .n{background:#0e9aa7;color:#fff;border-radius:4px;padding:1px 6px;font-size:10px;margin-right:4px}
    .when{float:right;color:#0b5560;font-weight:600} .goal{margin:2px 0 6px;color:#555}
    table{width:100%;border-collapse:collapse} th{background:#e6f2f3;text-align:left;padding:4px 6px;font-size:10px}
    td{padding:4px 6px;border-bottom:1px solid #e3e8ea;vertical-align:top} .r{text-align:right;white-space:nowrap}
    tfoot td{font-weight:700;border:none} .note{color:#8a6100;font-size:9.5px;font-style:italic} .disc{color:#0b6b3a;font-size:9.5px;font-weight:700}
    .total{text-align:right;font-size:15px;font-weight:700;color:#0b5560;border-top:2px solid #0e9aa7;padding-top:8px;margin:6px 0 14px}
    .box{border-radius:6px;padding:6px 12px;margin-bottom:10px;page-break-inside:avoid} .box h3{margin:4px 0;font-size:12px} .box ul{margin:4px 0;padding-left:18px}
    .q{background:#fff8e1;border:1px solid #f0c94d} .a{background:#eef8f1;border:1px solid #9bd3ad} .u{background:#fdecec;border:1px solid #e9a3a3}
    footer{margin-top:16px;color:#888;font-size:9px;border-top:1px solid #ddd;padding-top:6px}
  </style></head><body>
    <header>
      <div><div class="clinic">Cabinet dentaire – Démo PoC</div><h1>${t.title}</h1></div>
      <div class="meta">${t.patient} : <b>${esc(plan.patient.name)}</b>${plan.patient.age ? `, ${esc(plan.patient.age)}` : ''}<br>
        ${t.date} : ${new Date().toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB')} · ${t.version} : <b>v${version}</b><br>
        ${status ? `<span class="status ${final ? 'final' : 'draft'}">${status}</span>` : ''}</div>
    </header>
    ${plan.summary ? `<div class="summary">${esc(plan.summary)}</div>` : ''}
    ${stages}
    <div class="total">${t.total} : ${eur(plan.total)}</div>
    ${list(t.questions, 'q', plan.questions.map(q => `<li><b>${esc(q.question)}</b>${q.options?.length ? ` — ${q.options.map(esc).join(' / ')}` : ''}</li>`))}
    ${list(t.answered, 'a', (plan.answered || []).map(a => `<li>${esc(a.question)} → <b>${esc(a.answer)}</b></li>`))}
    ${list(t.unmatched, 'u', plan.unmatched.map(u => `<li>${esc(u.description)}${u.reason ? ` <i>(${esc(u.reason)})</i>` : ''}</li>`))}
    <footer>${t.foot}</footer>
  </body></html>`;
}

async function generatePdf(plan, opts, outPath) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(renderHtml(plan, opts), { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
  } finally { await page.close(); }
  return outPath;
}

module.exports = { generatePdf, renderHtml };
