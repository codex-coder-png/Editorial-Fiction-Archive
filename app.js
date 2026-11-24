/* ==========================================================================
   MARGIN ARCHIVE — CLIENT ENGINE
   - Cross-version persistent account linking (localStorage + IndexedDB + Sync Tokens)
   - Hybrid Online/Offline Sync (GitHub static archive.json + Cloud REST Relay + Local Cache)
   - Post-publish re-editing for authors
   - Single-kudos toggle (1 per user per story, toggleable off)
   - JSON story upload & export
   - Page-by-page PNG rendering into auto-named ZIP archive via JSZip
   - 1.0-second smooth theme cycler
   ========================================================================== */

const STORAGE_KEYS = {
  ACCOUNTS: 'margin_global_accounts_v1',
  SESSION: 'margin_active_session_v1',
  WORKS: 'margin_archive_works_v1',
  BOOKMARKS: 'margin_user_bookmarks_v1',
  HIGHLIGHTS: 'margin_user_highlights_v1',
  PLACE: 'margin_reading_place_v1',
  MUTED_TAGS: 'margin_muted_tags_v1',
  THEME_IDX: 'margin_theme_index_v1',
  CUSTOM_COLORS: 'margin_custom_colors_v1',
  RELAY_CFG: 'margin_relay_config_v1'
};

const THEME_PRESETS = [
  {
    name: 'Archival Crimson',
    bg: '#faf7f2',
    surface: '#ffffff',
    surfaceAlt: '#f3ede4',
    text: '#1c1917',
    textMuted: '#57534e',
    accent: '#991b1b',
    accentContrast: '#ffffff',
    border: '#e2d9ce',
    tagBg: '#f1e9df',
    tagText: '#44403c'
  },
  {
    name: 'Vellum Sepia Book',
    bg: '#f4ecd8',
    surface: '#fbf6ea',
    surfaceAlt: '#ece0c6',
    text: '#2c2219',
    textMuted: '#665341',
    accent: '#7c2d12',
    accentContrast: '#ffffff',
    border: '#dccba9',
    tagBg: '#eadcc1',
    tagText: '#4a3a2a'
  },
  {
    name: 'Midnight Obsidian',
    bg: '#0f1115',
    surface: '#171a21',
    surfaceAlt: '#20242e',
    text: '#e7e9ee',
    textMuted: '#9aa1b2',
    accent: '#e11d48',
    accentContrast: '#ffffff',
    border: '#2b303d',
    tagBg: '#232834',
    tagText: '#cbd5e1'
  },
  {
    name: 'Bodleian Slate',
    bg: '#131b24',
    surface: '#1b2633',
    surfaceAlt: '#243242',
    text: '#edf2f7',
    textMuted: '#9fb3c8',
    accent: '#38bdf8',
    accentContrast: '#0f172a',
    border: '#2f4156',
    tagBg: '#223040',
    tagText: '#bae6fd'
  },
  {
    name: 'Forest Library',
    bg: '#111916',
    surface: '#182420',
    surfaceAlt: '#21312b',
    text: '#e8f0ec',
    textMuted: '#9cb3a8',
    accent: '#34d399',
    accentContrast: '#06281e',
    border: '#2b4038',
    tagBg: '#1f3029',
    tagText: '#a7f3d0'
  }
];

const CANONICAL_TAGS = {
  'slowburn': 'Slow Burn',
  'slow-burn': 'Slow Burn',
  'enemies to lovers': 'Enemies to Lovers',
  'enemiestolovers': 'Enemies to Lovers',
  'found family': 'Found Family',
  'foundfamily': 'Found Family',
  '3rdperson': '3rdPerson',
  'original work': 'Original Work'
};

let state = {
  currentUser: null,
  works: [],
  includeTags: [],
  excludeTags: [],
  mutedTags: [],
  bookmarks: [],
  highlights: [],
  currentWorkId: null,
  currentChapterIdx: 0,
  unlockedWorkIds: new Set(),
  editingWorkId: null,
  editorChapters: [],
  editorActiveChapIdx: 0,
  editorTags: [],
  themeIndex: 0,
  shareTargetWorkId: null
};

let currentWorkId = null;
let authMode = 'register';

/* ==========================================================================
   INITIALIZATION & CROSS-VERSION ACCOUNT LINKING
   ========================================================================== */
window.addEventListener('DOMContentLoaded', async () => {
  loadTheme();
  loadUserLists();
  await hydrateAccountsFromIndexedDB();

  // Check if URL has a shared story hash (#story=...)
  const importedFromHash = checkURLHashForSharedStory();

  // Load local cached works (Starts completely empty — zero prebuilt works)
  const rawWorks = localStorage.getItem(STORAGE_KEYS.WORKS);
  state.works = rawWorks ? JSON.parse(rawWorks) : [];

  if (importedFromHash) {
    upsertWork(importedFromHash);
  }

  // Attempt automatic fetch of static archive.json if hosted on GitHub Pages + Online Relay
  await syncOnlineRelay(false);

  // Restore linked account session across versions automatically
  const savedSession = localStorage.getItem(STORAGE_KEYS.SESSION);
  const accounts = getStoredAccounts();

  if (savedSession) {
    const parsed = JSON.parse(savedSession);
    const matched = accounts.find(a => a.username.toLowerCase() === parsed.username.toLowerCase());
    if (matched) {
      state.currentUser = matched;
      enterApp();
      return;
    } else if (parsed && parsed.username) {
      // Re-link automatically if session survived storage migration
      accounts.push(parsed);
      saveStoredAccounts(accounts);
      state.currentUser = parsed;
      enterApp();
      return;
    }
  }

  // Show mandatory registration/sign-in gate
  document.getElementById('auth-gate').classList.remove('hidden');
});

function getStoredAccounts() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.ACCOUNTS) || '[]');
  } catch {
    return [];
  }
}

function saveStoredAccounts(accounts) {
  localStorage.setItem(STORAGE_KEYS.ACCOUNTS, JSON.stringify(accounts));
  mirrorAccountsToIndexedDB(accounts);
}

