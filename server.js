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
  /\bGR\b/i          // Greek language protocols (standalone GR)
];

function shouldExcludeDocument(docTitle) {
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

    if (requestedDoc.documentType !== '104') {
      console.warn(`⛔ BLOCKED: Attempted download of non-protocol document [${ctNumber}/${uuid}]. Type: ${requestedDoc.documentType}`);
      return res.status(403).json({ error: 'Only Type 104 (Protocol) documents can be downloaded' });
    }

    if (shouldExcludeDocument(requestedDoc.title)) {
      console.warn(`⛔ BLOCKED: Attempted download of excluded document [${ctNumber}/${uuid}]. Title: ${requestedDoc.title}`);
      return res.status(403).json({ error: 'This document type is excluded from downloads' });
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
