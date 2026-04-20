// ──────────────────────────────────────────────────────────────────────
// USDM v4.0 validator:
//   1. Structural check via Ajv against ajvSchema.
//   2. Custom audits:
//      - Required fields beyond what the schema expresses
//      - Objective ↔ Endpoint integrity
//      - SoA grid completeness (every activity × encounter has an instance)
//      - Orphan footnotes (referenced but not defined, OR defined but never
//        referenced)
//      - CDISC CT code validity (codes must be from the allowed set)
//
// Returns:
//   { valid, errors, warnings, audit: {...summary}, score: 0-100 }
// ──────────────────────────────────────────────────────────────────────

const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { ajvSchema } = require('./usdm-schema');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const ajvValidate = ajv.compile(ajvSchema);

// Known CDISC CT codes we expect to appear in extracted USDM payloads.
const ALLOWED_CODES = new Set([
  // Study Type
  'C98388', 'C16084', 'C48660',
  // Phase
  'C54721', 'C15600', 'C15693', 'C15601', 'C15694', 'C15602', 'C15603',
  // Objective
  'C85826', 'C85827', 'C85828',
  // Endpoint
  'C94496', 'C94497', 'C188769',
  // Intervention Model
  'C82639', 'C82640', 'C82638', 'C15710', 'C82637',
  // Blinding
  'C15228', 'C15229', 'C15230', 'C28233', 'C28234',
  // Sex
  'C49636', 'C16576', 'C20197',
  // Study Title types
  'C207606', 'C207607',
  // Intervention role
  'C270837', 'C49648', 'C49631', 'C49647', 'C49650',
  // Org types
  'C70793', 'C93453', 'C188574'
]);

function auditCdiscCodes(usdm) {
  const warnings = [];
  const visit = (obj, path) => {
    if (!obj || typeof obj !== 'object') return;
    if (typeof obj.code === 'string' && obj.code !== '' && !ALLOWED_CODES.has(obj.code)) {
      warnings.push({
        path,
        message: `CDISC CT code '${obj.code}' is not in the known USDM v4.0 code set.`
      });
    }
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => visit(v, `${path}[${i}]`));
    } else {
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === 'object') visit(v, `${path}.${k}`);
      }
    }
  };
  visit(usdm, '$');
  return warnings;
}

function auditObjectivesAndEndpoints(usdm) {
  const warnings = [];
  const design = usdm?.study?.versions?.[0]?.studyDesigns?.[0];
  if (!design) return warnings;

  const objectives = design.objectives || [];
  if (objectives.length === 0) {
    warnings.push({
      path: '$.study.versions[0].studyDesigns[0].objectives',
      message: 'No objectives extracted — protocol objectives section may be missing or misidentified.'
    });
  }

  let primaryObjectiveCount = 0;
  let primaryEndpointCount = 0;

  for (const [i, o] of objectives.entries()) {
    const pathO = `$.studyDesigns[0].objectives[${i}]`;
    if (!o.level?.code) {
      warnings.push({ path: pathO, message: `Objective "${o.name || '(unnamed)'}" has no level code.` });
    }
    if (o.level?.code === 'C85826') primaryObjectiveCount++;
    if (!o.endpoints || o.endpoints.length === 0) {
      warnings.push({ path: pathO, message: `Objective "${o.name || '(unnamed)'}" has no endpoints — every objective should have at least one measurable endpoint.` });
    }
    for (const [j, e] of (o.endpoints || []).entries()) {
      const pathE = `${pathO}.endpoints[${j}]`;
      if (!e.level?.code) {
        warnings.push({ path: pathE, message: `Endpoint "${e.name || '(unnamed)'}" has no level code.` });
      }
      if (e.level?.code === 'C94496') primaryEndpointCount++;
    }
  }

  if (primaryObjectiveCount === 0 && objectives.length > 0) {
    warnings.push({ path: '$.objectives', message: 'No Primary Objective (C85826) identified — every protocol must have at least one.' });
  }
  if (primaryEndpointCount === 0 && objectives.length > 0) {
    warnings.push({ path: '$.objectives.endpoints', message: 'No Primary Endpoint (C94496) identified — extraction likely misclassified endpoint levels.' });
  }

  return warnings;
}