/* IndexedDB Secondary Persistence so accounts survive version/file updates */
function openMarginDB() {
  return new Promise((resolve) => {
    if (!window.indexedDB || window.location.protocol === 'file:') return resolve(null);
    const req = indexedDB.open('MarginArchivePersistentDB', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function mirrorAccountsToIndexedDB(accounts) {
  const db = await openMarginDB();
  if (!db) return;
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put(accounts, 'linked_accounts');
}

async function hydrateAccountsFromIndexedDB() {
  const db = await openMarginDB();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get('linked_accounts');
    req.onsuccess = () => {
      if (Array.isArray(req.result) && req.result.length > 0) {
        const local = getStoredAccounts();
        const merged = [...local];
        req.result.forEach(acc => {
          if (!merged.some(m => m.username.toLowerCase() === acc.username.toLowerCase())) {
            merged.push(acc);
          }
        });
        localStorage.setItem(STORAGE_KEYS.ACCOUNTS, JSON.stringify(merged));
      }
      resolve();
    };
    req.onerror = () => resolve();
  });
}

function switchAuthTab(mode) {
  authMode = mode;
  document.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-${mode}`).classList.add('active');
  document.getElementById('auth-error').classList.add('hidden');

  const stdFields = document.getElementById('auth-fields-standard');
  const regExtra = document.getElementById('auth-register-extra');
  const linkFields = document.getElementById('auth-fields-link');
  const submitBtn = document.getElementById('auth-submit-btn');

  if (mode === 'register') {
    stdFields.classList.remove('hidden');
    regExtra.classList.remove('hidden');
    linkFields.classList.add('hidden');
    submitBtn.textContent = 'Create & Link Account';
  } else if (mode === 'login') {
    stdFields.classList.remove('hidden');
    regExtra.classList.add('hidden');
    linkFields.classList.add('hidden');
    submitBtn.textContent = 'Sign In to Linked Account';
  } else {
    stdFields.classList.add('hidden');
    linkFields.classList.remove('hidden');
    submitBtn.textContent = 'Restore & Link Account Token';
  }
}

function handleAuthSubmit(e) {
  e.preventDefault();
  const errBox = document.getElementById('auth-error');
  errBox.classList.add('hidden');
  const accounts = getStoredAccounts();

  if (authMode === 'link') {
    const raw = document.getElementById('auth-sync-token').value.trim();
    if (!raw.startsWith('MARGIN-ID-')) {
      errBox.textContent = 'Invalid Account Sync Token. Must start with MARGIN-ID-.';
      errBox.classList.remove('hidden');
      return;
    }
    try {
      const decoded = JSON.parse(decodeURIComponent(escape(atob(raw.replace('MARGIN-ID-', '')))));
      if (!decoded.username) throw new Error('Malformed');
      const idx = accounts.findIndex(a => a.username.toLowerCase() === decoded.username.toLowerCase());
      if (idx >= 0) accounts[idx] = decoded;
      else accounts.push(decoded);
      saveStoredAccounts(accounts);
      loginUser(decoded);
      showToast(`Linked account "${decoded.username}" across versions.`);
    } catch {
      errBox.textContent = 'Could not decode Account Sync Token.';
      errBox.classList.remove('hidden');
    }
    return;
  }

  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;

  if (!username || !password) {
    errBox.textContent = 'Please enter both a handle and a passcode.';
    errBox.classList.remove('hidden');
    return;
  }

  if (authMode === 'register') {
    const existing = accounts.find(a => a.username.toLowerCase() === username.toLowerCase());
    if (existing) {
      // Automatically link if passcode matches
      if (existing.password === password) {
        loginUser(existing);
        showToast(`Existing account "${existing.username}" linked!`);
        return;
      }
      errBox.textContent = 'That handle is already registered. Switch to Sign In or use a different handle.';
      errBox.classList.remove('hidden');
      return;
    }
    const pseud = document.getElementById('auth-pseud').value.trim() || username;
    const bio = document.getElementById('auth-bio').value.trim();
    const newAccount = {
      id: 'usr-' + Date.now(),
      username,
      password,
      pseud,
      bio,
      joined: new Date().toISOString().split('T')[0]
    };
    accounts.push(newAccount);
    saveStoredAccounts(accounts);
    loginUser(newAccount);
  } else {
    const found = accounts.find(
      a => a.username.toLowerCase() === username.toLowerCase() && a.password === password
    );
    if (!found) {
      errBox.textContent = 'Invalid handle or passcode.';
      errBox.classList.remove('hidden');
      return;
    }
    loginUser(found);
  }
}

function loginUser(account) {
  state.currentUser = account;
  localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify(account));
  enterApp();
}

function logoutAccount() {
  localStorage.removeItem(STORAGE_KEYS.SESSION);
  state.currentUser = null;
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('auth-gate').classList.remove('hidden');
}

function enterApp() {
  document.getElementById('auth-gate').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  document.getElementById('welcome-heading').textContent = `Welcome back, ${state.currentUser.pseud || state.currentUser.username}`;
  checkResumeBanner();
  renderFeed();
}

/* ==========================================================================
   1-SECOND SMOOTH CYCLING THEME SWITCHER & COLOR STUDIO
   ========================================================================== */
function loadTheme() {
  const savedIdx = parseInt(localStorage.getItem(STORAGE_KEYS.THEME_IDX) || '0', 10);
  state.themeIndex = isNaN(savedIdx) ? 0 : savedIdx % THEME_PRESETS.length;
  applyThemePreset(state.themeIndex, false);

  const customRaw = localStorage.getItem(STORAGE_KEYS.CUSTOM_COLORS);
  if (customRaw) {
    const custom = JSON.parse(customRaw);
    Object.entries(custom).forEach(([k, v]) => setCSSColorToken(k, v));
  }
  renderThemePresetsGrid();
}

function cycleThemeSmooth() {
  localStorage.removeItem(STORAGE_KEYS.CUSTOM_COLORS);
  state.themeIndex = (state.themeIndex + 1) % THEME_PRESETS.length;
  localStorage.setItem(STORAGE_KEYS.THEME_IDX, String(state.themeIndex));
  applyThemePreset(state.themeIndex, true);
}

function applyThemePreset(idx, announce = true) {
  const p = THEME_PRESETS[idx];
  const root = document.documentElement.style;
  root.setProperty('--bg', p.bg);
  root.setProperty('--surface', p.surface);
  root.setProperty('--surface-alt', p.surfaceAlt);
  root.setProperty('--text', p.text);
  root.setProperty('--text-muted', p.textMuted);
  root.setProperty('--accent', p.accent);
  root.setProperty('--accent-contrast', p.accentContrast);
  root.setProperty('--border', p.border);
  root.setProperty('--tag-bg', p.tagBg);
  root.setProperty('--tag-text', p.tagText);

  const lbl = document.getElementById('theme-cycle-label');
  if (lbl) lbl.textContent = p.name;

  // Sync color pickers in settings
  const map = { 'cfg-accent': p.accent, 'cfg-bg': p.bg, 'cfg-surface': p.surface, 'cfg-text': p.text, 'cfg-tagBg': p.tagBg };
  Object.entries(map).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  });

  if (announce) showToast(`Style shifted to: ${p.name}`);
}

function applyCustomColor(token, hex) {
  setCSSColorToken(token, hex);
  const current = JSON.parse(localStorage.getItem(STORAGE_KEYS.CUSTOM_COLORS) || '{}');
  current[token] = hex;
  localStorage.setItem(STORAGE_KEYS.CUSTOM_COLORS, JSON.stringify(current));
}

function setCSSColorToken(token, hex) {
  const map = {
    accent: '--accent',
    bg: '--bg',
    surface: '--surface',
    text: '--text',
    tagBg: '--tag-bg'
  };
  if (map[token]) {
    document.documentElement.style.setProperty(map[token], hex);
  }
}

function renderThemePresetsGrid() {
  const grid = document.getElementById('theme-presets-grid');
  if (!grid) return;
  grid.innerHTML = THEME_PRESETS.map((p, i) => `
    <button class="preset-btn" onclick="localStorage.removeItem('${STORAGE_KEYS.CUSTOM_COLORS}'); state.themeIndex=${i}; localStorage.setItem('${STORAGE_KEYS.THEME_IDX}', '${i}'); applyThemePreset(${i}, true)">
      <span style="width:14px;height:14px;border-radius:50%;background:${p.accent};border:1px solid ${p.border};display:inline-block;"></span>
      ${p.name}
    </button>
  `).join('');
}

/* ==========================================================================
   HYBRID ONLINE SERVER & OFFLINE SYNC (GITHUB STATIC + CLOUD RELAY)
   ========================================================================== */
function getRelayConfig() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.RELAY_CFG) || '{"mode":"hybrid","url":"","key":""}');
  } catch {
    return { mode: 'hybrid', url: '', key: '' };
  }
}

function saveRelayConfig() {
  const cfg = {
    mode: document.getElementById('relay-mode').value,
    url: document.getElementById('relay-url').value.trim(),
    key: document.getElementById('relay-key').value.trim()
  };
  localStorage.setItem(STORAGE_KEYS.RELAY_CFG, JSON.stringify(cfg));
  showToast('Online relay configuration saved.');
}

async function syncOnlineRelay(manual = false) {
  const badge = document.getElementById('server-status-badge');
  const cfg = getRelayConfig();

  // 1. Try loading static archive.json over http/https (zero-config online posts)
  if (window.location.protocol !== 'file:') {
    try {
      const staticRes = await fetch('./archive.json', { cache: 'no-store' });
      if (staticRes.ok) {
        const staticData = await staticRes.json();
        const incoming = Array.isArray(staticData) ? staticData : (staticData.works || []);
        mergeIncomingWorks(incoming);
      }
    } catch {
      // No archive.json present
    }
  }

  // 2. If configured with a live REST relay (e.g., JSONBin.io), pull & push works
  if (cfg.mode === 'hybrid' && cfg.url) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (cfg.key) headers['X-Master-Key'] = cfg.key;
      const res = await fetch(cfg.url, { headers });
      if (res.ok) {
        const payload = await res.json();
        const remoteWorks = Array.isArray(payload) ? payload : (payload.record?.works || payload.works || []);
        mergeIncomingWorks(remoteWorks);

        // Push merged archive back so other visitors see new posts
        await fetch(cfg.url, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ works: state.works, updatedAt: new Date().toISOString() })
        });
        if (badge) badge.textContent = '● Online & Cached';
        if (manual) showToast('Synced with online server!');
        renderFeed();
        return;
      }
    } catch {
      if (badge) badge.textContent = '● Offline Cache';
      if (manual) showToast('Offline mode active — changes cached locally.');
      return;
    }
  }

  if (badge) {
    badge.textContent = navigator.onLine ? '● GitHub / Local Sync' : '● Offline Cache';
  }
  if (manual) showToast('Archive refreshed from local & static sources.');
  renderFeed();
}

function mergeIncomingWorks(incomingList) {
  if (!Array.isArray(incomingList)) return;
  let changed = false;
  incomingList.forEach(w => {
    if (!w || !w.id || !w.title) return;
    const idx = state.works.findIndex(existing => existing.id === w.id);
    if (idx === -1) {
      state.works.unshift(w);
      changed = true;
    } else if ((w.updatedAt || w.date || '') > (state.works[idx].updatedAt || state.works[idx].date || '')) {
      state.works[idx] = w;
      changed = true;
    }
  });
  if (changed) {
    persistWorks(false);
  }
}

function persistWorks(pushRemote = true) {
  localStorage.setItem(STORAGE_KEYS.WORKS, JSON.stringify(state.works));
  if (pushRemote) {
    const cfg = getRelayConfig();
    if (cfg.mode === 'hybrid' && cfg.url) {
      syncOnlineRelay(false);
    }
  }
}

function exportArchiveSnapshotFile() {
  const blob = new Blob([JSON.stringify({ works: state.works }, null, 2)], { type: 'application/json' });
  triggerDownload(blob, 'archive.json');
  showToast('Downloaded archive.json — commit to your GitHub repo root for global readers!');
}

/* ==========================================================================
   JSON STORY UPLOADER (COMPATIBLE WITH UPLOADED STORY JSON FORMAT)
   ========================================================================== */
function uploadStoryJSON(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      const stories = Array.isArray(parsed) ? parsed : (parsed.works ? parsed.works : [parsed]);
      let importedCount = 0;

      stories.forEach(raw => {
        if (!raw || !raw.title || !Array.isArray(raw.chapters)) return;
        const normalized = normalizeStoryObject(raw);
        upsertWork(normalized);
        importedCount++;
      });

      if (importedCount === 0) {
        showToast('Invalid story JSON structure.');
      } else {
        renderFeed();
        showToast(`Uploaded ${importedCount} work(s) into the archive!`);
      }
    } catch {
      showToast('Could not parse JSON file.');
    }
    event.target.value = '';
  };
  reader.readAsText(file);
}

function normalizeStoryObject(raw) {
  const chapters = (raw.chapters || []).map((ch, idx) => ({
    title: ch.title || `Chapter ${idx + 1}`,
    notesTop: ch.notesTop || '',
    notesBottom: ch.notesBottom || '',
    content: ch.content || '<p></p>'
  }));

  const wordCount = raw.wordCount || computeChaptersWordCount(chapters);
  return {
    id: raw.id || 'work-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    title: raw.title,
    author: raw.author || (state.currentUser ? state.currentUser.username : 'Archivist'),
    pseud: raw.isAnonymous ? 'Anonymous Writer' : (raw.pseud || raw.author || 'Archivist'),
    isAnonymous: Boolean(raw.isAnonymous),
    fandom: raw.fandom || 'Original Work',
    rating: raw.rating || 'Not Rated',
    category: raw.category || 'Gen',
    warning: raw.warning || 'No Archive Warnings Apply',
    isComplete: raw.isComplete !== undefined ? Boolean(raw.isComplete) : true,
    tags: Array.isArray(raw.tags) ? raw.tags.map(canonicalizeTag) : [],
    summary: raw.summary || '',
    spineColor: raw.spineColor || '#991b1b',
    chapters,
    date: raw.date || new Date().toISOString().split('T')[0],
    updatedAt: new Date().toISOString(),
    wordCount,
    kudosUsers: Array.isArray(raw.kudosUsers) ? raw.kudosUsers : [],
    kudos: Array.isArray(raw.kudosUsers) ? raw.kudosUsers.length : (raw.kudos || 0),
    password: raw.password || '',
    passwordHint: raw.passwordHint || '',
    comments: Array.isArray(raw.comments) ? raw.comments : []
  };
}

function upsertWork(work) {
  const idx = state.works.findIndex(w => w.id === work.id);
  if (idx >= 0) {
    state.works[idx] = work;
  } else {
    state.works.unshift(work);
  }
  persistWorks(true);
}

/* ==========================================================================
   NAVIGATION & MAIN ARCHIVE FEED RENDERING
   ========================================================================== */
function navigate(view) {
  ['feed', 'reader', 'editor', 'bookmarks', 'profile', 'settings'].forEach(v => {
    document.getElementById(`view-${v}`).classList.toggle('hidden', v !== view);
  });
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  if (view === 'feed') renderFeed();
  if (view === 'bookmarks') renderBookmarksView();
  if (view === 'profile') renderProfileView();
  if (view === 'settings') renderSettingsView();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function canonicalizeTag(tag) {
  const clean = tag.trim().replace(/^#/, '');
  const lower = clean.toLowerCase();
  return CANONICAL_TAGS[lower] || clean;
}

function handleTagFilterKey(e, type) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const val = canonicalizeTag(e.target.value);
  if (!val) return;
  if (type === 'include' && !state.includeTags.includes(val)) {
    state.includeTags.push(val);
  } else if (type === 'exclude' && !state.excludeTags.includes(val)) {
    state.excludeTags.push(val);
  }
  e.target.value = '';
  renderFeed();
}

function toggleTagFilterFromCard(tag) {
  const canon = canonicalizeTag(tag);
  if (state.includeTags.includes(canon)) {
    state.includeTags = state.includeTags.filter(t => t !== canon);
  } else {
    state.includeTags.push(canon);
  }
  renderFeed();
}

function removeTagFilter(type, tag) {
  if (type === 'include') state.includeTags = state.includeTags.filter(t => t !== tag);
  else state.excludeTags = state.excludeTags.filter(t => t !== tag);
  renderFeed();
}

function renderFeed() {
  const feedEl = document.getElementById('works-feed');
  const query = (document.getElementById('search-input').value || '').toLowerCase().trim();
  const ratingFilter = document.getElementById('filter-rating').value;
  const catFilter = document.getElementById('filter-category').value;
  const statusFilter = document.getElementById('filter-status').value;
  const sortBy = document.getElementById('sort-by').value;
  const tagMode = document.getElementById('tag-match-mode').value;

  // Render active filter chips
  const chipsEl = document.getElementById('active-filter-chips');
  chipsEl.innerHTML = [
    ...state.includeTags.map(t => `<span class="filter-chip inc" onclick="removeTagFilter('include', '${escapeAttr(t)}')">+${escapeHTML(t)} ×</span>`),
    ...state.excludeTags.map(t => `<span class="filter-chip exc" onclick="removeTagFilter('exclude', '${escapeAttr(t)}')">−${escapeHTML(t)} ×</span>`)
  ].join('');

  // Render popular tags bar
  const tagCounts = {};
  state.works.forEach(w => (w.tags || []).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const popBar = document.getElementById('popular-tags-bar');
  popBar.innerHTML = topTags.length
    ? `<span>Indexed Tags:</span>` + topTags.map(([t, c]) => `<span class="tag-pill" onclick="toggleTagFilterFromCard('${escapeAttr(t)}')">#${escapeHTML(t)} (${c})</span>`).join('')
    : '';

  // Filter works
  let filtered = state.works.filter(w => {
    const wTags = (w.tags || []).map(t => t.toLowerCase());
    if (state.mutedTags.some(m => wTags.includes(m.toLowerCase()))) return false;
    if (ratingFilter && w.rating !== ratingFilter) return false;
    if (catFilter && w.category !== catFilter) return false;
    if (statusFilter === 'complete' && !w.isComplete) return false;
    if (statusFilter === 'wip' && w.isComplete) return false;
    if (statusFilter === 'locked' && !w.password) return false;

    if (state.includeTags.length > 0) {
      const incLower = state.includeTags.map(t => t.toLowerCase());
      const match = tagMode === 'AND'
        ? incLower.every(t => wTags.includes(t))
        : incLower.some(t => wTags.includes(t));
      if (!match) return false;
    }
    if (state.excludeTags.length > 0) {
      const excLower = state.excludeTags.map(t => t.toLowerCase());
      if (excLower.some(t => wTags.includes(t))) return false;
    }

    if (query) {
      const isLocked = Boolean(w.password) && !state.unlockedWorkIds.has(w.id);
      const searchable = isLocked
        ? [w.fandom, ...(w.tags || [])].join(' ').toLowerCase()
        : [w.title, w.pseud, w.fandom, w.summary, ...(w.tags || [])].join(' ').toLowerCase();
      if (!searchable.includes(query)) return false;
    }
    return true;
  });

  // Sort works
  filtered.sort((a, b) => {
    if (sortBy === 'kudos') return (b.kudosUsers?.length || b.kudos || 0) - (a.kudosUsers?.length || a.kudos || 0);
    if (sortBy === 'words') return (b.wordCount || 0) - (a.wordCount || 0);
    if (sortBy === 'title') return a.title.localeCompare(b.title);
    return (b.updatedAt || b.date || '').localeCompare(a.updatedAt || a.date || '');
  });

  const totalWords = state.works.reduce((acc, w) => acc + (w.wordCount || 0), 0);
  const userLabel = state.currentUser ? `Signed in as ${state.currentUser.username}` : 'Guest Preview';
  document.getElementById('archive-stats-line').textContent =
    `${state.works.length} Published Work${state.works.length === 1 ? '' : 's'} · ${totalWords.toLocaleString()} Total Words · ${userLabel}`;

  if (filtered.length === 0) {
    feedEl.innerHTML = `
      <div class="empty-state">
        <h3>${state.works.length === 0 ? 'The Archive Shelves Are Ready' : 'No Matching Works Found'}</h3>
        <p class="hint-text">${state.works.length === 0
          ? 'No prebuilt filler stories exist here. Publish your first original story or upload a story .json file to populate the archive.'
          : 'Try clearing one of your active tag filters or search terms.'}</p>
        <div class="btn-row mt-2" style="justify-content:center;">
          <button class="btn btn-primary" onclick="openNewStoryEditor()">+ Publish First Work</button>
          <label class="btn btn-outline file-btn">
            ↑ Upload Story .JSON
            <input type="file" accept=".json" onchange="uploadStoryJSON(event)" hidden />
          </label>
        </div>
      </div>
    `;
    return;
  }

  feedEl.innerHTML = filtered.map(w => buildWorkCardHTML(w)).join('');
}

function buildWorkCardHTML(w) {
  const isLocked = Boolean(w.password) && !state.unlockedWorkIds.has(w.id);
  const readMins = Math.max(1, Math.round((w.wordCount || 0) / 200));
  const kudosList = Array.isArray(w.kudosUsers) ? w.kudosUsers : [];
  const hasLiked = state.currentUser && kudosList.includes(state.currentUser.username);
  const kudosCount = kudosList.length;
  const isOwner = state.currentUser && w.author && w.author.toLowerCase() === state.currentUser.username.toLowerCase();

  const visibleTags = (w.tags || []).slice(0, 7);
  const extraCount = Math.max(0, (w.tags || []).length - 7);

  return `
    <article class="work-card" style="--spine: ${w.spineColor || 'var(--accent)'}">
      <div class="work-card-top">
        <div class="meta-badges">
          <span class="badge badge-rating">${escapeHTML(w.rating)}</span>
          <span class="badge badge-category">${escapeHTML(w.category)}</span>
          <span class="badge-fandom">• ${escapeHTML(w.fandom)}</span>
          ${w.password ? `<span class="status-pill">🔒 Protected</span>` : ''}
        </div>
        <div class="work-card-stats">
          <span class="status-pill">${w.isComplete ? '✓ Complete' : '◷ WIP'}</span>
          <span>${w.chapters?.length || 1} ch</span>
          <span>${(w.wordCount || 0).toLocaleString()} words</span>
          <span>~${readMins}m</span>
        </div>
      </div>

      <h3 class="work-title ${isLocked ? 'blurred-secret' : ''}" onclick="openWorkReader('${w.id}')">
        ${escapeHTML(w.title)}
      </h3>
      <div class="work-byline ${isLocked ? 'blurred-secret' : ''}">
        by <strong>${escapeHTML(w.isAnonymous ? 'Anonymous Writer' : (w.pseud || w.author))}</strong> · Updated ${escapeHTML(w.date || '')}
      </div>

      <p class="work-summary ${isLocked ? 'blurred-secret' : ''}">
        ${escapeHTML(w.summary || 'No summary provided.')}
      </p>

      <!-- TAGS ALWAYS REMAIN CRISP & READABLE EVEN WHEN STORY IS PASSWORD LOCKED -->
      <div class="tag-list">
        ${visibleTags.map(t => `<span class="tag-pill" onclick="toggleTagFilterFromCard('${escapeAttr(t)}')">#${escapeHTML(t)}</span>`).join('')}
        ${extraCount > 0 ? `<span class="tag-pill" onclick="openWorkReader('${w.id}')">+${extraCount} more</span>` : ''}
      </div>

      <div class="work-card-footer">
        <div class="work-card-actions-left">
          <button class="kudos-chip ${hasLiked ? 'liked' : ''}" onclick="toggleKudos('${w.id}')" title="Give 1 Kudos (Click again to remove)">
            ♥ ${kudosCount} Kudos
          </button>
          <button class="btn btn-ghost btn-sm" onclick="openShareModal('${w.id}')">↗ Share / ZIP</button>
          ${isOwner ? `<button class="btn btn-ghost btn-sm" onclick="openEditStoryEditor('${w.id}')">✎ Edit</button>` : ''}
        </div>
        <div class="work-card-actions-right">
          <button class="btn btn-primary btn-sm" onclick="openWorkReader('${w.id}')">
            ${isLocked ? 'Unlock & Read →' : 'Read Story →'}
          </button>
        </div>
      </div>
    </article>
  `;
}

/* ==========================================================================
   SINGLE-KUDOS TOGGLE (1 PER ACCOUNT, TOGGLEABLE OFF)
   ========================================================================== */
function toggleKudos(workId) {
  if (!state.currentUser) return;
  const work = state.works.find(w => w.id === workId);
  if (!work) return;

  if (!Array.isArray(work.kudosUsers)) work.kudosUsers = [];
  const uname = state.currentUser.username;
  const idx = work.kudosUsers.indexOf(uname);

  if (idx >= 0) {
    work.kudosUsers.splice(idx, 1);
    showToast('Kudos removed.');
  } else {
    work.kudosUsers.push(uname);
    showToast('Kudos added! ♥');
  }
  work.kudos = work.kudosUsers.length;
  persistWorks(true);

  if (!document.getElementById('view-feed').classList.contains('hidden')) renderFeed();
  if (!document.getElementById('view-reader').classList.contains('hidden') && currentWorkId === workId) {
    updateReaderKudosButton(work);
  }
}

/* ==========================================================================
   READER VIEW, PASSWORD UNLOCK, PLACE MARKERS & HIGHLIGHTER
   ========================================================================== */
function openWorkReader(workId, chapIdx = 0) {
  const work = state.works.find(w => w.id === workId);
  if (!work) return;
  currentWorkId = workId;
  state.currentWorkId = workId;
  state.currentChapterIdx = chapIdx;

  navigate('reader');

  const isLocked = Boolean(work.password) && !state.unlockedWorkIds.has(work.id);
  const lockScreen = document.getElementById('reader-lock-screen');
  const article = document.getElementById('reader-article');

  if (isLocked) {
    lockScreen.classList.remove('hidden');
    article.classList.add('hidden');
    document.getElementById('unlock-password-input').value = '';
    document.getElementById('unlock-error').classList.add('hidden');
    document.getElementById('lock-visible-tags').innerHTML = (work.tags || [])
      .map(t => `<span class="tag-pill">#${escapeHTML(t)}</span>`).join('');
    const hintBox = document.getElementById('lock-hint-box');
    if (work.passwordHint) {
      hintBox.textContent = `Author Hint: ${work.passwordHint}`;
      hintBox.classList.remove('hidden');
    } else {
      hintBox.classList.add('hidden');
    }
    return;
  }

  lockScreen.classList.add('hidden');
  article.classList.remove('hidden');

  const isOwner = state.currentUser && work.author && work.author.toLowerCase() === state.currentUser.username.toLowerCase();
  document.getElementById('reader-edit-btn').classList.toggle('hidden', !isOwner);

  document.getElementById('reader-badges').innerHTML = `
    <span class="badge badge-rating">${escapeHTML(work.rating)}</span>
    <span class="badge badge-category">${escapeHTML(work.category)}</span>
    <span class="badge-fandom">• ${escapeHTML(work.fandom)}</span>
    <span class="status-pill">${escapeHTML(work.warning)}</span>
  `;
  document.getElementById('reader-title').textContent = work.title;
  document.getElementById('reader-byline').innerHTML =
    `By <strong>${escapeHTML(work.isAnonymous ? 'Anonymous Writer' : (work.pseud || work.author))}</strong> · Published ${escapeHTML(work.date || '')}`;
  document.getElementById('reader-summary').textContent = work.summary || 'No summary provided.';
  document.getElementById('reader-tags').innerHTML = (work.tags || [])
    .map(t => `<span class="tag-pill" onclick="navigate('feed'); toggleTagFilterFromCard('${escapeAttr(t)}')">#${escapeHTML(t)}</span>`).join('');
  document.getElementById('reader-stats').textContent =
    `Chapters: ${work.chapters.length} · Words: ${(work.wordCount || 0).toLocaleString()} · Status: ${work.isComplete ? 'Complete' : 'Work in Progress'}`;

  // Populate chapter selector
  const chapSelect = document.getElementById('chapter-select');
  chapSelect.innerHTML = work.chapters.map((c, idx) => `<option value="${idx}">${idx + 1}. ${escapeHTML(c.title || 'Chapter ' + (idx + 1))}</option>`).join('');
  chapSelect.value = String(chapIdx);

  renderCurrentChapter();
  updateReaderKudosButton(work);
  updateBookmarkButton(work);
  renderComments(work);
  renderHighlightsDrawer();
}

function attemptUnlockWork() {
  const work = state.works.find(w => w.id === currentWorkId);
  if (!work) return;
  const entered = document.getElementById('unlock-password-input').value;
  if (entered === work.password) {
    state.unlockedWorkIds.add(work.id);
    openWorkReader(work.id, state.currentChapterIdx);
    showToast('Work unlocked.');
  } else {
    document.getElementById('unlock-error').classList.remove('hidden');
  }
}

function renderCurrentChapter() {
  const work = state.works.find(w => w.id === currentWorkId);
  if (!work) return;
  const chap = work.chapters[state.currentChapterIdx] || work.chapters[0];

  const topNote = document.getElementById('reader-notes-top');
  if (chap.notesTop) {
    topNote.innerHTML = `<strong>Author's Note:</strong> ${escapeHTML(chap.notesTop)}`;
    topNote.classList.remove('hidden');
  } else {
    topNote.classList.add('hidden');
  }

  const botNote = document.getElementById('reader-notes-bottom');
  if (chap.notesBottom) {
    botNote.innerHTML = `<strong>End Note:</strong> ${escapeHTML(chap.notesBottom)}`;
    botNote.classList.remove('hidden');
  } else {
    botNote.classList.add('hidden');
  }

  document.getElementById('reader-prose').innerHTML = chap.content || '<p>Empty chapter.</p>';
  document.getElementById('prev-chap-btn').disabled = state.currentChapterIdx <= 0;
  document.getElementById('next-chap-btn').disabled = state.currentChapterIdx >= work.chapters.length - 1;
}

function changeChapter(delta) {
  const work = state.works.find(w => w.id === currentWorkId);
  if (!work) return;
  const next = state.currentChapterIdx + delta;
  if (next >= 0 && next < work.chapters.length) {
    state.currentChapterIdx = next;
    document.getElementById('chapter-select').value = String(next);
    renderCurrentChapter();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

function selectChapter(idxStr) {
  state.currentChapterIdx = parseInt(idxStr, 10) || 0;
  renderCurrentChapter();
}

function updateReaderKudosButton(work) {
  const list = work.kudosUsers || [];
  const liked = state.currentUser && list.includes(state.currentUser.username);
  const btn = document.getElementById('kudos-btn');
  btn.classList.toggle('liked', liked);
  document.getElementById('kudos-btn-label').textContent = liked ? 'Kudos Given (Click to Remove)' : 'Leave Kudos';
  document.getElementById('kudos-btn-count').textContent = list.length;
}

function updateReaderTypography() {
  const font = document.getElementById('reader-font-select').value;
  document.getElementById('reader-prose').style.fontFamily = font;
}

let readerFontSizeRem = 1.12;
function adjustFontSize(delta) {
  readerFontSizeRem = Math.min(1.65, Math.max(0.9, readerFontSizeRem + delta * 0.08));
  document.getElementById('reader-prose').style.fontSize = readerFontSizeRem + 'rem';
}

/* READING PLACE MARKERS */
function saveReadingPlace() {
  const work = state.works.find(w => w.id === currentWorkId);
  if (!work) return;
  const scrollMax = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  const percent = Math.min(100, Math.round((window.scrollY / scrollMax) * 100));
  const marker = {
    workId: work.id,
    title: work.title,
    chapterIdx: state.currentChapterIdx,
    chapterTitle: work.chapters[state.currentChapterIdx]?.title || `Chapter ${state.currentChapterIdx + 1}`,
    scrollY: window.scrollY,
    percent
  };
  localStorage.setItem(STORAGE_KEYS.PLACE, JSON.stringify(marker));
  checkResumeBanner();
  showToast(`Saved reading place at ${percent}%!`);
}

function checkResumeBanner() {
  const raw = localStorage.getItem(STORAGE_KEYS.PLACE);
  const banner = document.getElementById('resume-banner');
  if (!raw) {
    banner.classList.add('hidden');
    return;
  }
  const m = JSON.parse(raw);
  const exists = state.works.some(w => w.id === m.workId);
  if (!exists) {
    banner.classList.add('hidden');
    return;
  }
  document.getElementById('resume-title').textContent = m.title;
  document.getElementById('resume-chapter').textContent = m.chapterTitle;
  document.getElementById('resume-percent').textContent = m.percent;
  banner.classList.remove('hidden');
}

function resumeSavedPlace() {
  const raw = localStorage.getItem(STORAGE_KEYS.PLACE);
  if (!raw) return;
  const m = JSON.parse(raw);
  openWorkReader(m.workId, m.chapterIdx || 0);
  setTimeout(() => window.scrollTo({ top: m.scrollY || 0, behavior: 'smooth' }), 120);
}

function clearSavedPlace() {
  localStorage.removeItem(STORAGE_KEYS.PLACE);
  document.getElementById('resume-banner').classList.add('hidden');
}

/* HIGHLIGHTER & MARGIN NOTES */
let pendingSelectionText = '';
function handleTextSelection() {
  const sel = window.getSelection();
  const text = sel ? sel.toString().trim() : '';
  const popover = document.getElementById('highlight-popover');
  if (text.length > 3) {
    pendingSelectionText = text;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    popover.style.top = Math.max(10, rect.top - 44) + 'px';
    popover.style.left = Math.max(10, rect.left) + 'px';
    popover.classList.remove('hidden');
  } else {
    popover.classList.add('hidden');
  }
}

function applyHighlight(color) {
  if (!pendingSelectionText || !currentWorkId) return;
  const work = state.works.find(w => w.id === currentWorkId);
  state.highlights.unshift({
    id: 'hl-' + Date.now(),
    workId: currentWorkId,
    workTitle: work ? work.title : 'Untitled',
    quote: pendingSelectionText.slice(0, 280),
    color,
    date: new Date().toLocaleDateString()
  });
  localStorage.setItem(STORAGE_KEYS.HIGHLIGHTS, JSON.stringify(state.highlights));
  document.getElementById('highlight-popover').classList.add('hidden');
  window.getSelection()?.removeAllRanges();
  renderHighlightsDrawer();
  showToast('Passage saved to Margin Highlights.');
}

function toggleNotesDrawer() {
  document.getElementById('notes-drawer').classList.toggle('hidden');
  renderHighlightsDrawer();
}

function renderHighlightsDrawer() {
  const list = document.getElementById('highlights-list');
  const relevant = state.highlights.filter(h => !currentWorkId || h.workId === currentWorkId);
  document.getElementById('reader-highlight-count').textContent = relevant.length;
  if (relevant.length === 0) {
    list.innerHTML = `<p class="hint-text">Select any passage while reading to highlight and save it here.</p>`;
    return;
  }
  list.innerHTML = relevant.map(h => `
    <div class="highlight-item" style="border-left: 5px solid ${h.color}">
      <div>“${escapeHTML(h.quote)}”</div>
      <div class="hint-text mt-1">${escapeHTML(h.workTitle)} · ${h.date}</div>
    </div>
  `).join('');
}

/* COMMENTS */
function postComment() {
  const input = document.getElementById('comment-input');
  const body = input.value.trim();
  if (!body || !currentWorkId) return;
  const work = state.works.find(w => w.id === currentWorkId);
  if (!work) return;
  if (!Array.isArray(work.comments)) work.comments = [];
  work.comments.unshift({
    author: state.currentUser.pseud || state.currentUser.username,
    chapter: state.currentChapterIdx + 1,
    body,
    date: new Date().toLocaleDateString()
  });
  input.value = '';
  persistWorks(true);
  renderComments(work);
  showToast('Comment posted.');
}

function renderComments(work) {
  const list = work.comments || [];
  document.getElementById('comment-count').textContent = list.length;
  const el = document.getElementById('comments-list');
  if (list.length === 0) {
    el.innerHTML = `<p class="hint-text">No reader comments yet.</p>`;
    return;
  }
  el.innerHTML = list.map(c => `
    <div class="author-note-box">
      <strong>${escapeHTML(c.author)}</strong> <span class="hint-text">(Ch. ${c.chapter} · ${escapeHTML(c.date)})</span>
      <p style="margin:6px 0 0;">${escapeHTML(c.body)}</p>
    </div>
  `).join('');
}

/* ==========================================================================
   PUBLISH & RE-EDIT STUDIO (EDIT ANYTIME AFTER POSTING)
   ========================================================================== */
function openNewStoryEditor() {
  state.editingWorkId = null;
  document.getElementById('editor-heading').textContent = 'Publish New Work';
  document.getElementById('ed-title').value = '';
  document.getElementById('ed-fandom').value = 'Original Work';
  document.getElementById('ed-spine-color').value = '#991b1b';
  document.getElementById('ed-rating').value = 'General Audiences';
  document.getElementById('ed-category').value = 'Gen';
  document.getElementById('ed-warning').value = 'No Archive Warnings Apply';
  document.getElementById('ed-summary').value = '';
  document.getElementById('ed-complete').checked = true;
  document.getElementById('ed-anonymous').checked = false;
  document.getElementById('ed-password').value = '';
  document.getElementById('ed-password-hint').value = '';

  state.editorTags = [];
  state.editorChapters = [{ title: 'Chapter 1', notesTop: '', notesBottom: '', content: '<p></p>' }];
  state.editorActiveChapIdx = 0;

  renderEditorTags();
  renderEditorChapterTabs();
  loadActiveEditorChapter();
  navigate('editor');
}

function editCurrentWork() {
  if (currentWorkId) openEditStoryEditor(currentWorkId);
}

function openEditStoryEditor(workId) {
  const work = state.works.find(w => w.id === workId);
  if (!work) return;

  state.editingWorkId = work.id;
  document.getElementById('editor-heading').textContent = `Re-Editing: ${work.title}`;
  document.getElementById('ed-title').value = work.title;
  document.getElementById('ed-fandom').value = work.fandom || 'Original Work';
  document.getElementById('ed-spine-color').value = work.spineColor || '#991b1b';
  document.getElementById('ed-rating').value = work.rating || 'General Audiences';
  document.getElementById('ed-category').value = work.category || 'Gen';
  document.getElementById('ed-warning').value = work.warning || 'No Archive Warnings Apply';
  document.getElementById('ed-summary').value = work.summary || '';
  document.getElementById('ed-complete').checked = Boolean(work.isComplete);
  document.getElementById('ed-anonymous').checked = Boolean(work.isAnonymous);
  document.getElementById('ed-password').value = work.password || '';
  document.getElementById('ed-password-hint').value = work.passwordHint || '';

  state.editorTags = [...(work.tags || [])];
  state.editorChapters = JSON.parse(JSON.stringify(work.chapters || [{ title: 'Chapter 1', notesTop: '', notesBottom: '', content: '<p></p>' }]));
  state.editorActiveChapIdx = 0;

  renderEditorTags();
  renderEditorChapterTabs();
  loadActiveEditorChapter();
  navigate('editor');
}

function handleEditorTagKey(e) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    addEditorTagFromInput();
  }
}

function addEditorTagFromInput() {
  const inp = document.getElementById('ed-tag-input');
  const raw = inp.value.split(',').map(t => canonicalizeTag(t)).filter(Boolean);
  raw.forEach(t => {
    if (!state.editorTags.includes(t)) state.editorTags.push(t);
  });
  inp.value = '';
  renderEditorTags();
}

function removeEditorTag(idx) {
  state.editorTags.splice(idx, 1);
  renderEditorTags();
}

function renderEditorTags() {
  document.getElementById('ed-tags-container').innerHTML = state.editorTags
    .map((t, i) => `<span class="tag-pill" onclick="removeEditorTag(${i})">#${escapeHTML(t)} ×</span>`).join('');
}

function renderEditorChapterTabs() {
  const el = document.getElementById('ed-chapter-tabs');
  el.innerHTML = state.editorChapters.map((ch, idx) => `
    <button type="button" class="chap-tab ${idx === state.editorActiveChapIdx ? 'active' : ''}" onclick="switchEditorChapter(${idx})">
      Ch. ${idx + 1}
    </button>
  `).join('');
}

function switchEditorChapter(idx) {
  syncEditorProse();
  state.editorActiveChapIdx = idx;
  renderEditorChapterTabs();
  loadActiveEditorChapter();
}

function loadActiveEditorChapter() {
  const ch = state.editorChapters[state.editorActiveChapIdx];
  document.getElementById('ed-chap-title').value = ch.title || `Chapter ${state.editorActiveChapIdx + 1}`;
  document.getElementById('ed-chap-notes-top').value = ch.notesTop || '';
  document.getElementById('ed-chap-notes-bottom').value = ch.notesBottom || '';
  document.getElementById('ed-prose-area').innerHTML = ch.content || '<p></p>';
  updateEditorWordCount();
}

function syncEditorChapterMeta() {
  const ch = state.editorChapters[state.editorActiveChapIdx];
  ch.title = document.getElementById('ed-chap-title').value;
  ch.notesTop = document.getElementById('ed-chap-notes-top').value;
  ch.notesBottom = document.getElementById('ed-chap-notes-bottom').value;
}

function syncEditorProse() {
  const ch = state.editorChapters[state.editorActiveChapIdx];
  ch.content = document.getElementById('ed-prose-area').innerHTML;
  updateEditorWordCount();
}

function addEditorChapter() {
  syncEditorProse();
  const num = state.editorChapters.length + 1;
  state.editorChapters.push({ title: `Chapter ${num}`, notesTop: '', notesBottom: '', content: '<p></p>' });
  state.editorActiveChapIdx = num - 1;
  renderEditorChapterTabs();
  loadActiveEditorChapter();
}

function deleteEditorChapter() {
  if (state.editorChapters.length <= 1) {
    showToast('A work must have at least one chapter.');
    return;
  }
  state.editorChapters.splice(state.editorActiveChapIdx, 1);
  state.editorActiveChapIdx = Math.max(0, state.editorActiveChapIdx - 1);
  renderEditorChapterTabs();
  loadActiveEditorChapter();
}

function execEditorCmd(cmd, val = null) {
  document.execCommand(cmd, false, val);
  syncEditorProse();
}

function insertSceneBreak() {
  document.execCommand('insertHTML', false, '<p style="text-align:center;">✦ &nbsp; ✦ &nbsp; ✦</p><p><br></p>');
  syncEditorProse();
}

function toggleGlyphDrawer() {
  document.getElementById('glyph-drawer').classList.toggle('hidden');
}

function insertGlyph(sym) {
  document.getElementById('ed-prose-area').focus();
  document.execCommand('insertText', false, sym);
  syncEditorProse();
}

function computeChaptersWordCount(chapters) {
  const tmp = document.createElement('div');
  let count = 0;
  chapters.forEach(c => {
    tmp.innerHTML = c.content || '';
    const words = (tmp.textContent || '').trim().split(/\s+/).filter(Boolean);
    count += words.length;
  });
  return count;
}

function updateEditorWordCount() {
  const count = computeChaptersWordCount(state.editorChapters);
  document.getElementById('ed-word-count').textContent = `${count.toLocaleString()} words`;
}

function savePublishedWork() {
  syncEditorChapterMeta();
  syncEditorProse();
  addEditorTagFromInput();

  const title = document.getElementById('ed-title').value.trim();
  if (!title) {
    showToast('Please enter a title before publishing.');
    return;
  }

  const isAnon = document.getElementById('ed-anonymous').checked;
  const existing = state.editingWorkId ? state.works.find(w => w.id === state.editingWorkId) : null;

  const workObj = {
    id: existing ? existing.id : 'work-' + Date.now(),
    title,
    author: existing ? existing.author : state.currentUser.username,
    pseud: isAnon ? 'Anonymous Writer' : (state.currentUser.pseud || state.currentUser.username),
    isAnonymous: isAnon,
    fandom: document.getElementById('ed-fandom').value.trim() || 'Original Work',
    rating: document.getElementById('ed-rating').value,
    category: document.getElementById('ed-category').value,
    warning: document.getElementById('ed-warning').value,
    isComplete: document.getElementById('ed-complete').checked,
    tags: [...state.editorTags],
    summary: document.getElementById('ed-summary').value.trim(),
    spineColor: document.getElementById('ed-spine-color').value,
    chapters: JSON.parse(JSON.stringify(state.editorChapters)),
    date: existing ? existing.date : new Date().toISOString().split('T')[0],
    updatedAt: new Date().toISOString(),
    wordCount: computeChaptersWordCount(state.editorChapters),
    kudosUsers: existing ? (existing.kudosUsers || []) : [],
    kudos: existing ? (existing.kudosUsers?.length || existing.kudos || 0) : 0,
    password: document.getElementById('ed-password').value,
    passwordHint: document.getElementById('ed-password-hint').value.trim(),
    comments: existing ? (existing.comments || []) : []
  };

  upsertWork(workObj);
  showToast(existing ? 'Work updated and saved!' : 'Work published to archive!');
  openWorkReader(workObj.id, 0);
}

/* ==========================================================================
   STORY SHARING & PAGE-BY-PAGE PNG EXPORT IN AUTO-NAMED ZIP
   ========================================================================== */
function openShareModal(workId) {
  const work = state.works.find(w => w.id === workId);
  if (!work) return;
  state.shareTargetWorkId = workId;

  const safeSlug = sanitizeFilename(work.title);
  document.getElementById('zip-filename-preview').textContent = safeSlug;
  document.getElementById('zip-progress-text').textContent = '';

  // Build self-contained URL hash
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(work))));
  const baseUrl = window.location.href.split('#')[0];
  document.getElementById('share-url-output').value = `${baseUrl}#story=${encoded}`;

  document.getElementById('share-modal').classList.remove('hidden');
}

