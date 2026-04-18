const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3900;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Base CTIS API URL
const CTIS_API = 'https://euclinicaltrials.eu/ctis-public-api';

// Excluded Document Type Codes
// Document type numbers to completely block
const EXCLUDED_DOC_TYPES = ['D2', 'D3', 'D4'];  // D2/D3/D4 = Patient-facing documents

// Excluded Document Types (by title pattern)
// Documents matching these patterns will be rejected
const EXCLUDED_DOC_PATTERNS = [
  /patient.?facing/i,
  /eDiary|e-diary/i,
  /subject.?questionnaire/i,
  /home.?supply.?position/i,
  /home.?supply|supply.?position/i,
  /patient.?facing.?material/i,
  /_GR(?:[_-]|$)/i,  // Greek language protocols (filename contains _GR)
  /\bGR\b/i,         // Greek language protocols (standalone GR)
  /D1.*(?:GRE|Track)|(?:GRE|Track).*D1/i  // D1 documents with GRE or Track
];

function shouldExcludeDocument(docTitle, docTypeCode) {
  // Check document type code first
  if (docTypeCode && EXCLUDED_DOC_TYPES.includes(docTypeCode)) {
    return true;
  }
  // Then check title patterns
  if (!docTitle) return false;
  return EXCLUDED_DOC_PATTERNS.some(pattern => pattern.test(docTitle));
}

// Common headers for CTIS API requests
const CTIS_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'Origin': 'https://euclinicaltrials.eu',
  'Referer': 'https://euclinicaltrials.eu/ctis-public/search?lang=en'
};

// ─── Health Check (Railway) ──────────────────────────
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

