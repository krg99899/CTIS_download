// ──────────────────────────────────────────────────────────────────────
// CDISC USDM v4.0 schema — two flavors:
//   1. geminiSchema  → sent to Gemini as responseSchema (OpenAPI subset)
//   2. ajvSchema     → stricter JSON Schema used by Ajv for validation
//
// USDM v4.0 root:  Study > StudyVersion > StudyDesign > (objectives, arms,
// populations, scheduleTimelines, estimands, etc.)
// CDISC CT codes populated for Objective/Endpoint level, phase, study type.
// ──────────────────────────────────────────────────────────────────────

// Code-pair shape (CDISC Controlled Terminology code + decoded name)
const codeProperties = {
  code:       { type: 'string', description: 'CDISC C-code (e.g., C85826 for Primary Objective)' },
  decode:     { type: 'string', description: 'Human-readable decode of the C-code' },
  codeSystem: { type: 'string', description: 'Code system URI, usually http://www.cdisc.org' }
};

const objectiveSchema = {
  type: 'object',
  properties: {
    id:          { type: 'string' },
    instanceType:{ type: 'string', enum: ['Objective'] },
    name:        { type: 'string', description: 'Short objective name' },
    description: { type: 'string', description: 'Full objective text as stated in the protocol' },
    level: {
      type: 'object',
      properties: codeProperties,
      description: 'Primary (C85826) / Secondary (C85827) / Tertiary (C85828)'
    },
    endpoints: {
      type: 'array',
      description: 'Endpoints that measure this objective. Must be nested — do not flatten.',
      items: {
        type: 'object',
        properties: {
          id:          { type: 'string' },
          instanceType:{ type: 'string', enum: ['Endpoint'] },
          name:        { type: 'string' },
          description: { type: 'string' },
          purpose:     { type: 'string', description: 'Timing / analysis purpose' },
          level: {
            type: 'object',
            properties: codeProperties,
            description: 'Primary (C94496) / Secondary (C94497) / Exploratory (C188769)'
          }
        },
        required: ['name', 'description', 'level']
      }
    }
  },
  required: ['name', 'description', 'level', 'endpoints']
};

const estimandSchema = {
  type: 'object',
  description: 'ICH E9(R1) estimand. Null fields if not stated — never infer.',
  properties: {
    id:                 { type: 'string' },
    instanceType:       { type: 'string', enum: ['Estimand'] },
    summaryMeasure:     { type: 'string' },
    analysisPopulation: { type: 'string', description: 'Target population definition' },
    variable:           { type: 'string', description: 'Outcome variable' },
    treatmentGroup:     { type: 'string' },
    intercurrentEvents: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name:     { type: 'string' },
          strategy: { type: 'string', description: 'Treatment Policy / Hypothetical / Composite / While on Treatment / Principal Stratum' }
        },
        required: ['name', 'strategy']
      }
    }
  },
  required: ['summaryMeasure', 'analysisPopulation', 'variable', 'intercurrentEvents']
};

const criterionSchema = {
  type: 'object',
  properties: {
    id:          { type: 'string' },
    instanceType:{ type: 'string', enum: ['EligibilityCriterion'] },
    text:        { type: 'string' },
    category:    { type: 'string', enum: ['Inclusion', 'Exclusion'] }
  },
  required: ['text', 'category']
};

const armSchema = {
  type: 'object',
  properties: {
    id:          { type: 'string' },
    instanceType:{ type: 'string', enum: ['StudyArm'] },
    name:        { type: 'string' },
    description: { type: 'string' },
    type: {
      type: 'object',
      properties: codeProperties,
      description: 'Experimental / Active Comparator / Placebo Comparator / Sham Comparator / No Intervention / Other'
    },
    interventionNames: { type: 'array', items: { type: 'string' } }
  },
  required: ['name', 'description']
};

const interventionSchema = {
  type: 'object',
  properties: {
    id:          { type: 'string' },
    instanceType:{ type: 'string', enum: ['StudyIntervention'] },
    name:        { type: 'string' },
    description: { type: 'string' },
    role:        { anyOf: [{ type: 'object', properties: codeProperties }, { type: 'null' }] },
    route:       { type: 'string' },
    dosage:      { type: 'string' },
    frequency:   { type: 'string' }
  },
  required: ['name', 'description']
};