function closeShareModal() {
  document.getElementById('share-modal').classList.add('hidden');
}

function copyShareURL() {
  const inp = document.getElementById('share-url-output');
  inp.select();
  navigator.clipboard?.writeText(inp.value);
  showToast('Self-contained share link copied to clipboard!');
}

function checkURLHashForSharedStory() {
  const hash = window.location.hash || '';
  if (!hash.startsWith('#story=')) return null;
  try {
    const rawB64 = hash.slice('#story='.length);
    const parsed = JSON.parse(decodeURIComponent(escape(atob(rawB64))));
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return normalizeStoryObject(parsed);
  } catch {
    return null;
  }
}

function downloadSingleStoryJSON() {
  const work = state.works.find(w => w.id === state.shareTargetWorkId);
  if (!work) return;
  const blob = new Blob([JSON.stringify(work, null, 2)], { type: 'application/json' });
  triggerDownload(blob, `story_${sanitizeFilename(work.title)}.json`);
  showToast('Downloaded story JSON file.');
}

function copyBookplateCitation() {
  const work = state.works.find(w => w.id === state.shareTargetWorkId);
  if (!work) return;
  const author = work.isAnonymous ? 'Anonymous Writer' : (work.pseud || work.author);
  const text = `“${work.title}” by ${author} (${work.fandom} · ${work.rating} · ${work.wordCount.toLocaleString()} words)
Tags: ${(work.tags || []).map(t => '#' + t).join(', ')}`;
  navigator.clipboard?.writeText(text);
  showToast('Formatted bookplate citation copied!');
}

