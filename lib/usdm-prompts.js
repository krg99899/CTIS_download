// ──────────────────────────────────────────────────────────────────────
// Section-specific extraction prompts for Gemini Flash.
// Each prompt is a surgical extractor — it receives only the relevant
// pages (identified via TOC) and returns a narrow JSON partial that
// gets merged into the final USDM v4.0 document.
//
// Design principles:
//   1. Tight instructions, CDISC CT codes baked in so Gemini doesn't
//      invent invalid codes.
//   2. Always allow nulls — "never infer data" rule from ICH E9(R1).
//   3. Each prompt matches the sub-schema used as responseSchema.
// ──────────────────────────────────────────────────────────────────────

const CT_CODES_REFERENCE = `
CDISC Controlled Terminology codes (USE EXACTLY THESE, do NOT invent):

Study Type:
  C98388 = Interventional Study
  C16084 = Observational Study
  C48660 = Expanded Access Study

Study Phase:
  C54721 = Early Phase 1
  C15600 = Phase 1
  C15693 = Phase 1/Phase 2
  C15601 = Phase 2
  C15694 = Phase 2/Phase 3
  C15602 = Phase 3
  C15603 = Phase 4
  C48660 = Not Applicable

Objective Level:
  C85826 = Primary Objective
  C85827 = Secondary Objective
  C85828 = Tertiary Objective

Endpoint Level:
  C94496  = Primary Endpoint
  C94497  = Secondary Endpoint
  C188769 = Exploratory Endpoint

Intervention Model:
  C82639 = Single Group Study
  C82640 = Parallel Study
  C82638 = Crossover Study
  C15710 = Factorial Study Design
  C82637 = Sequential Study

Blinding:
  C15228 = Open Label
  C15229 = Single Blind
  C15230 = Double Blind
  C28233 = Triple Blind
  C28234 = Quadruple Blind

Sex:
  C49636 = Both
  C16576 = Female
  C20197 = Male

Arm Type:
  C82638 = Experimental
  C82639 = Active Comparator
  C49631 = Placebo Comparator
  C49648 = Sham Comparator
  C102531 = No Intervention
`.trim();

// ──────────────────────────────────────────────────────────────────────
// TOC extraction prompt — runs on the first ~10-15 pages of the PDF.
// Returns page ranges (1-indexed) for each USDM-relevant section.
// ──────────────────────────────────────────────────────────────────────
const tocPrompt = `
You are given the Table of Contents (TOC) pages AND the end-of-document
pages (appendices / annexes) of a clinical trial protocol PDF.

Your job is to locate every USDM-relevant section and return ALL page
ranges where that section appears. A single section can appear in
multiple places — for example, a protocol may have a brief SoA in the
main body AND a detailed SoA in an appendix. You MUST return both.

Sections to locate (return empty "ranges" array if truly absent):
  1. titlePage              — Cover / title page with official title, brief title,
                              protocol number, version, protocol date, sponsor name.
                              Usually pages 1-3 (before TOC).
  2. synopsis               — Protocol Synopsis / Summary / Executive Summary
                              (FALLBACK only — prefer body sections below)
  3. objectives             — Objectives / Study Objectives / Aims and Endpoints
                              (BODY section — full detailed text, NOT synopsis row)
  4. studyDesign            — Study Design / Study Overview / Trial Design / Overall Design
                              (BODY section — the actual design chapter, typically
                              a dedicated section with detailed design rationale,
                              phase, intervention model, blinding, etc.)
  5. armsInterventions      — Treatment Arms / Study Treatment / Interventions / Dosing
                              (BODY section)
  6. eligibility            — Inclusion Criteria / Exclusion Criteria / Eligibility / Subject Selection
                              (BODY section with full numbered lists)
  7. schedule               — Schedule of Activities / Schedule of Assessments / Study Assessments / SoA
                              INCLUDES appendix tables, per-period schedules, PK sampling schedules,
                              PD sampling schedules, biomarker schedules. If ANY kind of schedule
                              table exists in an appendix, include it.
  8. estimands              — Estimands / Statistical Framework / ICH E9(R1)
  9. statisticalAnalysis    — Statistical Analysis / Statistical Considerations

CRITICAL: "synopsis" and body sections are DIFFERENT. The synopsis is a 2-5
page summary table that condenses everything; body sections contain the
authoritative detail. When a protocol has BOTH a synopsis and a body
objectives chapter, return both but prioritize the BODY section in its
field — ignore the synopsis row for "objectives". Only return synopsis
page range for the synopsis field.

Return 1-indexed page ranges. If a section spans multiple TOC entries,
merge into one range only when the entries are contiguous. If not
contiguous, return multiple ranges.

Rules:
  - Do NOT invent page numbers. Return an empty ranges array if uncertain.
  - For the "schedule" section especially — look HARD in the appendices.
    Common appendix titles: "Appendix A - Schedule of Assessments",
    "Annex 1", "Appendix 1 - SoA", "Study Assessments (Appendix)", etc.
  - If the TOC gives chapter ranges but not page numbers, infer the end
    page as the start page of the next section minus 1.
  - Flag tocFound = false if no formal TOC exists; you can still return
    your best-guess ranges from visible headers.
`.trim();

