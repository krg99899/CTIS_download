// ──────────────────────────────────────────────────────────────────────
// PDF utilities — page count, page-range extraction, text-per-page.
// Used by the TOC-guided extractor to slice a protocol into the
// specific page ranges that contain each USDM-relevant section.
// ──────────────────────────────────────────────────────────────────────

const { PDFDocument } = require('pdf-lib');
const pdfParse = require('pdf-parse');

// Clamp a page range to the actual bounds of the PDF.
function clampRange(range, totalPages) {
  if (!range || typeof range.startPage !== 'number') return null;
  const start = Math.max(1, Math.min(range.startPage, totalPages));
  const end   = range.endPage && range.endPage > 0
    ? Math.max(start, Math.min(range.endPage, totalPages))
    : start;
  return { startPage: start, endPage: end };
}

// Return the total number of pages in the PDF.
async function getPageCount(pdfBuffer) {
  const doc = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  return doc.getPageCount();
}

// Extract a 1-indexed inclusive page range and return a new PDF buffer.
async function sliceByRange(pdfBuffer, startPage, endPage) {
  const src = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  const total = src.getPageCount();
  const s = Math.max(1, Math.min(startPage, total));
  const e = Math.max(s, Math.min(endPage || s, total));

  const out = await PDFDocument.create();
  const indices = [];
  for (let i = s - 1; i <= e - 1; i++) indices.push(i);
  const pages = await out.copyPages(src, indices);
  for (const p of pages) out.addPage(p);
  const bytes = await out.save();
  return Buffer.from(bytes);
}

// Extract the first N pages as a sub-PDF — used for TOC parsing.
async function sliceFirstN(pdfBuffer, n = 15) {
  const total = await getPageCount(pdfBuffer);
  return sliceByRange(pdfBuffer, 1, Math.min(n, total));
}

// TOC sub-PDF: first N pages + last M pages, merged into one PDF.
// Protocols can have SoA / appendix-schedule / annex references only at the end,
// so sending both ends of the document to the TOC pass catches appendix content.
async function sliceTocInput(pdfBuffer, firstN = 20, lastM = 15) {
  const total = await getPageCount(pdfBuffer);
  if (total <= firstN + lastM) {
    // Short PDF — send whole thing.
    return sliceByRange(pdfBuffer, 1, total);
  }
  const src = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  const out = await PDFDocument.create();
  const indices = [];
  for (let i = 0; i < firstN; i++) indices.push(i);
  for (let i = total - lastM; i < total; i++) indices.push(i);
  const pages = await out.copyPages(src, indices);
  for (const p of pages) out.addPage(p);
  const bytes = await out.save();
  return Buffer.from(bytes);
}

// Concatenate multiple page ranges into a single PDF. Used to combine
// body + appendix ranges for a single section (e.g., SoA).
async function sliceByRanges(pdfBuffer, ranges) {
  if (!ranges || ranges.length === 0) return null;
  const src = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  const total = src.getPageCount();
  const out = await PDFDocument.create();
  const indices = [];
  for (const r of ranges) {
    const c = clampRange(r, total);
    if (!c) continue;
    for (let i = c.startPage - 1; i <= c.endPage - 1; i++) {
      if (!indices.includes(i)) indices.push(i);
    }
  }
  if (indices.length === 0) return null;
  const pages = await out.copyPages(src, indices);
  for (const p of pages) out.addPage(p);
  const bytes = await out.save();
  return Buffer.from(bytes);
}

// Plain text for the whole PDF (fallback when no TOC found).
async function extractAllText(pdfBuffer) {
  const data = await pdfParse(pdfBuffer);
  return {
    text: data.text || '',
    numPages: data.numpages || 0,
    info: data.info || {}
  };
}

// Plain text for the first N pages (used to locate section headers
// when Gemini's TOC pass returns tocFound = false).
async function extractFirstNPagesText(pdfBuffer, n = 15) {
  const sub = await sliceFirstN(pdfBuffer, n);
  const data = await pdfParse(sub);
  return data.text || '';
}

// Regex-based TOC fallback — scans the TOC pages AND end-of-document
// pages (appendices) for common section headers. Returns ranges[] per
// section so a single section can have multiple locations.
async function fallbackTocScan(pdfBuffer, scanFirst = 25, scanLast = 20) {
  const total = await getPageCount(pdfBuffer);
  const firstText = await extractFirstNPagesText(pdfBuffer, Math.min(scanFirst, total));

  // Use a tail PDF slice to extract text from the end pages (appendices).
  let tailText = '';
  if (total > scanFirst) {
    try {
      const tailStart = Math.max(scanFirst + 1, total - scanLast + 1);
      const tailSlice = await sliceByRange(pdfBuffer, tailStart, total);
      const parsed = await pdfParse(tailSlice);
      tailText = parsed.text || '';
    } catch { /* ignore — fall back to first-page text only */ }
  }

  const combined = `${firstText}\n${tailText}`;

  // Each pattern captures a number after the section title — that's
  // the TOC page reference. Multiple matches per section are allowed.
  const patterns = {
    synopsis:            /\b(?:protocol synopsis|study synopsis|executive summary|synopsis)\b.{0,80}?(\d{1,4})/gi,
    objectives:          /\b(?:objectives?|aims and endpoints|study objectives|trial objectives)\b.{0,80}?(\d{1,4})/gi,
    studyDesign:         /\b(?:study design|trial design|overall design)\b.{0,80}?(\d{1,4})/gi,
    armsInterventions:   /\b(?:treatment arms?|study treatments?|interventions?|study medication|dosing regimen)\b.{0,80}?(\d{1,4})/gi,
    eligibility:         /\b(?:eligibility|inclusion criteria|exclusion criteria|subject selection)\b.{0,80}?(\d{1,4})/gi,
    schedule:            /\b(?:schedule of activities|schedule of assessments|study assessments|visit schedule|soa|pk sampling schedule|pd sampling schedule|appendix [a-z0-9]*\s*(?:-|:)?\s*schedule)\b.{0,80}?(\d{1,4})/gi,
    estimands:           /\bestimands?\b.{0,80}?(\d{1,4})/gi,
    statisticalAnalysis: /\b(?:statistical analysis|statistical considerations|analysis plan)\b.{0,80}?(\d{1,4})/gi
  };

  const sections = {};
  for (const [key, rx] of Object.entries(patterns)) {
    const ranges = [];
    let m;
    while ((m = rx.exec(combined)) !== null) {
      const page = parseInt(m[1], 10);
      if (!isNaN(page) && page >= 1 && page <= total) {
        ranges.push({ startPage: page, endPage: Math.min(page + 10, total) });
      }
    }
    sections[key] = { ranges };
  }

  // titlePage is almost always the first 1-3 pages of the document,
  // before the TOC. Attach it unconditionally — its cost to extract
  // is tiny and it's always the authoritative source for cover metadata.
  sections.titlePage = { ranges: [{ startPage: 1, endPage: Math.min(3, total), locationHint: 'Cover' }] };

  return {
    tocFound: Object.values(sections).some(s => s.ranges.length > 0),
    totalPages: total,
    sections
  };
}

module.exports = {
  getPageCount,
  sliceByRange,
  sliceByRanges,
  sliceFirstN,
  sliceTocInput,
  extractAllText,
  extractFirstNPagesText,
  fallbackTocScan,
  clampRange
};
