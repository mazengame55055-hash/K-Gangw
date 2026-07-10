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

// ========== Storage ==========
function saveState() {
  try { localStorage.setItem('kgang_bracket_v1', JSON.stringify(state)); } catch (e) {}
}

function loadState() {
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
    saveState();
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
    saveState();
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
document.addEventListener('DOMContentLoaded', function() {
  if (!loadState()) loadShared();
  state.isLocked = true; // Always start locked for security
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
});
