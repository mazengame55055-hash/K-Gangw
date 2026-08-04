/* ============================================
   The Kareka | K-Gang Tournament - App Logic
   ============================================ */

window.addEventListener('error', function(e) {
  // Only surface errors that actually come from this file. Without this
  // check, errors injected by browser extensions or third-party scripts
  // some free hosts add to every page (ads, analytics) get caught here
  // too and shown to the user as if they were bugs in K-Gang itself.
  if (!e.filename || e.filename.indexOf('script.js') === -1) return;
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
    background: { type: 'default', color: '#141219', gradColor1: '#1b1822', gradColor2: '#0d0c12', imageUrl: '', overlayOpacity: 55, blur: 0 },
    // Team logo image (compressed data URL) shown in the header, hero crest
    // and the exported bracket image. Empty string = the default K hexagon.
    logo: '',
    // Per-preset thumbnail overrides uploaded from the admin panel
    // ({ presetId: compressed data URL }) — shown in the theme list, synced
    // to every visitor like the rest of `theme`. Missing ids fall back to
    // THEME_PRESETS[id].image, then to a generated emblem.
    themeImages: {},
    // Shape used to frame every player avatar site-wide (match slots, the
    // admin players list, the champion modal) AND in the exported
    // image/PDF, so both always look identical. One of: circle | hexagon | square.
    avatarShape: 'circle',
    // Animation / motion settings — admin-configurable from the "المؤثرات" tab
    // and synced to every visitor like the rest of `theme`.
    animations: {
      bracketEntrance: 'fade', // how match cards animate in: fade | slide | flip | zoom | none
      winnerFlip: true,        // 3D 360° flip on the winning slot when a result is set
      logoSpin: false,         // continuous 360° rotation on the crest/logo icons
      bgMotion: true,          // slow drifting light overlay on the site background
      cardTilt: true           // subtle 3D tilt on match/player cards on hover
    }
  }
};

const DEFAULT_PASSWORD_HASH = '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9';

const DEFAULT_ANIMATIONS = { bracketEntrance: 'fade', winnerFlip: true, logoSpin: false, bgMotion: true, cardTilt: true };

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
  // Never let a state that lost the admin password hash (or never had one
  // in the cloud) overwrite a bin that DOES have one — otherwise a single
  // stale load can silently wipe the panel lock for every visitor.
  if (!cloudEnabled || isApplyingRemoteUpdate) return;
  if (state.adminPasswordHash == null) {
    console.warn('[K-Gang] refusing cloud push while adminPasswordHash is missing');
    return;
  }
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
      ensureAnimationsDefaults();
      buildPlayerMap();
      return true;
    }
  } catch (e) {}
  return false;
}

// Avoids showing the same "cloud save failed" toast over and over if a
// push keeps failing (e.g. offline for a while) — one warning is enough.
let lastCloudErrorToastAt = 0;

// Marker key that flags a record as LZ-String-compressed, so pullFromCloud
// can tell it apart from an old, pre-compression raw record still sitting
// in the bin (no migration step needed — first push after loading just
// overwrites it in the new compressed format).
const LZ_MARKER = '__lz';

function hasLzString() {
  return typeof LZString !== 'undefined';
}

// Wraps the synced fields into a single compressed string field. Cuts the
// bytes actually sent to/stored on JSONBin — usually 40-70% smaller for the
// JSON structure/text (player names, settings, theme colors, etc.); base64
// image data compresses less since it's already dense, but every bit still
// counts toward the free-tier size limit.
function buildCloudBody(payload) {
  if (!hasLzString()) return JSON.stringify(payload); // CDN blocked/offline: fall back to raw JSON
  const compressed = LZString.compressToBase64(JSON.stringify(payload));
  return JSON.stringify({ [LZ_MARKER]: true, data: compressed });
}

// Reverses buildCloudBody. Also transparently reads old, never-compressed
// records (no __lz marker) so upgrading this file doesn't break existing
// tournaments already stored in the bin.
function parseCloudRecord(record) {
  if (record && record[LZ_MARKER] && hasLzString()) {
    try {
      const json = LZString.decompressFromBase64(record.data);
      return json ? JSON.parse(json) : {};
    } catch (e) {
      console.error('[K-Gang] failed to decompress cloud record', e);
      return {};
    }
  }
  return record || {}; // old uncompressed format, or LZString not loaded
}