/* RENDER EACH STORY PAGE ON HTML5 CANVAS AS HIGH-RES PNG & BUNDLE INTO AUTO-NAMED ZIP */
async function exportStoryPagesAsZip() {
  const work = state.works.find(w => w.id === state.shareTargetWorkId);
  if (!work) return;
  if (typeof JSZip === 'undefined') {
    showToast('ZIP library still loading—please try again in a second.');
    return;
  }

  const statusEl = document.getElementById('zip-progress-text');
  const btn = document.getElementById('download-zip-btn');
  btn.disabled = true;
  statusEl.textContent = 'Typesetting book pages...';

  try {
    const zip = new JSZip();
    const safeTitle = sanitizeFilename(work.title);
    const pages = paginateStoryForCanvas(work);

    for (let i = 0; i < pages.length; i++) {
      statusEl.textContent = `Rendering page ${i + 1} of ${pages.length}...`;
      const pngBlob = await renderBookPageToPNG(work, pages[i], i + 1, pages.length);
      const pageNum = String(i + 1).padStart(3, '0');
      zip.file(`${safeTitle}_page_${pageNum}.png`, pngBlob);
    }

    statusEl.textContent = 'Compressing ZIP archive...';
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    triggerDownload(zipBlob, `${safeTitle}.zip`);
    statusEl.textContent = `Complete! Downloaded ${safeTitle}.zip (${pages.length} pages).`;
    showToast(`Downloaded ${safeTitle}.zip!`);
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Error generating page ZIP.';
  } finally {
    btn.disabled = false;
  }
}

