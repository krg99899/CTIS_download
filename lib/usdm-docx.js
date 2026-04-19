// ──────────────────────────────────────────────────────────────────────
// USDM v4.0 JSON → DOCX (Word) generator.
//
// Layout:
//   1. Title page (briefTitle, officialTitle, NCT, sponsor, phase, date)
//   2. Study Synopsis (conditions, enrollment, design)
//   3. Objectives & Endpoints  (header per objective, bullets per endpoint)
//   4. Study Arms & Interventions
//   5. Eligibility (inclusion / exclusion numbered lists)
//   6. Schedule of Activities  (one table per timeline, with footnotes)
//   7. Estimands (if present)
//   8. Extraction meta (TOC ranges used, source system)
//
// Uses `docx` npm package. Returns a Buffer.
// ──────────────────────────────────────────────────────────────────────

const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, AlignmentType, WidthType,
  BorderStyle, ShadingType
} = require('docx');

function decodeOf(codeObj) {
  if (!codeObj) return '';
  return codeObj.decode || codeObj.code || '';
}

function p(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text: text || '', ...opts })],
    spacing: { after: 120 }
  });
}

function heading(text, level) {
  return new Paragraph({ text, heading: level, spacing: { before: 240, after: 120 } });
}

function bullet(text, indent = 0) {
  return new Paragraph({
    children: [new TextRun({ text: text || '' })],
    bullet: { level: indent },
    spacing: { after: 60 }
  });
}

function kvRow(label, value) {
  return new TableRow({
    children: [
      new TableCell({
        width: { size: 35, type: WidthType.PERCENTAGE },
        shading: { type: ShadingType.CLEAR, fill: 'EEF2F7' },
        children: [p(label, { bold: true })]
      }),
      new TableCell({
        width: { size: 65, type: WidthType.PERCENTAGE },
        children: [p(value || '—')]
      })
    ]
  });
}

function kvTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(([k, v]) => kvRow(k, v))
  });
}

