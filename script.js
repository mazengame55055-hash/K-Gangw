/* ============================================
   The Kareka | K-Gang Tournament - App Logic
   ============================================ */

window.addEventListener('error', function(e) {
  console.error('[K-Gang]', e.error || e.message);
  try {
    const t = document.createElement('div');
    t.className = 'toast error';
    t.textContent = '⚠️ حدث خطأ: ' + (e.message || '').slice(0, 80);
    $('#toastContainer').appendChild(t);
    setTimeout(() => { t.classList.add('removing'); setTimeout(() => t.remove(), 300); }, 4000);
  } catch (_) {}
});

const state = {
  players: [],
  matches: [],
  tournamentStarted: false,
  tournamentFinished: false,
  tournamentPaused: false,
  nextPlayerId: 1,
  nextMatchId: 1,
  // Password is never stored in plain text — only its SHA-256 hash.
  // This is the hash of the default password 'admin123'.
  adminPasswordHash: '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9',
  isLocked: true,
  settings: {
    name: 'K-Gang Valorant Championship',
    description: 'تنافس. انتصر. احكم.',
    type: 'single'
  },
  // Site-wide appearance, set from the admin panel's "المظهر" tab and
  // synced to every visitor (same JSONBin state as players/settings).
  theme: {
    preset: 'kgang',
    colors: { primary: '#9184c9', textPrimary: '#ece8f5', bgDeep: '#0d0c12', bgSurface: '#1b1822' },
    font: 'rajdhani_inter',
    background: { type: 'default', color: '#141219', gradColor1: '#1b1822', gradColor2: '#0d0c12', imageUrl: '', overlayOpacity: 55, blur: 0 }
  }
};

const DEFAULT_PASSWORD_HASH = '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9';

