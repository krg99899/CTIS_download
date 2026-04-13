const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3900;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Base CTIS API URL
const CTIS_API = 'https://euclinicaltrials.eu/ctis-public-api';


// Common headers for CTIS API requests
const CTIS_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'Origin': 'https://euclinicaltrials.eu',
  'Referer': 'https://euclinicaltrials.eu/ctis-public/search?lang=en'
};

// ─── API Routes ───────────────────────────────

// Search clinical trials
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

// Retrieve trial details (includes documents list)
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

// Download a document by UUID - handles JSON redirect to S3 and streams to browser
app.get('/api/document/:ctNumber/:uuid', async (req, res) => {
  try {
    const { ctNumber, uuid } = req.params;
    const filename = req.query.filename || `${uuid}.pdf`;

    // 1. Get the S3 Download URL from CTIS Public API
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
        return res.status(500).json({ error: 'CTIS returned No S3 URL' });
    }

    // 2. Fetch the actual PDF content from the S3 URL
    const fileResponse = await fetch(s3Url, { method: 'GET' });

    if (!fileResponse.ok) {
        const errorText = await fileResponse.text();
        console.error(`S3 Fetch Error [${uuid}]:`, fileResponse.status, errorText);
        return res.status(fileResponse.status).json({ error: 'Failed to fetch PDF from secure storage', details: errorText });
    }

    console.log(`Successfully proxying PDF [${ctNumber}/${uuid}] - Size: ${fileResponse.headers.get('content-length')} bytes`);

    const contentType = fileResponse.headers.get('content-type') || 'application/pdf';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    // 3. Pipe the actual file stream back to the client browser
    fileResponse.body.pipe(res);
  } catch (err) {
    console.error('Download error:', err.message);
    res.status(500).json({ error: 'Failed to download document', details: err.message });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Using process.env.PORT for Railway cloud deployments
const serverPort = process.env.PORT || PORT;

app.listen(serverPort, '0.0.0.0', () => {
  console.log(`\n  ╔══════════════════════════════════════════════════╗`);
  console.log(`  ║  CTIS Protocol Downloader running on port ${serverPort.toString().padEnd(4)}  ║`);
  console.log(`  ║  http://localhost:${serverPort.toString().padEnd(27)}║`);
  console.log(`  ╚══════════════════════════════════════════════════╝\n`);
});