function buildTitlePage(usdm) {
  const ver = usdm?.study?.versions?.[0];
  const design = ver?.studyDesigns?.[0];
  const nct = ver?.studyIdentifiers?.find(s => s.studyIdentifierScope?.name === 'ClinicalTrials.gov')?.studyIdentifier || '—';
  const sponsorId = ver?.studyIdentifiers?.find(s => s.studyIdentifierScope?.organizationType?.code === 'C70793')?.studyIdentifier;
  const sponsor = ver?.organizations?.find(o => o.organizationType?.code === 'C70793')?.name;
  const date = ver?.dateValues?.find(d => d.name === 'ProtocolEffectiveDate')?.dateValue || '';

  const titleText = usdm?.study?.name || ver?.titles?.find(t => decodeOf(t.type).includes('Brief'))?.text || 'Study';
  const officialTitle = ver?.titles?.find(t => decodeOf(t.type).includes('Official'))?.text || '';

  return [
    new Paragraph({
      children: [new TextRun({ text: titleText, bold: true, size: 36 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 }
    }),
    officialTitle ? new Paragraph({
      children: [new TextRun({ text: officialTitle, italics: true, size: 24 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 }
    }) : null,
    kvTable([
      ['NCT Number',       nct],
      ['Sponsor Study ID', sponsorId || '—'],
      ['Sponsor',          sponsor || '—'],
      ['Study Type',       decodeOf(design?.studyType) || '—'],
      ['Phase',            decodeOf(design?.studyPhase) || '—'],
      ['Intervention Model', decodeOf(design?.interventionModel) || '—'],
      ['Blinding',         decodeOf(design?.blindingSchema) || '—'],
      ['Protocol Version', ver?.versionIdentifier || '—'],
      ['Protocol Date',    date || '—']
    ]),
    new Paragraph({ text: '', pageBreakBefore: true })
  ].filter(Boolean);
}

function buildSynopsis(usdm) {
  const design = usdm?.study?.versions?.[0]?.studyDesigns?.[0];
  const pop = design?.populations?.[0];
  const conditions = (design?.conditions || []).map(c => c.name).filter(Boolean);
  const nodes = [heading('1. Study Synopsis', HeadingLevel.HEADING_1)];
  if (usdm?.study?.description) nodes.push(p(usdm.study.description));
  nodes.push(kvTable([
    ['Conditions',       conditions.join('; ') || '—'],
    ['Planned Enrollment', pop?.plannedEnrollmentNumber != null ? String(pop.plannedEnrollmentNumber) : '—'],
    ['Sex',              decodeOf(pop?.sex) || '—'],
    ['Min Age',          pop?.minimumAge || '—'],
    ['Max Age',          pop?.maximumAge || '—'],
    ['Healthy Volunteers', pop?.healthySubjectIndicator ? 'Yes' : 'No']
  ]));
  return nodes;
}

function buildObjectives(usdm) {
  const objectives = usdm?.study?.versions?.[0]?.studyDesigns?.[0]?.objectives || [];
  const nodes = [heading('2. Objectives & Endpoints', HeadingLevel.HEADING_1)];
  if (objectives.length === 0) {
    nodes.push(p('No objectives extracted.'));
    return nodes;
  }
  for (const [i, o] of objectives.entries()) {
    nodes.push(heading(`${i + 1}. ${decodeOf(o.level) || 'Objective'}: ${o.name || '(unnamed)'}`, HeadingLevel.HEADING_2));
    if (o.description && o.description !== o.name) nodes.push(p(o.description));
    if (o.endpoints?.length) {
      nodes.push(p('Endpoints:', { bold: true }));
      for (const e of o.endpoints) {
        const tag = decodeOf(e.level) || 'Endpoint';
        const purpose = e.purpose ? ` — ${e.purpose}` : '';
        nodes.push(bullet(`[${tag}] ${e.name}${purpose}`));
        if (e.description && e.description !== e.name) nodes.push(bullet(e.description, 1));
      }
    }
  }
  return nodes;
}

function buildArmsInterventions(usdm) {
  const design = usdm?.study?.versions?.[0]?.studyDesigns?.[0];
  const arms = design?.arms || [];
  const iv = design?.studyInterventions || [];
  const nodes = [heading('3. Study Arms & Interventions', HeadingLevel.HEADING_1)];

  if (arms.length > 0) {
    nodes.push(heading('Arms', HeadingLevel.HEADING_2));
    for (const a of arms) {
      nodes.push(p(`${a.name}${a.type ? ` (${decodeOf(a.type)})` : ''}`, { bold: true }));
      if (a.description) nodes.push(p(a.description));
      if (a.interventionNames?.length) nodes.push(p(`Interventions: ${a.interventionNames.join(', ')}`, { italics: true }));
    }
  }

  if (iv.length > 0) {
    nodes.push(heading('Interventions', HeadingLevel.HEADING_2));
    for (const x of iv) {
      nodes.push(p(x.name, { bold: true }));
      nodes.push(kvTable([
        ['Route',     x.route || '—'],
        ['Dosage',    x.dosage || '—'],
        ['Frequency', x.frequency || '—'],
        ['Description', x.description || '—']
      ]));
    }
  }

  if (arms.length === 0 && iv.length === 0) nodes.push(p('No arms or interventions extracted.'));
  return nodes;
}

function buildEligibility(usdm) {
  const pop = usdm?.study?.versions?.[0]?.studyDesigns?.[0]?.populations?.[0];
  const nodes = [heading('4. Eligibility Criteria', HeadingLevel.HEADING_1)];
  if (!pop) { nodes.push(p('No eligibility extracted.')); return nodes; }

  nodes.push(heading('Inclusion Criteria', HeadingLevel.HEADING_2));
  if (pop.includeCriteria?.length) {
    pop.includeCriteria.forEach((c, i) => nodes.push(bullet(`${i + 1}. ${c.text || ''}`)));
  } else nodes.push(p('None extracted.'));

  nodes.push(heading('Exclusion Criteria', HeadingLevel.HEADING_2));
  if (pop.excludeCriteria?.length) {
    pop.excludeCriteria.forEach((c, i) => nodes.push(bullet(`${i + 1}. ${c.text || ''}`)));
  } else nodes.push(p('None extracted.'));

  return nodes;
}

// SoA table — one Word table per timeline. Rows = activities, columns = encounters.
// Cell value = "✓" if performed, empty otherwise; footnote markers appended.
function buildSoaTable(timeline, footnoteSymbolById) {
  const encounters = timeline.encounters || [];
  const activities = timeline.activities || [];
  const instances  = timeline.scheduledInstances || [];

  const cellMap = new Map(); // `${activityId}|${encounterId}` → { performed, footnoteIds, notes }
  for (const si of instances) {
    cellMap.set(`${si.activityId}|${si.encounterId}`, si);
  }

  // Header row
  const headerCells = [
    new TableCell({
      width: { size: 25, type: WidthType.PERCENTAGE },
      shading: { type: ShadingType.CLEAR, fill: '4A5A6B' },
      children: [new Paragraph({ children: [new TextRun({ text: 'Activity', bold: true, color: 'FFFFFF' })] })]
    }),
    ...encounters.map(e => {
      const label = `${e.name}${e.timing ? `\n${e.timing}` : ''}${e.window ? ` (${e.window})` : ''}`;
      const fnMarkers = (e.footnoteIds || []).map(id => footnoteSymbolById[id] || '').filter(Boolean).join('');
      return new TableCell({
        shading: { type: ShadingType.CLEAR, fill: '4A5A6B' },
        children: [new Paragraph({ children: [new TextRun({ text: label + (fnMarkers ? ` ${fnMarkers}` : ''), bold: true, color: 'FFFFFF', size: 18 })] })]
      });
    })
  ];

  const dataRows = activities.map(a => {
    const fnMarkers = (a.footnoteIds || []).map(id => footnoteSymbolById[id] || '').filter(Boolean).join('');
    const cells = [
      new TableCell({
        shading: { type: ShadingType.CLEAR, fill: 'F4F6F8' },
        children: [new Paragraph({ children: [new TextRun({ text: `${a.name}${fnMarkers ? ` ${fnMarkers}` : ''}`, bold: true, size: 18 })] })]
      }),
      ...encounters.map(e => {
        const si = cellMap.get(`${a.id}|${e.id}`);
        if (!si || !si.performed) {
          return new TableCell({ children: [new Paragraph({ text: '' })] });
        }
        const cellFns = (si.footnoteIds || []).map(id => footnoteSymbolById[id] || '').filter(Boolean).join('');
        const mark = si.notes ? si.notes : '✓';
        return new TableCell({
          children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: mark + (cellFns ? ` ${cellFns}` : ''), size: 18 })] })]
        });
      })
    ];
    return new TableRow({ children: cells });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: headerCells, tableHeader: true }), ...dataRows]
  });
}