// ──────────────────────────────────────────────────────────────────────
// SoA — Schedule of Activities
// Encounters (visit columns) × Activities (assessment rows), plus the
// grid cells mapping which activity happens at which encounter, and
// footnotes referenced by symbol (*, †, ‡, a, b, 1, 2, …).
// ──────────────────────────────────────────────────────────────────────
const encounterSchema = {
  type: 'object',
  properties: {
    id:           { type: 'string' },
    instanceType: { type: 'string', enum: ['Encounter'] },
    name:         { type: 'string', description: 'Visit label, e.g. "Screening", "Visit 1", "Day 1"' },
    timing:       { type: 'string', description: 'Day/week label, e.g. "Day -28 to -1" or "Week 4"' },
    window:       { type: 'string', description: 'Visit window, e.g. "±3 days"' },
    footnoteIds:  { type: 'array', items: { type: 'string' } }
  },
  required: ['name', 'timing']
};

const activitySchema = {
  type: 'object',
  properties: {
    id:           { type: 'string' },
    instanceType: { type: 'string', enum: ['Activity'] },
    name:         { type: 'string', description: 'Assessment / procedure name as shown in SoA row' },
    category:     { type: 'string', description: 'Safety / Efficacy / PK / PD / Biomarker / Other (if stated)' },
    footnoteIds:  { type: 'array', items: { type: 'string' } }
  },
  required: ['name']
};

const scheduledInstanceSchema = {
  type: 'object',
  description: 'Single grid cell: activity X happens at encounter Y.',
  properties: {
    activityId:  { type: 'string' },
    encounterId: { type: 'string' },
    performed:   { type: 'boolean', description: 'True if a mark (X / ● / •) is present in the cell' },
    notes:       { type: 'string', description: 'Cell-level note (e.g. conditional assessment)' },
    footnoteIds: { type: 'array', items: { type: 'string' } }
  },
  required: ['activityId', 'encounterId', 'performed']
};

const footnoteSchema = {
  type: 'object',
  properties: {
    id:     { type: 'string' },
    symbol: { type: 'string', description: 'The marker as used in the table (e.g. "*", "†", "a", "1")' },
    text:   { type: 'string', description: 'Full footnote text from the footer block' }
  },
  required: ['symbol', 'text']
};

const scheduleTimelineSchema = {
  type: 'object',
  properties: {
    id:              { type: 'string' },
    instanceType:    { type: 'string', enum: ['ScheduleTimeline'] },
    name:            { type: 'string', description: 'Timeline label, e.g. "Main Study Schedule"' },
    mainTimeline:    { type: 'boolean' },
    encounters:      { type: 'array', items: encounterSchema },
    activities:      { type: 'array', items: activitySchema },
    scheduledInstances: { type: 'array', items: scheduledInstanceSchema },
    footnotes:       { type: 'array', items: footnoteSchema }
  },
  required: ['name', 'encounters', 'activities', 'scheduledInstances', 'footnotes']
};

// ──────────────────────────────────────────────────────────────────────
// StudyDesign
// ──────────────────────────────────────────────────────────────────────
const studyDesignSchema = {
  type: 'object',
  properties: {
    id:              { type: 'string' },
    instanceType:    { type: 'string', enum: ['StudyDesign'] },
    name:            { type: 'string' },
    label:           { type: 'string' },
    description:     { type: 'string', description: 'Protocol synopsis / design rationale paragraph' },
    studyType:       { type: 'object', properties: codeProperties, description: 'Interventional C98388 / Observational C16084' },
    studyPhase:      { type: 'object', properties: codeProperties, description: 'Phase 1 C15600 / 1-2 C15693 / 2 C15601 / 2-3 C15694 / 3 C15602 / 4 C15603 / NA C48660' },
    interventionModel:{ type: 'object', properties: codeProperties, description: 'Parallel / Crossover / Single Group / Factorial / Sequential' },
    blindingSchema:  { type: 'object', properties: codeProperties, description: 'Open Label / Single / Double / Triple / Quadruple Blind' },
    conditions:      { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name'] } },
    rationale:       { type: 'string' },
    studyInterventions:{ type: 'array', items: interventionSchema },
    arms:            { type: 'array', items: armSchema },
    objectives:      { type: 'array', items: objectiveSchema },
    estimands:       { type: 'array', items: estimandSchema },
    populations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id:           { type: 'string' },
          instanceType: { type: 'string', enum: ['StudyDesignPopulation'] },
          name:         { type: 'string' },
          description:  { type: 'string' },
          includeCriteria: { type: 'array', items: criterionSchema },
          excludeCriteria: { type: 'array', items: criterionSchema },
          plannedEnrollmentNumber: { type: 'integer' },
          sex:          { type: 'object', properties: codeProperties },
          minimumAge:   { type: 'string' },
          maximumAge:   { type: 'string' },
          healthySubjectIndicator: { type: 'boolean' }
        },
        required: ['name', 'includeCriteria', 'excludeCriteria']
      }
    },
    scheduleTimelines:  { type: 'array', items: scheduleTimelineSchema },
    biomedicalConcepts: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, code: { type: 'string' }, decode: { type: 'string' } }, required: ['name'] } }
  },
  required: ['name', 'studyType', 'studyPhase', 'objectives', 'populations']
};