// A single section returns an array of ranges so SoA in body + appendix
// (or multi-cohort / multi-period schedules) can all be captured.
const rangeArraySchema = {
  type: 'object',
  properties: {
    ranges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          startPage: { type: 'integer' },
          endPage:   { type: 'integer' },
          locationHint: { type: 'string', description: 'e.g. "Main body", "Appendix A", "Annex 2"' }
        },
        required: ['startPage', 'endPage']
      }
    }
  },
  required: ['ranges']
};

const tocResponseSchema = {
  type: 'object',
  properties: {
    tocFound:   { type: 'boolean' },
    totalPages: { type: 'integer' },
    sections: {
      type: 'object',
      properties: {
        titlePage:           rangeArraySchema,
        synopsis:            rangeArraySchema,
        objectives:          rangeArraySchema,
        studyDesign:         rangeArraySchema,
        armsInterventions:   rangeArraySchema,
        eligibility:         rangeArraySchema,
        schedule:            rangeArraySchema,
        estimands:           rangeArraySchema,
        statisticalAnalysis: rangeArraySchema
      }
    }
  },
  required: ['tocFound', 'sections']
};

// ──────────────────────────────────────────────────────────────────────
// Metadata / Identification — runs on synopsis pages.
// ──────────────────────────────────────────────────────────────────────
const metadataPrompt = `
Extract protocol identification metadata from the provided pages.
The pages are drawn from the BODY of the protocol — specifically the
title/cover page and the Study Design chapter — NOT the synopsis.
If you see a row of data that appears to come from a synopsis summary
table, treat it as secondary — prefer the values stated in the cover
page and the full study design body text.

${CT_CODES_REFERENCE}

Extract:
  - briefTitle  → Short title
  - officialTitle → Full official title
  - protocolVersion  → "Version 2.0", "Amendment 3", etc.
  - protocolDate  → ISO-8601 if possible, otherwise the string as written
  - nctId  → NCT number if present
  - sponsorStudyId  → Sponsor's internal protocol ID
  - sponsorName  → Lead sponsor organization
  - collaborators → Array of collaborator names
  - conditions  → Array of conditions / indications
  - studyTypeCode   → The C-code for study type
  - studyPhaseCode  → The C-code for phase
  - interventionModelCode  → The C-code for intervention model (if stated)
  - blindingCode  → The C-code for blinding (if stated)
  - plannedEnrollment  → integer
  - briefSummary  → Short description
  - detailedDescription  → Longer description if available

Return null for any field not explicitly stated. Do NOT infer.
`.trim();

const metadataResponseSchema = {
  type: 'object',
  properties: {
    briefTitle:          { type: 'string' },
    officialTitle:       { type: 'string' },
    protocolVersion:     { type: 'string' },
    protocolDate:        { type: 'string' },
    nctId:               { type: 'string' },
    sponsorStudyId:      { type: 'string' },
    sponsorName:         { type: 'string' },
    collaborators:       { type: 'array', items: { type: 'string' } },
    conditions:          { type: 'array', items: { type: 'string' } },
    studyTypeCode:       { type: 'string' },
    studyPhaseCode:      { type: 'string' },
    interventionModelCode:{ type: 'string' },
    blindingCode:        { type: 'string' },
    plannedEnrollment:   { type: 'integer' },
    briefSummary:        { type: 'string' },
    detailedDescription: { type: 'string' }
  }
};

// ──────────────────────────────────────────────────────────────────────
// Objectives & Endpoints — preserves parent-child hierarchy.
// ──────────────────────────────────────────────────────────────────────
const objectivesPrompt = `
Extract the clinical trial objectives and their endpoints from the
provided pages. Preserve the parent-child structure: each objective
must contain its measuring endpoints nested inside it.

${CT_CODES_REFERENCE}

Rules:
  - Classify each objective as Primary (C85826), Secondary (C85827), or Tertiary/Exploratory (C85828) based on the section header.
  - Classify each endpoint as Primary (C94496), Secondary (C94497), or Exploratory (C188769).
  - An endpoint's level should match its parent objective's level when the protocol doesn't explicitly separate them.
  - Include the full objective text in "description".
  - Put timing/analysis info (e.g., "at Week 24") into the endpoint's "purpose" field.
  - Do NOT invent objectives — only extract what is explicitly listed.
  - Do NOT flatten endpoints — keep them nested under their objective.
`.trim();

