// ──────────────────────────────────────────────────────────────────────
// USDM v4.0 TOC-guided extraction orchestrator.
//
// Flow:
//   1. Parse TOC from first-N + last-M pages of PDF (Gemini with tocPrompt).
//      Fallback to regex scan if Gemini returns tocFound = false.
//   2. For each USDM section, slice the identified page ranges into a
//      focused sub-PDF.
//   3. Run a dedicated Gemini call per section with the section's prompt
//      and responseSchema. SoA runs last — receives both body and
//      appendix ranges.
//   4. Merge all section outputs into a single USDM v4.0 envelope.
//   5. Validate via ajv + custom audits (done outside this module).
//
// All Gemini calls use structured outputs (responseMimeType JSON +
// responseSchema) so we never get free-form text back.
// ──────────────────────────────────────────────────────────────────────

const { GoogleGenAI } = require('@google/genai');
const prompts = require('./usdm-prompts');
const splitter = require('./usdm-splitter');
const metering = require('./usdm-metering');

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// UUID-lite for id generation — good enough for an extraction artifact.
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function requireApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    const err = new Error(
      'GEMINI_API_KEY environment variable is not set. Get a free key at ' +
      'https://aistudio.google.com/app/apikey and add it to your environment.'
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }
  return key;
}

function getClient() {
  return new GoogleGenAI({ apiKey: requireApiKey() });
}

// Call Gemini with a PDF buffer + prompt + responseSchema.
// Returns parsed JSON. If the response is truncated (Flash output cap = 8192
// tokens), try to salvage the partial JSON before throwing — callers can
// chunk + retry at a higher level.
async function callGemini({ client, pdfBuffer, prompt, responseSchema, modelName = DEFAULT_MODEL, meter = null, stage = 'unknown', maxOutputTokens = 8192 }) {
  const contents = [
    {
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { text: prompt }
      ]
    }
  ];

  const response = await client.models.generateContent({
    model: modelName,
    contents,
    config: {
      responseMimeType: 'application/json',
      responseSchema,
      temperature: 0.1,
      maxOutputTokens
    }
  });

  // Record token usage for this call.
  if (meter) {
    const u = response?.usageMetadata || {};
    metering.recordCall(meter, stage, u);
  }

  let text = '';
  try { text = typeof response.text === 'function' ? response.text() : (response.text || ''); }
  catch { text = ''; }
  if (!text || !text.trim()) {
    const parts = response?.candidates?.[0]?.content?.parts || [];
    text = parts.map(p => p.text || '').join('');
  }
  if (!text.trim()) throw new Error('Gemini returned empty response');

  const finishReason = response?.candidates?.[0]?.finishReason;
  const truncated = finishReason === 'MAX_TOKENS' || finishReason === 'LENGTH';

  try {
    return JSON.parse(text);
  } catch (err) {
    const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(cleaned); } catch {}
    // Try salvaging a truncated JSON object by closing open structures.
    const salvaged = salvageTruncatedJson(cleaned);
    if (salvaged) return salvaged;
    const msg = truncated
      ? `Gemini output hit the 8192-token cap (truncated). Consider narrower page slices.`
      : `Could not parse Gemini JSON: ${err.message}`;
    const e = new Error(msg);
    e.truncated = truncated;
    throw e;
  }
}