function buildSoaSection(usdm) {
  const timelines = usdm?.study?.versions?.[0]?.studyDesigns?.[0]?.scheduleTimelines || [];
  const nodes = [heading('5. Schedule of Activities', HeadingLevel.HEADING_1)];
  if (timelines.length === 0) { nodes.push(p('No schedule of activities extracted.')); return nodes; }

  for (const [ti, tl] of timelines.entries()) {
    nodes.push(heading(`${5}.${ti + 1} ${tl.name || `Timeline ${ti + 1}`}${tl.mainTimeline ? ' (Main)' : ''}`, HeadingLevel.HEADING_2));

    const footnoteSymbolById = {};
    for (const fn of (tl.footnotes || [])) footnoteSymbolById[fn.id] = fn.symbol;

    nodes.push(buildSoaTable(tl, footnoteSymbolById));

    if ((tl.footnotes || []).length > 0) {
      nodes.push(p('Footnotes:', { bold: true }));
      for (const fn of tl.footnotes) {
        nodes.push(bullet(`${fn.symbol}  ${fn.text}`));
      }
    }

    // Coverage summary (for burden / cost downstream)
    const expected = (tl.activities?.length || 0) * (tl.encounters?.length || 0);
    const actual = tl.scheduledInstances?.length || 0;
    const performed = (tl.scheduledInstances || []).filter(s => s.performed).length;
    nodes.push(p(`Grid coverage: ${actual} of ${expected} cells (${expected ? ((actual / expected) * 100).toFixed(1) : 0}%) · Performed cells: ${performed}`, { italics: true, size: 18 }));
  }
  return nodes;
}

function buildEstimands(usdm) {
  const ests = usdm?.study?.versions?.[0]?.studyDesigns?.[0]?.estimands || [];
  if (ests.length === 0) return [];
  const nodes = [heading('6. Estimands (ICH E9 R1)', HeadingLevel.HEADING_1)];
  for (const [i, e] of ests.entries()) {
    nodes.push(heading(`Estimand ${i + 1}`, HeadingLevel.HEADING_2));
    nodes.push(kvTable([
      ['Summary Measure',      e.summaryMeasure || '—'],
      ['Analysis Population',  e.analysisPopulation || '—'],
      ['Variable',             e.variable || '—'],
      ['Treatment Group',      e.treatmentGroup || '—']
    ]));
    if (e.intercurrentEvents?.length) {
      nodes.push(p('Intercurrent Events:', { bold: true }));
      for (const ie of e.intercurrentEvents) {
        nodes.push(bullet(`${ie.name} — strategy: ${ie.strategy}`));
      }
    }
  }
  return nodes;
}

function buildMetaSection(usdm) {
  const meta = usdm?.extractionMeta;
  if (!meta) return [];
  const nodes = [heading('Extraction Metadata', HeadingLevel.HEADING_1)];
  nodes.push(kvTable([
    ['USDM Version',     usdm.usdmVersion || '—'],
    ['Source System',    usdm.sourceSystem || '—'],
    ['Extracted At',     usdm.extractedAt || '—'],
    ['Total Pages',      String(meta.totalPages || '—')],
    ['TOC Found',        meta.tocFound ? 'Yes' : 'No']
  ]));
  if (meta.sectionsExtracted?.length) {
    nodes.push(p('Sections extracted (from TOC):', { bold: true }));
    for (const s of meta.sectionsExtracted) {
      nodes.push(bullet(`${s.section} — pages ${s.ranges.map(r => `${r.startPage}-${r.endPage}`).join(', ')}`));
    }
  }
  return nodes;
}

async function usdmToDocx(usdm) {
  const children = [
    ...buildTitlePage(usdm),
    ...buildSynopsis(usdm),
    ...buildObjectives(usdm),
    ...buildArmsInterventions(usdm),
    ...buildEligibility(usdm),
    ...buildSoaSection(usdm),
    ...buildEstimands(usdm),
    ...buildMetaSection(usdm)
  ];

  const doc = new Document({
    creator: 'CTIS USDM Extractor',
    title: usdm?.study?.name || 'USDM Protocol',
    styles: {
      default: {
        document: { run: { size: 22 } }
      }
    },
    sections: [{ children }]
  });

  return Packer.toBuffer(doc);
}

module.exports = { usdmToDocx };