function paginateStoryForCanvas(work) {
  const pages = [];
  // Page 1: Cover / Bookplate Page
  pages.push({
    type: 'cover',
    title: work.title,
    author: work.isAnonymous ? 'Anonymous Writer' : (work.pseud || work.author),
    fandom: work.fandom,
    rating: work.rating,
    category: work.category,
    tags: work.tags || [],
    summary: work.summary || ''
  });

  // Extract clean paragraphs across all chapters
  const tmp = document.createElement('div');
  const linesPerPage = 26;
  const maxCharsPerLine = 68;

  work.chapters.forEach((ch, cIdx) => {
    tmp.innerHTML = ch.content || '';
    const rawParas = Array.from(tmp.querySelectorAll('p, blockquote, h3, div')).map(el => el.textContent.trim()).filter(Boolean);
    if (rawParas.length === 0 && tmp.textContent.trim()) {
      rawParas.push(tmp.textContent.trim());
    }

    const wrappedLines = [];
    rawParas.forEach(p => {
      const words = p.split(/\s+/);
      let cur = '';
      words.forEach(w => {
        if ((cur + ' ' + w).trim().length > maxCharsPerLine) {
          wrappedLines.push(cur.trim());
          cur = w;
        } else {
          cur = (cur + ' ' + w).trim();
        }
      });
      if (cur) wrappedLines.push(cur);
      wrappedLines.push(''); // Paragraph spacing
    });

    for (let i = 0; i < wrappedLines.length; i += linesPerPage) {
      pages.push({
        type: 'text',
        chapterHeading: `${cIdx + 1}. ${ch.title || 'Chapter ' + (cIdx + 1)}`,
        lines: wrappedLines.slice(i, i + linesPerPage)
      });
    }
  });

  return pages;
}