// ========== Password Hashing ==========
// NOTE: This still runs entirely client-side, so someone with devtools access
// can flip state.isLocked directly and bypass the panel — that's an inherent
// limit of a static, backend-less site, not something a hash fixes. What the
// hash DOES fix is that the password itself is no longer sitting in
// localStorage/state in plain, human-readable text.
async function hashPassword(pw) {
  const enc = new TextEncoder().encode(pw);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ========== JSONBin.io Setup ==========
// 1) Log in at https://jsonbin.io/app/bins
// 2) Click "+ Create Bin", paste a starter JSON object (players/matches/etc),
//    save it, then copy the Bin ID it gives you.
// 3) In your JSONBin dashboard, generate an Access Key scoped to just this
//    bin if possible — do NOT use your Master Key here. Anyone who views
//    this page's source can read this key, and a Master Key would let them
//    read/write/delete every bin in your whole account, not just this one.
// 4) Paste your Bin ID and key below. Until you do, the app falls back to
//    localStorage (old behaviour: changes only visible on this device).
const JSONBIN_BIN_ID = '6a51bd72f5f4af5e297f8ab7';
const JSONBIN_KEY = '$2a$10$q7mO1ej/e57QkPcvv0PChOEpeLz5Achhnrkfb.DwYNek8Ka55PKUO';
const JSONBIN_BASE = 'https://api.jsonbin.io/v3/b/' + JSONBIN_BIN_ID;

// Fields that are shared with everyone via the cloud. Deliberately excludes
// `isLocked`, which stays per-device/per-session (so unlocking the admin
// panel on one phone doesn't unlock it for every visitor).
const SYNCED_FIELDS = ['players', 'matches', 'tournamentStarted', 'tournamentFinished', 'tournamentPaused', 'nextPlayerId', 'nextMatchId', 'adminPasswordHash', 'settings', 'theme'];

let cloudEnabled = false;
let isApplyingRemoteUpdate = false;
let saveDebounceTimer = null;
let pollTimer = null;
let lastSeenUpdatedAt = null;
// JSONBin has no real-time push like Firestore, so we poll instead. Kept
// fairly slow (and paused while the tab is hidden) to stay within the free
// tier's monthly request quota — this means updates from other visitors can
// take a few seconds to appear, instead of Firestore's instant push.
const POLL_INTERVAL_MS = 8000;

function initCloud() {
  if (JSONBIN_BIN_ID === 'PASTE_YOUR_BIN_ID_HERE' || JSONBIN_KEY === 'PASTE_YOUR_ACCESS_OR_MASTER_KEY_HERE') {
    console.warn('[K-Gang] JSONBin not configured yet — falling back to localStorage only. See comment above JSONBIN_BIN_ID.');
    return false;
  }
  return true;
}

function getSyncPayload() {
  const payload = {};
  SYNCED_FIELDS.forEach(k => { payload[k] = state[k]; });
  return payload;
}

// ========== Storage ==========
// Always caches locally (instant reads on next visit / offline fallback).
// Also pushes to JSONBin (debounced) when the cloud is configured, so
// every visitor's browser converges on the same shared state.
function saveState() {
  try { localStorage.setItem('kgang_bracket_v1', JSON.stringify(state)); } catch (e) {}
  if (!cloudEnabled || isApplyingRemoteUpdate) return;
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(pushToCloud, 600);
}

// Saves a purely local/per-device change (e.g. lock state) without pushing
// anything to the cloud.
function saveLocalOnly() {
  try { localStorage.setItem('kgang_bracket_v1', JSON.stringify(state)); } catch (e) {}
}

function loadLocalCache() {
  try {
    const raw = localStorage.getItem('kgang_bracket_v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migration: older saves kept the password in plain text as
      // `adminPassword`. If we find that, hash it and drop the plain field.
      if (parsed.adminPassword && !parsed.adminPasswordHash) {
        hashPassword(parsed.adminPassword).then(h => {
          state.adminPasswordHash = h;
          delete state.adminPassword;
          saveState();
        });
        delete parsed.adminPassword;
      }
      Object.assign(state, parsed);
      buildPlayerMap();
      return true;
    }
  } catch (e) {}
  return false;
}

async function pushToCloud() {
  try {
    const res = await fetch(JSONBIN_BASE, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Access-Key': JSONBIN_KEY },
      body: JSON.stringify(getSyncPayload())
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.metadata && data.metadata.updatedAt) lastSeenUpdatedAt = data.metadata.updatedAt;
  } catch (e) {
    console.error('[K-Gang] cloud save failed', e);
    toast('⚠️ فشل حفظ التعديلات على السحابة — تحقق من الاتصال', 'error');
  }
}

// Polls the shared bin. Applies remote changes made by ANY visitor
// (including this one from another tab) so all devices converge — with a
// few seconds of latency instead of Firestore's instant push.
async function pullFromCloud() {
  try {
    const res = await fetch(JSONBIN_BASE + '/latest', {
      headers: { 'X-Access-Key': JSONBIN_KEY }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const updatedAt = data.metadata && data.metadata.updatedAt;
    if (updatedAt && updatedAt === lastSeenUpdatedAt) return; // nothing new since last check
    lastSeenUpdatedAt = updatedAt;
    isApplyingRemoteUpdate = true;
    const record = data.record || {};
    SYNCED_FIELDS.forEach(k => { if (record[k] !== undefined) state[k] = record[k]; });
    buildPlayerMap();
    saveLocalOnly();
    renderAll();
    isApplyingRemoteUpdate = false;
  } catch (e) {
    console.error('[K-Gang] cloud pull failed', e);
    toast('⚠️ تعذّر الاتصال بقاعدة البيانات السحابية — راجع إعدادات JSONBin أعلى script.js', 'error');
  }
}

function startPolling() {
  pullFromCloud();
  pollTimer = setInterval(() => {
    if (document.hidden) return; // pause while tab is backgrounded, saves quota
    pullFromCloud();
  }, POLL_INTERVAL_MS);
}


// ========== Helpers ==========
function defaultAvatar(name) {
  let c = (name || '?').trim().charAt(0).toUpperCase();
  // Only allow a single safe letter/digit character into the generated SVG.
  // (Prevents a crafted player name from breaking out of the data URI / markup it's embedded in.)
  if (!c || !/^[A-Za-z0-9\u0600-\u06FF]$/.test(c)) c = '?';
  return 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'128\' height=\'128\'%3E%3Crect fill=\'%231f1c27\' width=\'128\' height=\'128\'/%3E%3Ctext x=\'64\' y=\'80\' text-anchor=\'middle\' fill=\'%239184c9\' font-size=\'48\' font-weight=\'700\' font-family=\'Rajdhani\'%3E' + encodeURIComponent(c) + '%3C/text%3E%3C/svg%3E';
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// Escapes a value for safe use inside an HTML attribute (quotes included).
// escapeHtml() alone does NOT escape quote characters, so it is not safe
// for attribute contexts like src="...".
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only allow http(s) URLs or our own generated data:image/svg+xml avatars.
// Anything else (javascript:, a crafted string with quotes/onerror=, etc.)
// falls back to a generated default avatar instead of being trusted.
function sanitizeAvatarUrl(url, name) {
  const fallback = defaultAvatar(name);
  if (!url || typeof url !== 'string') return fallback;
  const trimmed = url.trim();
  if (/^data:image\/svg\+xml,/i.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed, window.location.href);
    if (u.protocol === 'http:' || u.protocol === 'https:') return trimmed;
  } catch (e) {}
  return fallback;
}

let playerMap = null;
function buildPlayerMap() {
  playerMap = new Map(state.players.map(p => [p.id, p]));
}
function getPlayer(id) {
  if (!playerMap) buildPlayerMap();
  return playerMap.get(id) || null;
}

function toast(msg, type) {
  const t = document.createElement('div');
  t.className = 'toast ' + (type || 'success');
  t.textContent = msg;
  $('#toastContainer').appendChild(t);
  setTimeout(() => { t.classList.add('removing'); setTimeout(() => t.remove(), 300); }, 3000);
}

// ========== Theme Engine ==========
// Presets only define 4 base colors — every other CSS variable (borders,
// hover shades, secondary/muted text, glows) is derived from these at
// apply-time, so a theme change (preset OR a manually-picked color)
// consistently recolors the whole site instead of leaving mismatched bits.
const THEME_PRESETS = {
  kgang:     { label: 'K-Gang الأصلي',   colors: { primary: '#9184c9', textPrimary: '#ece8f5', bgDeep: '#0d0c12', bgSurface: '#1b1822' } },
  cyberpunk: { label: 'سايبربانك',       colors: { primary: '#ff2e9a', textPrimary: '#f2f0ff', bgDeep: '#08060f', bgSurface: '#160f22' } },
  crimson:   { label: 'قرمزي',            colors: { primary: '#e5484d', textPrimary: '#f5e8e8', bgDeep: '#120808', bgSurface: '#1f1010' } },
  emerald:   { label: 'زمردي',            colors: { primary: '#3ecf8e', textPrimary: '#e6f5ee', bgDeep: '#07120d', bgSurface: '#10201a' } },
  ocean:     { label: 'محيطي',            colors: { primary: '#4fa3f7', textPrimary: '#e8f0fa', bgDeep: '#070d16', bgSurface: '#0f1c2e' } },
  sunset:    { label: 'غروب',             colors: { primary: '#f2a154', textPrimary: '#f7ecdf', bgDeep: '#140d07', bgSurface: '#241708' } },
  frost:     { label: 'فاتح (Frost)',     colors: { primary: '#6e5fa8', textPrimary: '#1c1826', bgDeep: '#f5f3fb', bgSurface: '#ffffff' } }
};

const FONT_PAIRS = {
  rajdhani_inter: { label: 'الافتراضي — Rajdhani', display: 'Rajdhani', body: 'Inter', mono: 'JetBrains Mono', google: 'family=Rajdhani:wght@400;500;600;700&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500' },
  orbitron_barlow: { label: 'مستقبلي — Orbitron', display: 'Orbitron', body: 'Barlow', mono: 'JetBrains Mono', google: 'family=Orbitron:wght@500;600;700;800&family=Barlow:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500' },
  arabic_modern: { label: 'عربي عصري — Almarai', display: 'Almarai', body: 'Cairo', mono: 'JetBrains Mono', google: 'family=Almarai:wght@400;700;800&family=Cairo:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500' },
  elegant: { label: 'أنيق — Cinzel', display: 'Cinzel', body: 'Tajawal', mono: 'JetBrains Mono', google: 'family=Cinzel:wght@500;600;700;800&family=Tajawal:wght@300;400;500;700&family=JetBrains+Mono:wght@400;500' },
  tech_mono: { label: 'تقني — Chakra Petch', display: 'Chakra Petch', body: 'Rubik', mono: 'JetBrains Mono', google: 'family=Chakra+Petch:wght@500;600;700&family=Rubik:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500' }
};

function clamp255(n) { return Math.max(0, Math.min(255, Math.round(n))); }

function hexToRgbObj(hex) {
  let h = (hex || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const num = parseInt(h, 16) || 0;
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => clamp255(v).toString(16).padStart(2, '0')).join('');
}

// Mixes hexA and hexB; weightA is the 0..1 proportion of hexA in the result.
function mixHex(hexA, hexB, weightA) {
  const a = hexToRgbObj(hexA), b = hexToRgbObj(hexB);
  return rgbToHex(
    a.r * weightA + b.r * (1 - weightA),
    a.g * weightA + b.g * (1 - weightA),
    a.b * weightA + b.b * (1 - weightA)
  );
}

function hexToRgba(hex, alpha) {
  const { r, g, b } = hexToRgbObj(hex);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

// Applies the 4 base theme colors by deriving every other CSS variable
// (borders, hover shades, secondary/muted text, glows) from them.
function applyThemeColors(c) {
  const root = document.documentElement.style;
  root.setProperty('--primary', c.primary);
  root.setProperty('--primary-dark', mixHex(c.primary, '#000000', 0.82));
  root.setProperty('--primary-light', mixHex(c.primary, '#ffffff', 0.82));
  root.setProperty('--primary-glow', hexToRgba(c.primary, 0.35));
  root.setProperty('--primary-subtle', hexToRgba(c.primary, 0.12));

  root.setProperty('--bg-deep', c.bgDeep);
  root.setProperty('--bg-dark', mixHex(c.bgDeep, c.bgSurface, 0.5));
  root.setProperty('--bg-surface', c.bgSurface);
  root.setProperty('--bg-surface-hover', mixHex(c.bgSurface, c.textPrimary, 0.94));
  root.setProperty('--bg-card', mixHex(c.bgSurface, c.bgDeep, 0.7));
  root.setProperty('--bg-card-hover', mixHex(c.bgSurface, c.textPrimary, 0.91));

  root.setProperty('--text-primary', c.textPrimary);
  root.setProperty('--text-secondary', mixHex(c.textPrimary, c.bgDeep, 0.62));
  root.setProperty('--text-muted', mixHex(c.textPrimary, c.bgDeep, 0.38));

  root.setProperty('--border', mixHex(c.bgSurface, c.textPrimary, 0.88));
  root.setProperty('--border-light', mixHex(c.bgSurface, c.textPrimary, 0.78));

  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', c.bgDeep);
}

function applyThemeFont(fontId) {
  const f = FONT_PAIRS[fontId] || FONT_PAIRS.rajdhani_inter;
  let link = document.getElementById('dynamicFontLink');
  if (!link) {
    link = document.createElement('link');
    link.id = 'dynamicFontLink';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  link.href = 'https://fonts.googleapis.com/css2?' + f.google + '&display=swap';
  const root = document.documentElement.style;
  root.setProperty('--font-display', "'" + f.display + "', sans-serif");
  root.setProperty('--font-body', "'" + f.body + "', sans-serif");
  root.setProperty('--font-mono', "'" + f.mono + "', monospace");
}

// Same URL allow-list as sanitizeAvatarUrl (http/https or our generated
// data URIs only) — this value gets interpolated into a CSS url(), so
// anything else is rejected rather than trusted.
function sanitizeBgImageUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (/^data:image\//i.test(trimmed)) return trimmed.replace(/["\\]/g, '');
  try {
    const u = new URL(trimmed, window.location.href);
    if (u.protocol === 'http:' || u.protocol === 'https:') return trimmed.replace(/["\\]/g, '');
  } catch (e) {}
  return '';
}

function applyThemeBackground(bg) {
  const layer = $('#siteBgLayer');
  const overlay = $('#siteBgOverlay');
  if (!layer || !overlay) return;
  layer.style.filter = bg.blur ? 'blur(' + bg.blur + 'px)' : 'none';

  if (bg.type === 'solid') {
    layer.style.backgroundImage = 'none';
    layer.style.backgroundColor = bg.color || '#000000';
    overlay.style.opacity = 0;
  } else if (bg.type === 'gradient') {
    layer.style.backgroundImage = 'linear-gradient(135deg, ' + (bg.gradColor1 || '#000') + ', ' + (bg.gradColor2 || '#333') + ')';
    layer.style.backgroundColor = 'transparent';
    overlay.style.opacity = 0;
  } else if (bg.type === 'image') {
    const safeUrl = sanitizeBgImageUrl(bg.imageUrl);
    if (safeUrl) {
      layer.style.backgroundImage = 'url("' + safeUrl + '")';
      layer.style.backgroundColor = 'transparent';
      overlay.style.opacity = (bg.overlayOpacity != null ? bg.overlayOpacity : 55) / 100;
    } else {
      layer.style.backgroundImage = 'none';
      overlay.style.opacity = 1;
    }
  } else {
    layer.style.backgroundImage = 'none';
    layer.style.backgroundColor = 'transparent';
    overlay.style.opacity = 1;
  }
}

function applyThemeFull() {
  applyThemeColors(state.theme.colors);
  applyThemeFont(state.theme.font);
  applyThemeBackground(state.theme.background);
}

// ----- Admin panel: Theme tab UI -----
function renderThemeTab() {
  const grid = $('#themeGrid');
  if (!grid) return; // panel not in DOM yet

  grid.innerHTML = Object.keys(THEME_PRESETS).map(id => {
    const p = THEME_PRESETS[id];
    const active = state.theme.preset === id;
    return '<button type="button" class="theme-swatch' + (active ? ' active' : '') + '" onclick="selectThemePreset(\'' + id + '\')">' +
      '<span class="theme-swatch-check">✓</span>' +
      '<span class="theme-swatch-preview"><span style="background:' + p.colors.bgDeep + '"></span><span style="background:' + p.colors.primary + '"></span><span style="background:' + p.colors.bgSurface + '"></span></span>' +
      '<span class="theme-swatch-label">' + escapeHtml(p.label) + '</span>' +
      '</button>';
  }).join('');

  const c = state.theme.colors;
  if ($('#themeColorPrimary')) $('#themeColorPrimary').value = c.primary;
  if ($('#themeColorText')) $('#themeColorText').value = c.textPrimary;
  if ($('#themeColorBgDeep')) $('#themeColorBgDeep').value = c.bgDeep;
  if ($('#themeColorBgSurface')) $('#themeColorBgSurface').value = c.bgSurface;

  const fontSelect = $('#fontSelect');
  if (fontSelect) {
    if (!fontSelect.dataset.built) {
      fontSelect.innerHTML = Object.keys(FONT_PAIRS).map(id => '<option value="' + id + '">' + escapeHtml(FONT_PAIRS[id].label) + '</option>').join('');
      fontSelect.dataset.built = '1';
    }
    fontSelect.value = state.theme.font;
  }

  const bg = state.theme.background;
  $$('.bg-type-tab').forEach(b => b.classList.toggle('active', b.dataset.bgtype === bg.type));
  ['solid', 'gradient', 'image'].forEach(t => {
    const panel = $('#bgPanel-' + t);
    if (panel) panel.classList.toggle('active', bg.type === t);
  });
  if ($('#bgSolidColor')) $('#bgSolidColor').value = bg.color || '#141219';
  if ($('#bgGradColor1')) $('#bgGradColor1').value = bg.gradColor1 || '#1b1822';
  if ($('#bgGradColor2')) $('#bgGradColor2').value = bg.gradColor2 || '#0d0c12';
  if ($('#bgImageUrl')) $('#bgImageUrl').value = /^https?:/i.test(bg.imageUrl || '') ? bg.imageUrl : '';
  const preview = $('#bgImagePreview');
  if (preview) {
    if (bg.type === 'image' && bg.imageUrl) {
      preview.style.backgroundImage = 'url("' + sanitizeBgImageUrl(bg.imageUrl) + '")';
      preview.classList.add('show');
    } else {
      preview.classList.remove('show');
    }
  }
  if ($('#bgOverlayRange')) { $('#bgOverlayRange').value = bg.overlayOpacity; $('#bgOverlayVal').textContent = bg.overlayOpacity + '%'; }
  if ($('#bgBlurRange')) { $('#bgBlurRange').value = bg.blur; $('#bgBlurVal').textContent = bg.blur + 'px'; }
}

function selectThemePreset(id) {
  const preset = THEME_PRESETS[id];
  if (!preset) return;
  state.theme.preset = id;
  state.theme.colors = Object.assign({}, preset.colors);
  applyThemeColors(state.theme.colors);
  renderThemeTab();
  saveState();
  toast('تم تطبيق ثيم "' + preset.label + '" على الموقع');
}

function updateThemeColor(key, value) {
  state.theme.colors[key] = value;
  state.theme.preset = 'custom';
  applyThemeColors(state.theme.colors);
  $$('.theme-swatch').forEach(b => b.classList.remove('active'));
  saveState();
}

function updateFontSelection(fontId) {
  if (!FONT_PAIRS[fontId]) return;
  state.theme.font = fontId;
  applyThemeFont(fontId);
  saveState();
  toast('تم تغيير الخط');
}

function updateBgType(type) {
  state.theme.background.type = type;
  applyThemeBackground(state.theme.background);
  renderThemeTab();
  saveState();
}

function updateBgValue() {
  const bg = state.theme.background;
  if (bg.type === 'solid') bg.color = $('#bgSolidColor').value;
  else if (bg.type === 'gradient') { bg.gradColor1 = $('#bgGradColor1').value; bg.gradColor2 = $('#bgGradColor2').value; }
  else if (bg.type === 'image') bg.imageUrl = $('#bgImageUrl').value.trim();
  applyThemeBackground(bg);
  const preview = $('#bgImagePreview');
  if (preview && bg.type === 'image') {
    const safe = sanitizeBgImageUrl(bg.imageUrl);
    if (safe) { preview.style.backgroundImage = 'url("' + safe + '")'; preview.classList.add('show'); }
    else preview.classList.remove('show');
  }
  saveState();
}

function updateBgOverlay(val) {
  state.theme.background.overlayOpacity = Number(val);
  $('#bgOverlayVal').textContent = val + '%';
  applyThemeBackground(state.theme.background);
  saveState();
}

function updateBgBlur(val) {
  state.theme.background.blur = Number(val);
  $('#bgBlurVal').textContent = val + 'px';
  applyThemeBackground(state.theme.background);
  saveState();
}

// Reads an uploaded image, downsizes it on a canvas, and stores it as a
// compressed base64 data URL — no server/storage bucket needed. Kept
// deliberately small: this data URL lives inside the same shared JSONBin
// record as the rest of the tournament, which has a modest free-tier size
// limit, so a big, uncompressed image could break syncing for everyone.
function handleBgImageUpload(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('لازم تختار ملف صورة', 'error'); return; }
  const reader = new FileReader();
  reader.onload = function() {
    const img = new Image();
    img.onload = function() {
      const maxW = 900;
      const scale = Math.min(1, maxW / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.65);
      state.theme.background.imageUrl = dataUrl;
      applyThemeBackground(state.theme.background);
      renderThemeTab();
      saveState();
      if (dataUrl.length > 70000) {
        toast('⚠️ الصورة كبيرة نسبياً — ممكن متتزامنش مع باقي الزوار عبر السحابة. لو حابب كل الزوار يشوفوها، حط رابط صورة (URL) بدل الرفع', 'error');
      } else {
        toast('تم رفع الخلفية');
      }
    };
    img.onerror = function() { toast('تعذّر قراءة الصورة', 'error'); };
    img.src = reader.result;
  };
  reader.onerror = function() { toast('تعذّر قراءة الملف', 'error'); };
  reader.readAsDataURL(file);
}

function resetTheme() {
  state.theme = {
    preset: 'kgang',
    colors: Object.assign({}, THEME_PRESETS.kgang.colors),
    font: 'rajdhani_inter',
    background: { type: 'default', color: '#141219', gradColor1: '#1b1822', gradColor2: '#0d0c12', imageUrl: '', overlayOpacity: 55, blur: 0 }
  };
  applyThemeFull();
  renderThemeTab();
  saveState();
  toast('تم استعادة المظهر الافتراضي');
}

// ========== Password / Lock ==========
function openAdminPanel() {
  if (state.isLocked) {
    $('#passwordModal').classList.add('open');
    $('#passwordInput').value = '';
    $('#passwordError').textContent = '';
    setTimeout(() => $('#passwordInput').focus(), 100);
  } else {
    toggleAdminPanel(true);
  }
}

function closeAdmin() { toggleAdminPanel(false); }

function toggleAdminPanel(open) {
  $('#adminPanel').classList.toggle('open', open);
}

async function checkPassword() {
  const pw = $('#passwordInput').value;
  const btn = $('#passwordModal .btn-primary');
  if (btn) btn.disabled = true;
  const hash = await hashPassword(pw);
  if (btn) btn.disabled = false;
  if (hash === state.adminPasswordHash) {
    state.isLocked = false;
    $('#passwordModal').classList.remove('open');
    toggleAdminPanel(true);
    updateLockUI();
    renderBracket(); // update slot cursors
    saveLocalOnly();
    toast('تم فتح لوحة التحكم');
    warnIfDefaultPassword();
  } else {
    $('#passwordError').textContent = '❌ كلمة السر خطأ';
    $('#passwordInput').value = '';
    $('#passwordInput').focus();
  }
}

// Nags the admin (once per session) if the panel is still protected by the
// factory-default password, since that's effectively no protection at all.
let defaultPasswordWarned = false;
function warnIfDefaultPassword() {
  if (defaultPasswordWarned) return;
  if (state.adminPasswordHash === DEFAULT_PASSWORD_HASH) {
    defaultPasswordWarned = true;
    toast('⚠️ لسه بتستخدم كلمة السر الافتراضية — غيّرها من تبويب الإعدادات', 'error');
  }
}

function toggleLock() {
  if (!state.isLocked) {
    state.isLocked = true;
    toggleAdminPanel(false);
    updateLockUI();
    renderBracket(); // update slot cursors
    saveLocalOnly();
    toast('تم قفل لوحة التحكم');
  } else {
    openAdminPanel();
  }
}

async function changePassword() {
  const input = $('#adminPassword');
  const pw = input.value.trim();
  if (!pw || pw.length < 4) { toast('كلمة السر يجب أن تكون 4 أحرف على الأقل', 'error'); return; }
  state.adminPasswordHash = await hashPassword(pw);
  input.value = '';
  defaultPasswordWarned = false;
  updateDefaultPasswordWarning();
  saveState();
  toast('تم تغيير كلمة السر بنجاح');
}

function updateLockUI() {
  const ind = $('#lockIndicator');
  const txt = $('#lockText');
  if (state.isLocked) {
    ind.style.display = 'none';
  } else {
    ind.style.display = 'flex';
    txt.textContent = 'مفتوح';
  }
  const badge = $('#panelLockBadge');
  if (badge) badge.textContent = state.isLocked ? '🔒 مقفل' : '🔓 مفتوح';
}

// Close password modal on Escape
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    if ($('#passwordModal').classList.contains('open')) { $('#passwordModal').classList.remove('open'); }
    if ($('#adminPanel').classList.contains('open') && state.isLocked) { toggleAdminPanel(false); }
    if ($('#championModal').classList.contains('open')) closeChampionModal();
  }
});

// Close modals on overlay click
document.addEventListener('click', function(e) {
  if (e.target === $('#passwordModal')) $('#passwordModal').classList.remove('open');
  if (e.target === $('#championModal')) closeChampionModal();
});

// ========== Players ==========
function addPlayer(e) {
  e.preventDefault();
  const name = $('#playerName').value.trim();
  if (!name) { toast('الرجاء إدخال اسم اللاعب', 'error'); return; }
  const avatarInput = $('#playerAvatar').value.trim();
  state.players.push({
    id: state.nextPlayerId++,
    name,
    discordId: $('#playerDiscord').value.trim(),
    avatarUrl: avatarInput ? sanitizeAvatarUrl(avatarInput, name) : defaultAvatar(name),
    seed: state.players.length + 1
  });
  buildPlayerMap();
  saveState();
  renderPlayers();
  updateStats();
  $('#playerForm').reset();
  toast('تمت إضافة ' + name);
}

function removePlayer(id) {
  if (state.tournamentStarted) { toast('لا يمكن تعديل اللاعبين بعد بدء البطولة', 'error'); return; }
  state.players = state.players.filter(p => p.id !== id);
  state.players.forEach((p, i) => p.seed = i + 1);
  buildPlayerMap();
  saveState(); renderPlayers(); updateStats(); toast('تم حذف اللاعب');
}

function editPlayer(id) {
  const p = getPlayer(id);
  if (!p) return;
  const n = prompt('اسم اللاعب:', p.name);
  if (!n || !n.trim()) return;
  p.name = n.trim();

  // Cancel returns null from prompt(); previously that was coerced to '' and
  // silently wiped out an existing Discord ID / avatar. Only overwrite when
  // the user actually confirmed the dialog (didn't press Cancel).
  const discordInput = prompt('معرف ديسكورد:', p.discordId || '');
  if (discordInput !== null) p.discordId = discordInput.trim();

  const avatarInput = prompt('رابط الصورة:', p.avatarUrl || '');
  if (avatarInput !== null) {
    p.avatarUrl = avatarInput.trim() ? sanitizeAvatarUrl(avatarInput.trim(), p.name) : defaultAvatar(p.name);
  }

  saveState(); renderPlayers(); toast('تم تحديث ' + p.name);
}

function clearAllPlayers() {
  if (state.tournamentStarted) { toast('لا يمكن حذف اللاعبين بعد بدء البطولة', 'error'); return; }
  if (!state.players.length) return;
  if (!confirm('حذف جميع اللاعبين؟')) return;
  state.players = [];
  buildPlayerMap();
  saveState(); renderPlayers(); updateStats(); renderBracket(); renderMatchControls();
  toast('تم حذف جميع اللاعبين');
}

function renderPlayers() {
  const list = $('#playersList');
  $('#playersCount').textContent = state.players.length;
  if (!state.players.length) {
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">لا يوجد لاعبون بعد. أضف لاعباً الآن!</div>';
    return;
  }
  list.innerHTML = state.players.map(p =>
    '<div class="player-card">' +
      '<img class="player-avatar" src="' + escapeAttr(sanitizeAvatarUrl(p.avatarUrl, p.name)) + '" alt="' + escapeHtml(p.name) + '" loading="lazy" onerror="this.src=\'' + escapeAttr(defaultAvatar(p.name)) + '\'">' +
      '<div class="player-info">' +
        '<div class="player-name">' + escapeHtml(p.name) + '</div>' +
        '<div class="player-discord">' + (p.discordId ? 'ID: ' + escapeHtml(p.discordId) : '') + '</div>' +
      '</div>' +
      '<div class="player-actions">' +
        '<button class="edit-btn" onclick="editPlayer(' + p.id + ')" title="تعديل">✎</button>' +
        '<button class="delete-btn" onclick="removePlayer(' + p.id + ')" title="حذف">✕</button>' +
      '</div>' +
    '</div>'
  ).join('');
}

// ========== Bracket ==========
// Standard tournament seeding order (e.g. for size 8: [1,8,4,5,2,7,3,6]).
// This is the classic recursive "avoid top seeds meeting early" bracket
// layout used by real tournaments (NCAA-style), so seed 1 and seed 2 can
// only meet in the final, seeds 1-4 can't meet before the semis, etc.
function standardSeedOrder(size) {
  if (size <= 1) return [1];
  let order = [1, 2];
  while (order.length < size) {
    const total = order.length * 2 + 1;
    const next = [];
    order.forEach(s => { next.push(s); next.push(total - s); });
    order = next;
  }
  return order;
}

function generateBracket() {
  if (state.players.length < 2) { toast('يجب إضافة لاعبين على الأقل', 'error'); return; }
  if (state.tournamentStarted) { toast('البطولة قيد التشغيل', 'error'); return; }

  const size = Math.pow(2, Math.ceil(Math.log2(state.players.length)));
  const rounds = Math.log2(size);
  const sorted = [...state.players].sort((a, b) => a.seed - b.seed);
  const slots = new Array(size).fill(null);

  const order = standardSeedOrder(size); // order[i] = seed number placed at slot i
  order.forEach((seed, pos) => {
    if (seed <= sorted.length) slots[pos] = sorted[seed - 1];
  });

  state.matches = [];
  state.nextMatchId = 1;
  state.tournamentStarted = true;
  state.tournamentFinished = false;

  for (let i = 0; i < slots.length; i += 2) {
    const p1 = slots[i], p2 = slots[i + 1];
    const isBye = !p1 || !p2;
    const winner = isBye ? (p1 || p2 || null) : null;
    state.matches.push({
      id: state.nextMatchId++, round: 1, position: i / 2,
      player1Id: p1 ? p1.id : null, player2Id: p2 ? p2.id : null,
      winnerId: winner ? winner.id : null, isBye
    });
  }

  for (let r = 2; r <= rounds; r++) {
    const c = size / Math.pow(2, r);
    for (let p = 0; p < c; p++) {
      state.matches.push({
        id: state.nextMatchId++, round: r, position: p,
        player1Id: null, player2Id: null, winnerId: null, isBye: false
      });
    }
  }

  state.matches.filter(m => m.isBye).forEach(m => {
    if (m.winnerId) autoAdvance(m.id, m.winnerId);
  });

  saveState(); renderBracket(); renderMatchControls(); updateStats(); updateBracketStatus();
  toast('بدأت البطولة! ' + state.players.length + ' لاعبين في ' + rounds + ' أدوار');
}

function setWinner(matchId, playerId) {
  const match = state.matches.find(m => m.id === matchId);
  if (!match || !playerId) return;
  if (state.tournamentFinished) { toast('انتهت البطولة', 'error'); return; }
  if (state.tournamentPaused) { toast('⏸️ البطولة موقوفة مؤقتاً', 'error'); return; }
  if (match.player1Id !== playerId && match.player2Id !== playerId) return;

  if (match.winnerId === playerId) {
    if (match.isBye) { toast('لا يمكن إلغاء تأهل باي', 'error'); return; }
    match.winnerId = null;
    clearDownstream(match);
    state.tournamentFinished = false;
    saveState(); renderBracket(); renderMatchControls(); updateBracketStatus();
    return;
  }

  match.winnerId = playerId;
  autoAdvance(matchId, playerId);

  const finalRound = Math.max(...state.matches.map(m => m.round));
  const finalMatch = state.matches.find(m => m.round === finalRound);
  if (finalMatch && finalMatch.winnerId) {
    state.tournamentFinished = true;
    saveState(); renderBracket(); renderMatchControls(); updateStats(); updateBracketStatus();
    showChampionModal(finalMatch.winnerId);
    toast('انتهت البطولة! تهانياً للبطل!');
    return;
  }

  saveState(); renderBracket(); renderMatchControls(); updateStats(); updateBracketStatus();
}

function autoAdvance(matchId, winnerId) {
  const match = state.matches.find(m => m.id === matchId);
  if (!match) return;
  const next = state.matches.find(m => m.round === match.round + 1 && m.position === Math.floor(match.position / 2));
  if (!next) return;

  // Place winner in the correct slot of the next match
  if (match.position % 2 === 0) next.player1Id = winnerId;
  else next.player2Id = winnerId;

  // Stop here. The next match waits for both players before a winner can be set.
  // No auto-advance cascade — each round must be played.
}

function clearDownstream(match) {
  if (!match) return;
  const next = state.matches.find(m => m.round === match.round + 1 && m.position === Math.floor(match.position / 2));
  if (!next) return;
  if (match.position % 2 === 0) next.player1Id = null;
  else next.player2Id = null;
  if (next.winnerId) { next.winnerId = null; next.isBye = false; clearDownstream(next); }
}

function togglePause() {
  if (!state.tournamentStarted) return;
  state.tournamentPaused = !state.tournamentPaused;
  saveState();
  renderBracket();
  renderMatchControls();
  updateBracketStatus();
  toast(state.tournamentPaused ? '⏸️ تم إيقاف البطولة مؤقتاً' : '▶️ تم استئناف البطولة');
}

function resetBracket() {
  if (!state.tournamentStarted) return;
  if (!confirm('إعادة تعيين البطولة؟ سيتم مسح جميع النتائج.')) return;
  state.tournamentStarted = false;
  state.tournamentPaused = false;
  state.tournamentFinished = false;
  state.matches = [];
  saveState(); renderBracket(); renderMatchControls(); updateStats(); updateBracketStatus();
  toast('تم إعادة تعيين البطولة');
}

// ========== Bracket Rendering ==========
function renderBracket() {
  const grid = $('#bracketGrid');
  const empty = $('#bracketEmpty');

  if (!state.tournamentStarted || !state.matches.length) {
    grid.innerHTML = '';
    grid.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }

  grid.style.display = 'flex';
  empty.style.display = 'none';

  const rounds = [...new Set(state.matches.map(m => m.round))].sort((a, b) => a - b);
  grid.classList.toggle('paused', state.tournamentPaused);
  const maxR = Math.max(...rounds);

  const nameMap = {};
  nameMap[maxR] = 'النهائي';
  if (maxR === 3) { nameMap[1] = 'ربع النهائي'; nameMap[2] = 'نصف النهائي'; }
  else if (maxR === 2) { nameMap[1] = 'نصف النهائي'; }

  function slotHtml(match, playerId, isFirst) {
    if (playerId == null) {
      const waitingText = match.isBye ? 'باي (تأهل تلقائي)' : 'بانتظار المتأهل';
      return '<div class="match-slot empty' + (match.isBye ? ' bye-indicator' : '') + '"><span class="slot-name" style="padding-left:20px">' + waitingText + '</span></div>';
    }
    const p = getPlayer(playerId);
    const iw = match.winnerId === playerId;
    const isByeSlot = match.isBye && ((isFirst && !match.player2Id) || (!isFirst && !match.player1Id));
    const locked = state.isLocked ? ' locked' : '';
    return '<div class="match-slot' + (iw ? ' winner' : '') + locked + '" data-match="' + match.id + '" data-player="' + playerId + '">' +
      (p
        ? '<img class="slot-avatar" src="' + escapeAttr(sanitizeAvatarUrl(p.avatarUrl, p.name)) + '" alt="" loading="lazy" onerror="this.src=\'' + escapeAttr(defaultAvatar(p.name)) + '\'">'
        : '') +
      '<div class="slot-info">' +
        '<span class="slot-name">' + (p ? escapeHtml(p.name) : '—') + (match.isBye ? ' <span class="bye-tag">BYE</span>' : '') + '</span>' +
        (p && p.discordId ? '<span class="slot-id">' + escapeHtml(p.discordId) + '</span>' : '') +
      '</div>' +
      '</div>';
  }

  let html = '';

  if (state.tournamentPaused) {
    html += '<div class="paused-banner"><div class="paused-icon">⏸️</div><div class="paused-text">البطولة موقوفة مؤقتاً</div><div class="paused-sub">المباريات متوقفة حتى استئناف البطولة</div></div>';
  }

  rounds.forEach(round => {
    const matches = state.matches.filter(m => m.round === round).sort((a, b) => a.position - b.position);
    html += '<div class="round-column"><div class="round-header">' + (nameMap[round] || 'الدور ' + round) + '</div>';

    matches.forEach(match => {
      const hw = match.winnerId != null;
      const byeClass = match.isBye ? ' match-bye' : '';
      html += '<div class="match-card' + (hw ? ' has-winner' : '') + byeClass + '">';
      html += slotHtml(match, match.player1Id, true);
      html += slotHtml(match, match.player2Id, false);
      html += '</div>';
    });

    html += '</div>';
  });

  grid.innerHTML = html;
}

// Click on bracket slot
document.addEventListener('click', function(e) {
  const slot = e.target.closest('.match-slot[data-match]');
  if (!slot) return;
  const matchId = parseInt(slot.dataset.match);
  const playerId = parseInt(slot.dataset.player);
  if (state.isLocked) {
    toast('يجب فتح لوحة التحكم أولاً', 'error');
    return;
  }
  if (state.tournamentPaused) {
    toast('⏸️ البطولة موقوفة مؤقتاً', 'error');
    return;
  }
  setWinner(matchId, playerId);
});

// ========== Match Controls (Admin) ==========
function renderMatchControls() {
  const el = $('#matchControls');
  if (!state.tournamentStarted || !state.matches.length) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">ابدأ البطولة أولاً لتظهر المباريات هنا</p>';
    return;
  }

  let html = '<div class="mc-toolbar">';
  html += '<button class="mc-pause-btn ' + (state.tournamentPaused ? 'resume' : 'pause') + '" onclick="togglePause()" title="' + (state.tournamentPaused ? 'استئناف البطولة' : 'إيقاف البطولة مؤقتاً') + '">';
  html += state.tournamentPaused ? '▶️ استئناف' : '⏸️ إيقاف مؤقت';
  html += '</button>';
  if (state.tournamentPaused) {
    html += '<span class="paused-indicator">⏸️ البطولة موقوفة مؤقتاً</span>';
  }
  html += '</div>';

  const rounds = [...new Set(state.matches.map(m => m.round))].sort((a, b) => a - b);
  const maxR = Math.max(...rounds);
  const nameMap = {};
  nameMap[maxR] = 'النهائي';
  if (maxR === 3) { nameMap[1] = 'ربع النهائي'; nameMap[2] = 'نصف النهائي'; }
  else if (maxR === 2) { nameMap[1] = 'نصف النهائي'; }

  rounds.forEach(round => {
    const matches = state.matches.filter(m => m.round === round).sort((a, b) => a.position - b.position);
    let rHtml = '<div class="mc-round"><div class="mc-round-title">' + (nameMap[round] || 'الدور ' + round) + '</div>';

    matches.forEach(m => {
      const p1 = getPlayer(m.player1Id), p2 = getPlayer(m.player2Id);
      const p1Name = p1 ? p1.name : '—';
      const p2Name = p2 ? p2.name : '—';
      const hasWinner = m.winnerId != null;
      const disabled = state.tournamentPaused || !m.player1Id;

      rHtml += '<div class="mc-match' + (hasWinner ? ' mc-done' : '') + (state.tournamentPaused ? ' mc-paused' : '') + '">';
      rHtml += '<div class="mc-players">';
      rHtml += '<button class="mc-btn' + (m.winnerId === m.player1Id ? ' mc-winner' : '') + '" onclick="setWinner(' + m.id + ',' + m.player1Id + ')" ' + (disabled ? 'disabled' : '') + '>' + escapeHtml(p1Name) + '</button>';
      rHtml += '<span class="mc-vs">VS</span>';
      rHtml += '<button class="mc-btn' + (m.winnerId === m.player2Id ? ' mc-winner' : '') + '" onclick="setWinner(' + m.id + ',' + m.player2Id + ')" ' + (!m.player2Id || state.tournamentPaused ? 'disabled' : '') + '>' + escapeHtml(p2Name) + '</button>';
      rHtml += '</div>';
      if (m.isBye) rHtml += '<span class="mc-bye">باي</span>';
      rHtml += '</div>';
    });

    rHtml += '</div>';
    html += rHtml;
  });

  el.innerHTML = html;
}

// ========== UI ==========
function updateStats() {
  $('#playerCount').textContent = state.players.length;
  $('#matchCount').textContent = state.tournamentStarted ? state.matches.filter(m => m.round === 1).length : '—';
  const r = state.tournamentStarted ? [...new Set(state.matches.map(m => m.round))].length : 0;
  $('#roundCount').textContent = r || '—';
}

function updateBracketStatus() {
  const s = $('#bracketStatus');
  if (!state.tournamentStarted) { s.textContent = 'بانتظار الإعداد'; s.className = 'bracket-status pending'; }
  else if (state.tournamentPaused) { s.textContent = '⏸️ موقوفة'; s.className = 'bracket-status paused'; }
  else if (state.tournamentFinished) { s.textContent = 'انتهت'; s.className = 'bracket-status finished'; }
  else { s.textContent = 'جارية'; s.className = 'bracket-status active'; }
}

function switchTab(tab) {
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + tab));
  if (tab === 'settings') updateDefaultPasswordWarning();
  if (tab === 'theme') renderThemeTab();
}