function auditSoaCompleteness(usdm) {
  const warnings = [];
  const audit = {
    timelineCount: 0,
    totalExpectedCells: 0,
    totalActualCells: 0,
    missingCells: 0,
    orphanFootnoteRefs: 0,
    unusedFootnoteDefs: 0
  };
  const timelines = usdm?.study?.versions?.[0]?.studyDesigns?.[0]?.scheduleTimelines || [];
  audit.timelineCount = timelines.length;

  if (timelines.length === 0) {
    warnings.push({ path: '$.scheduleTimelines', message: 'No schedule timelines extracted — SoA may be absent, in an appendix not detected, or require manual review.' });
    return { warnings, audit };
  }

  for (const [ti, tl] of timelines.entries()) {
    const path = `$.scheduleTimelines[${ti}]`;
    const activities = tl.activities || [];
    const encounters = tl.encounters || [];
    const instances  = tl.scheduledInstances || [];
    const footnotes  = tl.footnotes || [];

    const expected = activities.length * encounters.length;
    audit.totalExpectedCells += expected;
    audit.totalActualCells   += instances.length;
    audit.missingCells       += Math.max(0, expected - instances.length);

    if (expected > 0 && instances.length < expected) {
      const coverage = (instances.length / expected * 100).toFixed(1);
      warnings.push({
        path: `${path}.scheduledInstances`,
        message: `Incomplete grid: ${instances.length} of ${expected} cells present (${coverage}% coverage). ` +
                 `Burden/cost analysis requires full coverage.`
      });
    }

    // Referential integrity — activityId / encounterId must point to defined items.
    const activityIds = new Set(activities.map(a => a.id));
    const encounterIds = new Set(encounters.map(e => e.id));
    for (const [i, si] of instances.entries()) {
      if (!activityIds.has(si.activityId)) {
        warnings.push({ path: `${path}.scheduledInstances[${i}].activityId`, message: `References unknown activityId "${si.activityId}"` });
      }
      if (!encounterIds.has(si.encounterId)) {
        warnings.push({ path: `${path}.scheduledInstances[${i}].encounterId`, message: `References unknown encounterId "${si.encounterId}"` });
      }
    }

    // Footnote audit
    const footnoteIds = new Set(footnotes.map(f => f.id));
    const referencedFootnotes = new Set();

    const collectRefs = (arr, label) => {
      for (const item of (arr || [])) {
        for (const fid of (item.footnoteIds || [])) {
          referencedFootnotes.add(fid);
          if (!footnoteIds.has(fid)) {
            audit.orphanFootnoteRefs++;
            warnings.push({
              path: `${path}.${label}`,
              message: `Orphan footnote reference "${fid}" — no matching footnote definition.`
            });
          }
        }
      }
    };
    collectRefs(activities, 'activities');
    collectRefs(encounters, 'encounters');
    collectRefs(instances,  'scheduledInstances');

    for (const fn of footnotes) {
      if (!referencedFootnotes.has(fn.id)) {
        audit.unusedFootnoteDefs++;
        warnings.push({
          path: `${path}.footnotes`,
          message: `Defined footnote "${fn.symbol}" (id ${fn.id}) is never referenced — either spurious or extraction missed the reference.`
        });
      }
    }
  }

  return { warnings, audit };
}

function auditEligibility(usdm) {
  const warnings = [];
  const pop = usdm?.study?.versions?.[0]?.studyDesigns?.[0]?.populations?.[0];
  if (!pop) {
    warnings.push({ path: '$.populations', message: 'No study population extracted.' });
    return warnings;
  }
  if (!pop.includeCriteria?.length) warnings.push({ path: '$.populations[0].includeCriteria', message: 'No inclusion criteria extracted — likely missed.' });
  if (!pop.excludeCriteria?.length) warnings.push({ path: '$.populations[0].excludeCriteria', message: 'No exclusion criteria extracted — likely missed.' });
  if (!pop.minimumAge) warnings.push({ path: '$.populations[0].minimumAge', message: 'Minimum age not extracted.' });
  if (!pop.sex?.code)  warnings.push({ path: '$.populations[0].sex',         message: 'Sex eligibility not extracted.' });
  return warnings;
}

function auditRequiredCoreFields(usdm) {
  const warnings = [];
  const ver = usdm?.study?.versions?.[0];
  const design = ver?.studyDesigns?.[0];
  if (!ver?.studyIdentifiers?.length) warnings.push({ path: '$.studyVersion.studyIdentifiers', message: 'No study identifiers (e.g., NCT, sponsor ID) extracted.' });
  if (!ver?.titles?.length)          warnings.push({ path: '$.studyVersion.titles',           message: 'No study titles extracted.' });
  if (!design?.studyPhase?.code || design.studyPhase.code === 'C48660')
    warnings.push({ path: '$.studyDesign.studyPhase', message: 'Study phase not extracted or set to N/A — verify manually.' });
  if (!design?.arms?.length) warnings.push({ path: '$.studyDesign.arms', message: 'No study arms extracted.' });
  if (!design?.studyInterventions?.length) warnings.push({ path: '$.studyDesign.studyInterventions', message: 'No interventions extracted.' });
  return warnings;
}

// ──────────────────────────────────────────────────────────────────────
// Public
// ──────────────────────────────────────────────────────────────────────
function validateUsdm(usdm) {
  const errors = [];
  const warnings = [];
  const audit = {
    schemaValid: false,
    soa: null,
    cdiscCodeViolations: 0,
    missingFields: 0,
    orphanFootnotes: 0
  };

  const schemaValid = ajvValidate(usdm);
  audit.schemaValid = !!schemaValid;
  if (!schemaValid) {
    for (const e of (ajvValidate.errors || [])) {
      errors.push({
        path: e.instancePath || e.schemaPath,
        message: `${e.message}${e.params ? ' — ' + JSON.stringify(e.params) : ''}`
      });
    }
  }

  const cdiscW = auditCdiscCodes(usdm);
  warnings.push(...cdiscW);
  audit.cdiscCodeViolations = cdiscW.length;

  warnings.push(...auditRequiredCoreFields(usdm));
  warnings.push(...auditObjectivesAndEndpoints(usdm));
  warnings.push(...auditEligibility(usdm));

  const soaResult = auditSoaCompleteness(usdm);
  warnings.push(...soaResult.warnings);
  audit.soa = soaResult.audit;
  audit.orphanFootnotes = soaResult.audit.orphanFootnoteRefs;
  audit.missingFields = warnings.length - cdiscW.length;

  // Confidence score: deductive.
  //   - schema invalid      → -40
  //   - each error          → -3  (capped at -30)
  //   - each warning        → -0.5 (capped at -30)
  let score = 100;
  if (!schemaValid) score -= 40;
  score -= Math.min(30, errors.length * 3);
  score -= Math.min(30, warnings.length * 0.5);
  score = Math.max(0, Math.round(score));

  return {
    valid: errors.length === 0 && schemaValid,
    errors,
    warnings,
    audit,
    score
  };
}

module.exports = { validateUsdm };
