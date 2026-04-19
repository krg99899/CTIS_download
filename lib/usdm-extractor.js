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
// Returns parsed JSON — if Gemini returns invalid JSON, throws.
async function callGemini({ client, pdfBuffer, prompt, responseSchema, modelName = DEFAULT_MODEL }) {
  const contents = [
    {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'application/pdf',
            data: pdfBuffer.toString('base64')
          }
        },
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
      maxOutputTokens: 8192   // Gemini 2.5 Flash hard cap
    }
  });

  // Newer @google/genai SDK exposes .text as a getter, older builds as a method.
  let text = '';
  try {
    text = typeof response.text === 'function' ? response.text() : (response.text || '');
  } catch { text = ''; }
  if (!text || !text.trim()) {
    // Fallback: dig into the raw candidates structure.
    const parts = response?.candidates?.[0]?.content?.parts || [];
    text = parts.map(p => p.text || '').join('');
  }
  if (!text.trim()) throw new Error('Gemini returned empty response');

  try {
    return JSON.parse(text);
  } catch (err) {
    // Gemini sometimes wraps JSON in markdown fences; strip them.
    const cleaned = text
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    return JSON.parse(cleaned);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Pass 1 — TOC mapping
// ──────────────────────────────────────────────────────────────────────
async function extractTOC(client, pdfBuffer, emit) {
  const tocPdf = await splitter.sliceTocInput(pdfBuffer, 20, 15);
  emit('progress', { stage: 'toc', message: 'Analyzing table of contents…' });

  let toc;
  try {
    toc = await callGemini({
      client,
      pdfBuffer: tocPdf,
      prompt: prompts.tocPrompt,
      responseSchema: prompts.tocResponseSchema
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
async function runSection({ client, pdfBuffer, toc, sectionKey, sectionLabel, prompt, responseSchema, emit, fallbackFullIfEmpty = false }) {
  const section = toc.sections?.[sectionKey];
  const ranges = section?.ranges || [];
  const label = sectionLabel || sectionKey;

  let subPdf;
  if (ranges.length === 0) {
    if (!fallbackFullIfEmpty) {
      emit('progress', { stage: sectionKey, message: `✗ ${label} — not found in TOC (skipped)` });
      return null;
    }
    emit('progress', { stage: sectionKey, message: `⚠ ${label} — no TOC range, scanning full PDF` });
    subPdf = pdfBuffer;
  } else {
    const rangeLabel = ranges.map(r => `pp. ${r.startPage}–${r.endPage}${r.locationHint ? ` (${r.locationHint})` : ''}`).join(', ');
    emit('progress', { stage: sectionKey, message: `→ ${label} — ${rangeLabel}` });
    subPdf = await splitter.sliceByRanges(pdfBuffer, ranges);
    if (!subPdf) {
      emit('warning', { stage: sectionKey, message: `${label}: could not slice PDF` });
      return null;
    }
  }

  try {
    const result = await callGemini({ client, pdfBuffer: subPdf, prompt, responseSchema });
    // Summarize what we got back for this section:
    const summary = summarizeSection(sectionKey, result);
    emit('progress', { stage: sectionKey, message: `✓ ${label}${summary ? ' — ' + summary : ' done'}` });
    return result;
  } catch (err) {
    emit('warning', { stage: sectionKey, message: `${label} extraction failed: ${err.message}` });
    return null;
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
        const totalC = tls.reduce((s, t) => s + (t.scheduledInstances?.length || 0), 0);
        return `${tls.length} timeline(s) · ${totalA} activities × ${totalE} visits = ${totalC} cells`;
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
  if (m.nctId) {
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
  if (m.sponsorStudyId) {
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
    studyInterventions: (armsData.interventions || []).map(iv => ({
      id: uuid(),
      instanceType: 'StudyIntervention',
      name: iv.name || '',
      description: iv.description || '',
      role: null,
      route: iv.route || '',
      dosage: iv.dosage || '',
      frequency: iv.frequency || ''
    })),
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
      plannedEnrollmentNumber: elig.plannedEnrollmentNumber ?? m.plannedEnrollment ?? null,
      sex: codePair(elig.sexCode),
      minimumAge: elig.minimumAge || '',
      maximumAge: elig.maximumAge || '',
      healthySubjectIndicator: elig.healthyVolunteers ?? false
    }],
    scheduleTimelines: (soaData.scheduleTimelines || []).map(tl => ({
      id: uuid(),
      instanceType: 'ScheduleTimeline',
      name: tl.name || 'Study Schedule',
      mainTimeline: !!tl.mainTimeline,
      encounters: (tl.encounters || []).map(e => ({
        id: e.id, instanceType: 'Encounter',
        name: e.name || '', timing: e.timing || '',
        window: e.window || '', footnoteIds: e.footnoteIds || []
      })),
      activities: (tl.activities || []).map(a => ({
        id: a.id, instanceType: 'Activity',
        name: a.name || '', category: a.category || '',
        estimatedDurationMinutes: a.estimatedDurationMinutes ?? null,
        footnoteIds: a.footnoteIds || []
      })),
      scheduledInstances: (tl.scheduledInstances || []).map(si => ({
        activityId: si.activityId, encounterId: si.encounterId,
        performed: !!si.performed, notes: si.notes || '',
        footnoteIds: si.footnoteIds || []
      })),
      footnotes: (tl.footnotes || []).map(f => ({
        id: f.id, symbol: f.symbol || '', text: f.text || ''
      }))
    })),
    biomedicalConcepts: []
  };

  const titles = [];
  if (m.officialTitle) titles.push({ type: codePair(null, 'Official Study Title'), text: m.officialTitle });
  if (m.briefTitle)    titles.push({ type: codePair(null, 'Brief Study Title'),    text: m.briefTitle });

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

  emit('progress', { stage: 'init', message: 'Reading PDF…' });
  const totalPages = await splitter.getPageCount(pdfBuffer);
  emit('progress', { stage: 'init', message: `PDF has ${totalPages} pages.` });

  // Pass 1: TOC
  const toc = await extractTOC(client, pdfBuffer, emit);

  // Pass 2–6: Section extraction (run sequentially to respect free-tier rate limits;
  // switch to Promise.all once the user has paid-tier quotas).
  const metadata = await runSection({
    client, pdfBuffer, toc, sectionKey: 'synopsis',
    prompt: prompts.metadataPrompt,
    responseSchema: prompts.metadataResponseSchema,
    fallbackFullIfEmpty: true, emit
  });

  const objectives = await runSection({
    client, pdfBuffer, toc, sectionKey: 'objectives',
    prompt: prompts.objectivesPrompt,
    responseSchema: prompts.objectivesResponseSchema,
    fallbackFullIfEmpty: true, emit
  });

  const eligibility = await runSection({
    client, pdfBuffer, toc, sectionKey: 'eligibility',
    prompt: prompts.eligibilityPrompt,
    responseSchema: prompts.eligibilityResponseSchema,
    fallbackFullIfEmpty: true, emit
  });

  const arms = await runSection({
    client, pdfBuffer, toc, sectionKey: 'armsInterventions',
    prompt: prompts.armsPrompt,
    responseSchema: prompts.armsResponseSchema,
    fallbackFullIfEmpty: true, emit
  });

  // SoA — uses both 'schedule' ranges (body + appendix merged automatically
  // by sliceByRanges). If no ranges found, Gemini scans the full PDF.
  const soa = await runSection({
    client, pdfBuffer, toc, sectionKey: 'schedule',
    prompt: prompts.soaPrompt,
    responseSchema: prompts.soaResponseSchema,
    fallbackFullIfEmpty: true, emit
  });

  // Estimands often not present — don't fall back to full PDF (too much noise).
  const estimands = await runSection({
    client, pdfBuffer, toc, sectionKey: 'estimands',
    prompt: prompts.estimandsPrompt,
    responseSchema: prompts.estimandsResponseSchema,
    fallbackFullIfEmpty: false, emit
  });

  emit('progress', { stage: 'merge', message: 'Assembling USDM v4.0 envelope…' });
  const usdm = mergeIntoUsdm({ toc, metadata, objectives, eligibility, arms, soa, estimands, sourcePath });

  return { usdm, toc };
}

module.exports = { extractUsdmFromPdf };