function renderBookPageToPNG(work, pageData, pageNum, totalPages) {
  return new Promise((resolve) => {
    const W = 1200;
    const H = 1600;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Archival paper backdrop
    ctx.fillStyle = '#faf7f2';
    ctx.fillRect(0, 0, W, H);

    // Left book spine accent strip
    ctx.fillStyle = work.spineColor || '#991b1b';
    ctx.fillRect(0, 0, 26, H);

    // Subtle page border
    ctx.strokeStyle = '#d6ccc2';
    ctx.lineWidth = 2;
    ctx.strokeRect(56, 56, W - 112, H - 112);

    ctx.fillStyle = '#1c1917';

    if (pageData.type === 'cover') {
      ctx.font = '600 22px Inter, sans-serif';
      ctx.fillStyle = '#78716c';
      ctx.fillText(`${pageData.rating.toUpperCase()}  •  ${pageData.category}  •  ${pageData.fandom}`, 110, 170);

      // Wrapped Title
      ctx.fillStyle = '#1c1917';
      ctx.font = 'bold 64px Georgia, serif';
      const titleLines = wrapCanvasText(pageData.title, 26);
      let y = 270;
      titleLines.forEach(tl => {
        ctx.fillText(tl, 110, y);
        y += 76;
      });

      ctx.font = 'italic 32px Georgia, serif';
      ctx.fillStyle = '#44403c';
      ctx.fillText(`by ${pageData.author}`, 110, y + 24);

      // Divider
      ctx.fillStyle = work.spineColor || '#991b1b';
      ctx.fillRect(110, y + 70, 160, 5);

      // Summary
      ctx.fillStyle = '#292524';
      ctx.font = '28px Georgia, serif';
      let sy = y + 140;
      wrapCanvasText(pageData.summary, 58).slice(0, 10).forEach(sl => {
        ctx.fillText(sl, 110, sy);
        sy += 42;
      });

      // Tags
      ctx.fillStyle = '#57534e';
      ctx.font = '22px monospace';
      const tagStr = pageData.tags.map(t => '#' + t).join('  ');
      let ty = H - 240;
      wrapCanvasText(tagStr, 66).slice(0, 3).forEach(tl => {
        ctx.fillText(tl, 110, ty);
        ty += 34;
      });
    } else {
      // Running header
      ctx.fillStyle = '#78716c';
      ctx.font = '600 20px Inter, sans-serif';
      ctx.fillText(work.title.toUpperCase(), 110, 115);
      ctx.fillText(pageData.chapterHeading, 110, 148);

      ctx.strokeStyle = '#e7e0d6';
      ctx.beginPath();
      ctx.moveTo(110, 168);
      ctx.lineTo(W - 110, 168);
      ctx.stroke();

      // Body prose
      ctx.fillStyle = '#1c1917';
      ctx.font = '29px Georgia, serif';
      let y = 230;
      pageData.lines.forEach(line => {
        if (line === '') {
          y += 22;
        } else {
          ctx.fillText(line, 110, y);
          y += 45;
        }
      });
    }

    // Footer page folio
    ctx.fillStyle = '#78716c';
    ctx.font = '20px monospace';
    ctx.fillText(`Margin Archive  —  Page ${pageNum} of ${totalPages}`, 110, H - 85);

    canvas.toBlob(blob => resolve(blob), 'image/png');
  });
}