const objectivesResponseSchema = {
  type: 'object',
  properties: {
    objectives: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          level: { type: 'object', properties: { code: { type: 'string' }, decode: { type: 'string' } } },
          endpoints: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                purpose: { type: 'string' },
                level: { type: 'object', properties: { code: { type: 'string' }, decode: { type: 'string' } } }
              },
              required: ['name', 'description', 'level']
            }
          }
        },
        required: ['name', 'description', 'level', 'endpoints']
      }
    }
  },
  required: ['objectives']
};

// ──────────────────────────────────────────────────────────────────────
// Eligibility — inclusion/exclusion as discrete criteria.
// ──────────────────────────────────────────────────────────────────────
const eligibilityPrompt = `
Extract eligibility criteria from the provided pages. Split them into
two arrays: inclusion and exclusion. Each criterion must be a separate
entry — if the protocol uses numbered lists, split on the numbering.

${CT_CODES_REFERENCE}

Extract:
  - inclusion[]  → array of criterion text strings
  - exclusion[]  → array of criterion text strings
  - minimumAge   → e.g. "18 Years"
  - maximumAge   → e.g. "75 Years" or "N/A"
  - sexCode      → C49636 (Both), C16576 (Female), C20197 (Male)
  - healthyVolunteers → boolean
  - plannedEnrollmentNumber → integer if stated

Rules:
  - Do NOT merge multiple criteria into one entry.
  - Preserve numbered list ordering.
  - If a criterion spans multiple lines, join them into one string.
`.trim();

const eligibilityResponseSchema = {
  type: 'object',
  properties: {
    inclusion:               { type: 'array', items: { type: 'string' } },
    exclusion:               { type: 'array', items: { type: 'string' } },
    minimumAge:              { type: 'string' },
    maximumAge:              { type: 'string' },
    sexCode:                 { type: 'string' },
    healthyVolunteers:       { type: 'boolean' },
    plannedEnrollmentNumber: { type: 'integer' }
  },
  required: ['inclusion', 'exclusion']
};

// ──────────────────────────────────────────────────────────────────────
// Arms & Interventions
// ──────────────────────────────────────────────────────────────────────
const armsPrompt = `
Extract study arms and interventions from the provided pages.

${CT_CODES_REFERENCE}

For each ARM:
  - name (e.g., "Treatment", "Placebo")
  - description
  - type (Experimental / Active Comparator / Placebo Comparator / Sham Comparator / No Intervention)
  - interventionNames (array)

For each INTERVENTION:
  - name (drug / biologic / device name)
  - description
  - roleCode: one of C270837 (Investigational Product), C49648 (Comparator),
              C49631 (Placebo), C49647 (Background Medication),
              C49650 (Rescue Medication) — use null if not determinable
  - route (e.g., "Oral", "IV", "SC")
  - dosage (e.g., "100 mg")
  - frequency (e.g., "Once daily", "Q4W")

Rules:
  - Map each intervention to all arms that receive it.
  - Do NOT invent doses or routes — use null if not stated.
`.trim();

const armsResponseSchema = {
  type: 'object',
  properties: {
    arms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name:        { type: 'string' },
          description: { type: 'string' },
          type:        { type: 'string', description: 'Plain-text type: Experimental / Active Comparator / Placebo Comparator / Sham Comparator / No Intervention' },
          interventionNames: { type: 'array', items: { type: 'string' } }
        },
        required: ['name', 'description']
      }
    },
    interventions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name:        { type: 'string' },
          description: { type: 'string' },
          roleCode:    { type: 'string' },
          roleDecode:  { type: 'string' },
          route:       { type: 'string' },
          dosage:      { type: 'string' },
          frequency:   { type: 'string' }
        },
        required: ['name']
      }
    }
  },
  required: ['arms', 'interventions']
};

