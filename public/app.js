/* ═══════════════════════════════════════════════════════
   CTIS Protocol Downloader — Application Logic
   ═══════════════════════════════════════════════════════ */

const API_BASE = '';  // Same origin (Express serves both)

// ── State ──────────────────────────────────────────
const state = {
  currentPage: 1,
  pageSize: 20,
  totalRecords: 0,
  totalPages: 0,
  results: [],
  downloadCount: 0,
  filtersOpen: false,
  directoryHandle: null,
  bulkCancelled: false
};

// ── DOM Elements ───────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  searchInput: $('#searchInput'),
  btnSearch: $('#btnSearch'),
  therapeuticArea: $('#therapeuticArea'),
  trialPhase: $('#trialPhase'),
  trialStatus: $('#trialStatus'),
  sponsor: $('#sponsor'),
  hasProtocol: $('#hasProtocol'),
  hasResults: $('#hasResults'),
  excludeSuspended: $('#excludeSuspended'),
  toggleFilters: $('#toggleFilters'),
  filtersSection: $('#filtersSection'),
  btnClear: $('#btnClear'),
  resultsGrid: $('#resultsGrid'),
  resultsHeader: $('#resultsHeader'),
  resultsCount: $('#resultsCount'),
  resultsPage: $('#resultsPage'),
  emptyState: $('#emptyState'),
  loadingState: $('#loadingState'),
  pagination: $('#pagination'),
  btnPrev: $('#btnPrev'),
  btnNext: $('#btnNext'),
  pageInfo: $('#pageInfo'),
  modalOverlay: $('#modalOverlay'),
  modalContent: $('#modalContent'),
  modalClose: $('#modalClose'),
  toastContainer: $('#toastContainer'),
  totalTrialsStat: $('#totalTrialsStat .stat-value'),
  downloadedStat: $('#downloadedStat .stat-value'),
  btnBatchAll: $('#btnBatchAll'),
  // Bulk download panel
  bulkTA: $('#bulkTA'),
  bulkExcludeSuspended: $('#bulkExcludeSuspended'),
  bulkExcludeTerminated: $('#bulkExcludeTerminated'),
  btnBulkDownload: $('#btnBulkDownload'),
  bulkTrialInfo: $('#bulkTrialInfo')
};

// ── Init ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  loadDownloadsInfo();
  // Auto-run initial search to show total count
  performSearch();
});