// Attempt to close dangling arrays/objects in a truncated JSON response.
// Strips the incomplete tail element, then balances brackets. Good enough
// to recover partial data from MAX_TOKENS truncation.
function salvageTruncatedJson(text) {
  if (!text) return null;
  // Drop anything after the last complete-looking closer.
  let buf = text;
  // Remove trailing comma-or-incomplete tail.
  buf = buf.replace(/,\s*$/, '');
  // Remove a dangling partial property (`"key":` with nothing after).
  buf = buf.replace(/,\s*"[^"]*"\s*:\s*$/, '');
  // If we're inside an unterminated string, chop to last quote before it.
  // (Heuristic: if quote count is odd, strip to the last even quote.)
  const quotes = (buf.match(/"/g) || []).length;
  if (quotes % 2 !== 0) {
    const lastQuote = buf.lastIndexOf('"');
    if (lastQuote !== -1) buf = buf.slice(0, lastQuote).replace(/,\s*$/, '');
  }
  // Count unclosed brackets and close them.
  let openObj = 0, openArr = 0, inStr = false, escape = false;
  for (const c of buf) {
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') openObj++;
    else if (c === '}') openObj--;
    else if (c === '[') openArr++;
    else if (c === ']') openArr--;
  }
  buf = buf.replace(/,\s*$/, '');
  while (openArr-- > 0) buf += ']';
  while (openObj-- > 0) buf += '}';
  try { return JSON.parse(buf); } catch { return null; }
}

// ──────────────────────────────────────────────────────────────────────
// Pass 1 — TOC mapping
// ──────────────────────────────────────────────────────────────────────
async function extractTOC(client, pdfBuffer, emit, meter) {
  const tocPdf = await splitter.sliceTocInput(pdfBuffer, 12, 8);
  emit('progress', { stage: 'toc', message: 'Analyzing table of contents…' });

  let toc;
  try {
    toc = await callGemini({
      client,
      pdfBuffer: tocPdf,
      prompt: prompts.tocPrompt,
      responseSchema: prompts.tocResponseSchema,
      meter, stage: 'toc'
    });
  } catch (err) {
    emit('warning', { stage: 'toc', message: `Gemini TOC pass failed (${err.message}) — falling back to regex scan.` });
    toc = await splitter.fallbackTocScan(pdfBuffer);
  }

  if (!toc.tocFound || !toc.sections ||
      Object.values(toc.sections).every(s => !s?.ranges?.length)) {
    emit('warning', { stage: 'toc', message: 'No TOC ranges found — using regex fallback.' });
    const fallback = await splitter.fallbackTocScan(pdfBuffer);
    if (!toc.totalPages) toc.totalPages = fallback.totalPages;
    // Merge — prefer Gemini's result for any section it found, use
    // fallback for sections Gemini missed.
    toc.sections = toc.sections || {};
    for (const [key, val] of Object.entries(fallback.sections)) {
      if ((!toc.sections[key]?.ranges?.length) && val.ranges?.length) {
        toc.sections[key] = val;
      }
    }
    toc.tocFound = Object.values(toc.sections).some(s => s.ranges?.length);
  }

  if (!toc.totalPages) {
    toc.totalPages = await splitter.getPageCount(pdfBuffer);
  }

  return toc;
}

// ──────────────────────────────────────────────────────────────────────
// Slice PDF for a given section and run the section-specific prompt.
// ──────────────────────────────────────────────────────────────────────
async function runSection({ client, pdfBuffer, toc, sectionKey, sectionLabel, prompt, responseSchema, emit, fallbackFullIfEmpty = false, meter = null, maxOutputTokens = 8192 }) {
  const section = toc.sections?.[sectionKey];
  const ranges = section?.ranges || [];
  const label = sectionLabel || sectionKey;

  if (ranges.length === 0) {
    if (!fallbackFullIfEmpty) {
      emit('progress', { stage: sectionKey, message: `✗ ${label} — not found in TOC (skipped)` });
      return null;
    }
    emit('progress', { stage: sectionKey, message: `⚠ ${label} — no TOC range, scanning full PDF` });
    const result = await safeCallGemini({ client, pdfBuffer, prompt, responseSchema, emit, sectionKey, label, meter, maxOutputTokens });
    if (result) emit('progress', { stage: sectionKey, message: `✓ ${label}${summarizeSection(sectionKey, result) ? ' — ' + summarizeSection(sectionKey, result) : ' done'}` });
    return result;
  }

  // Strategy: process each range individually (keeps prompt size small),
  // then merge per-section. If a single range is >10 pages, split in half.
  const chunks = [];
  for (const r of ranges) {
    const pageCount = (r.endPage || r.startPage) - r.startPage + 1;
    if (pageCount > 10) {
      const mid = r.startPage + Math.floor(pageCount / 2);
      chunks.push({ startPage: r.startPage, endPage: mid - 1, locationHint: r.locationHint });
      chunks.push({ startPage: mid, endPage: r.endPage, locationHint: r.locationHint });
    } else {
      chunks.push(r);
    }
  }

  const rangeLabel = chunks.map(r => `pp. ${r.startPage}–${r.endPage}${r.locationHint ? ` (${r.locationHint})` : ''}`).join(', ');
  emit('progress', { stage: sectionKey, message: `→ ${label} — ${chunks.length} chunk(s): ${rangeLabel}` });

  const partials = [];
  for (const r of chunks) {
    const subPdf = await splitter.sliceByRanges(pdfBuffer, [r]);
    if (!subPdf) continue;
    const partial = await safeCallGemini({ client, pdfBuffer: subPdf, prompt, responseSchema, emit, sectionKey, label: `${label} ${r.startPage}–${r.endPage}`, meter, maxOutputTokens });
    if (partial) partials.push(partial);
  }

  if (partials.length === 0) {
    emit('warning', { stage: sectionKey, message: `${label} — all chunks failed` });
    return null;
  }

  const merged = mergeSectionPartials(sectionKey, partials);
  const summary = summarizeSection(sectionKey, merged);
  emit('progress', { stage: sectionKey, message: `✓ ${label} — merged ${partials.length}/${chunks.length} chunks${summary ? ' · ' + summary : ''}` });
  return merged;
}

// Single call with graceful error handling. Null on failure, not throw.
async function safeCallGemini({ client, pdfBuffer, prompt, responseSchema, emit, sectionKey, label, meter, maxOutputTokens = 8192 }) {
  try {
    return await callGemini({ client, pdfBuffer, prompt, responseSchema, meter, stage: sectionKey, maxOutputTokens });
  } catch (err) {
    emit('warning', { stage: sectionKey, message: `${label}: ${err.message}` });
    return null;
  }
}

// Merge multiple partial section responses into one. For array fields we
// concatenate; for scalar fields we keep the first non-null value.
function mergeSectionPartials(sectionKey, partials) {
  if (partials.length === 1) return partials[0];
  switch (sectionKey) {
    case 'synopsis': {
      const out = {};
      for (const p of partials) {
        for (const [k, v] of Object.entries(p || {})) {
          if (out[k] == null && v != null && v !== '') out[k] = v;
          else if (Array.isArray(v) && Array.isArray(out[k])) out[k] = [...out[k], ...v];
        }
      }
      return out;
    }
    case 'objectives':
      return { objectives: partials.flatMap(p => p?.objectives || []) };
    case 'eligibility': {
      const out = { inclusion: [], exclusion: [] };
      for (const p of partials) {
        out.inclusion.push(...(p?.inclusion || []));
        out.exclusion.push(...(p?.exclusion || []));
        for (const k of ['minimumAge', 'maximumAge', 'sexCode', 'plannedEnrollmentNumber']) {
          if (out[k] == null && p?.[k] != null) out[k] = p[k];
        }
        if (out.healthyVolunteers == null && p?.healthyVolunteers != null) out.healthyVolunteers = p.healthyVolunteers;
      }
      return out;
    }
    case 'armsInterventions':
      return {
        arms: partials.flatMap(p => p?.arms || []),
        interventions: partials.flatMap(p => p?.interventions || [])
      };
    case 'schedule':
      return { scheduleTimelines: partials.flatMap(p => p?.scheduleTimelines || []) };
    case 'estimands':
      return { estimands: partials.flatMap(p => p?.estimands || []) };
    default:
      return partials[0];
  }
}

function summarizeSection(key, result) {
  if (!result) return '';
  try {
    switch (key) {
      case 'synopsis':          return `${result.briefTitle ? 'title' : ''}${result.studyPhaseCode ? ', phase' : ''}${result.sponsorName ? ', sponsor' : ''}`.replace(/^, /, '');
      case 'objectives':        return `${(result.objectives || []).length} objective(s)`;
      case 'eligibility':       return `${(result.inclusion || []).length} incl + ${(result.exclusion || []).length} excl`;
      case 'armsInterventions': return `${(result.arms || []).length} arm(s), ${(result.interventions || []).length} intervention(s)`;
      case 'schedule': {
        const tls = result.scheduleTimelines || [];
        const totalA = tls.reduce((s, t) => s + (t.activities?.length || 0), 0);
        const totalE = tls.reduce((s, t) => s + (t.encounters?.length || 0), 0);
        return `${tls.length} timeline(s) · ${totalA} activities × ${totalE} visits`;
      }
      case 'estimands':         return `${(result.estimands || []).length} estimand(s)`;
      default: return '';
    }
  } catch { return ''; }
}

// ──────────────────────────────────────────────────────────────────────
// Merge all partials into a USDM v4.0 envelope.
// ──────────────────────────────────────────────────────────────────────
function codePair(code, decodeFallback) {
  if (!code) return null;
  const map = {
    C98388: 'Interventional Study',  C16084: 'Observational Study',
    C54721: 'Early Phase 1',          C15600: 'Phase 1',
    C15693: 'Phase 1/Phase 2',        C15601: 'Phase 2',
    C15694: 'Phase 2/Phase 3',        C15602: 'Phase 3',
    C15603: 'Phase 4',                C48660: 'Not Applicable',
    C82640: 'Parallel Study',         C82638: 'Crossover Study',
    C82639: 'Single Group Study',     C15710: 'Factorial Study Design',
    C82637: 'Sequential Study',
    C15228: 'Open Label',             C15229: 'Single Blind',
    C15230: 'Double Blind',           C28233: 'Triple Blind',
    C28234: 'Quadruple Blind',
    C49636: 'Both',                   C16576: 'Female', C20197: 'Male',
    C85826: 'Primary Objective',      C85827: 'Secondary Objective',
    C85828: 'Tertiary Objective',
    C94496: 'Primary Endpoint',       C94497: 'Secondary Endpoint',
    C188769: 'Exploratory Endpoint'
  };
  return {
    code,
    decode: map[code] || decodeFallback || code,
    codeSystem: 'http://www.cdisc.org'
  };
}

function normalizeObjective(o) {
  return {
    id: uuid(),
    instanceType: 'Objective',
    name: o.name || '',
    description: o.description || '',
    level: o.level && o.level.code ? codePair(o.level.code, o.level.decode) : null,
    endpoints: (o.endpoints || []).map(e => ({
      id: uuid(),
      instanceType: 'Endpoint',
      name: e.name || '',
      description: e.description || '',
      purpose: e.purpose || '',
      level: e.level && e.level.code ? codePair(e.level.code, e.level.decode) : null
    }))
  };
}

function mergeIntoUsdm({ toc, metadata, objectives, eligibility, arms, soa, estimands, sourcePath }) {
  const m = metadata || {};
  const elig = eligibility || {};
  const armsData = arms || { arms: [], interventions: [] };
  const soaData = soa || { scheduleTimelines: [] };
  const estData = estimands || { estimands: [] };

  const studyIdentifiers = [];
  // Filter out literal "null"/"N/A" strings Gemini sometimes returns.
  const isReal = (v) => typeof v === 'string' && v.trim() !== '' && !/^(null|n\/?a|none|tbd|pending)$/i.test(v.trim());
  if (isReal(m.nctId)) {
    studyIdentifiers.push({
      id: uuid(),
      instanceType: 'StudyIdentifier',
      studyIdentifier: m.nctId,
      studyIdentifierScope: {
        id: uuid(),
        instanceType: 'Organization',
        name: 'ClinicalTrials.gov',
        organizationType: { code: 'C93453', decode: 'Registry' }
      }
    });
  }
  if (isReal(m.sponsorStudyId)) {
    studyIdentifiers.push({
      id: uuid(),
      instanceType: 'StudyIdentifier',
      studyIdentifier: m.sponsorStudyId,
      studyIdentifierScope: {
        id: uuid(),
        instanceType: 'Organization',
        name: m.sponsorName || 'Sponsor',
        organizationType: { code: 'C70793', decode: 'Sponsor' }
      }
    });
  }

  const organizations = [];
  if (m.sponsorName) {
    organizations.push({
      id: uuid(),
      instanceType: 'Organization',
      name: m.sponsorName,
      organizationType: { code: 'C70793', decode: 'Sponsor' }
    });
  }
  (m.collaborators || []).forEach(c => {
    organizations.push({
      id: uuid(),
      instanceType: 'Organization',
      name: c,
      organizationType: { code: 'C188574', decode: 'Collaborator' }
    });
  });

  const studyDesign = {
    id: uuid(),
    instanceType: 'StudyDesign',
    name: `${m.briefTitle || 'Study'} — Design`,
    label: m.briefTitle || '',
    description: m.briefSummary || '',
    studyType: codePair(m.studyTypeCode) || codePair('C98388'),
    studyPhase: codePair(m.studyPhaseCode) || codePair('C48660'),
    interventionModel: codePair(m.interventionModelCode),
    blindingSchema: codePair(m.blindingCode),
    conditions: (m.conditions || []).map(c => ({
      id: uuid(), instanceType: 'Condition', name: c, description: c
    })),
    rationale: '',
    studyInterventions: (armsData.interventions || []).map(iv => {
      const intervention = {
        id: uuid(),
        instanceType: 'StudyIntervention',
        name: iv.name || '',
        description: iv.description || '',
        route: iv.route || '',
        dosage: iv.dosage || '',
        frequency: iv.frequency || ''
      };
      // role is optional — only include when Gemini returned a code
      if (iv.roleCode) intervention.role = codePair(iv.roleCode, iv.roleDecode);
      return intervention;
    }),
    arms: (armsData.arms || []).map(ag => ({
      id: uuid(),
      instanceType: 'StudyArm',
      name: ag.name || '',
      description: ag.description || '',
      type: ag.type ? { code: '', decode: ag.type, codeSystem: 'http://www.cdisc.org' } : null,
      interventionNames: ag.interventionNames || []
    })),
    objectives: (objectives?.objectives || []).map(normalizeObjective),
    estimands: (estData.estimands || []).map(e => ({
      id: uuid(),
      instanceType: 'Estimand',
      summaryMeasure: e.summaryMeasure || '',
      analysisPopulation: e.analysisPopulation || '',
      variable: e.variable || '',
      treatmentGroup: e.treatmentGroup || '',
      intercurrentEvents: (e.intercurrentEvents || []).map(ie => ({
        name: ie.name || '', strategy: ie.strategy || ''
      }))
    })),
    populations: [{
      id: uuid(),
      instanceType: 'StudyDesignPopulation',
      name: 'Trial Population',
      description: '',
      includeCriteria: (elig.inclusion || []).map(t => ({
        id: uuid(), instanceType: 'EligibilityCriterion', text: t, category: 'Inclusion'
      })),
      excludeCriteria: (elig.exclusion || []).map(t => ({
        id: uuid(), instanceType: 'EligibilityCriterion', text: t, category: 'Exclusion'
      })),
      plannedEnrollmentNumber: (elig.plannedEnrollmentNumber && elig.plannedEnrollmentNumber > 0)
        ? elig.plannedEnrollmentNumber
        : (m.plannedEnrollment && m.plannedEnrollment > 0 ? m.plannedEnrollment : null),
      sex: codePair(elig.sexCode),
      minimumAge: elig.minimumAge || '',
      maximumAge: elig.maximumAge || '',
      healthySubjectIndicator: elig.healthyVolunteers ?? false
    }],
    scheduleTimelines: (soaData.scheduleTimelines || []).map(tl => {
      const encounters = (tl.encounters || []).map(e => ({
        id: e.id, instanceType: 'Encounter',
        name: e.name || '', timing: e.timing || '',
        window: e.window || '',
        footnoteIds: e.encounterFootnoteIds || e.footnoteIds || []
      }));
      const encounterIdSet = new Set(encounters.map(e => e.id));
      const activities = (tl.activities || []).map(a => ({
        id: a.id, instanceType: 'Activity',
        name: a.name || '', category: a.category || '',
        estimatedDurationMinutes: a.estimatedDurationMinutes ?? null,
        footnoteIds: a.activityFootnoteIds || a.footnoteIds || []
      }));
      // Expand compact performedAt arrays → full N×M scheduledInstances.
      // Falls back to legacy scheduledInstances array if already present.
      let scheduledInstances;
      if (tl.scheduledInstances?.length) {
        scheduledInstances = tl.scheduledInstances.map(si => ({
          activityId: si.activityId, encounterId: si.encounterId,
          performed: !!si.performed, notes: si.notes || '',
          footnoteIds: si.footnoteIds || []
        }));
      } else {
        scheduledInstances = [];
        for (const a of tl.activities || []) {
          const performedSet = new Set(a.performedAt || []);
          const notesMap = new Map((a.performedAtWithNotes || []).map(n => [n.encounterId, n.notes || '']));
          for (const enc of encounters) {
            const inNotes = notesMap.has(enc.id);
            const performed = performedSet.has(enc.id) || inNotes;
            const si = { activityId: a.id, encounterId: enc.id, performed, notes: notesMap.get(enc.id) || '' };
            scheduledInstances.push(si);
          }
        }
      }
      return {
        id: uuid(),
        instanceType: 'ScheduleTimeline',
        name: tl.name || 'Study Schedule',
        mainTimeline: !!tl.mainTimeline,
        encounters,
        activities,
        scheduledInstances,
        footnotes: (tl.footnotes || []).map(f => ({ id: f.id, symbol: f.symbol || '', text: f.text || '' }))
      };
    }),
    biomedicalConcepts: []
  };

  // Title types must be valid CDISC code objects, not nulls.
  const officialTitleCode = { code: 'C207607', decode: 'Official Study Title', codeSystem: 'http://www.cdisc.org' };
  const briefTitleCode    = { code: 'C207606', decode: 'Brief Study Title',    codeSystem: 'http://www.cdisc.org' };
  const titles = [];
  if (isReal(m.officialTitle)) titles.push({ type: officialTitleCode, text: m.officialTitle });
  if (isReal(m.briefTitle))    titles.push({ type: briefTitleCode,    text: m.briefTitle });

  const dateValues = [];
  if (m.protocolDate) dateValues.push({ name: 'ProtocolEffectiveDate', dateValue: m.protocolDate });

  const studyVersion = {
    id: uuid(),
    instanceType: 'StudyVersion',
    versionIdentifier: m.protocolVersion || '1.0',
    rationale: '',
    studyType: studyDesign.studyType,
    studyPhase: studyDesign.studyPhase,
    studyIdentifiers,
    titles,
    dateValues,
    organizations,
    studyDesigns: [studyDesign]
  };

  const study = {
    id: uuid(),
    instanceType: 'Study',
    name: m.briefTitle || m.officialTitle || 'Study',
    label: m.briefTitle || '',
    description: m.briefSummary || '',
    versions: [studyVersion]
  };

  return {
    usdmVersion: '4.0',
    systemName: 'CTIS-USDM-Extractor',
    systemVersion: '1.0',
    sourceSystem: sourcePath || 'Protocol PDF',
    extractedAt: new Date().toISOString(),
    extractionMeta: {
      tocFound: !!toc?.tocFound,
      totalPages: toc?.totalPages || null,
      sectionsExtracted: Object.entries(toc?.sections || {})
        .filter(([, v]) => v?.ranges?.length)
        .map(([k, v]) => ({ section: k, ranges: v.ranges }))
    },
    study
  };
}

// ──────────────────────────────────────────────────────────────────────
// Public entry point
// ──────────────────────────────────────────────────────────────────────
async function extractUsdmFromPdf(pdfBuffer, { onProgress, sourcePath } = {}) {
  const emit = onProgress || (() => {});
  const client = getClient();
  const meter = metering.createMeter();

  emit('progress', { stage: 'init', message: 'Reading PDF…' });
  // Reject HTML-disguised files early (CTIS sometimes returns HTML instead of PDF).
  const magic = pdfBuffer.slice(0, 5).toString('ascii');
  if (!magic.startsWith('%PDF')) {
    const preview = pdfBuffer.slice(0, 20).toString('ascii').replace(/[^\x20-\x7E]/g, '?');
    throw Object.assign(new Error(`File does not appear to be a PDF (starts with: "${preview}"). CTIS may have returned an HTML error page — please re-download the file.`), { code: 'NOT_A_PDF' });
  }
  const totalPages = await splitter.getPageCount(pdfBuffer);
  emit('progress', { stage: 'init', message: `PDF has ${totalPages} pages.` });

  // Pass 1: TOC
  const toc = await extractTOC(client, pdfBuffer, emit, meter);

  // Pass 2–6: Section extraction (run sequentially to respect free-tier rate limits;
  // switch to Promise.all once the user has paid-tier quotas).

  // Metadata source: prefer titlePage + studyDesign body pages. Fall back
  // to synopsis if neither is detected (some short/amendment docs only
  // have a synopsis), then to the whole PDF.
  const metadataRanges = [
    ...((toc.sections?.titlePage?.ranges) || []),
    ...((toc.sections?.studyDesign?.ranges) || [])
  ];
  let metadata = null;
  if (metadataRanges.length > 0) {
    emit('progress', { stage: 'metadata', message:
      `→ metadata — body pages ${metadataRanges.map(r => `${r.startPage}–${r.endPage}`).join(', ')}` });
    const sub = await splitter.sliceByRanges(pdfBuffer, metadataRanges);
    try {
      metadata = await callGemini({
        client, pdfBuffer: sub,
        prompt: prompts.metadataPrompt,
        responseSchema: prompts.metadataResponseSchema,
        meter, stage: 'metadata'
      });
      emit('progress', { stage: 'metadata', message: `✓ metadata — ${summarizeSection('synopsis', metadata)}` });
    } catch (err) {
      emit('warning', { stage: 'metadata', message: `body-source metadata failed: ${err.message} — trying synopsis` });
    }
  }
  if (!metadata) {
    metadata = await runSection({
      client, pdfBuffer, toc, sectionKey: 'synopsis',
      sectionLabel: 'metadata (synopsis fallback)',
      prompt: prompts.metadataPrompt,
      responseSchema: prompts.metadataResponseSchema,
      fallbackFullIfEmpty: true, emit, meter
    });
  }

  const objectives = await runSection({
    client, pdfBuffer, toc, sectionKey: 'objectives',
    prompt: prompts.objectivesPrompt,
    responseSchema: prompts.objectivesResponseSchema,
    fallbackFullIfEmpty: true, emit, meter
  });

  const eligibility = await runSection({
    client, pdfBuffer, toc, sectionKey: 'eligibility',
    prompt: prompts.eligibilityPrompt,
    responseSchema: prompts.eligibilityResponseSchema,
    fallbackFullIfEmpty: true, emit, meter
  });

  const arms = await runSection({
    client, pdfBuffer, toc, sectionKey: 'armsInterventions',
    prompt: prompts.armsPrompt,
    responseSchema: prompts.armsResponseSchema,
    fallbackFullIfEmpty: true, emit, meter
  });

  // SoA — uses both 'schedule' ranges (body + appendix merged automatically
  // by sliceByRanges). If no ranges found, Gemini scans the full PDF.
  // SoA uses compact format (performedAt arrays) → fewer output tokens.
  // maxOutputTokens 32768 handles large SoA grids (Flash supports 65536).
  const soa = await runSection({
    client, pdfBuffer, toc, sectionKey: 'schedule',
    prompt: prompts.soaPrompt,
    responseSchema: prompts.soaResponseSchema,
    fallbackFullIfEmpty: true, emit, meter,
    maxOutputTokens: 32768
  });

  // Estimands often not present — don't fall back to full PDF. Also
  // guard against the TOC over-matching "estimands" to the objectives
  // page: if the two ranges are identical, treat estimands as absent to
  // avoid false positives (every endpoint gets misclassified as estimand).
  let estimands = null;
  const estRanges = toc.sections?.estimands?.ranges || [];
  const objRanges = toc.sections?.objectives?.ranges || [];
  const rangesEqual = estRanges.length === objRanges.length &&
    estRanges.every((r, i) => r.startPage === objRanges[i]?.startPage && r.endPage === objRanges[i]?.endPage);
  if (estRanges.length === 0) {
    emit('progress', { stage: 'estimands', message: '✗ estimands — not found in TOC (skipped)' });
  } else if (rangesEqual) {
    emit('warning', { stage: 'estimands', message: 'estimands skipped — TOC range is identical to objectives (false-positive guard)' });
  } else {
    estimands = await runSection({
      client, pdfBuffer, toc, sectionKey: 'estimands',
      prompt: prompts.estimandsPrompt,
      responseSchema: prompts.estimandsResponseSchema,
      fallbackFullIfEmpty: false, emit, meter
    });
  }

  emit('progress', { stage: 'merge', message: 'Assembling USDM v4.0 envelope…' });
  const usdm = mergeIntoUsdm({ toc, metadata, objectives, eligibility, arms, soa, estimands, sourcePath });
  const usage = metering.summarize(meter);
  emit('progress', { stage: 'metering', message: `💰 Gemini usage — ${usage.calls} calls · ${usage.totalTokens.toLocaleString()} tokens · $${usage.costUsd.toFixed(4)}` });

  return { usdm, toc, usage };
}

module.exports = { extractUsdmFromPdf };