async function pushToCloud() {
  const body = buildCloudBody(getSyncPayload());
  try {
    const res = await fetch(JSONBIN_BASE, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Access-Key': JSONBIN_KEY },
      body
    });
    if (!res.ok) {
      // JSONBin's free tier rejects records past its size limit — this is
      // the actual cause of "changes aren't syncing" when someone has
      // uploaded a large background image or the tournament has grown a
      // lot. Surface that specifically instead of a generic network error.
      let reason = '';
      try { reason = (await res.json()).message || ''; } catch (_) {}
      if (res.status === 400 || res.status === 413 || /size|large|limit/i.test(reason)) {
        toast('⚠️ بيانات البطولة كبرت عن الحد المسموح للتخزين السحابي المجاني حتى بعد الضغط (~' + Math.round(body.length / 1024) + ' كيلوبايت) — التعديل اتحفظ على جهازك بس ومش هيوصل لباقي الزوار. قلّل حجم صورة الخلفية أو احذف لاعبين مش محتاجهم', 'error');
      } else {
        throw new Error('HTTP ' + res.status);
      }
      return;
    }
    const data = await res.json();
    if (data.metadata && data.metadata.updatedAt) lastSeenUpdatedAt = data.metadata.updatedAt;
  } catch (e) {
    console.error('[K-Gang] cloud save failed', e);
    const now = Date.now();
    if (now - lastCloudErrorToastAt > 15000) {
      lastCloudErrorToastAt = now;
      toast('⚠️ فشل حفظ التعديلات على السحابة — تحقق من الاتصال', 'error');
    }
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
    try {
      const record = parseCloudRecord(data.record);
      // If the cloud record lost its password hash (e.g. a stale device
      // pushed a null), keep the hash we already have instead of unlocking
      // the panel for everyone on the next poll.
      const localHashBeforePull = state.adminPasswordHash;
      SYNCED_FIELDS.forEach(k => { if (record[k] !== undefined) state[k] = record[k]; });
      if (record.adminPasswordHash == null && localHashBeforePull != null) {
        state.adminPasswordHash = localHashBeforePull;
      }
      ensureAnimationsDefaults();
      resultHistory = [];
      buildPlayerMap();
      saveLocalOnly();
      renderAll();
    } finally {
      isApplyingRemoteUpdate = false;
    }
  } catch (e) {
    console.error('[K-Gang] cloud pull failed', e);
    const now = Date.now();
    if (now - lastCloudErrorToastAt > 30000) {
      lastCloudErrorToastAt = now;
      toast('⚠️ تعذّر الاتصال بقاعدة البيانات السحابية — راجع إعدادات JSONBin أعلى script.js', 'error');
    }
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
// خريطة أسماء الفرق → [إيموجي احتياطي، لون، رابط صورة حقيقية]. أي اسم موجود في
// الخريطة هيعرض صورة حقيقية من الإنترنت في كل حتة (القايمة، المخطط، التصدير،
// نافذة البطل) — نفس الاسم → نفس الصورة دايمًا. لو الصورة النت فضلت/اتقطعت،
// بيفضل الإيموجي كصورة احتياطية، وبعده الحرف الأول.
const TEAM_AVATARS = {
  'الحمام الممتاز':             ['🕊️', '#5b7cfa', 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a2/Rock_Pigeon_white.jpg/500px-Rock_Pigeon_white.jpg'],
  'نظام الطيبات':               ['🍗', '#e67e22', 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/Fried-Chicken-Leg.jpg/500px-Fried-Chicken-Leg.jpg'],
  'المتأهل':                    ['🏆', '#d4a017', 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/14/Gold_Trophy.jpg/500px-Gold_Trophy.jpg'],
  'sweety force':               ['💖', '#e91e8c', 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/14/Gold_Trophy.jpg/500px-Gold_Trophy.jpg'],
  'الحمامجية':                  ['🐦', '#16a085', 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/63/Pigeons_fly.jpg/500px-Pigeons_fly.jpg'],
  'الفرحة 🎀':                  ['🎀', '#f06292', 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d7/Confetti_%285879576562%29.jpg/500px-Confetti_%285879576562%29.jpg'],
  'كبار السن':                  ['👴', '#7f8c8d', 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Happy_Old_Man.jpg/500px-Happy_Old_Man.jpg'],
  '💪 احنا معندناش وبقى عندنا': ['💪', '#e74c3c', 'https://upload.wikimedia.org/wikipedia/commons/5/5c/Arm_flex_pronate.jpg'],
  'Food Cord':                  ['🍔', '#d68910', 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Quick_Burger_hamburgers_and_fries.jpg/500px-Quick_Burger_hamburgers_and_fries.jpg'],
  'ملل':                        ['🥱', '#95a5a6', 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5c/Bored_Man.jpg/500px-Bored_Man.jpg'],
  'TEAM':                       ['👥', '#3498db', 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/97/Group_of_people_talking.jpg/500px-Group_of_people_talking.jpg'],
  'القهوة':                     ['☕', '#a0522d', 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c2/Espresso_in_Espressotasse_von_Julius_Meinl_aus_Wien_1.JPG/500px-Espresso_in_Espressotasse_von_Julius_Meinl_aus_Wien_1.JPG'],
  'فرنة بلخة':                  ['🥖', '#ca9b65', 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Bread_-_Ekmek.jpg/500px-Bread_-_Ekmek.jpg'],
  'الحبة الكاملة':              ['🌾', '#7d8a2e', 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/16/Golden_wheat_field_2.jpg/500px-Golden_wheat_field_2.jpg'],
  '3H':                         ['🎧', '#8e44ad', 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8e/Woman_listening_to_music_with_wireless_headphones_neon_light_%2850810419882%29.jpg/500px-Woman_listening_to_music_with_wireless_headphones_neon_light_%2850810419882%29.jpg'],
  '404 حمام':                   ['❓', '#566573', 'https://upload.wikimedia.org/wikipedia/commons/8/8a/404_File_not_found.png'],
  'Team X':                     ['❌', '#c0392b', 'https://upload.wikimedia.org/wikipedia/commons/8/81/Red_Letter_X_on_a_black_background.png']
};

function teamAvatarUrl(name) {
  const known = TEAM_AVATARS[(name || '').trim()];
  return (known && known[2]) || '';
}

function teamEmojiAvatar(emoji, color) {
  return 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27128%27 height=%27128%27%3E' +
    '%3Crect fill=%27%23' + String(color).replace(/^#/, '') + '%27 width=%27128%27 height=%27128%27/%3E' +
    '%3Ctext x=%2764%27 y=%2792%27 text-anchor=%27middle%27 fill=%27%23ffffff%27 font-size=%2770%27%3E' +
    encodeURIComponent(emoji) + '%3C/text%3E%3C/svg%3E';
}

function defaultAvatar(name) {
  const known = TEAM_AVATARS[(name || '').trim()];
  if (known) return teamEmojiAvatar(known[0], known[1]);
  let c = (name || '?').trim().charAt(0).toUpperCase();
  // Only allow a single safe letter/digit character into the generated SVG.
  // (Prevents a crafted player name from breaking out of the data URI / markup it's embedded in.)
  if (!c || !/^[A-Za-z0-9\u0600-\u06FF]$/.test(c)) c = '?';
  // SVG attrs are percent-encoded (no raw quotes) so the data URI stays safe
  // inside single-quoted onerror handlers AND double-quoted src attributes.
  return 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27128%27 height=%27128%27%3E%3Crect fill=%27%231f1c27%27 width=%27128%27 height=%27128%27/%3E%3Ctext x=%2764%27 y=%2780%27 text-anchor=%27middle%27 fill=%27%239184c9%27 font-size=%2748%27 font-weight=%27700%27 font-family=%27Rajdhani%27%3E' + encodeURIComponent(c) + '%3C/text%3E%3C/svg%3E';
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// Single source of truth for round labels ("نصف النهائي", "ربع النهائي"...),
// used by the live bracket, the admin match-controls list, and the image/PDF
// export. Previously this map was duplicated in three places and had
// drifted out of sync (only the export version knew about 16/32-player
// brackets) — building it once here keeps all three views consistent.
function buildRoundNameMap(rounds) {
  const maxR = Math.max(...rounds);
  const nameMap = { [maxR]: 'النهائي' };
  if (maxR === 5) { nameMap[1] = 'دور الـ32'; nameMap[2] = 'ثمن النهائي'; nameMap[3] = 'ربع النهائي'; nameMap[4] = 'نصف النهائي'; }
  else if (maxR === 4) { nameMap[1] = 'ثمن النهائي'; nameMap[2] = 'ربع النهائي'; nameMap[3] = 'نصف النهائي'; }
  else if (maxR === 3) { nameMap[1] = 'ربع النهائي'; nameMap[2] = 'نصف النهائي'; }
  else if (maxR === 2) { nameMap[1] = 'نصف النهائي'; }
  return nameMap;
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

// Only allow http(s) URLs or our own generated data:image/svg+xml avatars,
// plus compressed image data URLs produced by the avatar upload (WebP/PNG).
// Anything else (javascript:, a crafted string with quotes/onerror=, etc.)
// falls back to a generated default avatar instead of being trusted.
function sanitizeAvatarUrl(url, name) {
  const fallback = teamAvatarUrl(name) || defaultAvatar(name);
  if (!url || typeof url !== 'string') return fallback;
  const trimmed = url.trim();
  if (/^data:image\/(svg\+xml|png|jpe?g|webp|gif);/i.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed, window.location.href);
    if (u.protocol === 'http:' || u.protocol === 'https:') return trimmed;
  } catch (e) {}
  return fallback;
}

// Tracks the single most-recent "a winner was just picked" event, so the
// next renderBracket() call can play the 360° flip once on exactly that
// slot instead of re-playing it on every already-decided match whenever the
// bracket re-renders (tab switch, cloud sync, etc).
let pendingWinnerAnim = null;

// Tracks every match whose result was set by the admin, so the "تراجع"
// (undo) button can step back through results in reverse order.
let resultHistory = [];

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

// ========== شاشة التحميل ==========
function hideLoader() {
  const l = $('#loaderScreen');
  if (!l || l.classList.contains('hide')) return;
  l.classList.add('hide');
  setTimeout(() => l.remove(), 600); // امسحها من الـ DOM خالص
}
window.addEventListener('load', hideLoader);
setTimeout(hideLoader, 3500); // شبكة بطيئة؟ ما نحبسش الزائر أكتر من 3.5 ثانية

// ========== كونفيتي البطل ==========
function launchChampionConfetti() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti-canvas';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // دهب + ألوان الثيم الحالي — الكونفيتي بيتغير مع الثيم تلقائياً
  const colors = ['#ffd700', '#fff6d0', '#ffffff'];
  try {
    const cs = getComputedStyle(document.documentElement);
    const p = (cs.getPropertyValue('--primary') || '').trim();
    const pl = (cs.getPropertyValue('--primary-light') || '').trim();
    if (p) colors.push(p);
    if (pl) colors.push(pl);
  } catch (e) {}

  const parts = [];
  for (let i = 0; i < 140; i++) {
    parts.push({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * canvas.height * 0.5,
      w: 5 + Math.random() * 6,
      h: 8 + Math.random() * 9,
      color: colors[Math.floor(Math.random() * colors.length)],
      vy: 2 + Math.random() * 3.5,
      vx: -1.5 + Math.random() * 3,
      rot: Math.random() * Math.PI,
      vr: -0.12 + Math.random() * 0.24,
      sway: Math.random() * Math.PI * 2
    });
  }

  const start = performance.now();
  (function frame(now) {
    const t = (now || performance.now()) - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    parts.forEach(p => {
      p.y += p.vy;
      p.x += p.vx + Math.sin(p.sway + t / 400) * 0.6;
      p.rot += p.vr;
      if (p.y < canvas.height + 30) alive = true;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    if (alive && t < 6000) requestAnimationFrame(frame);
    else canvas.remove();
  })(performance.now());
}

// ========== Theme Engine ==========
// Presets only define 4 base colors — every other CSS variable (borders,
// hover shades, secondary/muted text, glows) is derived from these at
// apply-time, so a theme change (preset OR a manually-picked color)
// consistently recolors the whole site instead of leaving mismatched bits.
// صورة كل تيم في القايمة: لو حطيت رابط صورة (https://... أو data:image/...)
// في حقل `image` هتظهر دي كصورة الثيم في قايمة التيمات، ولو سيبته فاضي
// ('' ) هيظهر لون التيم التدرجي. غيّر الروابط من هنا في ملف script.js وخلاص.
const THEME_PRESETS = {
  kgang:     { label: 'K-Gang الأصلي',   colors: { primary: '#9184c9', textPrimary: '#ece8f5', bgDeep: '#0d0c12', bgSurface: '#1b1822' }, image: '' },
  cyberpunk: { label: 'سايبربانك',       colors: { primary: '#ff2e9a', textPrimary: '#f2f0ff', bgDeep: '#08060f', bgSurface: '#160f22' }, image: '' },
  crimson:   { label: 'قرمزي',            colors: { primary: '#e5484d', textPrimary: '#f5e8e8', bgDeep: '#120808', bgSurface: '#1f1010' }, image: '' },
  emerald:   { label: 'زمردي',            colors: { primary: '#3ecf8e', textPrimary: '#e6f5ee', bgDeep: '#07120d', bgSurface: '#10201a' }, image: '' },
  ocean:     { label: 'محيطي',            colors: { primary: '#4fa3f7', textPrimary: '#e8f0fa', bgDeep: '#070d16', bgSurface: '#0f1c2e' }, image: '' },
  sunset:    { label: 'غروب',             colors: { primary: '#f2a154', textPrimary: '#f7ecdf', bgDeep: '#140d07', bgSurface: '#241708' }, image: '' },
  frost:     { label: 'فاتح (Frost)',     colors: { primary: '#6e5fa8', textPrimary: '#1c1826', bgDeep: '#f5f3fb', bgSurface: '#ffffff' }, image: '' }
};

// Letter shown inside each preset's generated emblem (theme-list thumbnail).
const PRESET_LETTERS = { kgang: 'K', cyberpunk: 'C', crimson: 'C', emerald: 'E', ocean: 'O', sunset: 'S', frost: 'F' };

// Generates a small hexagon emblem data URI in the preset's own colors —
// used as the theme-list thumbnail whenever a preset has no `image` URL
// configured, so every theme shows a distinct picture right away. Quotes
// are percent-encoded so the data URI stays safe inside HTML attributes.
function themeEmblem(colors, letter) {
  const enc = s => String(s).replace(/#/g, '%23');
  const primary = enc(colors.primary);
  const light = enc(mixHex(colors.primary, '#ffffff', 0.5));
  const dark = enc(mixHex(colors.primary, '#000000', 0.4));
  return 'data:image/svg+xml,' +
    '%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2760%27 height=%2760%27%3E' +
    '%3Cpolygon points=%2730,3 54,16 54,44 30,57 6,44 6,16%27 fill=%27' + dark + '%27/%3E' +
    '%3Cpolygon points=%2730,8 50,19 50,41 30,52 10,41 10,19%27 fill=%27' + primary + '%27/%3E' +
    '%3Cpolygon points=%2730,15 44,23 44,37 30,45 16,37 16,23%27 fill=%27' + light + '%27 opacity=%270.85%27/%3E' +
    '%3Ctext x=%2730%27 y=%2739%27 text-anchor=%27middle%27 fill=%27%23ffffff%27 font-size=%2724%27 font-weight=%27700%27 font-family=%27Rajdhani, Tahoma, sans-serif%27%3E' + encodeURIComponent(letter || 'K') + '%3C/text%3E%3C/svg%3E';
}

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
  // حماية: لو ات استدعت بكائن ناقص/فاضي، استخدم ألوان الثيم الافتراضي
  if (!c || typeof c !== 'object') c = THEME_PRESETS.kgang.colors;
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
  // renderAll() (and therefore applyThemeFont) runs on every cloud sync, not
  // just when someone actually changes the font. Re-assigning the same href
  // still makes the browser treat it as a new stylesheet (reload + FOUC-ish
  // flash), so skip the write entirely when nothing changed.
  const newHref = 'https://fonts.googleapis.com/css2?' + f.google + '&display=swap';
  if (link.href !== newHref) link.href = newHref;
  const root = document.documentElement.style;
  root.setProperty('--font-display', "'" + f.display + "', 'Cairo', sans-serif");
  root.setProperty('--font-body', "'" + f.body + "', 'Cairo', sans-serif");
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
  bg = (bg && typeof bg === 'object') ? bg : {};
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

// Sets a body-level class so CSS can frame every avatar on the page (and
// the champion modal) with the chosen shape — see the "Avatar Shape
// System" block in style.css. The canvas export reads `state.theme.avatarShape`
// directly instead, so the exported image/PDF always matches.
function applyAvatarShape(shape) {
  document.body.classList.remove('avatar-shape-circle', 'avatar-shape-hexagon', 'avatar-shape-square');
  document.body.classList.add('avatar-shape-' + (shape || 'circle'));
}

function applyThemeFull() {
  ensureThemeDefaults(); // تطبيع كامل قبل أي تطبيق
  applyThemeColors(state.theme.colors);
  applyThemeFont(state.theme.font);
  applyThemeBackground(state.theme.background);
  applyThemeLogo();
  applyAvatarShape(state.theme.avatarShape);
  applyAnimations(state.theme.animations);
}

// Swaps the default K hexagon SVGs (header, hero crest, hero watermark) for
// the admin-uploaded team logo whenever one is set, and restores them when
// it's removed. Runs for every visitor so the logo stays in sync with the
// rest of the shared theme.
function applyThemeLogo() {
  const logo = (state.theme && state.theme.logo) || '';
  const safe = sanitizeBgImageUrl(logo);
  ['.logo-icon', '.hero-crest-icon', '.hero-crest-logo'].forEach(sel => {
    const box = document.querySelector(sel);
    if (!box) return;
    let img = box.querySelector('img.team-logo-img');
    const svg = box.querySelector('svg');
    if (safe) {
      if (!img) {
        img = document.createElement('img');
        img.className = 'team-logo-img';
        img.alt = '';
        box.insertBefore(img, box.firstChild);
      }
      img.src = safe;
      img.style.display = '';
      if (svg) svg.style.display = 'none';
    } else {
      if (img) img.remove();
      if (svg) svg.style.display = '';
    }
  });
}

// يرمّم كل حقول الثيم الناقصة (preset / colors / font / background / logo /
// themeImages / avatarShape / animations) — من حفظ محلي قديم أو سجل سحابي
// وصل فيه كائن theme جزئي أو فاضي. من غيرها state.theme.colors ممكن يبقى
// undefined وتنهار applyThemeColors بخطأ:
// Cannot read properties of undefined (reading 'primary')
function ensureThemeDefaults() {
  const base = THEME_PRESETS.kgang;
  if (!state.theme || typeof state.theme !== 'object') state.theme = {};
  const t = state.theme;

  if (!t.preset || typeof t.preset !== 'string') t.preset = 'kgang';

  if (!t.colors || typeof t.colors !== 'object') t.colors = {};
  Object.keys(base.colors).forEach(k => {
    if (typeof t.colors[k] !== 'string' || !t.colors[k]) t.colors[k] = base.colors[k];
  });

  if (!t.font || !FONT_PAIRS[t.font]) t.font = 'rajdhani_inter';

  if (!t.background || typeof t.background !== 'object') {
    t.background = { type: 'default', color: '#141219', gradColor1: '#1b1822', gradColor2: '#0d0c12', imageUrl: '', overlayOpacity: 55, blur: 0 };
  } else {
    if (!t.background.type) t.background.type = 'default';
    if (t.background.overlayOpacity == null || isNaN(t.background.overlayOpacity)) t.background.overlayOpacity = 55;
    if (t.background.blur == null || isNaN(t.background.blur)) t.background.blur = 0;
    if (t.background.imageUrl == null) t.background.imageUrl = '';
  }

  if (t.logo == null) t.logo = '';
  if (!t.themeImages || typeof t.themeImages !== 'object') t.themeImages = {};
  if (!['circle', 'hexagon', 'square'].includes(t.avatarShape)) t.avatarShape = 'circle';
  t.animations = Object.assign({}, DEFAULT_ANIMATIONS, t.animations || {});
}

// نفس الاسم القديم كـ wrapper — عشان استدعاءات loadLocalCache / pullFromCloud
// تفضل تشتغل من غير أي تعديل فيهم
function ensureAnimationsDefaults() {
  ensureThemeDefaults();
}

// ========== Animation Engine ==========
// Applies the current animation settings as classes/attributes so CSS can
// react to them. Kept as classes (not inline styles) so all the actual
// keyframes/timings stay declarative and easy to tune in style.css.
function applyAnimations(anim) {
  anim = anim || DEFAULT_ANIMATIONS;
  document.body.classList.toggle('anim-logo-spin', !!anim.logoSpin);
  document.body.classList.toggle('anim-card-tilt', !!anim.cardTilt);
  document.body.classList.toggle('anim-winner-flip', !!anim.winnerFlip);
  const bgLayer = $('#siteBgLayer');
  if (bgLayer) bgLayer.classList.toggle('bg-motion-on', !!anim.bgMotion);
  const grid = $('#bracketGrid');
  if (grid) grid.setAttribute('data-entrance', anim.bracketEntrance || 'fade');
}

// ----- Admin panel: Effects (animations) tab UI -----
function renderEffectsTab() {
  const anim = state.theme.animations;
  if (!anim) return;
  const entranceSelect = $('#entranceSelect');
  if (entranceSelect) entranceSelect.value = anim.bracketEntrance;
  const map = { toggleWinnerFlip: 'winnerFlip', toggleLogoSpin: 'logoSpin', toggleBgMotion: 'bgMotion', toggleCardTilt: 'cardTilt' };
  Object.keys(map).forEach(elId => {
    const el = $('#' + elId);
    if (el) el.checked = !!anim[map[elId]];
  });
}

function updateBracketEntrance(value) {
  ensureThemeDefaults();
  state.theme.animations.bracketEntrance = value;
  applyAnimations(state.theme.animations);
  saveState();
}

function updateAnimToggle(key, checked) {
  ensureThemeDefaults();
  state.theme.animations[key] = !!checked;
  applyAnimations(state.theme.animations);
  saveState();
  const labels = { winnerFlip: 'تأثير القلب عند الفوز', logoSpin: 'تدوير الشعار', bgMotion: 'حركة الخلفية', cardTilt: 'إمالة الكروت' };
  toast((checked ? '✅ تم تفعيل: ' : '⛔ تم إيقاف: ') + (labels[key] || key));
}

// Lets the admin see the winner-flip effect immediately on a demo card,
// without needing to actually resolve a real match first.
function previewWinnerFlip() {
  const demo = $('#effectsPreviewCard');
  if (!demo) return;
  demo.classList.remove('winner-flip-anim');
  void demo.offsetWidth; // force reflow so the animation can restart
  demo.classList.add('winner-flip-anim');
}

function resetAnimations() {
  state.theme.animations = Object.assign({}, DEFAULT_ANIMATIONS);
  applyAnimations(state.theme.animations);
  renderEffectsTab();
  saveState();
  toast('تم استعادة إعدادات المؤثرات الافتراضية');
}

// ========== التحكم في المواجهات: قرعة + تبديل أماكن ==========
function shufflePlayers() {
  if (state.tournamentStarted) { toast('لا يمكن الخلط بعد بدء البطولة — اعمل إعادة تعيين الأول', 'error'); return; }
  if (state.players.length < 2) { toast('أضف فريقين على الأقل', 'error'); return; }
  if (!confirm('خلط ترتيب الفرق عشوائياً؟ الترتيب اليدوي الحالي هيتغيّر.')) return;
  for (let i = state.players.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = state.players[i]; state.players[i] = state.players[j]; state.players[j] = t;
  }
  state.players.forEach((p, k) => p.seed = k + 1);
  buildPlayerMap();
  saveState(); renderPlayers(); updateStats();
  toast('🎲 تم الخلط — راجع معاينة المواجهات تحت، وتقدر تعدّل يدوياً بالأسهم ▲▼');
}

let swapMode = false;
let swapFirstId = null;

function toggleSwapMode() {
  // الخروج مسموح دائماً — الحارس يمنع الدخول بس
  if (swapMode) {
    swapMode = false; swapFirstId = null;
    document.body.classList.remove('swap-mode');
    const b = $('#swapModeBtn'); if (b) b.classList.remove('active');
    toast('تم إيقاف وضع التبديل');
    return;
  }
  if (!state.tournamentStarted) { toast('ابدأ البطولة الأول — قبل البدء استخدم أسهم ▲▼', 'error'); return; }
  if (state.tournamentFinished) { toast('البطولة انتهت — مفيش تبديل بعد النهاية', 'error'); return; }
  swapMode = true; swapFirstId = null;
  document.body.classList.add('swap-mode');
  const b = $('#swapModeBtn'); if (b) b.classList.add('active');
  toast('🔁 وضع التبديل شغال — اضغط على فريقين في المخطط');
}

// الفريق مسموح تبديله طالما ما لعبش مباراة حقيقية محسومة (الباي مش مانع)
function playerHasDecidedMatch(playerId) {
  return state.matches.some(m => m.winnerId != null && !m.isBye &&
    (m.player1Id === playerId || m.player2Id === playerId));
}

function trySwapPlayers(idA, idB) {
  if (idA === idB) { swapFirstId = null; renderBracket(); return; }
  const pa = getPlayer(idA), pb = getPlayer(idB);
  if (!pa || !pb) return;
  if (playerHasDecidedMatch(idA) || playerHasDecidedMatch(idB)) {
    toast('⚠️ لا يمكن التبديل — أحد الفريقين لعب مباراة نتيجتها محسومة', 'error');
    swapFirstId = null;
    renderBracket();
    return;
  }
  // تبديل شامل: المعرّفات بتتبدل في كل المatches — هيكل الشجرة يفضل سليم
  state.matches.forEach(m => {
    if (m.player1Id === idA) m.player1Id = idB; else if (m.player1Id === idB) m.player1Id = idA;
    if (m.player2Id === idA) m.player2Id = idB; else if (m.player2Id === idB) m.player2Id = idA;
  });
  toast('✅ تم تبديل «' + pa.name + '» و«' + pb.name + '»');
  swapMode = false; swapFirstId = null;
  document.body.classList.remove('swap-mode');
  saveState(); renderBracket(); renderMatchControls();
}

// ----- Admin panel: Theme tab UI -----
function renderThemeTab() {
  const grid = $('#themeGrid');
  if (!grid) return; // panel not in DOM yet

  grid.innerHTML = Object.keys(THEME_PRESETS).map(id => {
    const p = THEME_PRESETS[id];
    const active = state.theme.preset === id;
    // Big live preview shaped like the player avatar (same shape classes the
    // rest of the site uses).
    const shape = state.theme.avatarShape || 'circle';
    // Preset thumbnail: an admin-uploaded override (state.theme.themeImages)
    // wins, then an explicit `image` URL from THEME_PRESETS, then a generated
    // emblem in the preset's own colors. `&quot;` is used because this style
    // lives inside a double-quoted HTML attribute and the URL has no raw `"`
    // (sanitized / percent-encoded).
    const over = (state.theme.themeImages || {})[id];
    const imgUrl = over || (p.image ? sanitizeBgImageUrl(p.image) : '');
    const previewUrl = imgUrl || themeEmblem(p.colors, PRESET_LETTERS[id]);
    const previewStyle = 'background-image:url(&quot;' + previewUrl + '&quot;);background-size:cover;background-position:center;';
    return '<button type="button" class="theme-swatch' + (active ? ' active' : '') + '" onclick="selectThemePreset(\'' + id + '\')">' +
      '<span class="theme-swatch-check">✓</span>' +
      '<span class="theme-swatch-preview theme-swatch-preview-' + shape + '" style="' + previewStyle + '"></span>' +
      '<span class="theme-swatch-label">' + escapeHtml(p.label) + '</span>' +
      '</button>';
  }).join('');

  const c = state.theme.colors || {};
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

  const bg = state.theme.background || {};
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

  const shape = state.theme.avatarShape || 'circle';
  $$('.avatar-shape-option').forEach(b => b.classList.toggle('active', b.dataset.shape === shape));

  const logo = (state.theme.logo || '') && sanitizeBgImageUrl(state.theme.logo);
  const logoPreview = $('#teamLogoPreview');
  if (logoPreview) {
    if (logo) {
      logoPreview.style.backgroundImage = 'url("' + logo + '")';
      logoPreview.classList.add('show');
    } else {
      logoPreview.style.backgroundImage = '';
      logoPreview.classList.remove('show');
    }
  }
  const removeLogoBtn = $('#removeLogoBtn');
  if (removeLogoBtn) removeLogoBtn.style.display = logo ? '' : 'none';

  // "صورة التيم" section — shows the active preset's thumbnail and lets the
  // admin upload a custom one (see handleThemeImageUpload/removeThemeImage).
  const thImg = $('#themeImagePreview');
  const thUrl = activeThemeImageUrl();
  if (thImg) {
    if (thUrl) {
      thImg.style.backgroundImage = 'url("' + thUrl + '")';
      thImg.classList.add('show');
    } else {
      thImg.style.backgroundImage = '';
      thImg.classList.remove('show');
    }
  }
  const thHint = $('#themeImageHint');
  if (thHint) {
    const pid = state.theme.preset;
    thHint.textContent = pid === 'custom'
      ? 'التيم المخصص ملوش صورة مستقلة — اختار تيم جاهز من القايمة الأول.'
      : 'التيم الحالي: ' + (THEME_PRESETS[pid] ? THEME_PRESETS[pid].label : pid) + ' — الصورة بتظهر في القايمة فوراً وبتتزامن لكل الزوار.';
  }
  const thRemove = $('#removeThemeImageBtn');
  if (thRemove) {
    thRemove.style.display = (state.theme.themeImages || {})[state.theme.preset] ? '' : 'none';
  }
}

// The currently-active theme's thumbnail: uploaded override → preset `image`
// URL → generated emblem. Returns '' only for an unknown/custom preset.
function activeThemeImageUrl() {
  const id = state.theme.preset;
  const over = (state.theme.themeImages || {})[id];
  if (over) return sanitizeBgImageUrl(over);
  const p = THEME_PRESETS[id];
  if (!p) return '';
  if (p.image) return sanitizeBgImageUrl(p.image);
  return themeEmblem(p.colors, PRESET_LETTERS[id]);
}

// Reads an uploaded image, compresses it like the team logo (keeps the cloud
// record small), and stores it as the ACTIVE preset's thumbnail override.
function handleThemeImageUpload(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('لازم تختار ملف صورة', 'error'); return; }
  if (state.theme.preset === 'custom') {
    toast('التيم المخصص ملوش صورة مستقلة — اختار تيم جاهز من القايمة الأول', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = function() {
    const img = new Image();
    img.onload = function() {
      const dataUrl = compressLogoToDataUrl(img);
      if (!dataUrl) {
        toast('⚠️ الصورة كبيرة جداً حتى بعد الضغط — جرّب صورة أصغر', 'error');
        return;
      }
      state.theme.themeImages = Object.assign({}, state.theme.themeImages || {});
      state.theme.themeImages[state.theme.preset] = dataUrl;
      renderThemeTab();
      saveState();
      const label = THEME_PRESETS[state.theme.preset] ? THEME_PRESETS[state.theme.preset].label : state.theme.preset;
      toast('تم تغيير صورة التيم "' + label + '"');
    };
    img.onerror = function() { toast('تعذّر قراءة الصورة', 'error'); };
    img.src = reader.result;
  };
  reader.onerror = function() { toast('تعذّر قراءة الملف', 'error'); };
  reader.readAsDataURL(file);
}

// Removes the active preset's uploaded thumbnail → falls back to the preset
// `image` URL / generated emblem.
function removeThemeImage() {
  const pid = state.theme.preset;
  if (pid === 'custom' || !(state.theme.themeImages || {})[pid]) return;
  state.theme.themeImages = Object.assign({}, state.theme.themeImages);
  delete state.theme.themeImages[pid];
  renderThemeTab();
  saveState();
  toast('تم حذف صورة التيم — رجعت للصورة الافتراضية');
}

// Switches the site-wide (and export) avatar frame between circle / hexagon
// / rounded-square. Synced to every visitor like the rest of `theme`.
function selectAvatarShape(shape) {
  if (!['circle', 'hexagon', 'square'].includes(shape)) return;
  state.theme.avatarShape = shape;
  applyAvatarShape(shape);
  renderThemeTab();
  saveState();
  const labels = { circle: 'دائري', hexagon: 'مسدس', square: 'مربع دائري الحواف' };
  toast('تم تغيير شكل صورة اللاعب إلى: ' + labels[shape]);
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
  ensureThemeDefaults();
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
  ensureThemeDefaults();
  state.theme.background.type = type;
  applyThemeBackground(state.theme.background);
  renderThemeTab();
  saveState();
}

function updateBgValue() {
  ensureThemeDefaults();
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
  ensureThemeDefaults();
  state.theme.background.overlayOpacity = Number(val);
  $('#bgOverlayVal').textContent = val + '%';
  applyThemeBackground(state.theme.background);
  saveState();
}

function updateBgBlur(val) {
  ensureThemeDefaults();
  state.theme.background.blur = Number(val);
  $('#bgBlurVal').textContent = val + 'px';
  applyThemeBackground(state.theme.background);
  saveState();
}

// Reads an uploaded image, downsizes it on a canvas, and stores it as a
// compressed base64 data URL — no server/storage bucket needed. This data
// URL lives inside the same shared JSONBin record as the rest of the
// tournament, which has a modest free-tier size limit, so we compress
// aggressively (and iteratively) instead of using one fixed quality/size —
// a single oversized image would break cloud syncing for every visitor,
// not just the person who uploaded it.

// Target and hard-cap sizes for the final base64 data URL (in characters,
// which is ~ bytes for base64 text). We try to land under TARGET; if even
// our smallest/lowest-quality attempt is still above HARD_CAP we refuse to
// save it rather than silently breaking the shared cloud sync.
const BG_IMAGE_TARGET_BYTES = 45000;
const BG_IMAGE_HARD_CAP_BYTES = 90000;

// Prefer WebP when the browser can actually encode it (not just decode) —
// it's noticeably smaller than JPEG at the same visual quality. Falls back
// to JPEG automatically for older browsers.
function supportsWebpEncoding() {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    return c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
  } catch (e) { return false; }
}

// Tries progressively smaller dimensions and lower quality until the
// resulting data URL fits under BG_IMAGE_TARGET_BYTES, returning the best
// (smallest-that-still-looks-decent) result it finds. Returns null only if
// nothing it tried gets under the hard cap.
function compressImageToDataUrl(img) {
  const mime = supportsWebpEncoding() ? 'image/webp' : 'image/jpeg';
  const widths = [900, 700, 500, 360];
  const qualities = [0.7, 0.55, 0.4, 0.28];
  let best = null;
  for (const maxW of widths) {
    const scale = Math.min(1, maxW / img.width);
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    for (const q of qualities) {
      const dataUrl = canvas.toDataURL(mime, q);
      if (!best || dataUrl.length < best.length) best = dataUrl;
      if (dataUrl.length <= BG_IMAGE_TARGET_BYTES) return dataUrl; // good enough, stop early
    }
  }
  // Nothing hit the target — return the smallest attempt if it at least
  // clears the hard cap, otherwise signal failure.
  return best && best.length <= BG_IMAGE_HARD_CAP_BYTES ? best : null;
}

function handleBgImageUpload(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = ''; // allow re-selecting the same file later
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('لازم تختار ملف صورة', 'error'); return; }
  const reader = new FileReader();
  reader.onload = function() {
    const img = new Image();
    img.onload = function() {
      const dataUrl = compressImageToDataUrl(img);
      if (!dataUrl) {
        toast('⚠️ الصورة كبيرة جداً حتى بعد الضغط — جرّب صورة تانية أبسط، أو حط رابط صورة (URL) بدل الرفع عشان محدش يفقد مزامنة السحابة', 'error');
        return;
      }
      state.theme.background.imageUrl = dataUrl;
      applyThemeBackground(state.theme.background);
      renderThemeTab();
      saveState();
      const kb = Math.round(dataUrl.length / 1024);
      toast('تم رفع الخلفية وضغطها (~' + kb + ' كيلوبايت)');
    };
    img.onerror = function() { toast('تعذّر قراءة الصورة', 'error'); };
    img.src = reader.result;
  };
  reader.onerror = function() { toast('تعذّر قراءة الملف', 'error'); };
  reader.readAsDataURL(file);
}

// Team logo compression — logos are small, so we keep more quality than the
// background image path and always use WebP/PNG (never JPEG) to preserve
// transparency. Stored as a compact data URL inside the shared theme record.
const LOGO_TARGET_BYTES = 20000;
const LOGO_HARD_CAP_BYTES = 45000;

function compressLogoToDataUrl(img) {
  const mime = supportsWebpEncoding() ? 'image/webp' : 'image/png';
  const widths = [280, 220, 170, 130];
  const qualities = [0.9, 0.75, 0.6];
  let best = null;
  for (const maxW of widths) {
    const scale = Math.min(1, maxW / img.width);
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    if (mime === 'image/png') {
      const dataUrl = canvas.toDataURL(mime);
      if (!best || dataUrl.length < best.length) best = dataUrl;
      if (dataUrl.length <= LOGO_TARGET_BYTES) return dataUrl;
    } else {
      for (const q of qualities) {
        const dataUrl = canvas.toDataURL(mime, q);
        if (!best || dataUrl.length < best.length) best = dataUrl;
        if (dataUrl.length <= LOGO_TARGET_BYTES) return dataUrl;
      }
    }
  }
  return best && best.length <= LOGO_HARD_CAP_BYTES ? best : null;
}

function handleLogoUpload(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('لازم تختار ملف صورة', 'error'); return; }
  const reader = new FileReader();
  reader.onload = function() {
    const img = new Image();
    img.onload = function() {
      const dataUrl = compressLogoToDataUrl(img);
      if (!dataUrl) {
        toast('⚠️ الشعار كبير جداً حتى بعد الضغط — جرّب صورة أصغر (يفضل PNG بشفافية)', 'error');
        return;
      }
      state.theme.logo = dataUrl;
      applyThemeLogo();
      renderThemeTab();
      saveState();
      const kb = Math.round(dataUrl.length / 1024);
      toast('تم تغيير شعار الفريق (~' + kb + ' كيلوبايت)');
    };
    img.onerror = function() { toast('تعذّر قراءة الصورة', 'error'); };
    img.src = reader.result;
  };
  reader.onerror = function() { toast('تعذّر قراءة الملف', 'error'); };
  reader.readAsDataURL(file);
}

function removeTeamLogo() {
  state.theme.logo = '';
  applyThemeLogo();
  renderThemeTab();
  saveState();
  toast('تم حذف شعار الفريق');
}

// Per-player (team) avatar upload. Avatars render tiny (40px on screen,
// ~64px in the export), so we compress far more aggressively than the logo
// path — keeping 17+ avatars inside the cloud size limit (~5KB each).
const AVATAR_TARGET_BYTES = 5000;
const AVATAR_HARD_CAP_BYTES = 12000;

function compressAvatarToDataUrl(img) {
  const mime = supportsWebpEncoding() ? 'image/webp' : 'image/png';
  const widths = [128, 96, 64];
  const qualities = [0.8, 0.6, 0.42];
  let best = null;
  for (const maxW of widths) {
    const scale = Math.min(1, maxW / img.width);
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    for (const q of qualities) {
      const dataUrl = canvas.toDataURL(mime, q);
      if (!best || dataUrl.length < best.length) best = dataUrl;
      if (dataUrl.length <= AVATAR_TARGET_BYTES) return dataUrl;
    }
  }
  return best && best.length <= AVATAR_HARD_CAP_BYTES ? best : null;
}

// Upload a picture from the "إضافة لاعب" form — it fills the URL field with
// a compressed data URL so addPlayer() stores it like any other avatar.
function handlePlayerAvatarUpload(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('لازم تختار ملف صورة', 'error'); return; }
  const reader = new FileReader();
  reader.onload = function() {
    const img = new Image();
    img.onload = function() {
      const dataUrl = compressAvatarToDataUrl(img);
      if (!dataUrl) {
        toast('⚠️ الصورة كبيرة جداً حتى بعد الضغط — جرّب صورة أصغر', 'error');
        return;
      }
      $('#playerAvatar').value = dataUrl;
      const prev = $('#avatarPreview');
      if (prev) { prev.src = dataUrl; prev.style.display = 'block'; }
      const kb = Math.round(dataUrl.length / 1024);
      toast('تم تجهيز الصورة (~' + kb + ' كيلوبايت) — اضغط «إضافة لاعب»');
    };
    img.onerror = function() { toast('تعذّر قراءة الصورة', 'error'); };
    img.src = reader.result;
  };
  reader.onerror = function() { toast('تعذّر قراءة الملف', 'error'); };
  reader.readAsDataURL(file);
}

// Change the picture of an EXISTING team directly from its row in the list.
let pendingAvatarPlayerId = null;
function pickPlayerRowImage(id) {
  if (state.tournamentStarted) { toast('لا يمكن تعديل اللاعبين بعد بدء البطولة', 'error'); return; }
  pendingAvatarPlayerId = id;
  const input = $('#playerRowImage');
  if (input) input.click();
}
function applyPlayerRowImage(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const id = pendingAvatarPlayerId;
  pendingAvatarPlayerId = null;
  if (id == null) return;
  if (!file.type.startsWith('image/')) { toast('لازم تختار ملف صورة', 'error'); return; }
  const reader = new FileReader();
  reader.onload = function() {
    const img = new Image();
    img.onload = function() {
      const dataUrl = compressAvatarToDataUrl(img);
      if (!dataUrl) { toast('⚠️ الصورة كبيرة جداً حتى بعد الضغط — جرّب صورة أصغر', 'error'); return; }
      const p = getPlayer(id);
      if (!p) return;
      p.avatarUrl = dataUrl;
      saveState(); renderPlayers(); updateStats();
      toast('تم تحديث صورة ' + p.name);
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
    background: { type: 'default', color: '#141219', gradColor1: '#1b1822', gradColor2: '#0d0c12', imageUrl: '', overlayOpacity: 55, blur: 0 },
    logo: '',
    themeImages: {},
    avatarShape: 'circle',
    animations: Object.assign({}, DEFAULT_ANIMATIONS)
  };
  applyThemeFull();
  renderThemeTab();
  renderEffectsTab();
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
  if (!window.crypto || !window.crypto.subtle) {
    toast('⚠️ تسجيل الدخول محتاج HTTPS — افتح الموقع عبر https:// أو localhost', 'error');
    return;
  }
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
  if (!window.crypto || !window.crypto.subtle) {
    toast('⚠️ تسجيل الدخول محتاج HTTPS — افتح الموقع عبر https:// أو localhost', 'error');
    return;
  }
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
    if (swapMode) toggleSwapMode();
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
// Strips invisible / zero-width Unicode characters (word-joiner U+2060,
// zero-width space/joiner/non-joiner U+200B-D, LRM/RLM, BOM, NBSP) from a
// team name. Names pasted from Discord/chats often carry these, which make
// two teams LOOK like a duplicate («الحبه الكامله» vs «الحبه-الكامله»),
// break copy/paste and shuffle the bracket order visually.
function normalizePlayerName(name) {
  return String(name).replace(/[\u00A0\u200B-\u200F\u2060-\u2063\uFEFF]/g, '').trim();
}

function addPlayer(e) {
  e.preventDefault();
  const name = normalizePlayerName($('#playerName').value);
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

// Manual bracket-order control. The seed (1..N) IS the bracket position, so
// moving a team up/down here directly changes "who plays whom" in the
// bracket — the admin decides the order before pressing start instead of
// letting the app scatter teams. Blocked after the tournament starts.
function movePlayer(id, dir) {
  if (state.tournamentStarted) { toast('لا يمكن تعديل الترتيب بعد بدء البطولة — اعمل إعادة تعيين الأول', 'error'); return; }
  const i = state.players.findIndex(p => p.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.players.length) return;
  const arr = state.players;
  const moved = arr[i];
  arr[i] = arr[j];
  arr[j] = moved;
  arr.forEach((p, k) => p.seed = k + 1);
  buildPlayerMap();
  saveState(); renderPlayers(); updateStats();
  toast(moved.name + ' ← المركز ' + moved.seed + ' في الترتيب');
}

function editPlayer(id) {
  const p = getPlayer(id);
  if (!p) return;
  const n = normalizePlayerName(prompt('اسم اللاعب:', p.name) || '');
  if (!n) return;
  p.name = n;

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
    renderPairingPreview();
    return;
  }
  const locked = state.tournamentStarted;
  list.innerHTML = state.players.map((p, i) => {
    const up = !locked && i > 0 ? '<button class="move-btn" data-dir="-1" onclick="movePlayer(' + p.id + ',-1)" title="تحريك لأعلى">▲</button>' : '<button class="move-btn disabled" disabled>▲</button>';
    const down = !locked && i < state.players.length - 1 ? '<button class="move-btn" data-dir="1" onclick="movePlayer(' + p.id + ',1)" title="تحريك لأسفل">▼</button>' : '<button class="move-btn disabled" disabled>▼</button>';
    return '<div class="player-card">' +
      '<span class="order-badge" title="الترتيب في المخطط">' + p.seed + '</span>' +
      '<span class="avatar-frame"><img class="player-avatar" src="' + escapeAttr(sanitizeAvatarUrl(p.avatarUrl, p.name)) + '" alt="' + escapeAttr(p.name) + '" loading="lazy" onerror="this.src=\'' + escapeAttr(defaultAvatar(p.name)) + '\'"></span>' +
      '<div class="player-info">' +
        '<div class="player-name">' + escapeHtml(p.name) + '</div>' +
        '<div class="player-discord">' + (p.discordId ? 'ID: ' + escapeHtml(p.discordId) : '') + '</div>' +
      '</div>' +
      '<div class="player-actions">' +
        '<div class="move-col">' + up + down + '</div>' +
        '<button class="pic-btn" onclick="pickPlayerRowImage(' + p.id + ')" title="تغيير صورة الفريق">🖼</button>' +
        '<button class="edit-btn" onclick="editPlayer(' + p.id + ')" title="تعديل">✎</button>' +
        '<button class="delete-btn" onclick="removePlayer(' + p.id + ')" title="حذف">✕</button>' +
      '</div>' +
    '</div>';
  }).join('');
  renderPairingPreview();
}

// ===== Round-1 pairing preview (admin side) =====
// Shows, BEFORE the tournament starts, exactly who plays whom in the first
// round — including the automatic byes that an odd team count forces. This
// is the same seed->slot math generateBracket() uses, read-only here.
function roundOneLabel(size) {
  if (size >= 32) return 'دور الـ32';
  if (size === 16) return 'ثمن النهائي';
  if (size === 8) return 'ربع النهائي';
  if (size === 4) return 'نصف النهائي';
  return 'النهائي';
}

function roundOnePairings() {
  const n = state.players.length;
  const size = Math.pow(2, Math.ceil(Math.log2(n)));
  const sorted = [...state.players].sort((a, b) => a.seed - b.seed);
  // Sequential placement: the order you set in the list IS the matchup
  // order — the first two teams face each other, then the next two, and so
  // on. No standard-seeding reshuffle, so "who plays whom" is exactly what
  // the admin arranged.
  const slots = new Array(size).fill(null);
  sorted.forEach((p, i) => { slots[i] = p; });
  const pairs = [];
  for (let i = 0; i < slots.length; i += 2) pairs.push({ p1: slots[i], p2: slots[i + 1] });
  return pairs;
}

function renderPairingPreview() {
  const box = $('#pairingPreview');
  if (!box) return;
  if (state.tournamentStarted) {
    box.style.display = 'block';
    box.innerHTML = '<div class="pairing-hint">البطولة بدأت — الترتيب مقفول. لتغيير «مين ضد مين»: اعمل <strong>إعادة تعيين البطولة</strong> ثم رتّب الفرق بالأسهم قبل الضغط على «بدأ».</div>';
    return;
  }
  if (state.players.length < 2) { box.style.display = 'none'; return; }
  const pairs = roundOnePairings();
  const size = Math.pow(2, Math.ceil(Math.log2(state.players.length)));
  const label = roundOneLabel(size);
  const byes = pairs.filter(p => (p.p1 && !p.p2) || (!p.p1 && p.p2)).length;
  const rows = pairs.filter(p => p.p1 || p.p2);
  const name = pl => pl
    ? '<span class="pairing-team"><span class="pairing-seed">' + pl.seed + '</span>' + escapeHtml(pl.name) + '</span>'
    : '<span class="pairing-bye">تأهل تلقائي</span>';
  box.style.display = 'block';
  box.innerHTML =
    '<div class="pairing-hint">الترتيب = المواجهات: أول فريقين في القايمة يقابلوا بعض، بعدين التالت والرابع… حرّك الفرق بأسهم ▲▼ عشان تحدد «مين يقابل مين»، وشوف النتيجة هنا قبل ما تضغط «بدأ».</div>' +
    '<div class="pairing-title">' + label + (byes ? ' · <span class="pairing-badges">' + byes + ' تأهل تلقائي</span>' : '') + '</div>' +
    '<div class="pairing-grid">' +
      rows.map((p, i) =>
        '<div class="pairing-row">' +
          '<span class="pairing-num">' + (i + 1) + '</span>' +
          name(p.p1) +
          '<span class="pairing-vs">VS</span>' +
          name(p.p2) +
        '</div>'
      ).join('') +
    '</div>';
}

// ========== Bracket ==========
function generateBracket() {
  if (state.players.length < 2) { toast('يجب إضافة لاعبين على الأقل', 'error'); return; }
  if (state.tournamentStarted) { toast('البطولة قيد التشغيل', 'error'); return; }

  const size = Math.pow(2, Math.ceil(Math.log2(state.players.length)));
  const rounds = Math.log2(size);
  const sorted = [...state.players].sort((a, b) => a.seed - b.seed);
  // Sequential placement — the list order IS the bracket order (team 1 vs
  // team 2, team 3 vs team 4, ...). Matches standardSeedOrder-based seeding.
  const slots = new Array(size).fill(null);
  sorted.forEach((p, i) => { slots[i] = p; });

  state.matches = [];
  resultHistory = [];
  state.nextMatchId = 1;
  state.tournamentStarted = true;
  state.tournamentFinished = false;

  for (let i = 0; i < slots.length; i += 2) {
    const p1 = slots[i], p2 = slots[i + 1];
    // A bye only when exactly ONE side is empty. Matches where BOTH sides are
    // empty (trailing slots that no team ever reaches) stay plain empty — they
    // must not count as auto-qualifiers or show a fake "باي" card.
    const isBye = (p1 && !p2) || (!p1 && p2);
    const winner = isBye ? (p1 || p2 || null) : null;
    state.matches.push({
      id: state.nextMatchId++, round: 1, position: i / 2,
      player1Id: p1 ? p1.id : null, player2Id: p2 ? p2.id : null,
      winnerId: winner ? winner.id : null, isBye,
      score1: null, score2: null
    });
  }

  for (let r = 2; r <= rounds; r++) {
    const c = size / Math.pow(2, r);
    for (let p = 0; p < c; p++) {
      state.matches.push({
        id: state.nextMatchId++, round: r, position: p,
        player1Id: null, player2Id: null, winnerId: null, isBye: false,
        score1: null, score2: null
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
  resultHistory.push(match.id);
  if (state.theme.animations && state.theme.animations.winnerFlip) {
    pendingWinnerAnim = { matchId: match.id, playerId: playerId };
  }
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

// يعيّن نقاط مباراة من خانة «النتيجة» في لوحة المباريات. لما الجانبين يبقى
// ليهم نقاط، الفائز بيتحدد تلقائياً بالأعلى — والتعادل يلغي أي فائز سابق.
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
  if (match.position % 2 === 0) { next.player1Id = null; next.score1 = null; }
  else { next.player2Id = null; next.score2 = null; }
  if (next.winnerId) { next.winnerId = null; next.isBye = false; next.score1 = null; next.score2 = null; clearDownstream(next); }
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

function undoLastResult() {
  if (state.isLocked) { toast('يجب فتح لوحة التحكم أولاً', 'error'); return; }
  while (resultHistory.length) {
    const id = resultHistory.pop();
    const m = state.matches.find(x => x.id === id);
    if (m && m.winnerId != null && !m.isBye) {
      m.winnerId = null;
      clearDownstream(m);
      state.tournamentFinished = false;
      saveState(); renderBracket(); renderMatchControls(); updateStats(); updateBracketStatus();
      toast('↩️ تم التراجع عن آخر نتيجة');
      return;
    }
  }
  toast('مفيش نتائج للتراجع عنها', 'error');
}

// ========== درجات النتائج (Score Chips) ==========
// بتتحفظ جوه كائن الماتش نفسه (score1 / score2) فبتتزامن للسحابة تلقائياً
// من غير أي تغيير في SYNCED_FIELDS. فاضي = مفيش شيب.
function updateMatchScore(matchId, side, value) {
  if (state.isLocked) { toast('يجب فتح لوحة التحكم أولاً', 'error'); return; }
  const match = state.matches.find(m => m.id === matchId);
  if (!match) return;
  const n = parseInt(value, 10);
  const v = (value === '' || isNaN(n)) ? null : Math.max(0, Math.min(99, n));
  if (side === 1) match.score1 = v;
  else match.score2 = v;
  saveState();
  renderBracket(); // الشيب يظهر فوراً في المخطط — من غير renderMatchControls عشان التركيز ما يضيعش من الحقل
}

function resetBracket() {
  if (!state.tournamentStarted) return;
  if (!confirm('إعادة تعيين البطولة؟ سيتم مسح جميع النتائج.')) return;
  state.tournamentStarted = false;
  state.tournamentPaused = false;
  state.tournamentFinished = false;
  state.matches = [];
  resultHistory = [];
  swapMode = false; swapFirstId = null;
  document.body.classList.remove('swap-mode');
  saveState(); renderBracket(); renderMatchControls(); renderPlayers(); updateStats(); updateBracketStatus();
  toast('تم إعادة تعيين البطولة — الآن رتّب الفرق بالأسهم في تبويب «اللاعبون» ثم ابدأ من جديد');
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
  const nameMap = buildRoundNameMap(rounds);

  // With sequential (list-ordered) placement the bracket tree is padded to a
  // power of two, so trailing round-1 slots have no team and their matches —
  // and every later-round match fed only by them — stay empty forever. Mark
  // those "dead" so they render as a plain dash instead of a misleading
  // "بانتظار المتأهل" that can look like a disappeared team.
  const maxRound = rounds[rounds.length - 1];
  const isLive = {};
  state.matches.forEach(m => { if (m.round === 1) isLive[m.id] = !!(m.player1Id || m.player2Id); });
  for (let r = 2; r <= maxRound; r++) {
    state.matches.filter(m => m.round === r).forEach(m => {
      const pa = state.matches.find(x => x.round === r - 1 && x.position === m.position * 2);
      const pb = state.matches.find(x => x.round === r - 1 && x.position === m.position * 2 + 1);
      isLive[m.id] = !!(pa && isLive[pa.id]) || !!(pb && isLive[pb.id]);
    });
  }

  let currentRound = null;
  if (!state.tournamentFinished && !state.tournamentPaused) {
    for (const r of rounds) {
      if (state.matches.some(m => m.round === r && m.winnerId == null && isLive[m.id])) { currentRound = r; break; }
    }
  }

  function slotHtml(match, playerId, isFirst) {
    const sideClass = isFirst ? 'slot-a' : 'slot-b';
    if (playerId == null) {
      // Empty slots in a "dead" match are reserved tree slots that no team
      // ever reaches (the bracket is padded to a power of two) — show them as
      // a plain dash. Live matches keep the "waiting" label.
      const dead = !isLive[match.id];
      const waitingText = match.isBye ? 'باي (تأهل تلقائي)' : (dead ? '—' : 'بانتظار المتأهل');
      return '<div class="match-slot ' + sideClass + ' empty' + (match.isBye ? ' bye-indicator' : '') + '"><span class="slot-name">' + waitingText + '</span></div>';
    }
    const p = getPlayer(playerId);
    const iw = match.winnerId === playerId;
    const locked = state.isLocked ? ' locked' : '';
    const scoreVal = isFirst ? match.score1 : match.score2;
    return '<div class="match-slot ' + sideClass + (iw ? ' winner' : '') + locked + (swapMode && swapFirstId === playerId ? ' swap-selected' : '') + '" data-match="' + match.id + '" data-player="' + playerId + '">' +
      (p
        ? '<span class="avatar-frame"><img class="slot-avatar" src="' + escapeAttr(sanitizeAvatarUrl(p.avatarUrl, p.name)) + '" alt="" loading="lazy" onerror="this.src=\'' + escapeAttr(defaultAvatar(p.name)) + '\'"></span>'
        : '') +
      '<div class="slot-info">' +
        '<span class="slot-name-row"><span class="slot-name">' + (p ? escapeHtml(p.name) : '—') + '</span>' + (match.isBye ? '<span class="bye-tag">BYE</span>' : '') + '</span>' +
        (p && p.discordId ? '<span class="slot-id">' + escapeHtml(p.discordId) + '</span>' : '') +
      '</div>' +
      (scoreVal != null ? '<span class="score-chip">' + escapeHtml(String(scoreVal)) + '</span>' : '') +
      '</div>';
  }

  let html = '';

  if (state.tournamentPaused) {
    html += '<div class="paused-banner"><div class="paused-icon">⏸️</div><div class="paused-text">البطولة موقوفة مؤقتاً</div><div class="paused-sub">المباريات متوقفة حتى استئناف البطولة</div></div>';
  }

  rounds.forEach(round => {
    const matches = state.matches.filter(m => m.round === round).sort((a, b) => a.position - b.position);
    const byeCount = round === 1 ? matches.filter(m => m.isBye).length : 0;
    const headerText = nameMap[round] || ('الدور ' + round);
    const header = byeCount > 0
      ? headerText + '<span class="round-bye-badge" title="' + byeCount + ' فريق تأهلوا تلقائياً لعدم اكتمال عدد الفرق">' + byeCount + ' تأهل تلقائي</span>'
      : headerText;
    html += '<div class="round-column' + (round === currentRound ? ' current-round' : '') + '"><div class="round-header">' + header + '</div>';

    matches.forEach(match => {
      const hw = match.winnerId != null;
      const byeClass = match.isBye ? ' match-bye' : '';
      html += '<div class="match-card' + (hw ? ' has-winner' : '') + byeClass + '">';
      html += slotHtml(match, match.player1Id, true);
      html += '<span class="vs-label">VS</span>';
      html += slotHtml(match, match.player2Id, false);
      html += '</div>';
    });

    html += '</div>';
  });

  grid.innerHTML = html;
  // شريط البطل — ظاهر لكل زائر لما البطولة تخلص
  let ribbon = $('#championRibbon');
  if (!ribbon) {
    ribbon = document.createElement('div');
    ribbon.id = 'championRibbon';
    grid.parentElement.appendChild(ribbon);
  }
  if (state.tournamentFinished) {
    const fr = Math.max(...state.matches.map(m => m.round));
    const fm = state.matches.find(m => m.round === fr);
    const champ = fm ? getPlayer(fm.winnerId) : null;
    if (champ) {
      ribbon.innerHTML = '<span class="cr-trophy">🏆</span><span class="cr-text"><span class="cr-label">البطل</span><span class="cr-name">' + escapeHtml(champ.name) + '</span></span>';
      ribbon.style.display = 'flex';
    } else ribbon.style.display = 'none';
  } else {
    ribbon.innerHTML = '';
    ribbon.style.display = 'none';
  }
  // Position each round's match cards so they align with the bracket
  // structure (round 1 stays in flow; later rounds are placed at the exact
  // midpoint of their two child matches). The old `space-around` CSS merely
  // spread cards evenly, leaving rounds unaligned and the connector lines
  // broken. Re-run once fonts are ready in case text wrapping changed
  // heights after the first pass.
  layoutBracket();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => layoutBracket()).catch(() => {});
  }
  // Never let a purely cosmetic animation glitch break the functional
  // updates that follow this call in setWinner()/renderAll() (stats, match
  // controls, bracket status) — those must run regardless.
  try {
    applyAnimations(state.theme.animations);
    playPendingWinnerFlip();
  } catch (e) {
    console.error('[K-Gang] animation step failed (non-fatal)', e);
  }
}

// Aligns bracket rounds vertically: every match in round r sits at the
// midpoint of its two child matches in round r-1, matching how the export
// image lays out. Round 1 stays in normal flow and defines the column
// height; later rounds are absolutely positioned inside their column.
function layoutBracket() {
  const grid = $('#bracketGrid');
  if (!grid) return;
  const g = grid.getBoundingClientRect();
  // If the grid is hidden (display:none, collapsed tab, zero-size during
  // initial layout), every rect reads as 0 and every later-round card gets
  // pinned to top:0 — piling them on top of each other so whole teams look
  // "missing". Bail and let a later call (tab switch / resize / re-render)
  // align it while actually visible.
  if (!g.width || !g.height) return;
  const cols = Array.from(grid.querySelectorAll('.round-column'));
  if (cols.length < 2) return;

  const first = cols[0].getBoundingClientRect().top;
  const centers = Array.from(cols[0].querySelectorAll('.match-card')).map(c => {
    const r = c.getBoundingClientRect();
    return r.top + r.height / 2 - first;
  });
  if (centers.length < 2) return;

  for (let ci = 1; ci < cols.length; ci++) {
    const cards = Array.from(cols[ci].querySelectorAll('.match-card'));
    cards.forEach((card, i) => {
      const childCenter = (centers[2 * i] + centers[2 * i + 1]) / 2;
      const h = card.getBoundingClientRect().height;
      card.style.position = 'absolute';
      card.style.left = '0';
      card.style.right = '0';
      card.style.top = (childCenter - h / 2) + 'px';
      centers[i] = childCenter;
    });
  }
}

// Re-align the bracket when the viewport changes size (mobile rotation,
// pinch-zoom, sidebar toggles). The cards in rounds 2+ are absolutely
// positioned from round-1 centers, so any font/width reflow after the last
// layout pass leaves them stale — overlapping each other and hiding teams.
let _relayoutTimer;
window.addEventListener('resize', function() {
  clearTimeout(_relayoutTimer);
  _relayoutTimer = setTimeout(function() {
    try { layoutBracket(); } catch (e) {}
  }, 150);
});

// Plays the one-shot 360° flip on whichever slot just won, if any is queued.
function playPendingWinnerFlip() {
  if (!pendingWinnerAnim) return;
  const { matchId, playerId } = pendingWinnerAnim;
  pendingWinnerAnim = null;
  const el = $('.match-slot[data-match="' + matchId + '"][data-player="' + playerId + '"]');
  if (!el) return;
  // .match-card normally clips its children (overflow: hidden) so rounded
  // corners stay clean — but that would also clip the flip's rotation/scale
  // mid-animation, so lift the clip only for the duration of the effect.
  const card = el.closest('.match-card');
  if (card) card.classList.add('flip-active');
  el.classList.add('winner-flip-anim');
  el.addEventListener('animationend', function handler() {
    el.classList.remove('winner-flip-anim');
    if (card) card.classList.remove('flip-active');
    el.removeEventListener('animationend', handler);
  });
}

// Click on bracket slot
document.addEventListener('click', function(e) {
  const slot = e.target.closest('.match-slot[data-match]');
  if (!slot) return;
  const matchId = parseInt(slot.dataset.match);
  const playerId = parseInt(slot.dataset.player);
  if (swapMode) {
    if (state.isLocked) { toast('يجب فتح لوحة التحكم أولاً', 'error'); return; }
    if (isNaN(playerId)) return;
    if (swapFirstId == null) {
      swapFirstId = playerId;
      renderBracket();
      toast('تمام — دلوقتي اضغط على الفريق التاني');
      return;
    }
    trySwapPlayers(swapFirstId, playerId);
    return;
  }
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
  html += '<button class="mc-pause-btn' + (swapMode ? ' active' : '') + '" id="swapModeBtn" onclick="toggleSwapMode()" title="بدّل مكان فريقين في المخطط">🔁 تبديل فرق</button>';
  html += '<button class="mc-pause-btn" onclick="undoLastResult()" title="تراجع عن آخر نتيجة اتسجّلت">↩️ تراجع</button>';
  if (state.tournamentPaused) {
    html += '<span class="paused-indicator">⏸️ البطولة موقوفة مؤقتاً</span>';
  }
  html += '</div>';

  const rounds = [...new Set(state.matches.map(m => m.round))].sort((a, b) => a - b);
  const nameMap = buildRoundNameMap(rounds);

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
      rHtml += '<input class="mc-score" type="number" min="0" max="99" inputmode="numeric" placeholder="–" value="' + (m.score1 != null ? m.score1 : '') + '" onchange="updateMatchScore(' + m.id + ',1,this.value)" title="نتيجة ' + escapeHtml(p1Name) + '" ' + (disabled ? 'disabled' : '') + '>';
      rHtml += '<button class="mc-btn' + (m.winnerId === m.player1Id ? ' mc-winner' : '') + '" onclick="setWinner(' + m.id + ',' + m.player1Id + ')" ' + (disabled ? 'disabled' : '') + '>' + escapeHtml(p1Name) + '</button>';
      rHtml += '<span class="mc-vs">VS</span>';
      rHtml += '<button class="mc-btn' + (m.winnerId === m.player2Id ? ' mc-winner' : '') + '" onclick="setWinner(' + m.id + ',' + m.player2Id + ')" ' + (!m.player2Id || state.tournamentPaused ? 'disabled' : '') + '>' + escapeHtml(p2Name) + '</button>';
      rHtml += '<input class="mc-score" type="number" min="0" max="99" inputmode="numeric" placeholder="–" value="' + (m.score2 != null ? m.score2 : '') + '" onchange="updateMatchScore(' + m.id + ',2,this.value)" title="نتيجة ' + escapeHtml(p2Name) + '" ' + (!m.player2Id || state.tournamentPaused ? 'disabled' : '') + '>';
      rHtml += '</div>';
      if (m.isBye) rHtml += '<span class="mc-bye">باي</span>';
      rHtml += '</div>';
    });

    rHtml += '</div>';
    html += rHtml;
  });

  el.innerHTML = html;
}

// ========== Export (Image / PDF) ==========
// EARLIER APPROACH (removed): capture #bracketGrid with html2canvas, which
// re-implements CSS layout/text rendering itself. That's what caused both
// reported bugs — its Latin-only glyph renderer doesn't do Arabic letter
// joining (broken/disconnected Arabic text), and it can silently produce a
// blank/near-black canvas when it can't fully parse the page's CSS
// (custom properties, animations mid-flight, external fonts inside its
// clone) with no error thrown.
//
// NEW APPROACH: draw the bracket ourselves onto a plain <canvas> using the
// Canvas 2D API (rectangles, circles, fillText). fillText is rendered by
// the BROWSER's own text engine — the exact same one that draws Arabic
// correctly everywhere else on this page — so Arabic shaping/joining just
// works, and since we control every pixel drawn, there's no "the library
// failed to understand the CSS" failure mode left. html2canvas is no
// longer used at all. jsPDF is still used, but only to wrap the image we
// already drew (not to render any text itself).
let pdfLibPromise = null;
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-export-lib="' + src + '"]');
    if (existing) { existing.addEventListener('load', resolve); if (existing.dataset.loaded) resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.dataset.exportLib = src;
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = () => reject(new Error('فشل تحميل مكتبة التصدير'));
    document.head.appendChild(s);
  });
}
function ensurePdfLibLoaded() {
  if (pdfLibPromise) return pdfLibPromise;
  pdfLibPromise = (window.jspdf && window.jspdf.jsPDF)
    ? Promise.resolve()
    : loadScriptOnce('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
  pdfLibPromise = pdfLibPromise.catch(err => { pdfLibPromise = null; throw err; });
  return pdfLibPromise;
}

function exportFileBaseName() {
  return (state.settings.name || 'K-Gang-Bracket').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_') || 'bracket';
}

function describeExportError(e) {
  if (e && e.message === 'NO_DATA') return 'لازم تبدأ البطولة الأول عشان تقدر تصدّر الجدول';
  return '⚠️ فشل التصدير — تأكد من اتصال الإنترنت وحاول تاني';
}

function setExportButtonsBusy(busy) {
  ['exportImageBtn', 'exportPdfBtn'].forEach(id => { const b = $('#' + id); if (b) b.disabled = busy; });
}

// Loads a player avatar ONLY if it's safe to draw onto a canvas we intend
// to export later (own data: URI, or a remote URL that a CORS-anonymous
// load actually succeeds for). Anything else silently resolves to null so
// the caller draws a plain initial-letter avatar instead — this guarantees
// the final canvas can never end up "tainted" (which used to make the
// whole export fail/blank without a clear reason).
//
// Many avatar hosts (imgur, random image hosts, some CDNs) simply don't
// send an Access-Control-Allow-Origin header, so a direct crossOrigin
// request always fails there — that's what was causing avatars to
// silently fall back to initials in the exported image/PDF even though
// they show up fine on the page itself (an <img> tag doesn't need CORS,
// only a canvas draw does). As a second attempt, retry the same image
// through images.weserv.nl, a public read-only image proxy that always
// serves a CORS-friendly response — this recovers most of those cases.
function loadAvatarSafely(url) {
  return new Promise((resolve) => {
    if (!url || typeof url !== 'string') { resolve(null); return; }
    if (/^data:image\//i.test(url)) {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
      return;
    }
    const attempt = (src, onFail) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = onFail;
      img.src = src;
    };
    attempt(url, () => {
      let proxied = null;
      try {
        const u = new URL(url);
        proxied = 'https://images.weserv.nl/?url=' + encodeURIComponent(u.host + u.pathname + u.search);
      } catch (e) { /* not a valid absolute URL — nothing more to try */ }
      if (!proxied) { resolve(null); return; }
      attempt(proxied, () => resolve(null));
    });
  });
}

function isArabicText(s) { return /[\u0600-\u06FF]/.test(s || ''); }

// Draws text with the correct bidi direction for its content (so Arabic
// shapes/joins correctly) and truncates with an ellipsis if it overflows
// maxWidth, similar to CSS text-overflow: ellipsis.
function fitText(ctx, text, maxWidth) {
  text = text || '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}
function drawBidiText(ctx, text, x, y, maxWidth) {
  ctx.direction = isArabicText(text) ? 'rtl' : 'ltr';
  ctx.fillText(maxWidth ? fitText(ctx, text, maxWidth) : (text || ''), x, y);
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Traces an avatar clip/fill path centered at (cx, cy) with "radius" r, in
// one of the three shapes offered in the "المظهر" tab. Mirrors the CSS
// clip-path/border-radius used for the on-page `.avatar-frame` so the
// exported image/PDF always matches what visitors see on the site.
function avatarShapePath(ctx, shape, cx, cy, r) {
  ctx.beginPath();
  if (shape === 'hexagon') {
    // Same 6 points (as fractions of the bounding box) as the CSS
    // clip-path: polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%).
    const s = r * 2, x0 = cx - r, y0 = cy - r;
    [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]].forEach(([fx, fy], i) => {
      const px = x0 + fx * s, py = y0 + fy * s;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
  } else if (shape === 'square') {
    const rad = r * 0.42; // ~ the 22% border-radius used on-page
    ctx.moveTo(cx - r + rad, cy - r);
    ctx.arcTo(cx + r, cy - r, cx + r, cy + r, rad);
    ctx.arcTo(cx + r, cy + r, cx - r, cy + r, rad);
    ctx.arcTo(cx - r, cy + r, cx - r, cy - r, rad);
    ctx.arcTo(cx - r, cy - r, cx + r, cy - r, rad);
    ctx.closePath();
  } else {
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
  }
}

const EXPORT_FONT_STACK = "'Rajdhani', 'Cairo', Tahoma, Arial, sans-serif";
const EXPORT_NAME_FONT = "600 16px " + EXPORT_FONT_STACK;
const EXPORT_ID_FONT = "400 12px 'JetBrains Mono', monospace";
const EXPORT_PLACEHOLDER_FONT = "italic 12px " + EXPORT_FONT_STACK;
const EXPORT_AVATAR_R = 21;
const EXPORT_SLOT_PAD = 10;
const EXPORT_NAME_GAP = 10;

// بار بحافة خارجية مائلة (slash) — نفس لغة الصورة المرجعية
function barPath(ctx, x, y, w, h, side, cut) {
  ctx.beginPath();
  if (side === 'a') {
    ctx.moveTo(x + cut, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
  } else {
    ctx.moveTo(x, y);
    ctx.lineTo(x + w - cut, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
  }
  ctx.closePath();
}
function drawExportSlot(ctx, match, playerId, x, y, w, h, colors, avatarCache, side, avatarShape, dead) {
  const avatarR = EXPORT_AVATAR_R - 2;
  const cyMid = y + h / 2;
  const pad = EXPORT_SLOT_PAD;
  const shape = avatarShape || 'circle';

  if (playerId == null) {
    // شبح بار باهت لنفس شكل السلوت الفاضي
    ctx.save();
    ctx.globalAlpha = 0.4;
    barPath(ctx, x + 2, y + 5, w - 4, h - 10, side, 9);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.045)';
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = colors.textMuted;
    ctx.font = EXPORT_PLACEHOLDER_FONT;
    ctx.textAlign = side === 'a' ? 'right' : 'left';
    ctx.textBaseline = 'middle';
    const tx = side === 'a' ? x + w - pad - 6 : x + pad + 6;
    drawBidiText(ctx, match.isBye ? 'باي (تأهل تلقائي)' : (dead ? '—' : 'بانتظار المتأهل'), tx, cyMid, w - pad * 2 - 12);
    return;
  }

  const isWinner = match.winnerId != null && match.winnerId === playerId;
  const p = getPlayer(playerId);
  const name = p ? p.name : '—';

  // ===== البار المتدرج بحافة مائلة =====
  const bx = x + 2, by = y + 5, bw = w - 4, bh = h - 10;
  barPath(ctx, bx, by, bw, bh, side, 9);
  const grad = ctx.createLinearGradient(side === 'a' ? bx + bw : bx, 0, side === 'a' ? bx : bx + bw, 0);
  if (isWinner) { grad.addColorStop(0, colors.primary); grad.addColorStop(1, colors.primaryLight); }
  else { grad.addColorStop(0, colors.primaryDark); grad.addColorStop(1, colors.primary); }
  ctx.fillStyle = grad;
  ctx.fill();
  if (isWinner) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.65)';
    ctx.lineWidth = 1.2;
    barPath(ctx, bx, by, bw, bh, side, 9);
    ctx.stroke();
    ctx.restore();
  }

  // ===== الأفاتار بحلقة متوهجة على الحافة الداخلية =====
  const cx = side === 'a' ? (x + w - pad - avatarR - 2) : (x + pad + avatarR + 2);
  const ringR = avatarR + 2.5;
  ctx.save();
  const ringGrad = ctx.createLinearGradient(cx - ringR, cyMid - ringR, cx + ringR, cyMid + ringR);
  if (isWinner) {
    ringGrad.addColorStop(0, '#ffd700'); ringGrad.addColorStop(0.55, '#fff6d0'); ringGrad.addColorStop(1, '#ffd700');
    ctx.shadowColor = 'rgba(255, 215, 0, 0.55)'; ctx.shadowBlur = 10;
  } else {
    ringGrad.addColorStop(0, 'rgba(255,255,255,0.8)'); ringGrad.addColorStop(0.55, '#ffffff'); ringGrad.addColorStop(1, 'rgba(255,255,255,0.8)');
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'; ctx.shadowBlur = 6;
  }
  avatarShapePath(ctx, shape, cx, cyMid, ringR);
  ctx.fillStyle = ringGrad;
  ctx.fill();
  ctx.restore();
  ctx.save();
  avatarShapePath(ctx, shape, cx, cyMid, avatarR);
  ctx.clip();
  const img = avatarCache.get(playerId);
  if (img) {
    ctx.drawImage(img, cx - avatarR, cyMid - avatarR, avatarR * 2, avatarR * 2);
  } else {
    ctx.fillStyle = colors.bgDeep;
    ctx.fillRect(cx - avatarR, cyMid - avatarR, avatarR * 2, avatarR * 2);
    ctx.fillStyle = colors.primaryLight;
    ctx.font = "700 13px " + EXPORT_FONT_STACK;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.direction = 'ltr';
    ctx.fillText((name || '?').trim().charAt(0).toUpperCase(), cx, cyMid + 1);
  }
  ctx.restore();

  // ===== الاسم أبيض عريض + معرف ديسكورد شفاف =====
  const scoreVal = match ? (side === 'a' ? match.score1 : match.score2) : null;
  const hasScore = scoreVal != null && scoreVal !== '' && !isNaN(Number(scoreVal));
  const seedTxt = (p && p.seed) ? '#' + p.seed : '';
  const outerW = hasScore ? 26 : (seedTxt ? 22 : 0);
  const textX = side === 'a' ? cx - avatarR - EXPORT_NAME_GAP : cx + avatarR + EXPORT_NAME_GAP;
  const maxTextW = (side === 'a' ? (textX - (x + pad + 2)) : ((x + w - pad - 2) - textX)) - outerW;
  const hasId = !!(p && p.discordId);
  ctx.textAlign = side === 'a' ? 'right' : 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.font = "700 14px " + EXPORT_FONT_STACK;
  drawBidiText(ctx, name, textX, cyMid - (hasId ? 6 : 0), maxTextW);
  if (hasId) {
    ctx.font = EXPORT_ID_FONT;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
    ctx.direction = 'ltr';
    ctx.textAlign = side === 'a' ? 'right' : 'left';
    ctx.fillText(fitText(ctx, p.discordId, maxTextW), textX, cyMid + 8);
  }

  // ===== شيب النتيجة الأبيض/الدهب أو البذرة على الحافة الخارجية =====
  if (hasScore) {
    const cw = 20, chh = 22, cut = 6;
    const cx0 = side === 'a' ? x + 5 : x + w - 5 - cw;
    const cy0 = cyMid - chh / 2;
    ctx.beginPath();
    ctx.moveTo(cx0, cy0);
    ctx.lineTo(cx0 + cw, cy0);
    ctx.lineTo(cx0 + cw, cy0 + chh - cut);
    ctx.lineTo(cx0 + cw - cut, cy0 + chh);
    ctx.lineTo(cx0, cy0 + chh);
    ctx.closePath();
    ctx.fillStyle = isWinner ? '#ffd700' : '#f5f2ea';
    ctx.fill();
    ctx.fillStyle = '#171410';
    ctx.font = '800 12px ' + EXPORT_FONT_STACK;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.direction = 'ltr';
    ctx.fillText(String(scoreVal), cx0 + cw / 2, cyMid + 1);
  } else if (seedTxt) {
    ctx.font = "700 10px " + EXPORT_FONT_STACK;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.textAlign = side === 'a' ? 'left' : 'right';
    ctx.textBaseline = 'middle';
    ctx.direction = 'ltr';
    ctx.fillText(seedTxt, side === 'a' ? x + pad : x + w - pad, cyMid);
  }
}

function measureExportSlotContentWidth(matches) {
  const mctx = document.createElement('canvas').getContext('2d');
  let maxW = 0;
  const check = (font, text) => {
    if (!text) return;
    mctx.font = font;
    maxW = Math.max(maxW, mctx.measureText(text).width);
  };
  matches.forEach(match => {
    [match.player1Id, match.player2Id].forEach(pid => {
      if (pid == null) { check(EXPORT_PLACEHOLDER_FONT, match.isBye ? 'باي (تأهل تلقائي)' : 'بانتظار المتأهل'); return; }
      const p = getPlayer(pid);
      if (!p) return;
      check(EXPORT_NAME_FONT, p.name);
      check(EXPORT_ID_FONT, p.discordId);
    });
  });
  return maxW;
}

function setExportLineDash(ctx, dash) {
  try { ctx.setLineDash(dash || []); } catch (e) {}
}

// Replicates `.match-card.match-bye` — faint diagonal stripes of the surface
// color over a transparent card.
function drawDiagonalStripes(ctx, x, y, w, h, color) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  for (let i = -h; i < w + h; i += 5) {
    ctx.beginPath();
    ctx.moveTo(x + i, y + h);
    ctx.lineTo(x + i + h, y);
    ctx.stroke();
  }
  ctx.restore();
}

// Replicates the site's background (solid / gradient / image + overlay) so
// the exported bracket sits on the exact same backdrop as the page. The
// image is loaded CORS-safely (with a weserv.nl fallback) exactly like
// player avatars; if that fails the base color is kept instead.
async function drawExportBackground(ctx, w, h, colors) {
  const bg = (state.theme && state.theme.background) || {};
  const base = bg.type === 'solid' ? (bg.color || colors.bgDeep) : colors.bgDeep;

  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  if (bg.type === 'gradient') {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, bg.gradColor1 || base);
    g.addColorStop(1, bg.gradColor2 || base);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    return;
  }

  if (bg.type === 'image' && bg.imageUrl) {
    const img = await loadAvatarSafely(bg.imageUrl);
    if (img) {
      ctx.save();
      try { ctx.filter = bg.blur ? 'blur(' + bg.blur + 'px)' : 'none'; } catch (e) {}
      const s = Math.max(w / img.width, h / img.height);
      const dw = img.width * s, dh = img.height * s;
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      ctx.restore();
      const overlay = (bg.overlayOpacity != null ? bg.overlayOpacity : 55) / 100;
      if (overlay > 0) {
        ctx.fillStyle = hexToRgba(colors.bgDeep, overlay);
        ctx.fillRect(0, 0, w, h);
      }
    }
  }
}

// Builds the full bracket export at a fixed 2x pixel density for a crisp
// download regardless of the viewer's screen. Every element mirrors the
// on-page bracket (see the "Bracket" block in style.css): transparent
// unboxed cards, dashed separators, muted connectors, round headers, and
// the site background + paused overlay.
async function buildBracketExportCanvas() {
  if (!state.tournamentStarted || !state.matches.length) throw new Error('NO_DATA');
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }

  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  const colors = {
    bgDeep: v('--bg-deep', '#0d0c12'),
    bgDark: v('--bg-dark', '#1b1822'),
    bgCard: v('--bg-card', '#1b1822'),
    bgSurface: v('--bg-surface', '#1b1822'),
    border: v('--border', '#332f3d'),
    primary: v('--primary', '#9184c9'),
    primaryDark: v('--primary-dark', '#6e5fa8'),
    primaryLight: v('--primary-light', '#c4bce2'),
    primaryGlow: v('--primary-glow', 'rgba(145, 132, 201, 0.35)'),
    textPrimary: v('--text-primary', '#ece8f5'),
    textSecondary: v('--text-secondary', '#b8b0cc'),
    textMuted: v('--text-muted', '#7d7690'),
    winBg: v('--win-bg', 'rgba(255, 215, 0, 0.08)')
  };
  const avatarShape = state.theme.avatarShape || 'circle';

  const rounds = [...new Set(state.matches.map(m => m.round))].sort((a, b) => a - b);
  const nameMap = buildRoundNameMap(rounds);
  const matchesByRound = rounds.map(r => state.matches.filter(m => m.round === r).sort((a, b) => a.position - b.position));

  // Mirror the page's dead-slot rule: trailing power-of-two padding slots
  // (and any later match fed only by them) are impossible — render them as
  // "—" instead of a misleading "بانتظار المتأهل" row.
  const maxRound = rounds[rounds.length - 1];
  const isLive = {};
  state.matches.forEach(m => { if (m.round === 1) isLive[m.id] = !!(m.player1Id || m.player2Id); });
  for (let r = 2; r <= maxRound; r++) {
    state.matches.filter(m => m.round === r).forEach(m => {
      const pa = state.matches.find(x => x.round === r - 1 && x.position === m.position * 2);
      const pb = state.matches.find(x => x.round === r - 1 && x.position === m.position * 2 + 1);
      isLive[m.id] = !!(pa && isLive[pa.id]) || !!(pb && isLive[pb.id]);
    });
  }

  const scale = 4; // أقصى وضوح ممكن — الصورة تطلع حادة على أي شاشة
  const cardH = 64, vsGapW = 38, gapY = 18, columnPad = 10, connStub = 10;
  const marginX = 48, containerPad = 28, headerH = 54, topPad = 66;

  // Size the card to whatever the longest name/id in THIS tournament
  // actually needs, instead of a fixed width that clips real names with
  // an ellipsis. Never shrinks below the original 230px look for a
  // typical short-name bracket; capped generously so one absurdly long
  // string can't blow the canvas up without bound (falls back to the
  // existing ellipsis truncation only past that point).
  const neededTextW = measureExportSlotContentWidth(state.matches) + 4;
  const neededHalfW = EXPORT_SLOT_PAD * 2 + EXPORT_AVATAR_R * 2 + EXPORT_NAME_GAP + neededTextW + 24;
  const halfW = Math.min(Math.max(neededHalfW, (280 - vsGapW) / 2), 400);
  const cardW = halfW * 2 + vsGapW;
  const columnW = cardW + columnPad * 2;

  const round1Count = matchesByRound[0].length;
  const contentH = round1Count * cardH + (round1Count - 1) * gapY;
  const gridW = rounds.length * columnW;
  const gridX = marginX + containerPad;
  const cssW = marginX * 2 + gridW + containerPad * 2;
  const containerX = marginX, containerW = cssW - marginX * 2;
  const containerTop = topPad + 8;
  const gridTop = containerTop + containerPad;
  const cardsTop = gridTop + headerH + 8;
  const containerBottom = cardsTop + contentH + containerPad;
  // مساحة الفوتر: شريط البطل (لو البطولة خلصت) + سطر تاريخ التصدير
  const finalR = Math.max(...state.matches.map(m => m.round));
  const finalM = state.matches.find(m => m.round === finalR);
  const championPlayer = (state.tournamentFinished && finalM) ? getPlayer(finalM.winnerId) : null;
  const cssH = containerBottom + (championPlayer ? 96 : 44);

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(cssW * scale);
  canvas.height = Math.ceil(cssH * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  await drawExportBackground(ctx, cssW, cssH, colors);

  // شظايا هندسية قطرية + زوايا دهب — لغة تصميم البث
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
  ctx.beginPath(); ctx.moveTo(cssW * 0.55, 0); ctx.lineTo(cssW * 0.75, 0); ctx.lineTo(cssW * 0.45, cssH); ctx.lineTo(cssW * 0.25, cssH); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(cssW * 0.88, 0); ctx.lineTo(cssW, 0); ctx.lineTo(cssW, cssH * 0.55); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(210, 169, 92, 0.10)';
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(90, 0); ctx.lineTo(0, 90); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(cssW, cssH); ctx.lineTo(cssW - 90, cssH); ctx.lineTo(cssW, cssH - 90); ctx.closePath(); ctx.fill();
  ctx.restore();

  // Team logo — the admin-uploaded crest drawn centered above the title,
  // matching the hero layout on the page. Skipped when no logo is set.
  const teamLogoUrl = sanitizeBgImageUrl((state.theme && state.theme.logo) || '');
  if (teamLogoUrl) {
    try {
      const logoImg = await loadAvatarSafely(teamLogoUrl);
      if (logoImg && logoImg.width > 0) {
        const logoH = 26;
        const logoW = logoImg.width > logoImg.height
          ? logoH * (logoImg.width / logoImg.height)
          : logoH;
        ctx.drawImage(logoImg, cssW / 2 - logoW / 2, topPad - 18 - logoH - 14, logoW, logoH);
      }
    } catch (e) { /* logo is decorative — never fail the whole export for it */ }
  }

  // Title — tournament name, centered above the grid like the page header.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = colors.textPrimary;
  ctx.font = "700 26px " + EXPORT_FONT_STACK;
  drawBidiText(ctx, state.settings.name || 'K-Gang Tournament', cssW / 2, topPad - 14, cssW - marginX * 2);

  // The dark rounded container the on-page bracket lives in
  // (`.bracket-container`): bg-dark + two subtle radial glows + a border.
  {
    roundRectPath(ctx, containerX, containerTop, containerW, containerBottom - containerTop, 16);
    ctx.save();
    ctx.clip();
    ctx.fillStyle = colors.bgDark;
    ctx.fillRect(containerX, containerTop, containerW, containerBottom - containerTop);
    const glows = [
      { x: containerX + containerW * 0.2, y: containerTop + (containerBottom - containerTop) * 0.5, a: 0.04 },
      { x: containerX + containerW * 0.8, y: containerTop + (containerBottom - containerTop) * 0.5, a: 0.03 }
    ];
    glows.forEach(gl => {
      const rad = containerW * 0.45;
      const rg = ctx.createRadialGradient(gl.x, gl.y, 0, gl.x, gl.y, rad);
      rg.addColorStop(0, hexToRgba(colors.primary, gl.a));
      rg.addColorStop(1, hexToRgba(colors.primary, 0));
      ctx.fillStyle = rg;
      ctx.fillRect(containerX, containerTop, containerW, containerBottom - containerTop);
    });
    ctx.restore();
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Row centers per column — same layout as the page's flex columns.
  const yPos = [];
  yPos[0] = matchesByRound[0].map((m, i) => cardsTop + i * (cardH + gapY) + cardH / 2);
  for (let r = 1; r < rounds.length; r++) {
    yPos[r] = matchesByRound[r].map((m, i) => (yPos[r - 1][2 * i] + yPos[r - 1][2 * i + 1]) / 2);
  }

  // Round headers (with the page's border-bottom) + vertical dividers
  // between columns (the gradient fade line from `.round-column::after`).
  rounds.forEach((round, r) => {
    const colX = gridX + r * columnW;
    ctx.font = "800 14px " + EXPORT_FONT_STACK;
    ctx.fillStyle = '#d2a95c';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawBidiText(ctx, nameMap[round] || ('الدور ' + round), colX + columnW / 2, gridTop + headerH - 16, columnW - 8);
    ctx.strokeStyle = 'rgba(210, 169, 92, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(colX, gridTop + headerH - 5);
    ctx.lineTo(colX + columnW, gridTop + headerH - 5);
    ctx.stroke();

    if (r < rounds.length - 1) {
      const gx = colX + columnW;
      const grad = ctx.createLinearGradient(0, cardsTop, 0, cardsTop + contentH);
      grad.addColorStop(0, hexToRgba(colors.border, 0));
      grad.addColorStop(0.3, hexToRgba(colors.border, 0.6));
      grad.addColorStop(0.7, hexToRgba(colors.border, 0.6));
      grad.addColorStop(1, hexToRgba(colors.border, 0));
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(gx, cardsTop);
      ctx.lineTo(gx, cardsTop + contentH);
      ctx.stroke();
    }
  });

  // Bracket connectors between round r and r+1 — muted stubs + a vertical
  // link, highlighted in primary for matches that already have a winner.
  ctx.lineWidth = 2;
  for (let r = 0; r < rounds.length - 1; r++) {
    const colX = gridX + r * columnW;
    const cardRight = colX + columnPad + cardW;
    const vx = cardRight + connStub;
    const nextCardX = gridX + (r + 1) * columnW + columnPad;
    matchesByRound[r + 1].forEach((nm, ni) => {
      const y0 = yPos[r][2 * ni], y1 = yPos[r][2 * ni + 1], nextCy = yPos[r + 1][ni];
      const winner = nm.winnerId != null;
      ctx.strokeStyle = winner ? '#d2a95c' : colors.border;
      ctx.globalAlpha = winner ? 0.9 : 0.55;
      ctx.beginPath(); ctx.moveTo(cardRight, y0); ctx.lineTo(vx, y0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cardRight, y1); ctx.lineTo(vx, y1); ctx.stroke();
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = colors.border;
      ctx.beginPath(); ctx.moveTo(vx, y0); ctx.lineTo(vx, y1); ctx.stroke();
      ctx.globalAlpha = winner ? 0.9 : 0.55;
      ctx.strokeStyle = winner ? '#d2a95c' : colors.border;
      ctx.beginPath(); ctx.moveTo(vx, nextCy); ctx.lineTo(nextCardX, nextCy); ctx.stroke();
      ctx.globalAlpha = 1;
    });
  }

  const playerIds = new Set();
  state.matches.forEach(m => { if (m.player1Id) playerIds.add(m.player1Id); if (m.player2Id) playerIds.add(m.player2Id); });
  const avatarCache = new Map();
  await Promise.all([...playerIds].map(async pid => {
    const p = getPlayer(pid);
    if (!p) return;
    const avUrl = p.avatarUrl || teamAvatarUrl(p.name) || defaultAvatar(p.name);
    const img = await loadAvatarSafely(avUrl);
    if (img) avatarCache.set(pid, img);
  }));

  // Match cards — unboxed/transparent like the page, with the winner tint,
  // bye stripes, and dashed separators from the on-screen CSS.
  rounds.forEach((round, r) => {
    const colX = gridX + r * columnW;
    const x = colX + columnPad;
    const matches = matchesByRound[r];
    matches.forEach((match, i) => {
      const y = yPos[r][i] - cardH / 2;

      if (match.winnerId != null) {
        roundRectPath(ctx, x, y, cardW, cardH, 10);
        ctx.fillStyle = colors.winBg;
        ctx.fill();
      } else if (match.isBye) {
        ctx.save();
        ctx.globalAlpha = 0.85;
        drawDiagonalStripes(ctx, x, y, cardW, cardH, colors.bgSurface);
        ctx.restore();
      }

      if (i < matches.length - 1) {
        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 1;
        setExportLineDash(ctx, [4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, y + cardH);
        ctx.lineTo(x + cardW, y + cardH);
        ctx.stroke();
        setExportLineDash(ctx, []);
      }

      const halfW = (cardW - vsGapW) / 2;
      const dead = !isLive[match.id];
      drawExportSlot(ctx, match, match.player1Id, x, y, halfW, cardH, colors, avatarCache, 'a', avatarShape, dead);
      drawExportSlot(ctx, match, match.player2Id, x + halfW + vsGapW, y, halfW, cardH, colors, avatarCache, 'b', avatarShape, dead);

      {
        const vw = 26, vh = 20, vcut = 6;
        const vx0 = x + halfW + vsGapW / 2 - vw / 2;
        const vy0 = y + cardH / 2 - vh / 2;
        ctx.beginPath();
        ctx.moveTo(vx0, vy0);
        ctx.lineTo(vx0 + vw, vy0);
        ctx.lineTo(vx0 + vw, vy0 + vh - vcut);
        ctx.lineTo(vx0 + vw - vcut, vy0 + vh);
        ctx.lineTo(vx0, vy0 + vh);
        ctx.closePath();
        ctx.fillStyle = '#d2a95c';
        ctx.fill();
        ctx.fillStyle = '#171410';
        ctx.font = '800 9px ' + EXPORT_FONT_STACK;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.direction = 'ltr';
        ctx.fillText('VS', vx0 + vw / 2, vy0 + vh / 2 + 0.5);
      }
    });
  });

  // Paused banner overlay — same treatment as `.paused-banner` on the page.
  if (state.tournamentPaused) {
    ctx.save();
    roundRectPath(ctx, containerX, containerTop, containerW, containerBottom - containerTop, 16);
    ctx.clip();
    ctx.fillStyle = 'rgba(10, 15, 22, 0.85)';
    ctx.fillRect(containerX, containerTop, containerW, containerBottom - containerTop);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffc107';
    ctx.font = "700 34px " + EXPORT_FONT_STACK;
    drawBidiText(ctx, 'البطولة موقوفة مؤقتاً', cssW / 2, (containerTop + containerBottom) / 2 - 16, containerW - marginX * 2);
    ctx.fillStyle = colors.textMuted;
    ctx.font = "400 18px " + EXPORT_FONT_STACK;
    drawBidiText(ctx, 'المباريات متوقفة حتى استئناف البطولة', cssW / 2, (containerTop + containerBottom) / 2 + 20, containerW - marginX * 2);
    ctx.restore();
  }

  // شريط البطل + تاريخ التصدير في فوتر الصورة
  {
    let footY = containerBottom + 28;
    if (championPlayer) {
      ctx.font = "700 20px " + EXPORT_FONT_STACK;
      const champText = '🏆 البطل: ' + championPlayer.name;
      const tw = ctx.measureText(champText).width;
      const bw = Math.min(tw + 60, cssW - marginX * 2);
      roundRectPath(ctx, cssW / 2 - bw / 2, footY - 14, bw, 42, 21);
      ctx.fillStyle = 'rgba(255, 215, 0, 0.10)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 215, 0, 0.55)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = '#ffd700';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      drawBidiText(ctx, champText, cssW / 2, footY + 7, bw - 30);
      footY += 52;
    }
    const now = new Date();
    ctx.font = "400 11px " + EXPORT_FONT_STACK;
    ctx.fillStyle = colors.textMuted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.direction = 'ltr';
    ctx.fillText('K-Gang Bracket · ' + now.toLocaleDateString('ar-EG') + ' ' + now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }), marginX, footY);
  }

  return canvas;
}

async function exportBracketAsImage() {
  setExportButtonsBusy(true);
  const label = $('#exportImageBtnText');
  const prevLabel = label ? label.textContent : '';
  if (label) label.textContent = 'جاري التصدير...';
  try {
    const canvas = await buildBracketExportCanvas();
    const link = document.createElement('a');
    link.download = exportFileBaseName() + '.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
    toast('تم تصدير الجدول كصورة');
  } catch (e) {
    console.error('[K-Gang] image export failed', e);
    toast(describeExportError(e), 'error');
  } finally {
    if (label) label.textContent = prevLabel;
    setExportButtonsBusy(false);
  }
}

async function exportBracketAsPDF() {
  setExportButtonsBusy(true);
  const label = $('#exportPdfBtnText');
  const prevLabel = label ? label.textContent : '';
  if (label) label.textContent = 'جاري التصدير...';
  try {
    const canvas = await buildBracketExportCanvas();
    await ensurePdfLibLoaded();
    const { jsPDF } = window.jspdf;
    // One page sized exactly to the bracket image (px unit) — simplest and
    // sharpest result, avoids splitting a wide bracket across pages.
    const pdf = new jsPDF({
      orientation: canvas.width >= canvas.height ? 'landscape' : 'portrait',
      unit: 'px',
      format: [canvas.width, canvas.height],
      hotfixes: ['px_scaling']
    });
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, canvas.width, canvas.height);
    pdf.save(exportFileBaseName() + '.pdf');
    toast('تم تصدير الجدول كملف PDF');
  } catch (e) {
    console.error('[K-Gang] pdf export failed', e);
    toast(describeExportError(e), 'error');
  } finally {
    if (label) label.textContent = prevLabel;
    setExportButtonsBusy(false);
  }
}

// ========== UI ==========
// بيدّ الرقم من قيمته الحالية للهدف بحركة ease-out — أول تحميل بيعد من 0
function animateNumber(el, target) {
  if (!el) return;
  if (target === '—' || target == null) { el.textContent = '—'; return; }
  const targetNum = Number(target);
  const from = parseInt(el.textContent, 10);
  const startNum = isNaN(from) ? 0 : from;
  if (startNum === targetNum) { el.textContent = String(targetNum); return; }
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = String(targetNum); return;
  }
  const dur = Math.min(900, 250 + Math.abs(targetNum - startNum) * 40);
  const t0 = performance.now();
  (function tick(now) {
    const k = Math.min(1, ((now || performance.now()) - t0) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = String(Math.round(startNum + (targetNum - startNum) * eased));
    if (k < 1) requestAnimationFrame(tick);
  })(performance.now());
}

function updateStats() {
  animateNumber($('#playerCount'), state.players.length);
  animateNumber($('#matchCount'), state.tournamentStarted ? state.matches.length : '—');
  const r = state.tournamentStarted ? [...new Set(state.matches.map(m => m.round))].length : 0;
  animateNumber($('#roundCount'), r || '—');
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
  if (tab === 'effects') renderEffectsTab();
  if (tab === 'manage') {
    // The bracket may have been laid out while its container was hidden
    // (display:none makes every rect read as 0, which would pin all
    // later-round cards at top:0 and hide most teams). Align it now that
    // it's actually visible — harmless when it already is.
    requestAnimationFrame(function() { try { layoutBracket(); } catch (e) {} });
  }
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
  const avatarWrap = $('#championAvatar');
  if (avatarWrap) {
    avatarWrap.classList.remove('champion-flip-anim');
    if (state.theme.animations && state.theme.animations.winnerFlip) {
      void avatarWrap.offsetWidth; // reflow so the animation can (re)start
      avatarWrap.classList.add('champion-flip-anim');
    }
  }
  $('#championModal').classList.add('open');
  launchChampionConfetti();
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
    matches: state.matches.map(m => ({ round: m.round, position: m.position, player1Id: m.player1Id, player2Id: m.player2Id, winnerId: m.winnerId, isBye: m.isBye, score1: m.score1, score2: m.score2 })),
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
        winnerId: m.winnerId, isBye: m.isBye || false,
        score1: m.score1 != null ? m.score1 : null, score2: m.score2 != null ? m.score2 : null
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
  // renderThemeTab()/renderEffectsTab() rebuild a fair amount of admin-only
  // DOM (swatches, color pickers, sliders). renderAll() runs on every cloud
  // sync (not just user actions), so doing that work while the panel is
  // closed — or open on a different tab — was pure waste on every poll.
  // switchTab() already (re)builds a tab the moment someone opens it, so
  // skipping it here costs nothing functionally.
  try {
    applyThemeFull();
    const panelOpen = $('#adminPanel').classList.contains('open');
    const activeTab = panelOpen ? document.querySelector('.tab-btn.active') : null;
    const activeTabId = activeTab ? activeTab.dataset.tab : null;
    if (activeTabId === 'theme') renderThemeTab();
    if (activeTabId === 'effects') renderEffectsTab();
  } catch (e) { console.error('[K-Gang] theme apply failed', e); }
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