function wrapCanvasText(text, maxChars) {
  const words = (text || '').split(/\s+/);
  const lines = [];
  let cur = '';
  words.forEach(w => {
    if ((cur + ' ' + w).trim().length > maxChars) {
      lines.push(cur.trim());
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  });
  if (cur) lines.push(cur);
  return lines;
}

/* ==========================================================================
   BOOKMARKS, PROFILE & SETTINGS VIEWS
   ========================================================================== */
function loadUserLists() {
  state.bookmarks = JSON.parse(localStorage.getItem(STORAGE_KEYS.BOOKMARKS) || '[]');
  state.highlights = JSON.parse(localStorage.getItem(STORAGE_KEYS.HIGHLIGHTS) || '[]');
  state.mutedTags = JSON.parse(localStorage.getItem(STORAGE_KEYS.MUTED_TAGS) || '[]');
}

function toggleBookmark(workId) {
  const idx = state.bookmarks.indexOf(workId);
  if (idx >= 0) {
    state.bookmarks.splice(idx, 1);
    showToast('Removed from Reading Shelf.');
  } else {
    state.bookmarks.push(workId);
    showToast('Saved to Reading Shelf ★');
  }
  localStorage.setItem(STORAGE_KEYS.BOOKMARKS, JSON.stringify(state.bookmarks));
  const work = state.works.find(w => w.id === workId);
  if (work) updateBookmarkButton(work);
}

function updateBookmarkButton(work) {
  const saved = state.bookmarks.includes(work.id);
  document.getElementById('bookmark-btn').textContent = saved ? '★ Saved on Shelf' : '☆ Bookmark to Shelf';
}

function renderBookmarksView() {
  const feed = document.getElementById('bookmarks-feed');
  const savedWorks = state.works.filter(w => state.bookmarks.includes(w.id));
  if (savedWorks.length === 0) {
    feed.innerHTML = `<div class="empty-state"><h3>Your Reading Shelf is Empty</h3><p class="hint-text">Bookmark stories while reading to keep them here.</p></div>`;
    return;
  }
  feed.innerHTML = savedWorks.map(w => buildWorkCardHTML(w)).join('');
}

function renderProfileView() {
  const u = state.currentUser;
  const syncToken = 'MARGIN-ID-' + btoa(unescape(encodeURIComponent(JSON.stringify(u))));
  document.getElementById('profile-sync-token').value = syncToken;

  const myWorks = state.works.filter(w => w.author && w.author.toLowerCase() === u.username.toLowerCase());
  const totalKudos = myWorks.reduce((sum, w) => sum + (w.kudosUsers?.length || w.kudos || 0), 0);

  document.getElementById('profile-summary-box').innerHTML = `
    <p><strong>Handle:</strong> ${escapeHTML(u.username)} · <strong>Public Pseudonym:</strong> ${escapeHTML(u.pseud || u.username)}</p>
    <p><strong>Bio:</strong> ${escapeHTML(u.bio || 'No bio set.')}</p>
    <p><strong>Stats:</strong> ${myWorks.length} Published Works · ${totalKudos} Total Kudos Received</p>
  `;

  const listEl = document.getElementById('profile-works-list');
  if (myWorks.length === 0) {
    listEl.innerHTML = `<p class="hint-text">You haven't published any stories yet.</p>`;
    return;
  }
  listEl.innerHTML = myWorks.map(w => `
    <div class="author-note-box" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
      <div>
        <strong>${escapeHTML(w.title)}</strong>
        <div class="hint-text">${w.chapters.length} ch · ${w.wordCount.toLocaleString()} words · ♥ ${w.kudosUsers?.length || 0}</div>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary btn-xs" onclick="openEditStoryEditor('${w.id}')">✎ Re-Edit</button>
        <button class="btn btn-outline btn-xs" onclick="openShareModal('${w.id}')">↗ Share</button>
        <button class="btn btn-ghost btn-xs" onclick="deleteMyWork('${w.id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

function deleteMyWork(workId) {
  if (!confirm('Delete this story from the archive?')) return;
  state.works = state.works.filter(w => w.id !== workId);
  persistWorks(true);
  renderProfileView();
  showToast('Story deleted.');
}

function copySyncToken() {
  const el = document.getElementById('profile-sync-token');
  el.select();
  navigator.clipboard?.writeText(el.value);
  showToast('Cross-version Account Link Token copied!');
}

function renderSettingsView() {
  const cfg = getRelayConfig();
  document.getElementById('relay-mode').value = cfg.mode || 'hybrid';
  document.getElementById('relay-url').value = cfg.url || '';
  document.getElementById('relay-key').value = cfg.key || '';
  renderMutedTags();
}

function addMutedTag() {
  const inp = document.getElementById('mute-tag-input');
  const val = canonicalizeTag(inp.value);
  if (!val || state.mutedTags.includes(val)) return;
  state.mutedTags.push(val);
  localStorage.setItem(STORAGE_KEYS.MUTED_TAGS, JSON.stringify(state.mutedTags));
  inp.value = '';
  renderMutedTags();
  showToast(`Muted #${val}`);
}

function removeMutedTag(idx) {
  state.mutedTags.splice(idx, 1);
  localStorage.setItem(STORAGE_KEYS.MUTED_TAGS, JSON.stringify(state.mutedTags));
  renderMutedTags();
}

function renderMutedTags() {
  document.getElementById('muted-tags-list').innerHTML = state.mutedTags
    .map((t, i) => `<span class="tag-pill" onclick="removeMutedTag(${i})">#${escapeHTML(t)} ×</span>`).join('');
}

function exportFullBackupJSON() {
  const payload = {
    version: 'margin-v1',
    exportedAt: new Date().toISOString(),
    accounts: getStoredAccounts(),
    works: state.works,
    bookmarks: state.bookmarks,
    highlights: state.highlights
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  triggerDownload(blob, `margin_full_backup_${new Date().toISOString().split('T')[0]}.json`);
  showToast('Exported full archive & account backup.');
}

function importFullBackupJSON(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (Array.isArray(data.accounts)) {
        const merged = [...getStoredAccounts()];
        data.accounts.forEach(acc => {
          if (!merged.some(m => m.username.toLowerCase() === acc.username.toLowerCase())) merged.push(acc);
        });
        saveStoredAccounts(merged);
      }
      if (Array.isArray(data.works)) {
        mergeIncomingWorks(data.works);
      } else if (data.title && Array.isArray(data.chapters)) {
        upsertWork(normalizeStoryObject(data));
      }
      showToast('Backup imported successfully!');
      renderFeed();
    } catch {
      showToast('Invalid backup JSON file.');
    }
    event.target.value = '';
  };
  reader.readAsText(file);
}

/* ==========================================================================
   UTILITIES
   ========================================================================== */
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function sanitizeFilename(name) {
  return (name || 'story').replace(/[^a-z0-9_\-\(\)\+\s]/gi, '').trim().replace(/\s+/g, '_') || 'story';
}

function escapeHTML(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return String(str || '').replace(/'/g, "\'").replace(/"/g, '&quot;');
}

let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
}