function updateDefaultPasswordWarning() {
  const el = $('#defaultPasswordWarning');
  if (el) el.style.display = (state.adminPasswordHash === DEFAULT_PASSWORD_HASH) ? 'block' : 'none';
}

function saveSettings() {
  const name = $('#tournamentName').value.trim();
  const desc = $('#tournamentDesc').value.trim();
  if (name) { state.settings.name = name; $('#tournamentTitle').textContent = name; }
  if (desc) { state.settings.description = desc; $('#tournamentDesc').textContent = desc; }
  saveState();
  toast('تم حفظ الإعدادات');
}

// ========== Champion Modal ==========
function showChampionModal(playerId) {
  const p = getPlayer(playerId);
  if (!p) return;
  const img = $('#championAvatar img');
  img.src = sanitizeAvatarUrl(p.avatarUrl, p.name);
  img.onerror = function() { this.src = defaultAvatar(p.name); };
  $('#championName').textContent = p.name;
  $('#championModal').classList.add('open');
}

function closeChampionModal() { $('#championModal').classList.remove('open'); }

// ========== Share ==========
// Practical limit for URLs: most browsers handle 8k+ but many chat apps,
// old proxies, and some servers start truncating/rejecting well before
// that — 1900 is a safe, commonly-cited threshold to warn under.
const SHARE_URL_WARN_LENGTH = 1900;

