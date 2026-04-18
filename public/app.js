/* ═══════════════════════════════════════════════════════
   CTIS Protocol Downloader — Application Logic
   ═══════════════════════════════════════════════════════
   KEY RULE: ONLY English-language Protocol documents
   (documentType === '104') are ever downloaded.
   ALL other document types and ALL non-English docs
   are strictly excluded from every download path.
   ═══════════════════════════════════════════════════════ */

const API_BASE = '';  // Same origin (Express serves both)

// ── Excluded Document Type Codes ────────────────────
// Document type numbers to completely block
const EXCLUDED_DOC_TYPES = ['D2', 'D3', 'D4'];  // D2/D3/D4 = Patient-facing documents

// ── Excluded Document Types (by title pattern) ────────
// Documents matching these patterns will be skipped entirely
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

// ── Indications by Therapeutic Area ──────────────────
const TA_INDICATIONS = {
  C01: ['Bacterial pneumonia','Urinary tract infection','Sepsis','Tuberculosis','Skin and soft tissue infection','Intra-abdominal infection','Bloodstream infection','Meningitis','Osteomyelitis','Endocarditis','Candidiasis','Aspergillosis','Cryptococcosis','Fungal infection NOS'],
  C02: ['COVID-19','HIV infection','Hepatitis B','Hepatitis C','Influenza','RSV infection','Herpes simplex','Herpes zoster','Cytomegalovirus infection','Dengue fever','Ebola virus disease','SARS-CoV-2','HPV infection','Monkeypox'],
  C03: ['Malaria','Leishmaniasis','Chagas disease','Schistosomiasis','Trypanosomiasis','Cryptosporidiosis','Hookworm infection','Toxoplasmosis'],
  C04: ['Non-small cell lung cancer','Breast cancer','Colorectal cancer','Prostate cancer','Acute myeloid leukaemia','Chronic lymphocytic leukaemia','Diffuse large B-cell lymphoma','Melanoma','Ovarian cancer','Pancreatic cancer','Bladder cancer','Glioblastoma','Hepatocellular carcinoma','Renal cell carcinoma','Multiple myeloma','Gastric cancer','Esophageal cancer','Cervical cancer','Head and neck cancer','Endometrial cancer','Myelodysplastic syndrome','Chronic myeloid leukaemia'],
  C05: ['Rheumatoid arthritis','Osteoarthritis','Ankylosing spondylitis','Psoriatic arthritis','Systemic lupus erythematosus','Gout','Osteoporosis','Fibromyalgia','Juvenile idiopathic arthritis','Spondyloarthropathy'],
  C06: ['Crohn\'s disease','Ulcerative colitis','Irritable bowel syndrome','Gastroesophageal reflux disease','Non-alcoholic steatohepatitis','Liver cirrhosis','Coeliac disease','Eosinophilic esophagitis','Cholestatic liver disease','Primary biliary cholangitis'],
  C07: ['Periodontitis','Oral mucositis','Sjögren\'s syndrome','Dental caries','Oral lichen planus'],
  C08: ['Asthma','Chronic obstructive pulmonary disease','Idiopathic pulmonary fibrosis','Pulmonary arterial hypertension','Cystic fibrosis','Alpha-1 antitrypsin deficiency','Sarcoidosis','Bronchiectasis','Acute respiratory distress syndrome'],
  C09: ['Hearing loss','Chronic sinusitis','Meniere\'s disease','Otitis media','Allergic rhinitis','Tinnitus'],
  C10: ['Multiple sclerosis','Alzheimer\'s disease','Parkinson\'s disease','Epilepsy','Migraine','Amyotrophic lateral sclerosis','Stroke','Neuromyelitis optica','Spinal muscular atrophy','Huntington\'s disease','Peripheral neuropathy','Spasticity','Rett syndrome','Duchenne muscular dystrophy'],
  C11: ['Diabetic macular edema','Age-related macular degeneration','Dry eye disease','Glaucoma','Retinitis pigmentosa','Uveitis','Neovascular AMD'],
  C12: ['Prostate cancer','Overactive bladder','Benign prostatic hyperplasia','Erectile dysfunction','Kidney cancer','Bladder cancer','Interstitial cystitis'],
  C13: ['Endometriosis','Polycystic ovary syndrome','Preeclampsia','Uterine fibroids','Premature ovarian insufficiency','Preterm birth','Gestational diabetes'],
  C14: ['Heart failure','Atrial fibrillation','Coronary artery disease','Hypertension','Venous thromboembolism','Aortic stenosis','Peripheral arterial disease','Dyslipidaemia','Myocardial infarction','Cardiomyopathy','Stroke prevention','Pulmonary embolism'],
  C15: ['Sickle cell disease','Haemophilia A','Haemophilia B','Beta-thalassaemia','Iron deficiency anaemia','Immune thrombocytopenia','Aplastic anaemia','von Willebrand disease','Paroxysmal nocturnal haemoglobinuria','Myeloproliferative neoplasm','Thrombotic thrombocytopenic purpura'],
  C16: ['Spinal muscular atrophy','Cystic fibrosis','Down syndrome','Phenylketonuria','Duchenne muscular dystrophy','Fabry disease','Gaucher disease','Pompe disease','Hunter disease','Neonatal jaundice'],
  C17: ['Psoriasis','Atopic dermatitis','Hidradenitis suppurativa','Pemphigus vulgaris','Prurigo nodularis','Alopecia areata','Vitiligo','Acne vulgaris','Systemic sclerosis','Dermatomyositis'],
  C18: ['Type 2 diabetes','Type 1 diabetes','Obesity','Non-alcoholic fatty liver disease','Hypercholesterolaemia','Metabolic syndrome','Hyperuricaemia','Hypertriglyceridaemia'],
  C19: ['Type 1 diabetes','Hypothyroidism','Hyperthyroidism','Cushing\'s syndrome','Acromegaly','Primary hyperaldosteronism','Adrenal insufficiency','Hypoparathyroidism'],
  C20: ['Asthma','Atopic dermatitis','Allergic rhinitis','Food allergy','Systemic lupus erythematosus','Rheumatoid arthritis','Primary immunodeficiency','IgA nephropathy','Myasthenia gravis','Neuromyelitis optica spectrum disorder'],
  C21: ['Occupational lung disease','Heat stroke','Altitude sickness','Decompression sickness'],
  C22: ['Canine leishmaniosis','Feline infectious peritonitis','African swine fever','Bluetongue disease'],
  C23: ['Chronic pain','Fatigue','Septic shock','Cachexia','Anaphylaxis','Oedema'],
  C24: ['Occupational asthma','Silicosis','Asbestosis','Noise-induced hearing loss'],
  C25: ['Alcohol use disorder','Drug-induced liver injury','Organophosphate poisoning','Heavy metal poisoning','Opioid overdose'],
  C26: ['Traumatic brain injury','Spinal cord injury','Burns','Bone fractures','Post-traumatic stress disorder']
};

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
  bulkCancelled: false,
  currentSource: 'ctis'  // 'ctis' or 'ctg'
};

// ── DOM Elements ───────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  searchInput: $('#searchInput'),
  btnSearch: $('#btnSearch'),
  therapeuticArea: $('#therapeuticArea'),
  indication: $('#indication'),
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
  // Bulk download panel — EU CTIS
  bulkTA: $('#bulkTA'),
  bulkIndication: $('#bulkIndication'),
  bulkExcludeSuspended: $('#bulkExcludeSuspended'),
  bulkExcludeTerminated: $('#bulkExcludeTerminated'),
  btnBulkDownload: $('#btnBulkDownload'),
  bulkTrialInfo: $('#bulkTrialInfo'),
  bulkCTISSection: $('#bulkCTISSection'),
  // Bulk download panel — ClinicalTrials.gov
  bulkCTGSection: $('#bulkCTGSection'),
  bulkCTGTA: $('#bulkCTGTA'),
  bulkCTGIndication: $('#bulkCTGIndication'),
  bulkCTGCondition: $('#bulkCTGCondition'),
  bulkCTGPhase: $('#bulkCTGPhase'),
  bulkCTGExcludeSuspended: $('#bulkCTGExcludeSuspended'),
  bulkCTGExcludeTerminated: $('#bulkCTGExcludeTerminated'),
  bulkCTGFallbackJson:      $('#bulkCTGFallbackJson'),
  btnBulkDownloadCTG: $('#btnBulkDownloadCTG'),
  bulkCTGTrialInfo: $('#bulkCTGTrialInfo'),
  // Download Manager
  dmSessionList: $('#dmSessionList'),
  dmEmpty: $('#dmEmpty')
};

// ═══════════════════════════════════════════
// DOWNLOAD MANAGER — IndexedDB Checkpoint Store
// ═══════════════════════════════════════════
const DM_DB_NAME = 'ctis-dm';
const DM_DB_VERSION = 1;
let dmDb = null;