// ──────────────────────────────────────────────────────────────────────
// SoA + Footnotes — the hardest one. Uses vision implicitly because
// Gemini Flash handles PDF pages natively (both text and image).
// Footnotes MUST be linked to the cells/activities/encounters that
// reference them by symbol.
// ──────────────────────────────────────────────────────────────────────
const soaPrompt = `
You are extracting the Schedule of Activities (SoA) from a clinical trial
protocol. The input may contain MULTIPLE schedule tables (main body, appendix
PK schedule, per-period schedule, follow-up schedule, etc.).

Return one ScheduleTimeline per distinct schedule grid. Set mainTimeline=true
for the most comprehensive one.

COMPACT FORMAT — this is critical for output size:
  • List ENCOUNTERS (visit columns) as an array with id, name, timing, window.
    Assign ids "enc-1", "enc-2", etc. in left-to-right order.
  • List ACTIVITIES (assessment rows) with id, name, category, and TWO arrays:
      - performedAt: encounter ids where the cell is marked (X / ● / ✓ / •)
      - performedAtWithNotes: objects {encounterId, notes} for cells that have
        additional info (conditional frequency, footnote symbols)
    DO NOT include encounter ids in both arrays — pick one.
    Cells not listed anywhere are implicitly performed=false.
  • List FOOTNOTES: id (fn-1, fn-2...), symbol, text.
    In activities, put footnote ids under activityFootnoteIds.
    In encounters, put footnote ids under encounterFootnoteIds.

GRID PARSING RULES:
  - Blank cells → omit from performedAt.
  - X / ● / ✓ / • with NO footnote/condition → add encounterId to performedAt.
  - X / ● with footnote symbol → add to performedAtWithNotes: {encounterId, notes: "fn-1"}.
  - Cell has frequency/condition text (e.g. "q4w", "×3", "if needed") →
    add to performedAtWithNotes: {encounterId, notes: "text or fn-id"}.
  - Read visually — do NOT extract surrounding body text.
  - Preserve top-to-bottom activity order and left-to-right encounter order.

Activity categories: Safety / Efficacy / PK / PD / Biomarker /
  Pharmacogenomics / Imaging / Procedure / Consent / Administrative / Other.
estimatedDurationMinutes: integer ONLY if explicitly stated; otherwise omit.
`.trim();

// Compact SoA schema — Gemini returns activities with performedAt lists
// rather than an N×M scheduledInstances array. The assembler expands
// this into scheduledInstances. This keeps output tokens ~10x smaller.
const soaResponseSchema = {
  type: 'object',
  properties: {
    scheduleTimelines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name:         { type: 'string' },
          mainTimeline: { type: 'boolean' },
          encounters: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id:                  { type: 'string' },
                name:                { type: 'string' },
                timing:              { type: 'string' },
                window:              { type: 'string' },
                encounterFootnoteIds:{ type: 'array', items: { type: 'string' } }
              },
              required: ['id', 'name', 'timing']
            }
          },
          activities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id:                      { type: 'string' },
                name:                    { type: 'string' },
                category:                { type: 'string' },
                estimatedDurationMinutes:{ type: 'integer' },
                performedAt:             { type: 'array', items: { type: 'string' } },
                performedAtWithNotes: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      encounterId: { type: 'string' },
                      notes:       { type: 'string' }
                    },
                    required: ['encounterId']
                  }
                },
                activityFootnoteIds: { type: 'array', items: { type: 'string' } }
              },
              required: ['id', 'name']
            }
          },
          footnotes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id:     { type: 'string' },
                symbol: { type: 'string' },
                text:   { type: 'string' }
              },
              required: ['id', 'symbol', 'text']
            }
          }
        },
        required: ['name', 'encounters', 'activities', 'footnotes']
      }
    }
  },
  required: ['scheduleTimelines']
};

// ──────────────────────────────────────────────────────────────────────
// Estimands (ICH E9 R1) — optional, often absent in older protocols.
// ──────────────────────────────────────────────────────────────────────
const estimandsPrompt = `
Extract ICH E9(R1) estimand frameworks from the provided pages. These
are usually in a dedicated "Estimands" section or embedded in the SAP.

For each estimand, extract:
  - summaryMeasure        → The statistical measure (e.g. "difference in mean change at Week 24")
  - analysisPopulation    → Target population definition
  - variable              → Outcome variable
  - treatmentGroup        → Treatment condition
  - intercurrentEvents[]  → Array of:
      - name     → e.g. "Treatment discontinuation due to AE"
      - strategy → Treatment Policy / Hypothetical / Composite / While on Treatment / Principal Stratum

Rules:
  - Never infer missing fields. Return null.
  - If no estimand framework is stated, return an empty array.
  - Do NOT generate estimands from generic statistical analysis text.
`.trim();

const estimandsResponseSchema = {
  type: 'object',
  properties: {
    estimands: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          summaryMeasure:     { type: 'string' },
          analysisPopulation: { type: 'string' },
          variable:           { type: 'string' },
          treatmentGroup:     { type: 'string' },
          intercurrentEvents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name:     { type: 'string' },
                strategy: { type: 'string' }
              },
              required: ['name', 'strategy']
            }
          }
        },
        required: ['summaryMeasure', 'analysisPopulation', 'variable', 'intercurrentEvents']
      }
    }
  },
  required: ['estimands']
};

module.exports = {
  tocPrompt,                   tocResponseSchema,
  metadataPrompt,              metadataResponseSchema,
  objectivesPrompt,            objectivesResponseSchema,
  eligibilityPrompt,           eligibilityResponseSchema,
  armsPrompt,                  armsResponseSchema,
  soaPrompt,                   soaResponseSchema,
  estimandsPrompt,             estimandsResponseSchema
};
