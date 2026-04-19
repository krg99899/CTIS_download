// ──────────────────────────────────────────────────────────────────────
// Per-job + daily token/cost metering for Gemini calls.
//
// Price estimates (Gemini 2.5 Flash, Apr 2026 — these are your defaults,
// override via env if they change):
//   input  : $0.075 per 1M tokens
//   output : $0.30  per 1M tokens
//
// Aggregates:
//   - per-extraction (lives inside the job, surfaced in response)
//   - per-day totals in .metering/YYYY-MM-DD.json
// ──────────────────────────────────────────────────────────────────────

const fs = require('fs/promises');
const path = require('path');

const INPUT_PRICE_PER_MILLION  = parseFloat(process.env.GEMINI_INPUT_PRICE_PER_MILLION  || '0.075');
const OUTPUT_PRICE_PER_MILLION = parseFloat(process.env.GEMINI_OUTPUT_PRICE_PER_MILLION || '0.30');
const METERING_DIR = process.env.METERING_DIR || path.join(__dirname, '..', '.metering');

function estimateCostUsd({ promptTokens = 0, candidateTokens = 0 }) {
  return (promptTokens  / 1_000_000) * INPUT_PRICE_PER_MILLION
       + (candidateTokens / 1_000_000) * OUTPUT_PRICE_PER_MILLION;
}

function createMeter() {
  return {
    calls: 0,
    promptTokens: 0,
    candidateTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    byStage: {}
  };
}

function recordCall(meter, stage, usage) {
  if (!meter || !usage) return;
  const p = Number(usage.promptTokenCount    || usage.promptTokens    || 0);
  const c = Number(usage.candidatesTokenCount || usage.candidateTokens || usage.outputTokens || 0);
  const t = p + c;
  const cost = estimateCostUsd({ promptTokens: p, candidateTokens: c });
  meter.calls++;
  meter.promptTokens    += p;
  meter.candidateTokens += c;
  meter.totalTokens     += t;
  meter.costUsd         += cost;
  const s = meter.byStage[stage] || { calls: 0, promptTokens: 0, candidateTokens: 0, costUsd: 0 };
  s.calls++;
  s.promptTokens    += p;
  s.candidateTokens += c;
  s.costUsd         += cost;
  meter.byStage[stage] = s;
}

function summarize(meter) {
  return {
    calls: meter.calls,
    promptTokens: meter.promptTokens,
    candidateTokens: meter.candidateTokens,
    totalTokens: meter.totalTokens,
    costUsd: Math.round(meter.costUsd * 10000) / 10000,
    byStage: Object.fromEntries(Object.entries(meter.byStage).map(
      ([k, v]) => [k, { ...v, costUsd: Math.round(v.costUsd * 10000) / 10000 }]
    ))
  };
}

async function ensureDir() {
  try { await fs.mkdir(METERING_DIR, { recursive: true }); } catch {}
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC
}

async function persistDaily(meter, { pdfHash, filename, success, score }) {
  try {
    await ensureDir();
    const file = path.join(METERING_DIR, `${todayKey()}.json`);
    let day = { date: todayKey(), extractions: 0, totalTokens: 0, costUsd: 0, byHour: {}, items: [] };
    try {
      const raw = await fs.readFile(file, 'utf8');
      day = JSON.parse(raw);
    } catch {}
    day.extractions = (day.extractions || 0) + 1;
    day.totalTokens = (day.totalTokens || 0) + meter.totalTokens;
    day.costUsd     = Math.round(((day.costUsd || 0) + meter.costUsd) * 10000) / 10000;
    const hour = String(new Date().getUTCHours()).padStart(2, '0');
    day.byHour[hour] = day.byHour[hour] || { extractions: 0, totalTokens: 0, costUsd: 0 };
    day.byHour[hour].extractions++;
    day.byHour[hour].totalTokens += meter.totalTokens;
    day.byHour[hour].costUsd     = Math.round((day.byHour[hour].costUsd + meter.costUsd) * 10000) / 10000;
    day.items.push({
      ts: Date.now(),
      pdfHash, filename, success, score,
      totalTokens: meter.totalTokens,
      costUsd: Math.round(meter.costUsd * 10000) / 10000,
      calls: meter.calls
    });
    if (day.items.length > 1000) day.items = day.items.slice(-1000); // cap per-day log
    await fs.writeFile(file, JSON.stringify(day, null, 0), 'utf8');
  } catch (err) {
    console.warn('[metering] persistDaily failed:', err.message);
  }
}

async function getDaily(date) {
  try {
    const key = date || todayKey();
    const raw = await fs.readFile(path.join(METERING_DIR, `${key}.json`), 'utf8');
    return JSON.parse(raw);
  } catch { return { date: date || todayKey(), extractions: 0, totalTokens: 0, costUsd: 0, byHour: {}, items: [] }; }
}

async function listDays() {
  try {
    await ensureDir();
    const files = await fs.readdir(METERING_DIR);
    return files.filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).sort();
  } catch { return []; }
}

module.exports = {
  createMeter,
  recordCall,
  summarize,
  persistDaily,
  getDaily,
  listDays,
  pricing: { inputPerMillion: INPUT_PRICE_PER_MILLION, outputPerMillion: OUTPUT_PRICE_PER_MILLION }
};