function shareTournament() {
  const data = {
    name: state.settings.name,
    players: state.players.map(p => ({ name: p.name, discordId: p.discordId, avatarUrl: p.avatarUrl, seed: p.seed })),
    matches: state.matches.map(m => ({ round: m.round, position: m.position, player1Id: m.player1Id, player2Id: m.player2Id, winnerId: m.winnerId, isBye: m.isBye })),
    started: state.tournamentStarted, finished: state.tournamentFinished, paused: state.tournamentPaused
  };
  const url = window.location.origin + window.location.pathname + '?b=' + encodeURIComponent(JSON.stringify(data));

  // Always populate the manual-copy box first, regardless of whether the
  // clipboard API works — the user needs a fallback either way.
  const inp = $('#shareUrl');
  if (inp) inp.value = url;

  copyUrl(url).then(ok => {
    if (ok) toast('تم نسخ رابط المشاركة!');
    else toast('تعذّر النسخ التلقائي — الرابط جاهز في الحقل، انسخه يدوياً', 'error');
    warnIfShareUrlTooLong(url);
  });
}

// Returns a Promise<boolean> — true if the copy actually succeeded.
async function copyUrl(url) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try { await navigator.clipboard.writeText(url); return true; } catch (e) { /* fall through */ }
  }
  try {
    const inp = $('#shareUrl');
    inp.value = url;
    inp.select();
    inp.setSelectionRange(0, url.length); // mobile Safari needs this
    const ok = document.execCommand('copy');
    return !!ok;
  } catch (e) {
    return false;
  }
}