// ──────────────────────────────────────────────────────────────────────
// Root schema for Gemini responseSchema
// ──────────────────────────────────────────────────────────────────────
const geminiSchema = {
  type: 'object',
  properties: {
    usdmVersion:  { type: 'string', description: 'Must be "4.0"' },
    systemName:   { type: 'string' },
    systemVersion:{ type: 'string' },
    sourceSystem: { type: 'string', description: 'Where the PDF came from (e.g. "ClinicalTrials.gov")' },
    extractedAt:  { type: 'string', description: 'ISO-8601 timestamp' },
    study: {
      type: 'object',
      properties: {
        id:           { type: 'string' },
        instanceType: { type: 'string', enum: ['Study'] },
        name:         { type: 'string', description: 'Brief title' },
        label:        { type: 'string' },
        description:  { type: 'string' },
        versions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id:                { type: 'string' },
              instanceType:      { type: 'string', enum: ['StudyVersion'] },
              versionIdentifier: { type: 'string', description: 'Protocol version, e.g. "2.0" or "Amendment 3"' },
              rationale:         { type: 'string' },
              studyType:         { type: 'object', properties: codeProperties },
              studyPhase:        { type: 'object', properties: codeProperties },
              studyIdentifiers: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    studyIdentifier: { type: 'string', description: 'ID value (e.g. NCT number or sponsor study number)' },
                    studyIdentifierScope: {
                      type: 'object',
                      properties: {
                        name: { type: 'string', description: 'Organization that issued the ID (e.g. "ClinicalTrials.gov", sponsor name)' },
                        organizationType: { type: 'object', properties: codeProperties }
                      }
                    }
                  },
                  required: ['studyIdentifier']
                }
              },
              titles: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'object', properties: codeProperties },
                    text: { type: 'string' }
                  },
                  required: ['type', 'text']
                }
              },
              dateValues: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name:      { type: 'string', description: 'e.g. "StartDate", "ProtocolEffectiveDate", "CompletionDate"' },
                    dateValue: { type: 'string', description: 'ISO-8601 date' }
                  },
                  required: ['name']
                }
              },
              organizations: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name:             { type: 'string' },
                    organizationType: { type: 'object', properties: codeProperties }
                  },
                  required: ['name']
                }
              },
              studyDesigns: { type: 'array', items: studyDesignSchema }
            },
            required: ['versionIdentifier', 'titles', 'studyDesigns', 'studyIdentifiers']
          }
        }
      },
      required: ['name', 'versions']
    }
  },
  required: ['usdmVersion', 'study']
};

// ──────────────────────────────────────────────────────────────────────
// Ajv schema — same shape but stricter (draft-07). Used for post-extraction validation.
// ──────────────────────────────────────────────────────────────────────
const ajvSchema = JSON.parse(JSON.stringify(geminiSchema));
ajvSchema.$schema = 'http://json-schema.org/draft-07/schema#';
ajvSchema.title   = 'CDISC USDM v4.0 Protocol Extraction';

module.exports = {
  geminiSchema,
  ajvSchema
};