function bindEvents() {
  els.btnSearch.addEventListener('click', () => { state.currentPage = 1; performSearch(); });
  els.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { state.currentPage = 1; performSearch(); }
  });

  els.toggleFilters.addEventListener('click', toggleFilters);
  els.btnClear.addEventListener('click', clearFilters);

  els.btnPrev.addEventListener('click', () => { if (state.currentPage > 1) { state.currentPage--; performSearch(); } });
  els.btnNext.addEventListener('click', () => { if (state.currentPage < state.totalPages) { state.currentPage++; performSearch(); } });

  els.modalClose.addEventListener('click', closeModal);
  els.modalOverlay.addEventListener('click', (e) => { if (e.target === els.modalOverlay) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  els.btnBatchAll.addEventListener('click', batchDownloadVisible);

  // Bulk download panel
  els.bulkTA.addEventListener('change', onBulkTAChange);
  els.btnBulkDownload.addEventListener('click', bulkDownloadByTA);

  // Auto-search on filter change
  [els.therapeuticArea, els.trialPhase, els.trialStatus, els.hasResults, els.excludeSuspended].forEach(el => {
    if (el) el.addEventListener('change', () => { state.currentPage = 1; performSearch(); });
  });
}

function toggleFilters() {
  state.filtersOpen = !state.filtersOpen;
  els.filtersSection.classList.toggle('open', state.filtersOpen);
}

function clearFilters() {
  els.searchInput.value = '';
  els.therapeuticArea.value = '';
  els.trialPhase.value = '';
  els.trialStatus.value = '';
  els.sponsor.value = '';
  els.hasProtocol.checked = false;
  els.hasResults.checked = false;
  if(els.excludeSuspended) els.excludeSuspended.checked = true;
  state.currentPage = 1;
  performSearch();
}

// ── Search ─────────────────────────────────────────
async function performSearch() {
  showLoading(true);

  const keyword = els.searchInput.value.trim();
  const therapeuticArea = els.therapeuticArea.value || null;
  const phase = els.trialPhase.value || null;
  const status = els.trialStatus.value || null;
  const sponsor = els.sponsor.value.trim() || null;

  const body = {
    pagination: { page: state.currentPage, size: state.pageSize },
    sort: { property: 'decisionDate', direction: 'DESC' },
    searchCriteria: {
      containAll: keyword || null,
      containAny: null,
      containNot: null,
      title: null,
      number: null,
      status: status ? parseInt(status) : null,
      medicalCondition: null,
      sponsor: sponsor,
      endPoint: null,
      productName: null,
      productRole: null,
      populationType: null,
      orphanDesignation: null,
      msc: null,
      ageGroupCode: null,
      therapeuticArea: therapeuticArea,
      trialPhase: phase,
      sponsorTypeCode: null,
      gender: null,
      protocolCode: null,
      rareDisease: null,
      pip: null,
      haveOrphanDesignation: null,
      hasStudyResults: els.hasResults.checked ? true : null,
      hasClinicalStudyReport: null,
      isLowIntervention: null,
      hasSeriousBreach: null,
      hasUnexpectedEvent: null,
      hasUrgentSafetyMeasure: null,
      isTransitioned: null,
      eudraCtCode: null,
      trialRegion: null,
      vulnerablePopulation: null,
      mscStatus: null
    }
  };

  try {
    const resp = await fetch(`${API_BASE}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    let fetchedResults = data.data || [];
    if (els.excludeSuspended && els.excludeSuspended.checked) {
      // Exclude suspended trials (status 8)
      fetchedResults = fetchedResults.filter(t => t.ctStatus !== 8);
    }

    state.results = fetchedResults;
    state.totalRecords = data.pagination?.totalRecords || 0;
    state.totalPages = data.pagination?.totalPages || 0;
    state.currentPage = data.pagination?.currentPage || 1;

    els.totalTrialsStat.textContent = state.totalRecords.toLocaleString();
    renderResults();
  } catch (err) {
    console.error('Search failed:', err);
    showToast('error', 'Search Failed', err.message);
    showLoading(false);
  }
}

// ── Render Results ─────────────────────────────────
function renderResults() {
  showLoading(false);

  if (state.results.length === 0) {
    els.emptyState.style.display = 'flex';
    els.resultsHeader.style.display = 'none';
    els.pagination.style.display = 'none';
    els.resultsGrid.innerHTML = '';
    return;
  }

  els.emptyState.style.display = 'none';
  els.resultsHeader.style.display = 'flex';
  els.pagination.style.display = 'flex';

  els.resultsCount.textContent = `${state.totalRecords.toLocaleString()} trials found`;
  els.resultsPage.textContent = `• Page ${state.currentPage} of ${state.totalPages}`;
  els.pageInfo.textContent = `Page ${state.currentPage} / ${state.totalPages}`;
  els.btnPrev.disabled = state.currentPage <= 1;
  els.btnNext.disabled = state.currentPage >= state.totalPages;

  els.resultsGrid.innerHTML = state.results.map(trial => createTrialCard(trial)).join('');

  // Bind card events
  els.resultsGrid.querySelectorAll('.trial-card').forEach(card => {
    const ctNumber = card.dataset.ctNumber;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-mini')) return;
      openTrialModal(ctNumber);
    });
  });

  // Bind download buttons
  els.resultsGrid.querySelectorAll('.btn-download-quick').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ctNumber = btn.dataset.ctNumber;
      const ta = btn.dataset.therapeuticArea || '';
      quickDownloadProtocols(ctNumber, ta, btn);
    });
  });

  // Bind view buttons
  els.resultsGrid.querySelectorAll('.btn-view-detail').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTrialModal(btn.dataset.ctNumber);
    });
  });

  // Smooth scroll to results
  els.resultsHeader.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function createTrialCard(trial) {
  const statusClass = getStatusClass(trial.ctStatus);
  const statusLabel = getStatusLabel(trial.ctStatus);
  const ta = (trial.therapeuticAreas && trial.therapeuticAreas[0]) || '';
  const taShort = ta.replace(/Diseases \[C\] - /g, '').replace(/ \[C\d+\]/g, '') || 'Not specified';

  return `
    <div class="trial-card" data-ct-number="${trial.ctNumber}">
      <div class="trial-card-header">
        <span class="ct-number">${trial.ctNumber}</span>
        <span class="trial-status ${statusClass}">${statusLabel}</span>
      </div>
      <div class="trial-title">${escapeHtml(trial.ctTitle || 'Untitled trial')}</div>
      <div class="trial-meta">
        <span class="meta-tag">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.2"/><path d="M6 3.5v3l2 1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          ${trial.trialPhase ? trial.trialPhase.split(' (')[0] : 'N/A'}
        </span>
        <span class="meta-tag">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          ${taShort}
        </span>
        ${trial.trialCountries ? `<span class="meta-tag">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.2"/><path d="M1.5 6h9M6 1.5c-1.5 1.5-2 3-2 4.5s.5 3 2 4.5M6 1.5c1.5 1.5 2 3 2 4.5s-.5 3-2 4.5" stroke="currentColor" stroke-width="1"/></svg>
          ${trial.trialCountries.length} ${trial.trialCountries.length === 1 ? 'country' : 'countries'}
        </span>` : ''}
      </div>
      <div class="trial-footer">
        <span class="trial-sponsor" title="${escapeHtml(trial.sponsor || '')}">${escapeHtml(trial.sponsor || 'Unknown sponsor')}</span>
        <div class="trial-actions">
          <button class="btn-mini btn-mini-ghost btn-view-detail" data-ct-number="${trial.ctNumber}" title="View trial details & documents">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.2"/><path d="M6 4v4M4 6h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
            Details
          </button>
          <button class="btn-mini btn-mini-green btn-download-quick"
            data-ct-number="${trial.ctNumber}"
            data-therapeutic-area="${escapeHtml(taShort)}"
            title="Download protocol PDFs to local folder">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v6m0 0L4 6m2 2l2-2M2 10h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Download
          </button>
        </div>
      </div>
    </div>`;
}

function getStatusClass(code) {
  const map = { 2: 'status-authorised', 11: 'status-submitted', 5: 'status-ongoing', 7: 'status-completed', 9: 'status-terminated' };
  return map[code] || 'status-default';
}

function getStatusLabel(code) {
  const map = { 2: 'Authorised', 11: 'Submitted', 5: 'Ongoing', 7: 'Completed', 9: 'Terminated', 3: 'Not Authorised', 8: 'Suspended', 10: 'Withdrawn' };
  return map[code] || `Status ${code}`;
}

// ── Trial Detail Modal ─────────────────────────────
async function openTrialModal(ctNumber) {
  els.modalOverlay.style.display = 'flex';
  els.modalContent.innerHTML = `
    <div style="text-align:center;padding:3rem">
      <div class="loader-ring"><div></div><div></div><div></div></div>
      <p style="margin-top:1rem;color:var(--text-muted)">Loading trial ${ctNumber}…</p>
    </div>`;

  try {
    const resp = await fetch(`${API_BASE}/api/retrieve/${ctNumber}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    renderModal(data, ctNumber);
  } catch (err) {
    els.modalContent.innerHTML = `<p style="color:var(--red);text-align:center;padding:2rem">Failed to load trial: ${err.message}</p>`;
    showToast('error', 'Load Failed', err.message);
  }
}

function renderModal(data, ctNumber) {
  const info = data.authorizedPartI || {};
  const docs = data.documents || [];
  const protocolDocs = docs.filter(d => d.documentType === '104' || d.documentType === '7');
  const otherDocs = docs.filter(d => d.documentType !== '104' && d.documentType !== '7');

  const taLabel = (info.partOneTherapeuticAreas || '').replace(/Diseases \[C\] - /g, '').replace(/ \[C\d+\]/g, '') || 'Not specified';

  els.modalContent.innerHTML = `
    <div class="modal-ct-number">${ctNumber}</div>
    <h2 class="modal-title">${escapeHtml(info.fullTitle || info.ctTitle || 'Untitled Trial')}</h2>

    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:1.2rem">
      ${info.trialPhase ? `<span class="meta-tag">${info.trialPhase}</span>` : ''}
      <span class="meta-tag">${taLabel}</span>
      ${info.isLowIntervention ? '<span class="meta-tag">Low Intervention</span>' : ''}
    </div>

    ${info.medicalCondition ? `
    <div class="modal-section">
      <div class="modal-section-title">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        Medical Condition
      </div>
      <div class="modal-section-body">${escapeHtml(info.medicalCondition)}</div>
    </div>` : ''}

    ${info.primaryEndpoint ? `
    <div class="modal-section">
      <div class="modal-section-title">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5"/><circle cx="7" cy="7" r="2" fill="currentColor"/></svg>
        Primary Endpoint
      </div>
      <div class="modal-section-body">${escapeHtml(info.primaryEndpoint)}</div>
    </div>` : ''}

    <div class="modal-section">
      <div class="modal-section-title">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2" y="3" width="10" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M5 6h4M5 9h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        Protocol Documents (${protocolDocs.length})
      </div>
      <div class="doc-list">
        ${protocolDocs.length > 0 ? protocolDocs.map(doc => createDocItem(doc, ctNumber, taLabel)).join('') :
        '<p style="color:var(--text-muted);font-size:0.85rem;padding:0.5rem 0">No protocol documents available for this trial.</p>'}
      </div>
    </div>

    ${otherDocs.length > 0 ? `
    <div class="modal-section">
      <div class="modal-section-title">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 2h5l3 3v7a1.5 1.5 0 01-1.5 1.5h-6A1.5 1.5 0 012 12V3.5A1.5 1.5 0 013.5 2z" stroke="currentColor" stroke-width="1.3"/></svg>
        Other Documents (${otherDocs.length})
      </div>
      <div class="doc-list">
        ${otherDocs.map(doc => createDocItem(doc, ctNumber, taLabel)).join('')}
      </div>
    </div>` : ''}

    ${protocolDocs.length > 0 ? `
    <div style="margin-top:1.5rem;text-align:center">
      <button class="btn-outline" id="btnDownloadAllModal" data-ct-number="${ctNumber}" data-ta="${escapeHtml(taLabel)}">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 12h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Download All Protocols to Local Folder
      </button>
    </div>` : ''}
  `;

  // Bind modal download buttons
  els.modalContent.querySelectorAll('.btn-doc-save').forEach(btn => {
    btn.addEventListener('click', () => saveDocLocal(btn.dataset.uuid, btn.dataset.filename, btn.dataset.ctNumber, btn.dataset.ta, btn));
  });

  els.modalContent.querySelectorAll('.btn-doc-view').forEach(btn => {
    btn.addEventListener('click', () => viewDoc(btn.dataset.uuid, btn.dataset.filename, btn.dataset.ctNumber));
  });

  const btnAll = els.modalContent.querySelector('#btnDownloadAllModal');
  if (btnAll) {
    btnAll.addEventListener('click', () => {
      quickDownloadProtocols(btnAll.dataset.ctNumber, btnAll.dataset.ta, btnAll);
    });
  }
}

function createDocItem(doc, ctNumber, ta) {
  const typeLabels = {
    '104': 'Protocol',
    '7': 'Synopsis',
    '14': 'Recruitment',
    '15': 'ICF',
    '20': 'IMPD',
    '102': 'Scientific Advice',
    '100': 'CSR'
  };
  const typeLabel = typeLabels[doc.documentType] || doc.documentTypeLabel || 'Document';

  return `
    <div class="doc-item">
      <div class="doc-info">
        <div class="doc-icon">PDF</div>
        <div>
          <div class="doc-name" title="${escapeHtml(doc.title)}">${escapeHtml(doc.title)}</div>
          <div class="doc-type-label">${typeLabel} • v${doc.manualVersion || '1'}</div>
        </div>
      </div>
      <div class="doc-actions">
        <button class="btn-mini btn-mini-ghost btn-doc-view"
          data-uuid="${doc.uuid}"
          data-filename="${escapeHtml(doc.title)}.pdf"
          data-ct-number="${ctNumber}"
          title="View in browser">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 6s2-4 5-4 5 4 5 4-2 4-5 4-5-4-5-4z" stroke="currentColor" stroke-width="1.2"/><circle cx="6" cy="6" r="1.5" stroke="currentColor" stroke-width="1.2"/></svg>
          View
        </button>
        <button class="btn-mini btn-mini-green btn-doc-save"
          data-uuid="${doc.uuid}"
          data-filename="${escapeHtml(doc.title)}.pdf"
          data-ct-number="${ctNumber}"
          data-ta="${escapeHtml(ta)}"
          title="Save to local folder">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v6m0 0L4 6m2 2l2-2M2 10h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Save
        </button>
      </div>
    </div>`;
}

// ── File System Access Utilities ───────────────────
async function getDirectoryHandle() {
  if (state.directoryHandle) {
    const permission = await state.directoryHandle.requestPermission({ mode: 'readwrite' });
    if (permission === 'granted') return state.directoryHandle;
  }
  try {
    state.directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    return state.directoryHandle;
  } catch (err) {
    console.error('Folder picker cancelled or failed:', err);
    return null;
  }
}

async function streamToFileInDirectory(dirHandle, filename, response) {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await response.body.pipeTo(writable);
}

// ── Document Actions ───────────────────────────────
function viewDoc(uuid, filename, ctNumber) {
  window.open(`${API_BASE}/api/document/${ctNumber}/${uuid}?filename=${encodeURIComponent(filename)}`, '_blank');
}

async function saveDocLocal(uuid, filename, ctNumber, therapeuticArea, btnEl) {
  const origHTML = btnEl.innerHTML;
  btnEl.innerHTML = '<span class="btn-spinner"></span> Downloading…';
  btnEl.disabled = true;

  try {
    const resp = await fetch(`${API_BASE}/api/document/${ctNumber}/${uuid}?filename=${encodeURIComponent(filename)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    
    // Normal browser download for single file
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);

    state.downloadCount++;
    if (els.downloadedStat) els.downloadedStat.textContent = state.downloadCount;
    btnEl.innerHTML = '✓ Downloaded';
    btnEl.classList.remove('btn-mini-green');
    btnEl.style.background = 'var(--green-dim)';
    btnEl.style.color = 'var(--green)';
    showToast('success', 'Downloaded', filename);
  } catch (err) {
    btnEl.innerHTML = origHTML;
    btnEl.disabled = false;
    showToast('error', 'Download Failed', err.message);
  }
}

// ── Quick Download (from card) ─────────────────────
async function quickDownloadProtocols(ctNumber, therapeuticArea, btnEl) {
  if (!window.showDirectoryPicker) {
    showToast('error', 'Browser Unsupported', 'Folder picker requires Chrome, Edge, or a supported Chromium browser.');
    return;
  }
  
  const dirHandle = await getDirectoryHandle();
  if (!dirHandle) return; // user cancelled

  const origHTML = btnEl.innerHTML;
  btnEl.innerHTML = '<span class="btn-spinner"></span>';
  btnEl.disabled = true;

  try {
    // 1. Fetch trial info to get documents list
    const trialResp = await fetch(`${API_BASE}/api/retrieve/${ctNumber}`);
    if (!trialResp.ok) throw new Error('Failed to retrieve trial info');
    const trialData = await trialResp.json();
    const docs = trialData.documents || [];
    
    // 2. Filter for protocol and synopsis
    const protocolDocs = docs.filter(d => d.documentType === '104' || d.documentType === '7');
    if (protocolDocs.length === 0) {
      btnEl.innerHTML = 'No protocols';
      btnEl.style.background = 'var(--amber-dim)';
      btnEl.style.color = 'var(--amber)';
      btnEl.style.border = 'none';
      showToast('info', 'No Protocols', `No protocol documents found for ${ctNumber}`);
      return;
    }

    let downloaded = 0;
    let failed = 0;

    // 3. Create subdirectory for this trial
    const trialDirHandle = await dirHandle.getDirectoryHandle(ctNumber, { create: true });

    for (const doc of protocolDocs) {
      const filename = `${doc.title.replace(/[/\\\\?%*:|"<>]/g, '-')}.pdf`;
      try {
        const docResp = await fetch(`${API_BASE}/api/document/${ctNumber}/${doc.uuid}`);
        if (!docResp.ok) throw new Error('Download failed');
        await streamToFileInDirectory(trialDirHandle, filename, docResp);
        downloaded++;
      } catch (err) {
        failed++;
        console.error('Failed document', doc.uuid, err);
      }
    }

    state.downloadCount += downloaded;
    if(els.downloadedStat) els.downloadedStat.textContent = state.downloadCount;

    if (downloaded > 0) {
      btnEl.innerHTML = `✓ ${downloaded} files`;
      btnEl.style.background = 'var(--green-dim)';
      btnEl.style.color = 'var(--green)';
      btnEl.style.border = 'none';
      showToast('success', `${ctNumber}`, `${downloaded} protocols saved to local folder`);
      if (failed > 0) {
        showToast('error', 'Some Failed', `${failed} protocol(s) failed to download`);
      }
    } else {
      btnEl.innerHTML = origHTML;
      btnEl.disabled = false;
      showToast('error', 'Download Failed', 'All protocols failed to download');
    }
  } catch (err) {
    btnEl.innerHTML = origHTML;
    btnEl.disabled = false;
    showToast('error', 'Process Failed', err.message);
  }
}

// ── Batch Download All Visible ─────────────────────
async function batchDownloadVisible() {
  if (state.results.length === 0) return;
  
  if (!window.showDirectoryPicker) {
    showToast('error', 'Browser Unsupported', 'Folder picker requires Chrome, Edge, or a supported Chromium browser.');
    return;
  }

  const dirHandle = await getDirectoryHandle();
  if (!dirHandle) return; // user cancelled

  const overlay = document.createElement('div');
  overlay.className = 'batch-overlay';
  overlay.innerHTML = `
    <div class="batch-card">
      <h3 class="batch-title">Batch Downloading Protocols</h3>
      <p class="batch-subtitle">Processing <span id="batchCurrent">0</span> of ${state.results.length} trials</p>
      <div class="batch-progress-bar"><div class="batch-progress-fill" id="batchFill" style="width:0%"></div></div>
      <div class="batch-stats">
        <span>Downloaded: <span class="batch-stat-value" id="batchDl">0</span></span>
        <span>Skipped/Empty: <span class="batch-stat-value" id="batchSkip">0</span></span>
        <span>Failed: <span class="batch-stat-value" id="batchFail">0</span></span>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let downloaded = 0, skipped = 0, failed = 0;

  for (let i = 0; i < state.results.length; i++) {
    const trial = state.results[i];
    
    overlay.querySelector('#batchCurrent').textContent = i + 1;
    overlay.querySelector('#batchFill').style.width = `${((i + 1) / state.results.length) * 100}%`;

    try {
      // 1. Fetch info for trial
      const trialResp = await fetch(`${API_BASE}/api/retrieve/${trial.ctNumber}`);
      if (!trialResp.ok) throw new Error('API Error');
      const trialData = await trialResp.json();
      const docs = trialData.documents || [];
      const protocolDocs = docs.filter(d => d.documentType === '104' || d.documentType === '7');
      
      if (protocolDocs.length === 0) {
        skipped++;
      } else {
        const trialDirHandle = await dirHandle.getDirectoryHandle(trial.ctNumber, { create: true });
        for (const doc of protocolDocs) {
          const filename = `${doc.title.replace(/[\/\\?%*:|"<>]/g, '-')}.pdf`;
          try {
            const docResp = await fetch(`${API_BASE}/api/document/${trial.ctNumber}/${doc.uuid}`);
            if (!docResp.ok) throw new Error('API/Download Error');
            await streamToFileInDirectory(trialDirHandle, filename, docResp);
            downloaded++;
          } catch(e) {
            failed++;
          }
        }
      }
    } catch {
      failed++;
    }

    overlay.querySelector('#batchDl').textContent = downloaded;
    overlay.querySelector('#batchSkip').textContent = skipped;
    overlay.querySelector('#batchFail').textContent = failed;

    // Small delay to let UI render and balance requests
    await sleep(200);
  }

  state.downloadCount += downloaded;
  if (els.downloadedStat) els.downloadedStat.textContent = state.downloadCount;

  showToast('success', 'Batch Complete', `${downloaded} documents downloaded, ${skipped} skipped, ${failed} failed`);

  setTimeout(() => {
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.3s';
    setTimeout(() => overlay.remove(), 300);
  }, 2000);
}

// ── Bulk Download by Therapeutic Area ─────────────

const TA_LABELS = {
  C01: 'Bacterial Infections & Mycoses',
  C02: 'Virus Diseases',
  C03: 'Parasitic Diseases',
  C04: 'Neoplasms - Cancers & Tumors',
  C05: 'Musculoskeletal Diseases',
  C06: 'Digestive System Diseases - Gastroenterology',
  C07: 'Stomatognathic Diseases - Oral & Dental',
  C08: 'Respiratory Tract Diseases - Pulmonology',
  C09: 'Otorhinolaryngologic Diseases - ENT',
  C10: 'Nervous System Diseases - Neurology',
  C11: 'Eye Diseases - Ophthalmology',
  C12: 'Male Urogenital Diseases - Urology',
  C13: 'Female Urogenital Diseases & Pregnancy',
  C14: 'Cardiovascular Diseases - Cardiology',
  C15: 'Hemic & Lymphatic Diseases - Haematology',
  C16: 'Congenital, Hereditary & Neonatal Diseases',
  C17: 'Skin & Connective Tissue Diseases - Dermatology',
  C18: 'Nutritional & Metabolic Diseases',
  C19: 'Endocrine System Diseases - Endocrinology',
  C20: 'Immune System Diseases - Immunology & Allergy',
  C21: 'Disorders of Environmental Origin',
  C22: 'Animal Diseases - Veterinary',
  C23: 'Pathological Conditions, Signs & Symptoms',
  C24: 'Occupational Diseases',
  C25: 'Chemically-Induced Disorders - Toxicology',
  C26: 'Wounds & Injuries - Trauma'
};

function getTherapeuticAreaLabel(code) {
  return TA_LABELS[code] ? `${TA_LABELS[code]} [${code}]` : code;
}

function sanitizeFilename(str) {
  return (str || '').replace(/[/\\?%*:|"<>]/g, '-').trim();
}

// Returns true if the document is English (or has no language info)
function isEnglishDoc(doc) {
  if (doc.language) {
    const lang = doc.language.toLowerCase().trim();
    return lang === 'en' || lang === 'english' || lang === 'eng' || lang.startsWith('en-');
  }
  // Fallback: reject if title contains clear non-English language codes
  if (doc.title) {
    const t = doc.title.toUpperCase();
    const nonEnMarkers = [
      ' - DE', ' - FR', ' - ES', ' - IT', ' - PT', ' - NL', ' - PL',
      ' - SV', ' - DA', ' - FI', ' - NO', ' - CS', ' - HU', ' - RO',
      ' - BG', ' - HR', ' - SK', ' - SL', ' - LT', ' - LV', ' - ET',
      '(DE)', '(FR)', '(ES)', '(IT)', '(PT)', '(NL)', '(PL)', '(FI)',
      '_DE.', '_FR.', '_ES.', '_NL.'
    ];
    for (const m of nonEnMarkers) {
      if (t.includes(m)) return false;
    }
  }
  return true; // include if language cannot be determined
}

function buildBulkSearchBody(taCode, page, size) {
  return {
    pagination: { page, size },
    sort: { property: 'decisionDate', direction: 'DESC' },
    searchCriteria: {
      containAll: null, containAny: null, containNot: null,
      title: null, number: null, status: null,
      medicalCondition: null, sponsor: null, endPoint: null,
      productName: null, productRole: null, populationType: null,
      orphanDesignation: null, msc: null, ageGroupCode: null,
      therapeuticArea: taCode,
      trialPhase: null, sponsorTypeCode: null, gender: null,
      protocolCode: null, rareDisease: null, pip: null,
      haveOrphanDesignation: null, hasStudyResults: null,
      hasClinicalStudyReport: null, isLowIntervention: null,
      hasSeriousBreach: null, hasUnexpectedEvent: null,
      hasUrgentSafetyMeasure: null, isTransitioned: null,
      eudraCtCode: null, trialRegion: null,
      vulnerablePopulation: null, mscStatus: null
    }
  };
}

async function onBulkTAChange() {
  const taCode = els.bulkTA.value;
  if (!taCode) {
    els.btnBulkDownload.disabled = true;
    els.bulkTrialInfo.style.display = 'none';
    return;
  }

  els.bulkTrialInfo.style.display = 'flex';
  els.bulkTrialInfo.innerHTML = `
    <div class="bulk-info-loading">
      <span class="btn-spinner" style="border-color:rgba(99,102,241,0.3);border-top-color:var(--accent-primary-light)"></span>
      Fetching trial count…
    </div>`;
  els.btnBulkDownload.disabled = true;

  try {
    const body = buildBulkSearchBody(taCode, 1, 1);
    const resp = await fetch(`${API_BASE}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    const total = data.pagination?.totalRecords || 0;
    const taLabel = getTherapeuticAreaLabel(taCode);

    els.bulkTrialInfo.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="flex-shrink:0;opacity:0.7"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.4"/><path d="M7 5v4M7 4v.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      <span><strong>${total.toLocaleString()}</strong> trials found in <strong>${escapeHtml(taLabel)}</strong>. Only English-language Protocol &amp; Synopsis documents will be downloaded.</span>`;

    els.btnBulkDownload.disabled = total === 0;
  } catch {
    els.bulkTrialInfo.innerHTML = `<span style="color:var(--text-muted)">Could not fetch trial count — you may still attempt the download.</span>`;
    els.btnBulkDownload.disabled = false;
  }
}

async function bulkDownloadByTA() {
  const taCode = els.bulkTA.value;
  if (!taCode) return;

  if (!window.showDirectoryPicker) {
    showToast('error', 'Browser Unsupported', 'Folder picker requires Chrome, Edge, or a Chromium-based browser.');
    return;
  }

  const dirHandle = await getDirectoryHandle();
  if (!dirHandle) return;

  const excludeSuspended = els.bulkExcludeSuspended.checked;
  const excludeTerminated = els.bulkExcludeTerminated.checked;
  const taLabel = getTherapeuticAreaLabel(taCode);

  state.bulkCancelled = false;

  // Build and mount progress overlay
  const overlay = document.createElement('div');
  overlay.className = 'batch-overlay';
  overlay.innerHTML = `
    <div class="batch-card batch-card-wide">
      <h3 class="batch-title">Bulk Downloading Protocols</h3>
      <p class="batch-subtitle" id="bpSubtitle">Preparing <strong>${escapeHtml(taLabel)}</strong>…</p>
      <div class="batch-progress-bar"><div class="batch-progress-fill" id="bpFill" style="width:0%"></div></div>
      <div class="bp-current" id="bpCurrent">Fetching trial list…</div>
      <div class="batch-stats-wide">
        <div class="batch-stat-item">
          <span class="batch-stat-value" id="bpProcessed">0</span>
          <span class="batch-stat-label">Processed</span>
        </div>
        <div class="batch-stat-item">
          <span class="batch-stat-value" id="bpDownloaded" style="color:var(--green)">0</span>
          <span class="batch-stat-label">Downloaded</span>
        </div>
        <div class="batch-stat-item">
          <span class="batch-stat-value" id="bpSkipped" style="color:var(--amber)">0</span>
          <span class="batch-stat-label">Skipped</span>
        </div>
        <div class="batch-stat-item">
          <span class="batch-stat-value" id="bpNonEn" style="color:var(--text-muted)">0</span>
          <span class="batch-stat-label">Non-English</span>
        </div>
        <div class="batch-stat-item">
          <span class="batch-stat-value" id="bpFailed" style="color:var(--red)">0</span>
          <span class="batch-stat-label">Failed</span>
        </div>
      </div>
      <button class="btn-cancel-bulk" id="btnCancelBulk">Cancel</button>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#btnCancelBulk').addEventListener('click', () => {
    state.bulkCancelled = true;
    overlay.querySelector('#btnCancelBulk').disabled = true;
    overlay.querySelector('#btnCancelBulk').textContent = 'Cancelling…';
    overlay.querySelector('#bpSubtitle').textContent = 'Cancelling — finishing current trial…';
  });

  function updateOverlay(processed, total, downloaded, skipped, nonEn, failed) {
    const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : 0;
    overlay.querySelector('#bpFill').style.width = `${pct}%`;
    overlay.querySelector('#bpProcessed').textContent = processed;
    overlay.querySelector('#bpDownloaded').textContent = downloaded;
    overlay.querySelector('#bpSkipped').textContent = skipped;
    overlay.querySelector('#bpNonEn').textContent = nonEn;
    overlay.querySelector('#bpFailed').textContent = failed;
    if (total > 0) {
      overlay.querySelector('#bpSubtitle').innerHTML =
        `Processing <strong>${processed.toLocaleString()}</strong> of <strong>${total.toLocaleString()}</strong> trials`;
    }
  }

  // Create TA subfolder
  const taFolder = await dirHandle.getDirectoryHandle(sanitizeFilename(taLabel), { create: true });

  let pageNum = 1;
  const PAGE_SIZE = 50;
  let totalTrials = 0;
  let totalPages = 1;
  let processedTrials = 0;
  let totalDownloaded = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let totalNonEnglish = 0;

  try {
    do {
      if (state.bulkCancelled) break;

      const body = buildBulkSearchBody(taCode, pageNum, PAGE_SIZE);
      const resp = await fetch(`${API_BASE}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!resp.ok) throw new Error(`Search API error: HTTP ${resp.status}`);
      const data = await resp.json();

      totalTrials = data.pagination?.totalRecords || 0;
      totalPages = data.pagination?.totalPages || 1;
      const trials = data.data || [];

      for (const trial of trials) {
        if (state.bulkCancelled) break;

        overlay.querySelector('#bpCurrent').textContent = trial.ctNumber;

        // Status exclusions (client-side)
        if (excludeSuspended && trial.ctStatus === 8) {
          totalSkipped++;
          processedTrials++;
          updateOverlay(processedTrials, totalTrials, totalDownloaded, totalSkipped, totalNonEnglish, totalFailed);
          continue;
        }
        if (excludeTerminated && trial.ctStatus === 9) {
          totalSkipped++;
          processedTrials++;
          updateOverlay(processedTrials, totalTrials, totalDownloaded, totalSkipped, totalNonEnglish, totalFailed);
          continue;
        }

        try {
          const trialResp = await fetch(`${API_BASE}/api/retrieve/${trial.ctNumber}`);
          if (!trialResp.ok) throw new Error('Retrieve failed');
          const trialData = await trialResp.json();
          const docs = trialData.documents || [];

          // Protocol/Synopsis docs only
          const protocolDocs = docs.filter(d => d.documentType === '104' || d.documentType === '7');

          // Split by language
          const englishDocs = protocolDocs.filter(d => isEnglishDoc(d));
          const nonEnCount = protocolDocs.length - englishDocs.length;
          totalNonEnglish += nonEnCount;

          if (englishDocs.length === 0) {
            totalSkipped++;
          } else {
            const trialFolder = await taFolder.getDirectoryHandle(trial.ctNumber, { create: true });
            for (const doc of englishDocs) {
              const filename = `${sanitizeFilename(doc.title)}.pdf`;
              try {
                const docResp = await fetch(`${API_BASE}/api/document/${trial.ctNumber}/${doc.uuid}`);
                if (!docResp.ok) throw new Error('Download failed');
                await streamToFileInDirectory(trialFolder, filename, docResp);
                totalDownloaded++;
              } catch {
                totalFailed++;
              }
            }
          }
        } catch {
          totalFailed++;
        }

        processedTrials++;
        updateOverlay(processedTrials, totalTrials, totalDownloaded, totalSkipped, totalNonEnglish, totalFailed);
        await sleep(150);
      }

      pageNum++;
    } while (pageNum <= totalPages && !state.bulkCancelled);

  } catch (err) {
    showToast('error', 'Bulk Download Error', err.message);
  }

  state.downloadCount += totalDownloaded;
  if (els.downloadedStat) els.downloadedStat.textContent = state.downloadCount;

  const summaryMsg = state.bulkCancelled
    ? `Cancelled after ${totalDownloaded} protocols (${totalSkipped} skipped, ${totalNonEnglish} non-English excluded)`
    : `${totalDownloaded} English protocols saved • ${totalSkipped} skipped • ${totalNonEnglish} non-English excluded • ${totalFailed} failed`;

  showToast(state.bulkCancelled ? 'info' : 'success',
    state.bulkCancelled ? 'Bulk Download Cancelled' : 'Bulk Download Complete',
    summaryMsg);

  overlay.querySelector('#bpCurrent').textContent = state.bulkCancelled ? 'Cancelled.' : 'Complete!';
  overlay.querySelector('#btnCancelBulk').textContent = 'Close';
  overlay.querySelector('#btnCancelBulk').disabled = false;
  overlay.querySelector('#btnCancelBulk').onclick = () => {
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.3s';
    setTimeout(() => overlay.remove(), 300);
  };

  // Auto-close after 5s if not cancelled
  if (!state.bulkCancelled) {
    setTimeout(() => {
      if (overlay.parentNode) {
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity 0.3s';
        setTimeout(() => overlay.remove(), 300);
      }
    }, 5000);
  }
}

// ── Downloads Info ─────────────────────────────────
async function loadDownloadsInfo() {
  state.downloadCount = 0;
  if (els.downloadedStat) els.downloadedStat.textContent = 0;
}

// ── Modal ──────────────────────────────────────────
function closeModal() {
  els.modalOverlay.style.display = 'none';
  els.modalContent.innerHTML = '';
}

// ── Loading ────────────────────────────────────────
function showLoading(show) {
  els.loadingState.style.display = show ? 'flex' : 'none';
  if (show) {
    els.emptyState.style.display = 'none';
    els.resultsGrid.innerHTML = '';
    els.resultsHeader.style.display = 'none';
    els.pagination.style.display = 'none';
  }
}

// ── Toasts ─────────────────────────────────────────
function showToast(type, title, msg) {
  const icons = {
    success: '✓',
    error: '✕',
    info: 'ℹ'
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || 'ℹ'}</div>
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(title)}</div>
      ${msg ? `<div class="toast-msg">${escapeHtml(msg)}</div>` : ''}
    </div>`;

  els.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ── Utilities ──────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