function warnIfShareUrlTooLong(url) {
  if (url.length > SHARE_URL_WARN_LENGTH) {
    toast('⚠️ الرابط طويل جداً (' + url.length + ' حرف) — ممكن ينقطع في بعض المتصفحات أو تطبيقات الشات مع كتر اللاعبين', 'error');
  }
}

function loadShared() {
  const raw = new URLSearchParams(window.location.search).get('b');
  if (!raw) return false;
  try {
    const d = JSON.parse(decodeURIComponent(raw));
    if (!d.players || !d.players.length) return false;
    state.players = d.players.map((p, i) => ({
      id: i + 1, name: p.name, discordId: p.discordId || '',
      avatarUrl: p.avatarUrl || defaultAvatar(p.name), seed: p.seed || i + 1
    }));
    state.nextPlayerId = state.players.length + 1;
    buildPlayerMap();
    if (d.matches && d.matches.length) {
      state.matches = d.matches.map((m, i) => ({
        id: i + 1, round: m.round, position: m.position,
        player1Id: m.player1Id, player2Id: m.player2Id,
        winnerId: m.winnerId, isBye: m.isBye || false
      }));
      state.nextMatchId = state.matches.length + 1;
      state.tournamentStarted = !!d.started;
      state.tournamentFinished = !!d.finished;
      state.tournamentPaused = !!d.paused;
    }
    saveState();
    return true;
  } catch (e) { return false; }
}

// ========== Init ==========
function renderAll() {
  try { applyThemeFull(); renderThemeTab(); } catch (e) { console.error('[K-Gang] theme apply failed', e); }
  $('#tournamentTitle').textContent = state.settings.name;
  $('#tournamentDesc').textContent = state.settings.description;
  $('#tournamentName').value = state.settings.name;
  $('#tournamentDesc').value = state.settings.description;
  updateLockUI();
  updateDefaultPasswordWarning();
  renderPlayers();
  renderBracket();
  renderMatchControls();
  updateStats();
  updateBracketStatus();
}

document.addEventListener('DOMContentLoaded', function() {
  loadLocalCache();   // instant paint from last-seen cache (works offline too)
  loadShared();        // legacy: import from an old-style ?b= share link, if present
  state.isLocked = true; // Always start locked for security
  renderAll();

  cloudEnabled = initCloud();
  if (cloudEnabled) {
    startPolling(); // polling sync — every visitor converges within a few seconds
  } else {
    toast('⚠️ التخزين السحابي مش متظبط لسه — التعديلات هتفضل محلية بس على الجهاز ده. راجع الإعدادات أعلى script.js', 'error');
  }
});