// ─── Search clinical trials ───────────────────────────
app.post('/api/search', async (req, res) => {
  try {
    const response = await fetch(`${CTIS_API}/search`, {
      method: 'POST',
      headers: CTIS_HEADERS,
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Failed to search CTIS', details: err.message });
  }
});

// ─── Retrieve trial details (includes documents list) ──
app.get('/api/retrieve/:ctNumber', async (req, res) => {
  try {
    const { ctNumber } = req.params;
    const response = await fetch(`${CTIS_API}/retrieve/${ctNumber}`, {
      method: 'GET',
      headers: {
        ...CTIS_HEADERS,
        'Referer': `https://euclinicaltrials.eu/ctis-public/view/${ctNumber}?lang=en`
      }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Retrieve error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve trial', details: err.message });
  }
});

// ─── Download document — Type 104 (Protocol) Only ────
// Validates document type BEFORE downloading — only allows Type 104 protocols
app.get('/api/document/:ctNumber/:uuid', async (req, res) => {
  try {
    const { ctNumber, uuid } = req.params;
    const filename = req.query.filename || `${uuid}.pdf`;

    // Step 0 — VALIDATE: Document must be Type 104 (Protocol) ONLY
    const trialResp = await fetch(`${CTIS_API}/retrieve/${ctNumber}`, {
      method: 'GET',
      headers: {
        ...CTIS_HEADERS,
        'Referer': `https://euclinicaltrials.eu/ctis-public/view/${ctNumber}?lang=en`
      }
    });
    const trialData = await trialResp.json();
    const docs = trialData.documents || [];
    const requestedDoc = docs.find(d => d.uuid === uuid);

    if (!requestedDoc) {
      return res.status(404).json({ error: 'Document not found in trial' });
    }

    // Type check: must be exactly 104 (allow both string and number)
    const docTypeStr = String(requestedDoc.documentType).trim();
    if (docTypeStr !== '104' && docTypeStr !== '104') {
      console.warn(`⛔ BLOCKED: Attempted download of non-protocol document [${ctNumber}/${uuid}]. Type: ${requestedDoc.documentType}`);
      return res.status(403).json({ error: 'Only Type 104 (Protocol) documents can be downloaded' });
    }

    // Exclusion check: reject D2, D3, D4, and other excluded types
    if (shouldExcludeDocument(requestedDoc.title, requestedDoc.documentType)) {
      console.warn(`⛔ BLOCKED: Attempted download of excluded document [${ctNumber}/${uuid}]. Type: ${requestedDoc.documentType}, Title: ${requestedDoc.title}`);
      return res.status(403).json({ error: 'This document type is excluded from downloads' });
    }

    // Additional check: reject if title contains D2, D3, or D4
    const titleUpper = (requestedDoc.title || '').toUpperCase();
    if (['D2', 'D3', 'D4'].some(type => titleUpper.includes(type))) {
      console.warn(`⛔ BLOCKED: Document title contains excluded type [${ctNumber}/${uuid}]. Title: ${requestedDoc.title}`);
      return res.status(403).json({ error: 'This document type is excluded from downloads' });
    }

    // Check for D1 documents with GRE or Track in title
    if (requestedDoc.documentType === 'D1' && /(?:GRE|Track)/i.test(requestedDoc.title || '')) {
      console.warn(`⛔ BLOCKED: D1 document with GRE or Track [${ctNumber}/${uuid}]. Title: ${requestedDoc.title}`);
      return res.status(403).json({ error: 'This D1 document type is excluded from downloads' });
    }

    // Step 1 — Get the signed S3 URL from CTIS
    const redirectResponse = await fetch(`${CTIS_API}/documents/${ctNumber}/${uuid}/download`, {
      method: 'GET',
      headers: {
        'User-Agent': CTIS_HEADERS['User-Agent'],
        'Origin': 'https://euclinicaltrials.eu',
        'Referer': `https://euclinicaltrials.eu/ctis-public/view/${ctNumber}?lang=en`,
        'Accept': 'application/json, text/plain, */*',
        'Cookie': 'accepted_cookie=true'
      }
    });

    if (!redirectResponse.ok) {
      const errorText = await redirectResponse.text();
      console.error(`CTIS Redirect Error [${ctNumber}/${uuid}]:`, redirectResponse.status, errorText);
      return res.status(redirectResponse.status).json({ error: 'Failed to get document link from CTIS', details: errorText });
    }

    const redirectData = await redirectResponse.json();
    const s3Url = redirectData.url;

    if (!s3Url) {
      return res.status(500).json({ error: 'CTIS returned no S3 URL' });
    }

    // Step 2 — Stream the PDF from S3
    const fileResponse = await fetch(s3Url, { method: 'GET' });

    if (!fileResponse.ok) {
      const errorText = await fileResponse.text();
      console.error(`S3 Fetch Error [${uuid}]:`, fileResponse.status, errorText);
      return res.status(fileResponse.status).json({ error: 'Failed to fetch PDF from secure storage', details: errorText });
    }

    console.log(`✓ Proxying Protocol PDF [${ctNumber}/${uuid}] — ${fileResponse.headers.get('content-length')} bytes`);

    const contentType = fileResponse.headers.get('content-type') || 'application/pdf';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');

    // Pipe PDF stream to browser
    fileResponse.body.pipe(res);
  } catch (err) {
    console.error('Download error:', err.message);
    res.status(500).json({ error: 'Failed to download document', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// ──── ClinicalTrials.gov API Integration ─────────────────
// ─────────────────────────────────────────────────────────

// Base ClinicalTrials.gov API URL
const CTG_API = 'https://clinicaltrials.gov/api/v2';

// ClinicalTrials.gov Document Type Mappings
const CTG_PROTOCOL_FIELDS = ['protocolSection', 'documentSection'];

// Search ClinicalTrials.gov studies
app.post('/api/ctg/search', async (req, res) => {
  try {
    const keyword = req.body.query || '';
    const phase = req.body.phase || '';
    const status = req.body.status || '';
    const pageSize = req.body.pageSize || 20;
    const pageToken = req.body.pageToken || null;

    const params = new URLSearchParams({
      format: 'json',
      pageSize: Math.min(pageSize, 100),
      countTotal: true
    });

    if (keyword) params.append('query.cond', keyword);

    if (phase) params.append('filter.phase', `PHASE${phase.replace('PHASE', '').toUpperCase()}`);

    if (status) {
      const statusMap = {
        'RECRUITING': 'RECRUITING',
        'ACTIVE_NOT_RECRUITING': 'ACTIVE_NOT_RECRUITING',
        'COMPLETED': 'COMPLETED',
        'TERMINATED': 'TERMINATED'
      };
      params.append('filter.overallStatus', statusMap[status] || status);
    }

    if (pageToken) params.append('pageToken', pageToken);
    
    const response = await fetch(`${CTG_API}/studies?${params.toString()}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('CTG API Error:', response.status, errorText);
      return res.status(response.status).json({ 
        error: 'ClinicalTrials.gov search failed', 
        details: errorText 
      });
    }
    
    const data = await response.json();
    
    // Transform ClinicalTrials.gov response to match CTIS format
    const studies = (data.studies || []).map(study => {
      const protocolSection = study.protocolSection || {};
      const identificationModule = protocolSection.identificationModule || {};
      const designModule = protocolSection.designModule || {};
      const statusModule = protocolSection.statusModule || {};
      const conditionsModule = protocolSection.conditionsModule || {};
      
      return {
        nct: identificationModule.nctId || '',
        title: identificationModule.officialTitle || identificationModule.briefTitle || '',
        sponsor: (identificationModule.organization?.name) || (identificationModule.leadSponsor?.name) || 'N/A',
        condition: (conditionsModule.conditions || []).join('; '),
        phase: (designModule.phases && designModule.phases[0]) || 'N/A',
        status: statusModule.overallStatus || 'N/A',
        recruitmentStatus: statusModule.recruitmentStatus || 'N/A',
        enrollmentCount: statusModule.enrollmentInfo?.actualEnrollment || 0,
        sourceType: 'clinicaltrials.gov',
        hasProtocol: !!protocolSection
      };
    });
    
    res.json({
      studies: studies,
      totalCount: data.totalCount || 0,
      nextPageToken: data.nextPageToken || null
    });
    
  } catch (err) {
    console.error('ClinicalTrials.gov search error:', err.message);
    res.status(500).json({ 
      error: 'Failed to search ClinicalTrials.gov', 
      details: err.message 
    });
  }
});

// Get ClinicalTrials.gov study details
app.get('/api/ctg/retrieve/:nct', async (req, res) => {
  try {
    const { nct } = req.params;

    const response = await fetch(`${CTG_API}/studies/${nct}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      return res.status(404).json({ error: 'Study not found' });
    }

    const data = await response.json();
    const protocolSection = data.protocolSection || {};

    // documentSection is at the root level of the study object, not inside protocolSection
    const documentSection = data.documentSection || {};
    const largeDocumentModule = documentSection.largeDocumentModule || {};
    const documents = (largeDocumentModule.largeDocs || [])
      .filter(doc => doc.typeAbbrev === 'Prot')
      .map(doc => ({
        title: doc.label || doc.filename || 'Protocol Document',
        filename: doc.filename || `${nct}_protocol.pdf`,
        url: doc.url || '',
        typeAbbrev: doc.typeAbbrev,
        label: doc.label || 'Study Protocol',
        size: doc.size || 0,
        date: doc.date || '',
        docType: 'Protocol'
      }));

    res.json({
      nct: data.nctId,
      title: protocolSection.identificationModule?.officialTitle || protocolSection.identificationModule?.briefTitle || '',
      documents: documents,
      protocolSection: protocolSection
    });

  } catch (err) {
    console.error('ClinicalTrials.gov retrieve error:', err.message);
    res.status(500).json({
      error: 'Failed to retrieve study',
      details: err.message
    });
  }
});

// Download a specific protocol document from ClinicalTrials.gov by filename
app.get('/api/ctg/document/:nct/:filename', async (req, res) => {
  try {
    const { nct, filename } = req.params;

    const response = await fetch(`${CTG_API}/studies/${nct}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      return res.status(404).json({ error: 'Study not found' });
    }

    const data = await response.json();
    // documentSection is at root level
    const documentSection = data.documentSection || {};
    const largeDocumentModule = documentSection.largeDocumentModule || {};
    const documents = (largeDocumentModule.largeDocs || [])
      .filter(doc => doc.typeAbbrev === 'Prot');

    if (documents.length === 0) {
      return res.status(404).json({ error: 'Protocol document not found' });
    }

    // Find by filename match, or fall back to first document
    const doc = documents.find(d => d.filename === filename) || documents[0];
    const docUrl = doc.url;

    if (!docUrl) {
      return res.status(404).json({ error: 'Document URL not available' });
    }

    const fileResponse = await fetch(docUrl, { method: 'GET' });

    if (!fileResponse.ok) {
      return res.status(fileResponse.status).json({
        error: 'Failed to fetch PDF from ClinicalTrials.gov'
      });
    }

    const safeFilename = (doc.filename || filename).replace(/[^\w\s.\-]/g, '_');
    console.log(`✓ Proxying CTG Protocol [${nct}/${safeFilename}] — ${fileResponse.headers.get('content-length')} bytes`);

    const contentType = fileResponse.headers.get('content-type') || 'application/pdf';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');

    fileResponse.body.pipe(res);

  } catch (err) {
    console.error('ClinicalTrials.gov download error:', err.message);
    res.status(500).json({
      error: 'Failed to download document',
      details: err.message
    });
  }
});

// Proxy a PDF directly from a validated ClinicalTrials.gov CDN URL
// Used by bulk download to avoid re-fetching study metadata for each doc
app.get('/api/ctg/proxy-pdf', async (req, res) => {
  try {
    const { url, filename } = req.query;

    if (!url) return res.status(400).json({ error: 'url parameter required' });

    let parsed;
    try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

    const allowedHosts = ['cdn.clinicaltrials.gov', 'clinicaltrials.gov'];
    if (!allowedHosts.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
      return res.status(400).json({ error: 'URL must be from clinicaltrials.gov' });
    }

    const fileResponse = await fetch(url, { method: 'GET' });

    if (!fileResponse.ok) {
      return res.status(fileResponse.status).json({ error: 'Failed to fetch PDF' });
    }

    const safeFilename = (filename || 'protocol.pdf').replace(/[^\w\s.\-]/g, '_');
    console.log(`✓ Proxying CTG PDF via proxy-pdf: ${safeFilename}`);

    const contentType = fileResponse.headers.get('content-type') || 'application/pdf';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Cache-Control', 'no-store');

    fileResponse.body.pipe(res);

  } catch (err) {
    console.error('CTG proxy-pdf error:', err.message);
    res.status(500).json({ error: 'Failed to proxy PDF', details: err.message });
  }
});

// Bulk search ClinicalTrials.gov — returns studies with protocol document info
// Uses cursor-based pagination via nextPageToken
app.post('/api/ctg/bulk-search', async (req, res) => {
  try {
    const { condition, phase, overallStatus, pageToken, pageSize = 100 } = req.body;

    const params = new URLSearchParams({
      format: 'json',
      pageSize: Math.min(pageSize, 100),
      countTotal: true,
      aggFilters: 'docs:prot'   // only return studies that have a protocol PDF uploaded
    });

    if (condition) params.append('query.cond', condition);
    if (phase) params.append('filter.phase', `PHASE${phase.replace('PHASE', '')}`);
    if (overallStatus) params.append('filter.overallStatus', overallStatus);
    if (pageToken) params.append('pageToken', pageToken);

    const response = await fetch(`${CTG_API}/studies?${params.toString()}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({
        error: 'ClinicalTrials.gov bulk search failed',
        details: errorText
      });
    }

    const data = await response.json();

    const studies = (data.studies || []).map(study => {
      const protocolSection = study.protocolSection || {};
      const identificationModule = protocolSection.identificationModule || {};
      const statusModule = protocolSection.statusModule || {};

      // documentSection is at root level
      const documentSection = study.documentSection || {};
      const largeDocumentModule = documentSection.largeDocumentModule || {};
      // Only typeAbbrev 'Prot' — strict protocol documents only, no SAP, ICF, or other types
      const largeDocs = (largeDocumentModule.largeDocs || []).filter(
        doc => doc.typeAbbrev === 'Prot'
      );

      return {
        nct: identificationModule.nctId || '',
        title: identificationModule.officialTitle || identificationModule.briefTitle || '',
        overallStatus: statusModule.overallStatus || '',
        documents: largeDocs.map(doc => ({
          filename: doc.filename || `${identificationModule.nctId}_protocol.pdf`,
          url: doc.url || '',
          label: doc.label || 'Study Protocol',
          size: doc.size || 0
        }))
      };
    });

    res.json({
      studies,
      totalCount: data.totalCount || 0,
      nextPageToken: data.nextPageToken || null
    });

  } catch (err) {
    console.error('CTG bulk search error:', err.message);
    res.status(500).json({ error: 'Failed to bulk search ClinicalTrials.gov', details: err.message });
  }
});

// ─── Serve frontend ───────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────
const serverPort = process.env.PORT || PORT;

app.listen(serverPort, '0.0.0.0', () => {
  console.log(`\n  ╔══════════════════════════════════════════════════╗`);
  console.log(`  ║  CTIS Protocol Downloader running on port ${serverPort.toString().padEnd(4)}  ║`);
  console.log(`  ║  http://localhost:${serverPort.toString().padEnd(27)}║`);
  console.log(`  ╚══════════════════════════════════════════════════╝\n`);
});