function openDmDb() {
  return new Promise((resolve, reject) => {
    if (dmDb) { resolve(dmDb); return; }
    const req = indexedDB.open(DM_DB_NAME, DM_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      // sessions store
      if (!db.objectStoreNames.contains('sessions')) {
        const ss = db.createObjectStore('sessions', { keyPath: 'id' });
        ss.createIndex('status', 'status');
      }
      // downloaded docs store
      if (!db.objectStoreNames.contains('downloaded')) {
        const ds = db.createObjectStore('downloaded', { keyPath: 'key' }); // key = sessionId|ctNumber|uuid
        ds.createIndex('sessionId', 'sessionId');
        ds.createIndex('sessionCtNumber', ['sessionId', 'ctNumber']);
      }
      // processedTrials store
      if (!db.objectStoreNames.contains('processed')) {
        const ps = db.createObjectStore('processed', { keyPath: 'key' }); // key = sessionId|ctNumber
        ps.createIndex('sessionId', 'sessionId');
      }
    };
    req.onsuccess = (e) => { dmDb = e.target.result; resolve(dmDb); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function dbTx(storeName, mode = 'readonly') {
  return dmDb.transaction(storeName, mode).objectStore(storeName);
}

async function dmGetAllSessions() {
  const db = await openDmDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('sessions', 'readonly').objectStore('sessions').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dmSaveSession(session) {
  const db = await openDmDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('sessions', 'readwrite').objectStore('sessions').put(session);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dmDeleteSession(sessionId) {
  const db = await openDmDb();
  // Delete session
  await new Promise((resolve, reject) => {
    const req = db.transaction('sessions', 'readwrite').objectStore('sessions').delete(sessionId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  // Delete all downloaded records for this session
  await dmClearSessionDownloads(sessionId);
  await dmClearSessionProcessed(sessionId);
}

async function dmClearSessionDownloads(sessionId) {
  const db = await openDmDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('downloaded', 'readwrite');
    const store = tx.objectStore('downloaded');
    const idx = store.index('sessionId');
    const req = idx.openCursor(IDBKeyRange.only(sessionId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dmClearSessionProcessed(sessionId) {
  const db = await openDmDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('processed', 'readwrite');
    const store = tx.objectStore('processed');
    const idx = store.index('sessionId');
    const req = idx.openCursor(IDBKeyRange.only(sessionId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dmMarkDownloaded(sessionId, ctNumber, uuid) {
  const db = await openDmDb();
  return new Promise((resolve, reject) => {
    const key = `${sessionId}|${ctNumber}|${uuid}`;
    const req = db.transaction('downloaded', 'readwrite').objectStore('downloaded')
      .put({ key, sessionId, ctNumber, uuid, savedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dmIsDownloaded(sessionId, ctNumber, uuid) {
  const db = await openDmDb();
  return new Promise((resolve, reject) => {
    const key = `${sessionId}|${ctNumber}|${uuid}`;
    const req = db.transaction('downloaded', 'readonly').objectStore('downloaded').get(key);
    req.onsuccess = () => resolve(!!req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dmMarkProcessed(sessionId, ctNumber) {
  const db = await openDmDb();
  return new Promise((resolve, reject) => {
    const key = `${sessionId}|${ctNumber}`;
    const req = db.transaction('processed', 'readwrite').objectStore('processed')
      .put({ key, sessionId, ctNumber, processedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dmIsProcessed(sessionId, ctNumber) {
  const db = await openDmDb();
  return new Promise((resolve, reject) => {
    const key = `${sessionId}|${ctNumber}`;
    const req = db.transaction('processed', 'readonly').objectStore('processed').get(key);
    req.onsuccess = () => resolve(!!req.result);
    req.onerror = () => reject(req.error);
  });
}

function generateSessionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ═══════════════════════════════════════════
// RETRY FETCH — 3 attempts, exponential back-off
// For network-interruption resilience
// ═══════════════════════════════════════════
async function fetchWithRetry(url, options = {}, maxAttempts = 3) {
  const delays = [0, 2000, 5000];
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(delays[attempt]);
    try {
      const resp = await fetch(url, options);
      if (resp.ok) return resp;
      // 429 / 5xx → retry; 4xx client errors → don't retry
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) throw new Error(`HTTP ${resp.status}`);
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// ── Init ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  loadDownloadsInfo();
  await openDmDb();
  renderDownloadManager();
  // Don't auto-run search on page load - let user start from top
  // performSearch();
});

function bindEvents() {
  els.btnSearch.addEventListener('click', () => { state.currentPage = 1; performSearch(); });
  els.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { state.currentPage = 1; performSearch(); }
  });

  // Source tab switching
  document.querySelectorAll('.tab-btn').forEach(tab => {
    tab.addEventListener('click', (e) => {
      const sourceVal = e.currentTarget.dataset.source;
      switchSource(sourceVal);
    });
  });

  els.toggleFilters.addEventListener('click', toggleFilters);
  els.btnClear.addEventListener('click', clearFilters);

  els.btnPrev.addEventListener('click', () => { if (state.currentPage > 1) { state.currentPage--; performSearch(); } });
  els.btnNext.addEventListener('click', () => { if (state.currentPage < state.totalPages) { state.currentPage++; performSearch(); } });

  els.modalClose.addEventListener('click', closeModal);
  els.modalOverlay.addEventListener('click', (e) => { if (e.target === els.modalOverlay) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  els.btnBatchAll.addEventListener('click', batchDownloadVisible);

  // Therapeutic area → populate indication dropdown
  els.therapeuticArea.addEventListener('change', () => {
    const val = els.therapeuticArea.value;
    // Sync to bulk panel
    if (els.bulkTA) {
      els.bulkTA.value = val;
      populateIndicationDropdown(val, els.bulkIndication);
      onBulkTAChange();
    }
    populateIndicationDropdown(val, els.indication);
    state.currentPage = 1;
    performSearch();
  });

  if (els.indication) {
    els.indication.addEventListener('change', () => {
      // Sync to bulk panel
      if (els.bulkIndication) {
        els.bulkIndication.value = els.indication.value;
        onBulkTAChange();
      }
      state.currentPage = 1;
      performSearch();
    });
  }

  // Bulk download panel
  els.bulkTA.addEventListener('change', () => {
    const val = els.bulkTA.value;
    // Sync to primary filter
    if (els.therapeuticArea) {
      els.therapeuticArea.value = val;
      populateIndicationDropdown(val, els.indication);
    }
    populateIndicationDropdown(val, els.bulkIndication);
    onBulkTAChange();
    // Also trigger search update
    state.currentPage = 1;
    performSearch();
  });

  if (els.bulkIndication) {
    els.bulkIndication.addEventListener('change', () => {
      // Sync to primary filter
      if (els.indication) {
        els.indication.value = els.bulkIndication.value;
      }
      onBulkTAChange();
      // Also trigger search update
      state.currentPage = 1;
      performSearch();
    });
  }
  els.btnBulkDownload.addEventListener('click', bulkDownloadByTA);

  // CTG bulk download controls
  if (els.bulkCTGTA) {
    els.bulkCTGTA.addEventListener('change', () => {
      const val = els.bulkCTGTA.value;
      populateIndicationDropdown(val, els.bulkCTGIndication);
      // Clear custom keyword when TA changes so TA drives the search
      if (els.bulkCTGCondition) els.bulkCTGCondition.value = '';
      onBulkCTGChange();
    });
  }
  if (els.bulkCTGIndication) {
    els.bulkCTGIndication.addEventListener('change', () => {
      if (els.bulkCTGCondition) els.bulkCTGCondition.value = '';
      onBulkCTGChange();
    });
  }
  if (els.bulkCTGCondition) {
    els.bulkCTGCondition.addEventListener('input', onBulkCTGChange);
    els.bulkCTGCondition.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onBulkCTGChange();
    });
  }
  if (els.bulkCTGPhase)              els.bulkCTGPhase.addEventListener('change', onBulkCTGChange);
  if (els.bulkCTGExcludeSuspended)   els.bulkCTGExcludeSuspended.addEventListener('change', onBulkCTGChange);
  if (els.bulkCTGExcludeTerminated)  els.bulkCTGExcludeTerminated.addEventListener('change', onBulkCTGChange);
  if (els.btnBulkDownloadCTG) els.btnBulkDownloadCTG.addEventListener('click', bulkDownloadByCTG);

  // Auto-search on filter change
  [els.trialPhase, els.trialStatus, els.hasResults, els.excludeSuspended].forEach(el => {
    if (el) el.addEventListener('change', () => { state.currentPage = 1; performSearch(); });
  });
}

// ── Indication Dropdown ────────────────────────────
function populateIndicationDropdown(taCode, selectEl) {
  if (!selectEl) return;

  if (!taCode) {
    selectEl.innerHTML = '<option value="">— Select therapeutic area first —</option>';
    selectEl.disabled = true;
    return;
  }

  const indications = TA_INDICATIONS[taCode] || [];
  selectEl.innerHTML = '<option value="">All Indications</option>';

  if (indications.length > 0) {
    indications.forEach(ind => {
      const opt = document.createElement('option');
      opt.value = ind;
      opt.textContent = ind;
      selectEl.appendChild(opt);
    });
    selectEl.disabled = false;
  } else {
    selectEl.innerHTML = '<option value="">No indications mapped</option>';
    selectEl.disabled = true;
  }
}

function toggleFilters() {
  state.filtersOpen = !state.filtersOpen;
  els.filtersSection.classList.toggle('open', state.filtersOpen);
}

function clearFilters() {
  els.searchInput.value = '';
  els.therapeuticArea.value = '';
  populateIndicationDropdown('', els.indication);
  els.trialPhase.value = '';
  els.trialStatus.value = '';
  if (els.sponsor) els.sponsor.value = '';
  els.hasProtocol.checked = false;
  els.hasResults.checked = false;
  if (els.excludeSuspended) els.excludeSuspended.checked = true;
  state.currentPage = 1;
  performSearch();
}

// ── Search ─────────────────────────────────────────
async function performSearch() {
  showLoading(true);

  if (state.currentSource === 'ctg') {
    await performSearchCTG();
  } else {
    await performSearchCTIS();
  }
}

// ── ClinicalTrials.gov Search ──────────────────────
async function performSearchCTG() {
  const keyword = els.searchInput.value.trim();
  const phase = els.trialPhase.value || null;
  const status = els.trialStatus.value || null;

  // Map CTIS status codes to ClinicalTrials.gov status
  const statusMap = {
    '2': 'ACTIVE_NOT_RECRUITING',
    '5': 'RECRUITING',
    '7': 'COMPLETED',
    '9': 'TERMINATED'
  };

  let ctgStatus = status ? statusMap[status] : '';

  const body = {
    query: keyword || 'Trials',
    phase: phase,
    status: ctgStatus,
    pageSize: state.pageSize,
    pageToken: null
  };

  try {
    const resp = await fetch(`${API_BASE}/api/ctg/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    state.results = data.studies || [];
    state.totalRecords = data.totalCount || 0;
    state.totalPages = Math.ceil(state.totalRecords / state.pageSize) || 0;

    els.totalTrialsStat.textContent = state.totalRecords.toLocaleString();
    renderResults();
  } catch (err) {
    console.error('ClinicalTrials.gov search failed:', err);
    showToast('error', 'ClinicalTrials.gov Search Failed', err.message);
    showLoading(false);
  }
}

// ── CTIS Search (Original) ────────────────────────
async function performSearchCTIS() {
  const keyword = els.searchInput.value.trim();
  const therapeuticArea = els.therapeuticArea.value || null;
  const indication = (els.indication && !els.indication.disabled) ? els.indication.value.trim() || null : null;
  const phase = els.trialPhase.value || null;
  const status = els.trialStatus.value || null;
  const sponsor = els.sponsor ? els.sponsor.value.trim() || null : null;

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
      medicalCondition: indication || null,
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
      fetchedResults = fetchedResults.filter(t => t.ctStatus !== 8);
    }

    state.results = fetchedResults;
    state.totalRecords = data.pagination?.totalRecords || 0;
    state.totalPages = data.pagination?.totalPages || 0;
    state.currentPage = data.pagination?.currentPage || 1;

    els.totalTrialsStat.textContent = state.totalRecords.toLocaleString();
    renderResults();
  } catch (err) {
    console.error('CTIS search failed:', err);
    showToast('error', 'Search Failed', err.message);
    showLoading(false);
  }
}

// ── Switch Source ──────────────────────────────────
function switchSource(source) {
  state.currentSource = source;
  state.currentPage = 1;

  document.querySelectorAll('.tab-btn').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.source === source);
  });

  // Show/hide bulk panel sections
  if (els.bulkCTISSection) els.bulkCTISSection.style.display = source === 'ctis' ? '' : 'none';
  if (els.bulkCTGSection)  els.bulkCTGSection.style.display  = source === 'ctg'  ? '' : 'none';

  // Update bulk panel description
  const desc = document.getElementById('bulkDescription');
  if (desc) {
    desc.innerHTML = source === 'ctg'
      ? 'Downloads <strong>all</strong> Protocol PDFs uploaded to ClinicalTrials.gov for the given condition — paginated through all results. Interrupted downloads can be <strong>resumed</strong> from the Download Manager below.'
      : 'Downloads <strong>all</strong> English-language Protocol PDFs (type 104) for the selected therapeutic area — all pages, all trials. Interrupted downloads can be <strong>resumed</strong> from the Download Manager below.';
  }

  state.results = [];
  els.totalTrialsStat.textContent = '—';
  renderResults();

  performSearch();
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

  els.resultsGrid.querySelectorAll('.trial-card').forEach(card => {
    const ctNumber = card.dataset.ctNumber;
    const source = card.dataset.source;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-mini')) return;
      openTrialModal(ctNumber, source);
    });
  });

  els.resultsGrid.querySelectorAll('.btn-download-quick').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const source = btn.dataset.source || state.currentSource;
      quickDownloadProtocols(btn.dataset.ctNumber, btn.dataset.therapeuticArea || '', btn, source);
    });
  });

  els.resultsGrid.querySelectorAll('.btn-view-detail').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = btn.closest('.trial-card');
      const source = card?.dataset.source || state.currentSource;
      openTrialModal(btn.dataset.ctNumber, source);
    });
  });

  // Only scroll to results if user did a text search or navigated to another page
  // Don't scroll just for selecting filters (TA, indication, phase, status)
  if (state.currentPage > 1 || els.searchInput.value.trim().length > 0) {
    els.resultsHeader.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function createTrialCard(trial) {
  // Handle both CTIS and ClinicalTrials.gov formats
  const isCTG = trial.sourceType === 'clinicaltrials.gov';
  const id = isCTG ? trial.nct : trial.ctNumber;
  const title = isCTG ? trial.title : trial.ctTitle || 'Untitled trial';
  const sponsor = isCTG ? trial.sponsor : trial.sponsor || 'Unknown sponsor';
  const phase = isCTG ? trial.phase : trial.trialPhase ? trial.trialPhase.split(' (')[0] : 'N/A';
  const status = isCTG ? trial.recruitmentStatus : getStatusLabel(trial.ctStatus);
  const statusClass = isCTG ? getStatusClassCTG(trial.recruitmentStatus) : getStatusClass(trial.ctStatus);
  
  const ta = isCTG ? trial.condition : (trial.therapeuticAreas && trial.therapeuticAreas[0]) || '';
  const taShort = ta.replace(/Diseases \[C\] - /g, '').replace(/ \[C\d+\]/g, '').substring(0, 40) || 'Not specified';

  return `
    <div class="trial-card" data-ct-number="${id}" data-source="${isCTG ? 'ctg' : 'ctis'}">
      <div class="trial-card-header">
        <span class="ct-number">${id}</span>
        <span class="trial-status ${statusClass}">${status}</span>
      </div>
      <div class="trial-title">${escapeHtml(title)}</div>
      <div class="trial-meta">
        <span class="meta-tag">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.2"/><path d="M6 3.5v3l2 1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          ${phase || 'N/A'}
        </span>
        <span class="meta-tag">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          ${taShort}
        </span>
        ${isCTG && trial.enrollmentCount ? `<span class="meta-tag">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1"/><text x="6" y="7" text-anchor="middle" font-size="8" fill="currentColor">N</text></svg>
          ${trial.enrollmentCount} enrolled
        </span>` : ''}
      </div>
      <div class="trial-footer">
        <span class="trial-sponsor" title="${escapeHtml(sponsor)}">${escapeHtml(sponsor)}</span>
        <div class="trial-actions">
          <button class="btn-mini btn-mini-ghost btn-view-detail" data-ct-number="${id}" title="View trial details & documents">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.2"/><path d="M6 4v4M4 6h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
            Details
          </button>
          <button class="btn-mini btn-mini-green btn-download-quick"
            data-ct-number="${id}"
            data-therapeutic-area="${escapeHtml(taShort)}"
            data-source="${isCTG ? 'ctg' : 'ctis'}"
            title="Download English protocol PDFs only">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v6m0 0L4 6m2 2l2-2M2 10h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Download
          </button>
        </div>
      </div>
    </div>`;
}

function getStatusClassCTG(status) {
  const map = {
    'RECRUITING': 'status-ongoing',
    'ACTIVE_NOT_RECRUITING': 'status-authorized',
    'COMPLETED': 'status-completed',
    'TERMINATED': 'status-terminated'
  };
  return map[status] || 'status-default';
}

function getStatusClass(code) {
  const map = { 2: 'status-authorized', 11: 'status-submitted', 5: 'status-ongoing', 7: 'status-completed', 9: 'status-terminated' };
  return map[code] || 'status-default';
}

function getStatusLabel(code) {
  const map = { 2: 'Authorised', 11: 'Submitted', 5: 'Ongoing', 7: 'Completed', 9: 'Terminated', 3: 'Not Authorised', 8: 'Suspended', 10: 'Withdrawn' };
  return map[code] || `Status ${code}`;
}

// ── Trial Detail Modal ─────────────────────────────
async function openTrialModal(id, source) {
  // Detect source from data attribute if not provided
  if (!source) {
    const card = document.querySelector(`[data-ct-number="${id}"]`);
    source = card?.dataset.source || state.currentSource;
  }

  els.modalOverlay.style.display = 'flex';
  els.modalContent.innerHTML = `
    <div style="text-align:center;padding:3rem">
      <div class="loader-ring"><div></div><div></div><div></div></div>
      <p style="margin-top:1rem;color:var(--text-muted)">Loading trial ${id}…</p>
    </div>`;

  try {
    let resp, data;
    
    if (source === 'ctg') {
      resp = await fetch(`${API_BASE}/api/ctg/retrieve/${id}`);
    } else {
      resp = await fetch(`${API_BASE}/api/retrieve/${id}`);
    }
    
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    data = await resp.json();
    renderModal(data, id, source);
  } catch (err) {
    els.modalContent.innerHTML = `<p style="color:var(--red);text-align:center;padding:2rem">Failed to load trial: ${err.message}</p>`;
    showToast('error', 'Load Failed', err.message);
  }
}

function renderModal(data, id, source) {
  // Handle ClinicalTrials.gov format
  if (source === 'ctg') {
    const proto = data.protocolSection || {};
    const ident = proto.identificationModule || {};
    const design = proto.designModule || {};
    const status = proto.statusModule || {};
    const cond = proto.conditionsModule || {};
    const sponsor = ident.organization?.fullName || ident.leadSponsor?.name || 'N/A';

    els.modalContent.innerHTML = `
      <div class="modal-ct-number">${id}</div>
      <h2 class="modal-title">${escapeHtml(ident.officialTitle || ident.briefTitle || 'Untitled Trial')}</h2>

      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:1.2rem">
        ${design.studyType ? `<span class="meta-tag">${design.studyType}</span>` : ''}
        <span class="meta-tag">${status.overallStatus || 'N/A'}</span>
        <span class="badge-en-only">🌐 ClinicalTrials.gov</span>
      </div>

      ${cond.conditions?.length ? `
      <div class="modal-section">
        <div class="modal-section-title">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          Conditions
        </div>
        <div class="modal-section-body">${escapeHtml(cond.conditions.join(', '))}</div>
      </div>` : ''}

      <div class="modal-section">
        <div class="modal-section-title">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5"/><circle cx="7" cy="7" r="2" fill="currentColor"/></svg>
          Trial Information
        </div>
        <div class="modal-section-body">
          <div style="margin-bottom:0.8rem">
            <strong>Sponsor:</strong> ${escapeHtml(sponsor)}
          </div>
          <div style="margin-bottom:0.8rem">
            <strong>Recruitment Status:</strong> ${escapeHtml(status.recruitmentStatus || 'N/A')}
          </div>
          <div>
            <strong>Enrollment:</strong> ${status.enrollmentInfo?.actualEnrollment || 0} participants
          </div>
        </div>
      </div>

      <div class="modal-section">
        <div class="modal-section-title">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2" y="3" width="10" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M5 6h4M5 9h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          Protocol Documents (${data.documents?.length || 0})
        </div>
        <div class="doc-list">
          ${(data.documents || []).length > 0
            ? (data.documents || []).map(doc => `
              <div class="doc-item">
                <div class="doc-info">
                  <div class="doc-icon">PDF</div>
                  <div>
                    <div class="doc-name" title="${escapeHtml(doc.label || doc.filename)}">${escapeHtml(doc.label || doc.filename)}</div>
                    <div class="doc-type-label">Protocol${doc.size ? ` • ${formatBytes(doc.size)}` : ''}${doc.date ? ` • ${doc.date}` : ''}</div>
                  </div>
                </div>
                <div class="doc-actions">
                  <button class="btn-mini btn-mini-green btn-ctg-doc-save"
                    data-url="${escapeHtml(doc.url)}"
                    data-filename="${escapeHtml(doc.filename)}"
                    data-nct="${id}"
                    title="Save to local folder">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v6m0 0L4 6m2 2l2-2M2 10h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    Save
                  </button>
                </div>
              </div>`).join('')
            : '<p style="color:var(--text-muted);font-size:0.85rem;padding:0.5rem 0">No protocol documents uploaded for this study.</p>'}
        </div>
      </div>

      <div style="margin-top:1.5rem;display:flex;gap:1rem;justify-content:center;flex-wrap:wrap">
        ${(data.documents || []).length > 0 ? `
        <button class="btn-outline" id="btnDownloadAllCTG" data-nct="${id}">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 12h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Download All Protocols
        </button>` : ''}
        <button class="btn-outline" id="btnViewCTG" data-nct="${id}">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 8s2-4 6-4 6 4 6 4-2 4-6 4-6-4-6-4Z" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/></svg>
          View on ClinicalTrials.gov
        </button>
      </div>
    `;

    els.modalContent.querySelector('#btnViewCTG').addEventListener('click', (e) => {
      window.open(`https://clinicaltrials.gov/study/${e.currentTarget.dataset.nct}`, '_blank');
    });

    // Per-doc save buttons
    els.modalContent.querySelectorAll('.btn-ctg-doc-save').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { url, filename, nct } = btn.dataset;
        if (!url) return;
        const origHTML = btn.innerHTML;
        btn.innerHTML = '<span class="btn-spinner"></span>';
        btn.disabled = true;
        try {
          const dirHandle = await getDirectoryHandle();
          if (!dirHandle) { btn.innerHTML = origHTML; btn.disabled = false; return; }
          const trialDir = await dirHandle.getDirectoryHandle(nct, { create: true });
          const saveFilename = `${nct}_${sanitizeFilename(filename)}`;
          const resp = await fetchWithRetry(
            `${API_BASE}/api/ctg/proxy-pdf?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(saveFilename)}`
          );
          await streamToFileInDirectory(trialDir, saveFilename, resp);
          btn.innerHTML = '✓ Saved';
          btn.style.background = 'var(--green-dim)';
          btn.style.color = 'var(--green)';
          showToast('success', 'Saved', saveFilename);
        } catch (err) {
          btn.innerHTML = origHTML;
          btn.disabled = false;
          showToast('error', 'Save Failed', err.message);
        }
      });
    });

    // Download all button
    const btnAll = els.modalContent.querySelector('#btnDownloadAllCTG');
    if (btnAll) {
      btnAll.addEventListener('click', () => quickDownloadProtocols(id, '', btnAll, 'ctg'));
    }

    return;
  }

  // Original CTIS format handling
  const info = data.authorizedPartI || {};
  const docs = data.documents || [];
  // STRICT: Protocol only (type 104), English, and not excluded types
  const protocolDocs = docs.filter(d => 
    d.documentType === '104' && 
    isEnglishDoc(d) && 
    !shouldExcludeDocument(d.title, d.documentType)
  );

  const taLabel = (info.partOneTherapeuticAreas || '').replace(/Diseases \[C\] - /g, '').replace(/ \[C\d+\]/g, '') || 'Not specified';

  els.modalContent.innerHTML = `
    <div class="modal-ct-number">${ctNumber}</div>
    <h2 class="modal-title">${escapeHtml(info.fullTitle || info.ctTitle || 'Untitled Trial')}</h2>

    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:1.2rem">
      ${info.trialPhase ? `<span class="meta-tag">${info.trialPhase}</span>` : ''}
      <span class="meta-tag">${taLabel}</span>
      ${info.isLowIntervention ? '<span class="meta-tag">Low Intervention</span>' : ''}
      <span class="badge-en-only">🌐 English Protocols Only</span>
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
        English Protocol Documents (${protocolDocs.length})
      </div>
      <div class="doc-list">
        ${protocolDocs.length > 0
          ? protocolDocs.map(doc => createDocItem(doc, ctNumber, taLabel)).join('')
          : '<p style="color:var(--text-muted);font-size:0.85rem;padding:0.5rem 0">No English protocol documents found for this trial.</p>'}
      </div>
    </div>

    ${protocolDocs.length > 0 ? `
    <div style="margin-top:1.5rem;text-align:center">
      <button class="btn-outline" id="btnDownloadAllModal" data-ct-number="${ctNumber}" data-ta="${escapeHtml(taLabel)}">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 12h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Download All English Protocols
      </button>
    </div>` : ''}
  `;

  els.modalContent.querySelectorAll('.btn-doc-save').forEach(btn => {
    btn.addEventListener('click', () => saveDocLocal(btn.dataset.uuid, btn.dataset.filename, btn.dataset.ctNumber, btn.dataset.ta, btn));
  });

  els.modalContent.querySelectorAll('.btn-doc-view').forEach(btn => {
    btn.addEventListener('click', () => viewDoc(btn.dataset.uuid, btn.dataset.filename, btn.dataset.ctNumber));
  });

  const btnAll = els.modalContent.querySelector('#btnDownloadAllModal');
  if (btnAll) {
    btnAll.addEventListener('click', () => quickDownloadProtocols(btnAll.dataset.ctNumber, btnAll.dataset.ta, btnAll));
  }
}

function createDocItem(doc, ctNumber, ta) {
  return `
    <div class="doc-item">
      <div class="doc-info">
        <div class="doc-icon">PDF</div>
        <div>
          <div class="doc-name" title="${escapeHtml(doc.title)}">${escapeHtml(doc.title)}</div>
          <div class="doc-type-label">Protocol (EN) • v${doc.manualVersion || '1'}</div>
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
    try {
      const permission = await state.directoryHandle.requestPermission({ mode: 'readwrite' });
      if (permission === 'granted') return state.directoryHandle;
    } catch (_) {}
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

async function writeJsonToDirectory(dirHandle, filename, obj) {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(obj, null, 2));
  await writable.close();
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
    const resp = await fetchWithRetry(`${API_BASE}/api/document/${ctNumber}/${uuid}?filename=${encodeURIComponent(filename)}`);
    const blob = await resp.blob();

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

// ── Quick Download (from card) — English Protocols Only ────
async function quickDownloadProtocols(id, therapeuticArea, btnEl, source) {
  if (!source) source = state.currentSource;
  
  if (!window.showDirectoryPicker) {
    showToast('error', 'Browser Unsupported', 'Folder picker requires Chrome, Edge, or a supported Chromium browser.');
    return;
  }

  const dirHandle = await getDirectoryHandle();
  if (!dirHandle) return;

  const origHTML = btnEl.innerHTML;
  btnEl.innerHTML = '<span class="btn-spinner"></span>';
  btnEl.disabled = true;

  try {
    let trialResp, trialData, docs;
    
    if (source === 'ctg') {
      // Fetch study details — returns English-filtered PDFs + USDM trialJson fallback
      trialResp = await fetchWithRetry(`${API_BASE}/api/ctg/retrieve/${id}`);
      trialData = await trialResp.json();
      const allDocs = (trialData.documents || []).filter(d => d.url);
      docs = allDocs.filter(d => isEnglishCtgDoc(d));
      const fallbackJson = els.bulkCTGFallbackJson?.checked ?? true;

      const trialDirHandle = await dirHandle.getDirectoryHandle(id, { create: true });
      let downloaded = 0;
      let failed = 0;
      let jsonSaved = false;

      if (docs.length > 0) {
        // PDF available — download PDF(s), skip JSON
        for (const doc of docs) {
          const filename = `${id}_${sanitizeFilename(doc.filename || 'protocol.pdf')}`;
          try {
            const docResp = await fetchWithRetry(
              `${API_BASE}/api/ctg/proxy-pdf?url=${encodeURIComponent(doc.url)}&filename=${encodeURIComponent(filename)}`
            );
            if (!docResp.ok) { failed++; continue; }
            await streamToFileInDirectory(trialDirHandle, filename, docResp);
            downloaded++;
          } catch (err) {
            failed++;
            console.error('Failed CTG document', doc.filename, err);
          }
        }
      } else if (fallbackJson && trialData.trialJson) {
        // No PDF — save USDM v4.0 JSON fallback to JSON/ subfolder
        try {
          const jsonFolder = await trialDirHandle.getDirectoryHandle('JSON', { create: true });
          await writeJsonToDirectory(jsonFolder, `${id}.json`, trialData.trialJson);
          jsonSaved = true;
        } catch (err) {
          failed++;
          console.error('Failed CTG JSON fallback', id, err);
        }
      }

      state.downloadCount += downloaded;
      if (els.downloadedStat) els.downloadedStat.textContent = state.downloadCount;

      if (downloaded > 0) {
        btnEl.innerHTML = `✓ ${downloaded} file${downloaded > 1 ? 's' : ''}`;
        btnEl.style.background = 'var(--green-dim)';
        btnEl.style.color = 'var(--green)';
        btnEl.style.border = 'none';
        showToast('success', id, `${downloaded} protocol${downloaded > 1 ? 's' : ''} saved`);
        if (failed > 0) showToast('error', 'Some Failed', `${failed} protocol(s) failed to download`);
      } else if (jsonSaved) {
        btnEl.innerHTML = '✓ USDM JSON';
        btnEl.style.background = 'var(--accent-primary-dim)';
        btnEl.style.color = 'var(--accent-primary-light)';
        btnEl.style.border = 'none';
        showToast('success', id, 'No PDF available — CDISC USDM v4.0 JSON saved to JSON/ subfolder');
      } else {
        btnEl.innerHTML = 'No protocols';
        btnEl.style.background = 'var(--amber-dim)';
        btnEl.style.color = 'var(--amber)';
        btnEl.style.border = 'none';
        showToast('info', 'No Protocols', `No protocol PDF or JSON available for ${id}`);
      }
      return;
    }

    // CTIS source
    trialResp = await fetchWithRetry(`${API_BASE}/api/retrieve/${id}`);
    trialData = await trialResp.json();
    docs = trialData.documents || [];

    docs = docs.filter(d =>
      d.documentType === '104' &&
      isEnglishDoc(d) &&
      !shouldExcludeDocument(d.title, d.documentType)
    );

    if (docs.length === 0) {
      btnEl.innerHTML = 'No protocols';
      btnEl.style.background = 'var(--amber-dim)';
      btnEl.style.color = 'var(--amber)';
      btnEl.style.border = 'none';
      showToast('info', 'No Protocols', `No protocol documents found for ${id}`);
      return;
    }

    let downloaded = 0;
    let failed = 0;
    const trialDirHandle = await dirHandle.getDirectoryHandle(id, { create: true });

    for (const doc of docs) {
      const filename = `${sanitizeFilename(doc.title)}.pdf`;
      try {
        const docResp = await fetchWithRetry(`${API_BASE}/api/document/${id}/${doc.uuid}`);

        if (!docResp.ok) {
          console.error(`Document download returned ${docResp.status}:`, await docResp.text());
          failed++;
          continue;
        }
        await streamToFileInDirectory(trialDirHandle, filename, docResp);
        downloaded++;
      } catch (err) {
        failed++;
        console.error('Failed document', doc.uuid, err);
      }
    }

    state.downloadCount += downloaded;
    if (els.downloadedStat) els.downloadedStat.textContent = state.downloadCount;

    if (downloaded > 0) {
      btnEl.innerHTML = `✓ ${downloaded} file${downloaded > 1 ? 's' : ''}`;
      btnEl.style.background = 'var(--green-dim)';
      btnEl.style.color = 'var(--green)';
      btnEl.style.border = 'none';
      showToast('success', `${id}`, `${downloaded} English protocol${downloaded > 1 ? 's' : ''} saved`);
      if (failed > 0) showToast('error', 'Some Failed', `${failed} protocol(s) failed to download`);
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
  if (!dirHandle) return;

  const overlay = document.createElement('div');
  overlay.className = 'batch-overlay';
  overlay.innerHTML = `
    <div class="batch-card">
      <h3 class="batch-title">Batch Downloading English Protocols</h3>
      <p class="batch-subtitle">Processing <span id="batchCurrent">0</span> of ${state.results.length} trials</p>
      <div class="batch-progress-bar"><div class="batch-progress-fill" id="batchFill" style="width:0%"></div></div>
      <div class="batch-stats">
        <span>PDFs: <span class="batch-stat-value" id="batchDl">0</span></span>
        <span>USDM JSON: <span class="batch-stat-value" id="batchJson">0</span></span>
        <span>Skipped: <span class="batch-stat-value" id="batchSkip">0</span></span>
        <span>Failed: <span class="batch-stat-value" id="batchFail">0</span></span>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let downloaded = 0, skipped = 0, failed = 0, jsonSaved = 0;
  const fallbackJson = els.bulkCTGFallbackJson?.checked ?? true;

  for (let i = 0; i < state.results.length; i++) {
    const trial = state.results[i];
    overlay.querySelector('#batchCurrent').textContent = i + 1;
    overlay.querySelector('#batchFill').style.width = `${((i + 1) / state.results.length) * 100}%`;

    const isCTG = trial.sourceType === 'clinicaltrials.gov';
    const trialId = isCTG ? trial.nct : trial.ctNumber;

    try {
      if (isCTG) {
        // ClinicalTrials.gov: fetch study details — returns PDFs + USDM trialJson
        const trialResp = await fetchWithRetry(`${API_BASE}/api/ctg/retrieve/${trialId}`);
        const trialData = await trialResp.json();
        const docs = (trialData.documents || []).filter(d => d.url && isEnglishCtgDoc(d));
        const trialDirHandle = await dirHandle.getDirectoryHandle(trialId, { create: true });

        if (docs.length > 0) {
          for (const doc of docs) {
            const filename = `${trialId}_${sanitizeFilename(doc.filename || 'protocol.pdf')}`;
            try {
              const docResp = await fetchWithRetry(
                `${API_BASE}/api/ctg/proxy-pdf?url=${encodeURIComponent(doc.url)}&filename=${encodeURIComponent(filename)}`
              );
              await streamToFileInDirectory(trialDirHandle, filename, docResp);
              downloaded++;
            } catch { failed++; }
          }
        } else if (fallbackJson && trialData.trialJson) {
          try {
            const jsonFolder = await trialDirHandle.getDirectoryHandle('JSON', { create: true });
            await writeJsonToDirectory(jsonFolder, `${trialId}.json`, trialData.trialJson);
            jsonSaved++;
          } catch { failed++; }
        } else {
          skipped++;
        }
      } else {
        // CTIS: English Protocol type 104 only
        const trialResp = await fetchWithRetry(`${API_BASE}/api/retrieve/${trialId}`);
        const trialData = await trialResp.json();
        const docs = trialData.documents || [];
        const protocolDocs = docs.filter(d =>
          d.documentType === '104' &&
          isEnglishDoc(d) &&
          !shouldExcludeDocument(d.title, d.documentType)
        );

        if (protocolDocs.length === 0) {
          skipped++;
        } else {
          const trialDirHandle = await dirHandle.getDirectoryHandle(trialId, { create: true });
          for (const doc of protocolDocs) {
            const filename = `${sanitizeFilename(doc.title)}.pdf`;
            try {
              const docResp = await fetchWithRetry(`${API_BASE}/api/document/${trialId}/${doc.uuid}`);
              await streamToFileInDirectory(trialDirHandle, filename, docResp);
              downloaded++;
            } catch { failed++; }
          }
        }
      }
    } catch { failed++; }

    overlay.querySelector('#batchDl').textContent = downloaded;
    const batchJsonEl = overlay.querySelector('#batchJson');
    if (batchJsonEl) batchJsonEl.textContent = jsonSaved;
    overlay.querySelector('#batchSkip').textContent = skipped;
    overlay.querySelector('#batchFail').textContent = failed;
    await sleep(200);
  }

  state.downloadCount += downloaded;
  if (els.downloadedStat) els.downloadedStat.textContent = state.downloadCount;

  showToast('success', 'Batch Complete', `${downloaded} PDFs • ${jsonSaved} USDM JSON • ${skipped} skipped • ${failed} failed`);

  setTimeout(() => {
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.3s';
    setTimeout(() => overlay.remove(), 300);
  }, 2000);
}

// ═══════════════════════════════════════════
// BULK DOWNLOAD BY THERAPEUTIC AREA
// Full pagination + IndexedDB checkpoint + resume
// ═══════════════════════════════════════════

function buildBulkSearchBody(taCode, indication, page, size) {
  return {
    pagination: { page, size },
    sort: { property: 'decisionDate', direction: 'DESC' },
    searchCriteria: {
      containAll: null, containAny: null, containNot: null,
      title: null, number: null, status: null,
      medicalCondition: indication || null,
      sponsor: null, endPoint: null,
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
    els.btnBulkDownload.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 12h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Start Bulk Download
    `;
    els.bulkTrialInfo.style.display = 'none';
    return;
  }

  const indication = (els.bulkIndication && !els.bulkIndication.disabled) ? els.bulkIndication.value || null : null;

  els.bulkTrialInfo.style.display = 'flex';
  els.bulkTrialInfo.innerHTML = `
    <div class="bulk-info-loading">
      <span class="btn-spinner" style="border-color:rgba(99,102,241,0.3);border-top-color:var(--accent-primary-light)"></span>
      Analyzing therapeutic area scope…
    </div>`;
  
  // Enable button immediately for better visibility (unless we know it's empty)
  els.btnBulkDownload.disabled = false;
  els.btnBulkDownload.innerHTML = `
    <span class="btn-spinner"></span>
    Checking trials…
  `;

  try {
    const body = buildBulkSearchBody(taCode, indication, 1, 1);
    const resp = await fetch(`${API_BASE}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!resp.ok) throw new Error('Count fetch failed');

    const data = await resp.json();
    const total = data.pagination?.totalRecords || 0;
    const taLabel = getTherapeuticAreaLabel(taCode);
    const indicationText = indication ? ` → <strong>${escapeHtml(indication)}</strong>` : '';

    els.bulkTrialInfo.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="flex-shrink:0;opacity:0.7"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.4"/><path d="M7 5v4M7 4v.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      <span>Found <strong>${total.toLocaleString()}</strong> trials matching criteria. Bulk download will proceed with English Protocols ONLY.</span>`;

    els.btnBulkDownload.disabled = total === 0;
    els.btnBulkDownload.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 12h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Start Bulk Download (${total.toLocaleString()} trials)
    `;
  } catch (err) {
    console.warn('Could not fetch trial count for bulk panel:', err);
    els.bulkTrialInfo.innerHTML = `<span style="color:var(--text-muted)">Ready to download — unable to estimate count at this time.</span>`;
    els.btnBulkDownload.disabled = false;
    els.btnBulkDownload.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 12h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Start Bulk Download
    `;
  }
}

// ═══════════════════════════════════════════
// CTG BULK DOWNLOAD — by condition/keyword
// Full cursor pagination + IndexedDB checkpoint + resume
// ═══════════════════════════════════════════

// Priority: custom keyword → indication → TA label
function getCtgBulkCondition() {
  const custom = els.bulkCTGCondition?.value.trim();
  if (custom) return custom;
  const ind = (els.bulkCTGIndication && !els.bulkCTGIndication.disabled) ? els.bulkCTGIndication.value.trim() : '';
  if (ind) return ind;
  const taCode = els.bulkCTGTA?.value;
  if (taCode) return TA_LABELS[taCode] || taCode;
  return '';
}

async function onBulkCTGChange() {
  const condition = getCtgBulkCondition();

  if (!condition) {
    if (els.btnBulkDownloadCTG) {
      els.btnBulkDownloadCTG.disabled = true;
      els.btnBulkDownloadCTG.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 12h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Start Bulk Download`;
    }
    if (els.bulkCTGTrialInfo) els.bulkCTGTrialInfo.style.display = 'none';
    return;
  }

  if (els.bulkCTGTrialInfo) {
    els.bulkCTGTrialInfo.style.display = 'flex';
    els.bulkCTGTrialInfo.innerHTML = `
      <div class="bulk-info-loading">
        <span class="btn-spinner" style="border-color:rgba(99,102,241,0.3);border-top-color:var(--accent-primary-light)"></span>
        Analyzing scope on ClinicalTrials.gov…
      </div>`;
  }
  if (els.btnBulkDownloadCTG) {
    els.btnBulkDownloadCTG.disabled = false;
    els.btnBulkDownloadCTG.innerHTML = `<span class="btn-spinner"></span> Checking…`;
  }

  try {
    const phase = els.bulkCTGPhase?.value || '';

    const resp = await fetch(`${API_BASE}/api/ctg/bulk-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ condition, phase, pageSize: 1 })
    });
    if (!resp.ok) throw new Error('Count fetch failed');

    const data = await resp.json();
    const total = data.totalCount || 0;

    if (els.bulkCTGTrialInfo) {
      els.bulkCTGTrialInfo.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="flex-shrink:0;opacity:0.7"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.4"/><path d="M7 5v4M7 4v.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        <span>Found <strong>${total.toLocaleString()}</strong> studies matching <strong>${escapeHtml(condition)}</strong>. Bulk download will fetch Protocol PDFs only.</span>`;
    }

    if (els.btnBulkDownloadCTG) {
      els.btnBulkDownloadCTG.disabled = total === 0;
      els.btnBulkDownloadCTG.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 12h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Start Bulk Download (${total.toLocaleString()} studies)`;
    }
  } catch (err) {
    if (els.bulkCTGTrialInfo) {
      els.bulkCTGTrialInfo.innerHTML = `<span style="color:var(--text-muted)">Ready to download — unable to estimate count at this time.</span>`;
    }
    if (els.btnBulkDownloadCTG) {
      els.btnBulkDownloadCTG.disabled = false;
      els.btnBulkDownloadCTG.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 12h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Start Bulk Download`;
    }
  }
}

async function bulkDownloadByCTG(arg1 = null) {
  const isSession = arg1 && typeof arg1 === 'object' && arg1.id && arg1.sessionSource === 'ctg';
  const resumeSession = isSession ? arg1 : null;

  const condition = resumeSession ? resumeSession.condition : getCtgBulkCondition();
  if (!condition) return;

  const phase              = resumeSession ? resumeSession.phase              : (els.bulkCTGPhase?.value || '');
  const excludeSuspended   = resumeSession ? resumeSession.excludeSuspended   : (els.bulkCTGExcludeSuspended?.checked ?? true);
  const excludeTerminated  = resumeSession ? resumeSession.excludeTerminated  : (els.bulkCTGExcludeTerminated?.checked ?? true);
  const fallbackJson       = resumeSession ? (resumeSession.fallbackJson ?? true) : (els.bulkCTGFallbackJson?.checked ?? true);
  const taCode             = resumeSession ? resumeSession.taCode             : (els.bulkCTGTA?.value || null);
  const indication         = resumeSession ? resumeSession.indication         : ((els.bulkCTGIndication && !els.bulkCTGIndication.disabled) ? els.bulkCTGIndication.value.trim() || null : null);

  if (!window.showDirectoryPicker) {
    showToast('error', 'Browser Unsupported', 'Folder picker requires Chrome, Edge, or a Chromium-based browser.');
    return;
  }

  let dirHandle;
  try {
    dirHandle = await getDirectoryHandle();
  } catch (err) {
    showToast('error', 'Folder Access Error', 'Unable to access selected folder. Please try again.');
    return;
  }
  if (!dirHandle) return;

  state.bulkCancelled = false;

  let session;
  if (resumeSession) {
    session = { ...resumeSession, status: 'running', resumedAt: Date.now() };
  } else {
    const folderLabel = sanitizeFilename(condition);
    const displayLabel = indication || (taCode ? getTherapeuticAreaLabel(taCode) : condition);
    const folderBase   = indication ? sanitizeFilename(`${getTherapeuticAreaLabel(taCode || '')} - ${indication}`)
                       : taCode     ? sanitizeFilename(getTherapeuticAreaLabel(taCode))
                       :              sanitizeFilename(condition);
    session = {
      id: generateSessionId(),
      sessionSource: 'ctg',
      condition,
      phase,
      excludeSuspended,
      excludeTerminated,
      fallbackJson,
      taCode,
      indication,
      taLabel: displayLabel || condition,
      folderName: folderBase || 'ClinicalTrials-gov',
      status: 'running',
      totalTrials: 0,
      processedCount: 0,
      downloadedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      nonEnCount: 0,
      jsonOnlyCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }
  // Ensure fallbackJson + jsonOnlyCount exist on resumed legacy sessions
  if (session.fallbackJson === undefined) session.fallbackJson = fallbackJson;
  if (session.jsonOnlyCount === undefined) session.jsonOnlyCount = 0;
  await dmSaveSession(session);

  // Build progress overlay
  const overlay = document.createElement('div');
  overlay.className = 'batch-overlay';
  overlay.innerHTML = `
    <div class="batch-card batch-card-wide">
      <h3 class="batch-title">
        ${resumeSession ? '⟳ Resuming' : '⬇ Downloading'} ClinicalTrials.gov Protocols
      </h3>
      <p class="batch-subtitle" id="bpSubtitle">Preparing <strong>${escapeHtml(condition)}</strong>${phase ? ` — Phase ${escapeHtml(phase)}` : ''}…</p>
      <div class="batch-progress-bar"><div class="batch-progress-fill" id="bpFill" style="width:0%"></div></div>
      <div class="bp-current" id="bpCurrent">Fetching study list…</div>
      <div class="batch-stats-wide">
        <div class="batch-stat-item">
          <span class="batch-stat-value" id="bpProcessed">${session.processedCount}</span>
          <span class="batch-stat-label">Processed</span>
        </div>
        <div class="batch-stat-item">
          <span class="batch-stat-value" id="bpDownloaded" style="color:var(--green)">${session.downloadedCount}</span>
          <span class="batch-stat-label">Downloaded</span>
        </div>
        <div class="batch-stat-item">
          <span class="batch-stat-value" id="bpResumed" style="color:var(--accent-primary-light)">${resumeSession ? session.processedCount : 0}</span>
          <span class="batch-stat-label">Resumed</span>
        </div>
        <div class="batch-stat-item">
          <span class="batch-stat-value" id="bpSkipped" style="color:var(--amber)">${session.skippedCount}</span>
          <span class="batch-stat-label">No Protocol</span>
        </div>
        <div class="batch-stat-item">
          <span class="batch-stat-value" id="bpJsonOnly" style="color:var(--accent-primary-light)">${session.jsonOnlyCount || 0}</span>
          <span class="batch-stat-label">USDM JSON</span>
        </div>
        <div class="batch-stat-item">
          <span class="batch-stat-value" id="bpNonEn" style="color:var(--text-muted)">${session.nonEnCount}</span>
          <span class="batch-stat-label">Non-English</span>
        </div>
        <div class="batch-stat-item">
          <span class="batch-stat-value" id="bpFailed" style="color:var(--red)">${session.failedCount}</span>
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
    overlay.querySelector('#bpSubtitle').textContent = 'Cancelling — finishing current study…';
  });

  function updateOverlay() {
    const pct = session.totalTrials > 0 ? ((session.processedCount / session.totalTrials) * 100).toFixed(1) : 0;
    overlay.querySelector('#bpFill').style.width = `${pct}%`;
    overlay.querySelector('#bpProcessed').textContent  = session.processedCount;
    overlay.querySelector('#bpDownloaded').textContent = session.downloadedCount;
    overlay.querySelector('#bpSkipped').textContent    = session.skippedCount;
    const jsonOnlyEl = overlay.querySelector('#bpJsonOnly');
    if (jsonOnlyEl) jsonOnlyEl.textContent = session.jsonOnlyCount || 0;
    overlay.querySelector('#bpNonEn').textContent      = session.nonEnCount;
    overlay.querySelector('#bpFailed').textContent     = session.failedCount;
    if (session.totalTrials > 0) {
      overlay.querySelector('#bpSubtitle').innerHTML =
        `Processing <strong>${session.processedCount.toLocaleString()}</strong> of <strong>${session.totalTrials.toLocaleString()}</strong> studies`;
    }
  }

  // Create condition subfolder
  const taFolder = await dirHandle.getDirectoryHandle(session.folderName, { create: true });

  let nextPageToken = null;
  let isFirstPage   = true;

  try {
    do {
      if (state.bulkCancelled) break;

      const resp = await fetchWithRetry(`${API_BASE}/api/ctg/bulk-search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ condition, phase, pageToken: nextPageToken, pageSize: 100 })
      });
      const data = await resp.json();

      if (isFirstPage) {
        session.totalTrials = data.totalCount || 0;
        isFirstPage = false;
      }

      nextPageToken = data.nextPageToken || null;
      const studies = data.studies || [];

      for (const study of studies) {
        if (state.bulkCancelled) break;

        overlay.querySelector('#bpCurrent').textContent = study.nct;

        const alreadyProcessed = await dmIsProcessed(session.id, study.nct);
        if (alreadyProcessed) {
          const resumeEl = overlay.querySelector('#bpResumed');
          if (resumeEl) resumeEl.textContent = parseInt(resumeEl.textContent || '0') + 1;
          continue;
        }

        // Status exclusions — mirror CTIS exclude toggle behaviour
        const st = (study.overallStatus || '').toUpperCase();
        if (excludeSuspended  && st === 'SUSPENDED')  { session.skippedCount++; session.processedCount++; await dmMarkProcessed(session.id, study.nct); updateOverlay(); continue; }
        if (excludeTerminated && st === 'TERMINATED') { session.skippedCount++; session.processedCount++; await dmMarkProcessed(session.id, study.nct); updateOverlay(); continue; }

        // Always call retrieve — the list API does not return documentSection
        // reliably, and we also need trialJson for the USDM-fallback path.
        let rawDocs = [];
        let trialJson = null;
        try {
          const studyResp = await fetchWithRetry(`${API_BASE}/api/ctg/retrieve/${study.nct}`);
          const studyData = await studyResp.json();
          rawDocs = (studyData.documents || []).filter(d => d.url);
          trialJson = studyData.trialJson || null;
        } catch (e) {
          console.error(`[${study.nct}] retrieve failed:`, e.message);
        }

        const englishDocs = rawDocs.filter(d => isEnglishCtgDoc(d));
        const nonEnCount  = rawDocs.length - englishDocs.length;
        session.nonEnCount += nonEnCount;

        if (englishDocs.length > 0) {
          // PDF available → download PDF(s) only, skip JSON extraction
          for (const doc of englishDocs) {
            const alreadyDl = await dmIsDownloaded(session.id, study.nct, doc.filename);
            if (alreadyDl) continue;

            const filename = `${study.nct}_${sanitizeFilename(doc.filename || 'protocol.pdf')}`;
            try {
              const docResp = await fetchWithRetry(
                `${API_BASE}/api/ctg/proxy-pdf?url=${encodeURIComponent(doc.url)}&filename=${encodeURIComponent(filename)}`
              );
              if (!docResp.ok) {
                console.error(`CTG doc download failed [${study.nct}/${doc.filename}]: ${docResp.status}`);
                session.failedCount++;
                continue;
              }
              await streamToFileInDirectory(taFolder, filename, docResp);
              await dmMarkDownloaded(session.id, study.nct, doc.filename);
              session.downloadedCount++;
              console.log(`✓ CTG PDF Downloaded: ${filename}`);
            } catch (err) {
              console.error(`Failed CTG doc [${study.nct}/${doc.filename}]:`, err.message);
              session.failedCount++;
            }
          }
        } else if (session.fallbackJson && trialJson) {
          // No PDF available → save USDM v4.0 JSON fallback into JSON/ subfolder
          const jsonKey = `${study.nct}__usdm.json`;
          const alreadyDl = await dmIsDownloaded(session.id, study.nct, jsonKey);
          if (!alreadyDl) {
            try {
              const jsonFolder = await taFolder.getDirectoryHandle('JSON', { create: true });
              const jsonFilename = `${study.nct}.json`;
              await writeJsonToDirectory(jsonFolder, jsonFilename, trialJson);
              await dmMarkDownloaded(session.id, study.nct, jsonKey);
              session.jsonOnlyCount++;
              console.log(`✓ CTG USDM JSON saved: ${jsonFilename}`);
            } catch (err) {
              console.error(`Failed CTG JSON fallback [${study.nct}]:`, err.message);
              session.failedCount++;
            }
          }
        } else {
          // No PDF, JSON fallback disabled or unavailable
          session.skippedCount++;
          if (nonEnCount > 0) {
            console.log(`[${study.nct}] Skipped — ${nonEnCount} non-English protocol(s) excluded, JSON fallback off`);
          }
        }

        session.processedCount++;
        session.updatedAt = Date.now();
        await dmMarkProcessed(session.id, study.nct);
        await dmSaveSession(session);
        updateOverlay();
        await sleep(100);
      }

    } while (nextPageToken && !state.bulkCancelled);

  } catch (err) {
    showToast('error', 'Bulk Download Error', err.message);
  }

  // Finalise session
  session.status    = state.bulkCancelled ? 'interrupted' : 'complete';
  session.updatedAt = Date.now();
  await dmSaveSession(session);

  state.downloadCount += session.downloadedCount;
  if (els.downloadedStat) els.downloadedStat.textContent = state.downloadCount;

  const summaryMsg = state.bulkCancelled
    ? `Cancelled — ${session.downloadedCount} PDFs + ${session.jsonOnlyCount || 0} JSON saved. Click Resume to continue.`
    : `${session.downloadedCount} PDFs • ${session.jsonOnlyCount || 0} USDM JSON • ${session.skippedCount} skipped • ${session.nonEnCount} non-English excluded • ${session.failedCount} failed`;

  showToast(
    state.bulkCancelled ? 'info' : 'success',
    state.bulkCancelled ? 'Download Interrupted' : 'Bulk Download Complete',
    summaryMsg
  );

  overlay.querySelector('#bpCurrent').textContent = state.bulkCancelled ? 'Interrupted — use Resume to continue.' : 'Complete!';
  overlay.querySelector('#btnCancelBulk').textContent = 'Close';
  overlay.querySelector('#btnCancelBulk').disabled = false;
  overlay.querySelector('#btnCancelBulk').onclick = () => {
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.3s';
    setTimeout(() => overlay.remove(), 300);
    renderDownloadManager();
  };

  if (!state.bulkCancelled) {
    setTimeout(() => {
      if (overlay.parentNode) {
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity 0.3s';
        setTimeout(() => overlay.remove(), 300);
      }
      renderDownloadManager();
    }, 5000);
  }

  renderDownloadManager();
}

async function bulkDownloadByTA(arg1 = null) {
  // If called from addEventListener, arg1 is an Event. If called from Resume, it's a Session object.
  const isSession = arg1 && typeof arg1 === 'object' && arg1.id && arg1.taCode;
  const resumeSession = isSession ? arg1 : null;

  const taCode = resumeSession ? resumeSession.taCode : els.bulkTA.value;
  if (!taCode) return;

  if (!window.showDirectoryPicker) {
    showToast('error', 'Browser Unsupported', 'Folder picker requires Chrome, Edge, or a Chromium-based browser.');
    return;
  }

  let dirHandle;
  try {
    dirHandle = await getDirectoryHandle();
  } catch (err) {
    console.error('Directory picker error:', err);
    showToast('error', 'Folder Access Error', 'Unable to access selected folder. Please try again.');
    return;
  }
  
  if (!dirHandle) {
    // User cancelled or denied permission
    return;
  }

  const excludeSuspended  = resumeSession ? resumeSession.excludeSuspended  : els.bulkExcludeSuspended.checked;
  const excludeTerminated = resumeSession ? resumeSession.excludeTerminated : els.bulkExcludeTerminated.checked;
  const taLabel           = getTherapeuticAreaLabel(taCode);
  const indication        = resumeSession ? resumeSession.indication
    : (els.bulkIndication && !els.bulkIndication.disabled ? els.bulkIndication.value || null : null);

  state.bulkCancelled = false;

  // ── Create or Resume Session ────────────
  let session;
  if (resumeSession) {
    session = { ...resumeSession, status: 'running', resumedAt: Date.now() };
  } else {
    session = {
      id: generateSessionId(),
      taCode,
      indication,
      taLabel,
      folderName: indication ? sanitizeFilename(`${taLabel} - ${indication}`) : sanitizeFilename(taLabel),
      status: 'running',
      excludeSuspended,
      excludeTerminated,
      totalTrials: 0,
      processedCount: 0,
      downloadedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      nonEnCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }
  await dmSaveSession(session);

  // Build progress overlay
  const overlay = document.createElement('div');
  overlay.className = 'batch-overlay';
  overlay.innerHTML = `
    <div class="batch-card batch-card-wide">
      <h3 class="batch-title">
        ${resumeSession ? '⟳ Resuming' : '⬇ Downloading'} English Protocols
      </h3>
      <p class="batch-subtitle" id="bpSubtitle">Preparing <strong>${escapeHtml(taLabel)}</strong>${indication ? ` — <em>${escapeHtml(indication)}</em>` : ''}…</p>
      <div class="batch-progress-bar"><div class="batch-progress-fill" id="bpFill" style="width:0%"></div></div>
      <div class="bp-current" id="bpCurrent">Fetching trial list…</div>
      <div class="batch-stats-wide">
        <div class="batch-stat-item">
          <span class="batch-stat-value" id="bpProcessed">${session.processedCount}</span>
          <span class="batch-stat-label">Processed</span>
        </div>
        <div class="batch-stat-item">
          <span class="batch-stat-value" id="bpDownloaded" style="color:var(--green)">${session.downloadedCount}</span>
          <span class="batch-stat-label">Downloaded</span>
        </div>
        <div class="batch-stat-item">
          <span class="batch-stat-value" id="bpResumed" style="color:var(--accent-primary-light)">${resumeSession ? session.processedCount : 0}</span>
          <span class="batch-stat-label">Resumed</span>
        </div>
        <div class="batch-stat-item">
          <span class="batch-stat-value" id="bpSkipped" style="color:var(--amber)">${session.skippedCount}</span>
          <span class="batch-stat-label">Skipped</span>
        </div>
        <div class="batch-stat-item">
          <span class="batch-stat-value" id="bpNonEn" style="color:var(--text-muted)">${session.nonEnCount}</span>
          <span class="batch-stat-label">Non-English</span>
        </div>
        <div class="batch-stat-item">
          <span class="batch-stat-value" id="bpFailed" style="color:var(--red)">${session.failedCount}</span>
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

  function updateOverlay() {
    const pct = session.totalTrials > 0 ? ((session.processedCount / session.totalTrials) * 100).toFixed(1) : 0;
    overlay.querySelector('#bpFill').style.width = `${pct}%`;
    overlay.querySelector('#bpProcessed').textContent  = session.processedCount;
    overlay.querySelector('#bpDownloaded').textContent = session.downloadedCount;
    overlay.querySelector('#bpSkipped').textContent    = session.skippedCount;
    overlay.querySelector('#bpNonEn').textContent      = session.nonEnCount;
    overlay.querySelector('#bpFailed').textContent     = session.failedCount;
    if (session.totalTrials > 0) {
      overlay.querySelector('#bpSubtitle').innerHTML =
        `Processing <strong>${session.processedCount.toLocaleString()}</strong> of <strong>${session.totalTrials.toLocaleString()}</strong> trials`;
    }
  }

  // Create TA subfolder in chosen directory
  const taFolder = await dirHandle.getDirectoryHandle(session.folderName, { create: true });

  let pageNum = 1;
  const PAGE_SIZE = 50;
  let totalPages = 1;

  try {
    do {
      if (state.bulkCancelled) break;

      const body = buildBulkSearchBody(taCode, indication, pageNum, PAGE_SIZE);
      const resp = await fetchWithRetry(`${API_BASE}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await resp.json();

      session.totalTrials = data.pagination?.totalRecords || 0;
      totalPages          = data.pagination?.totalPages   || 1;
      const trials        = data.data || [];

      for (const trial of trials) {
        if (state.bulkCancelled) break;

        overlay.querySelector('#bpCurrent').textContent = trial.ctNumber;

        // Skip if already fully processed in this session
        const alreadyProcessed = await dmIsProcessed(session.id, trial.ctNumber);
        if (alreadyProcessed) {
          // Count it but don't re-download
          const resumeEl = overlay.querySelector('#bpResumed');
          if (resumeEl) resumeEl.textContent = parseInt(resumeEl.textContent || 0) + 1;
          continue;
        }

        // Status exclusions
        if (excludeSuspended  && trial.ctStatus === 8)  { session.skippedCount++; session.processedCount++; await dmMarkProcessed(session.id, trial.ctNumber); updateOverlay(); continue; }
        if (excludeTerminated && trial.ctStatus === 9)  { session.skippedCount++; session.processedCount++; await dmMarkProcessed(session.id, trial.ctNumber); updateOverlay(); continue; }

        try {
          const trialResp = await fetchWithRetry(`${API_BASE}/api/retrieve/${trial.ctNumber}`);
          const trialData = await trialResp.json();
          const docs = trialData.documents || [];

          // Debug: Log all documents found
          if (docs.length > 0) {
            console.log(`[${trial.ctNumber}] Found ${docs.length} total documents. Types: ${docs.map(d => d.documentType).join(', ')}`);
          }

          // STRICT: Type 104 (Protocol), English ONLY, skip D2/D3/D4 and other excluded types
          const allProtocols   = docs.filter(d => d.documentType === '104' || String(d.documentType) === '104');
          
          // Double-check: exclude any document with D2, D3, D4 in title or type
          const englishDocs    = allProtocols.filter(d => {
            const isExcluded = shouldExcludeDocument(d.title, d.documentType);
            const hasExcludedType = ['D2', 'D3', 'D4'].some(type => 
              String(d.documentType).toUpperCase().includes(type) || 
              (d.title && d.title.toUpperCase().includes(type))
            );
            const isD1WithGreOrTrack = d.documentType === 'D1' && d.title && /(?:GRE|Track)/i.test(d.title);
            return isEnglishDoc(d) && !isExcluded && !hasExcludedType && !isD1WithGreOrTrack;
          });
          
          const nonEnCount     = allProtocols.length - englishDocs.length;
          session.nonEnCount  += nonEnCount;

          if (allProtocols.length > 0 && englishDocs.length > 0) {
            console.log(`[${trial.ctNumber}] After filtering: ${englishDocs.length}/${allProtocols.length} documents kept`);
          }

          if (englishDocs.length === 0) {
            session.skippedCount++;
          } else {
            // Flattened: All documents in one folder, prefixed with CT number
            for (const doc of englishDocs) {
              // Skip if this specific doc was already downloaded in this session
              const alreadyDl = await dmIsDownloaded(session.id, trial.ctNumber, doc.uuid);
              if (alreadyDl) continue;

              const filename = `${trial.ctNumber}_${sanitizeFilename(doc.title)}.pdf`;
              try {
                const docResp = await fetchWithRetry(`${API_BASE}/api/document/${trial.ctNumber}/${doc.uuid}`);
                if (!docResp.ok) {
                  console.error(`Document download failed [${trial.ctNumber}/${doc.uuid}]: ${docResp.status}`);
                  session.failedCount++;
                  continue;
                }
                await streamToFileInDirectory(taFolder, filename, docResp);
                await dmMarkDownloaded(session.id, trial.ctNumber, doc.uuid);
                session.downloadedCount++;
                console.log(`✓ Downloaded: ${filename}`);
              } catch (err) {
                console.error(`Failed to download [${trial.ctNumber}/${doc.uuid}]:`, err.message);
                session.failedCount++;
              }
            }
          }
        } catch {
          session.failedCount++;
        }

        session.processedCount++;
        session.updatedAt = Date.now();
        await dmMarkProcessed(session.id, trial.ctNumber);
        await dmSaveSession(session);
        updateOverlay();
        await sleep(150);
      }

      pageNum++;
    } while (pageNum <= totalPages && !state.bulkCancelled);

  } catch (err) {
    showToast('error', 'Bulk Download Error', err.message);
  }

  // Finalise session
  session.status    = state.bulkCancelled ? 'interrupted' : 'complete';
  session.updatedAt = Date.now();
  await dmSaveSession(session);

  state.downloadCount += session.downloadedCount;
  if (els.downloadedStat) els.downloadedStat.textContent = state.downloadCount;

  const summaryMsg = state.bulkCancelled
    ? `Cancelled — ${session.downloadedCount} protocols saved. Click Resume to continue.`
    : `${session.downloadedCount} English protocols saved • ${session.skippedCount} skipped • ${session.nonEnCount} non-English excluded • ${session.failedCount} failed`;

  showToast(
    state.bulkCancelled ? 'info' : 'success',
    state.bulkCancelled ? 'Download Interrupted' : 'Bulk Download Complete',
    summaryMsg
  );

  overlay.querySelector('#bpCurrent').textContent = state.bulkCancelled ? 'Interrupted — use Resume to continue.' : 'Complete!';
  overlay.querySelector('#btnCancelBulk').textContent = 'Close';
  overlay.querySelector('#btnCancelBulk').disabled = false;
  overlay.querySelector('#btnCancelBulk').onclick = () => {
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.3s';
    setTimeout(() => overlay.remove(), 300);
    renderDownloadManager();
  };

  if (!state.bulkCancelled) {
    setTimeout(() => {
      if (overlay.parentNode) {
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity 0.3s';
        setTimeout(() => overlay.remove(), 300);
      }
      renderDownloadManager();
    }, 5000);
  }

  renderDownloadManager();
}

// ═══════════════════════════════════════════
// DOWNLOAD MANAGER UI — Session Panel
// ═══════════════════════════════════════════

async function renderDownloadManager() {
  const list  = els.dmSessionList;
  const empty = els.dmEmpty;
  if (!list) return;

  const sessions = await dmGetAllSessions();
  // Sort: running first, then interrupted, then complete; newest first within group
  sessions.sort((a, b) => {
    const order = { running: 0, interrupted: 1, complete: 2 };
    const od = (order[a.status] || 0) - (order[b.status] || 0);
    if (od !== 0) return od;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  if (sessions.length === 0) {
    empty.style.display = 'flex';
    list.innerHTML = '';
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = sessions.map(s => {
    const pct = s.totalTrials > 0 ? ((s.processedCount / s.totalTrials) * 100).toFixed(1) : 0;
    const statusBadge = {
      running:     '<span class="dm-badge dm-badge-running">Running</span>',
      interrupted: '<span class="dm-badge dm-badge-interrupted">Interrupted</span>',
      complete:    '<span class="dm-badge dm-badge-complete">Complete</span>'
    }[s.status] || '';

    const updatedStr = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '';

    const isCTGSession = s.sessionSource === 'ctg';
    const sourceTag = isCTGSession
      ? `<span class="dm-source-tag">ClinicalTrials.gov</span>`
      : `<span class="dm-source-tag">EU CTIS</span>`;

    return `
      <div class="dm-session-row" data-session-id="${s.id}">
        <div class="dm-session-header">
          <div class="dm-session-info">
            ${statusBadge}
            ${sourceTag}
            <span class="dm-ta-label">${escapeHtml(s.taLabel || s.taCode || s.condition || '')}</span>
            ${s.indication ? `<span class="dm-indication-label">→ ${escapeHtml(s.indication)}</span>` : ''}
            ${s.phase ? `<span class="dm-indication-label">Phase ${escapeHtml(s.phase)}</span>` : ''}
          </div>
          <div class="dm-session-actions">
            ${s.status === 'interrupted' ? `<button class="btn-resume" data-session-id="${s.id}">⟳ Resume</button>` : ''}
            <button class="btn-clear-session" data-session-id="${s.id}" title="Remove session">✕</button>
          </div>
        </div>
        <div class="dm-progress-bar">
          <div class="dm-progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="dm-stats-row">
          <span><strong>${s.processedCount.toLocaleString()}</strong> / ${s.totalTrials.toLocaleString()} ${isCTGSession ? 'studies' : 'trials'}</span>
          <span style="color:var(--green)">⬇ ${s.downloadedCount.toLocaleString()} PDFs</span>
          ${isCTGSession ? `<span style="color:var(--accent-primary-light)">📄 ${(s.jsonOnlyCount || 0).toLocaleString()} USDM JSON</span>` : ''}
          <span style="color:var(--amber)">⊘ ${s.skippedCount.toLocaleString()} skipped</span>
          <span style="color:var(--text-muted)">🌐 ${(s.nonEnCount || 0).toLocaleString()} non-EN</span>
          <span style="color:var(--red)">✕ ${s.failedCount.toLocaleString()} failed</span>
          ${updatedStr ? `<span class="dm-timestamp">${updatedStr}</span>` : ''}
        </div>
      </div>`;
  }).join('');

  // Bind Resume buttons
  list.querySelectorAll('.btn-resume').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sid = btn.dataset.sessionId;
      const sessions = await dmGetAllSessions();
      const session  = sessions.find(s => s.id === sid);
      if (!session) return;
      if (session.sessionSource === 'ctg') {
        bulkDownloadByCTG(session);
      } else {
        bulkDownloadByTA(session);
      }
    });
  });

  // Bind Clear buttons
  list.querySelectorAll('.btn-clear-session').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sid = btn.dataset.sessionId;
      await dmDeleteSession(sid);
      renderDownloadManager();
    });
  });
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
function showToast(type, title, msg, duration) {
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || 'ℹ'}</div>
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(title)}</div>
      ${msg ? `<div class="toast-msg">${escapeHtml(msg)}</div>` : ''}
    </div>`;
  els.toastContainer.appendChild(toast);
  const delay = duration || 5000;
  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  }, delay);
}

// ── Utilities ──────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sanitizeFilename(str) {
  return (str || '').replace(/[/\\?%*:|"<>]/g, '-').trim();
}

function getTherapeuticAreaLabel(code) {
  return TA_LABELS[code] ? `${TA_LABELS[code]} [${code}]` : code;
}

// ── isEnglishDoc — strict English-only check ───────
// ONLY passes if document language is English.
// Strict: Only accept truly English documents
// Checks both explicit language metadata and title markers
function isEnglishDoc(doc) {
  // English language codes that are acceptable
  const englishCodes = ['en', 'english', 'eng', 'en-us', 'en-gb', 'en_us', 'en_gb'];
  
  if (doc.language) {
    const lang = doc.language.toLowerCase().trim();
    // Only accept if explicitly English
    if (!englishCodes.includes(lang) && !lang.startsWith('en-') && !lang.startsWith('en_')) {
      // Language is explicitly set to non-English
      return false;
    }
  }
  
  // Check title for non-English language markers
  if (doc.title) {
    const t = doc.title.toUpperCase();
    
    // ALL non-English language codes (expanded list with multiple patterns)
    const nonEnMarkers = [
      // Common separators with language codes
      ' - DE', ' - FR', ' - ES', ' - IT', ' - PT', ' - NL', ' - PL',
      ' - SV', ' - DA', ' - FI', ' - NO', ' - CS', ' - HU', ' - RO',
      ' - BG', ' - HR', ' - SK', ' - SL', ' - LT', ' - LV', ' - ET',
      ' - RU', ' - TR', ' - GR', ' - EL', ' - JA', ' - ZH', ' - KO',
      // Parentheses patterns
      '(DE)', '(FR)', '(ES)', '(IT)', '(PT)', '(NL)', '(PL)', '(FI)',
      '(BG)', '(HR)', '(SK)', '(SL)', '(RU)', '(TR)', '(GR)', '(EL)',
      // Underscore patterns
      '_DE', '_FR', '_ES', '_IT', '_PT', '_NL', '_PL',
      '_BG', '_ES', '_FR',' _IT',
      // All uppercase codes without separators at end of string (risky but catches more)
      ' DE.', ' FR.', ' ES.', ' IT.', ' PT.', ' NL.', ' PL.',
      ' BG.', ' HR.', ' SK.', ' CS.', ' RO.', ' RU.', ' TR.'
    ];
    
    for (const m of nonEnMarkers) {
      if (t.includes(m)) return false;
    }
  }
  
  return true; // Accept if no non-EN markers found
}

// ── isEnglishCtgDoc — English-only + content exclusion check for CTG docs ──
// CTG docs have no language field; we inspect label + filename for
// non-English markers using the same pattern set as isEnglishDoc (CTIS).
// Also excludes documents with 'clarification' or 'ELL' tokens in the
// title/filename (request clarifications, standalone ELL packages).
function isEnglishCtgDoc(doc) {
  const text = [(doc.label || ''), (doc.filename || '')].join(' ').toUpperCase();

  const nonEnMarkers = [
    // Dash-separated language codes
    ' - DE', ' - FR', ' - ES', ' - IT', ' - PT', ' - NL', ' - PL',
    ' - SV', ' - DA', ' - FI', ' - NO', ' - CS', ' - HU', ' - RO',
    ' - BG', ' - HR', ' - SK', ' - SL', ' - LT', ' - LV', ' - ET',
    ' - RU', ' - TR', ' - GR', ' - EL', ' - JA', ' - ZH', ' - KO',
    // Parenthesised codes
    '(DE)', '(FR)', '(ES)', '(IT)', '(PT)', '(NL)', '(PL)', '(FI)',
    '(BG)', '(HR)', '(SK)', '(SL)', '(RU)', '(TR)', '(GR)', '(EL)',
    // Underscore codes (common in filenames)
    '_DE_', '_FR_', '_ES_', '_IT_', '_PT_', '_NL_', '_PL_',
    '_DE.', '_FR.', '_ES.', '_IT.', '_PT.', '_NL.', '_PL.',
    // Non-English label words — common protocol label translations
    'STUDIENPROTOKOLL', 'STUDIEPROTOKOL', 'PROTOCOLO', 'PROTOCOLE',
    'PROTOCOLLO', 'PROTOKOL', 'PRÜFPLAN', 'PRUEFPLAN',
    'STUDIEPROTOCOL', 'KLINIK PROTOKOL'
  ];
  if (nonEnMarkers.some(m => text.includes(m))) return false;

  // Content-type exclusions — skip clarification docs and ELL packages.
  // 'CLARIFICATION' is safe as substring. 'ELL' must be word-bounded to
  // avoid false positives like SELL, CELLULAR, BELL, WELL, etc.
  if (text.includes('CLARIFICATION')) return false;
  if (/(^|[\s._\-()\[\]/\\])ELL($|[\s._\-()\[\]/\\])/.test(text)) return false;

  return true;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
