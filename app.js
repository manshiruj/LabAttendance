'use strict';

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  ADMIN_PASS   : 'iitism',
  FAST2SMS_KEY : '6oEhWuNcMB5wOemUpZ4j7s9x1HDilCFavzA23nGtJP8QLIgrTYsc0Ph8vywRYgJ3CFIe71So4OjlZrtE',
  LAB_LAT      : 23.814494911410456,
  LAB_LNG      : 86.4412234473509,
  LAB_RADIUS_M : 150,   // meters — adjust if needed
};

// ── STORAGE ───────────────────────────────────────────────────────────────────
const store = {
  get : (k, fb = null) => { try { const v = localStorage.getItem(k); return v !== null ? JSON.parse(v) : fb; } catch { return fb; } },
  set : (k, v)         => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del : (k)            => { try { localStorage.removeItem(k); } catch {} },
};

const getMembers  = ()    => store.get('la_members', []);
const setMembers  = (arr) => store.set('la_members', arr);
const getRecords  = ()    => store.get('la_records', []);
const setRecords  = (arr) => store.set('la_records', arr);

// Verified device: { memberId, phone }
const getDevice   = ()    => store.get('la_device', null);
const setDevice   = (obj) => store.set('la_device', obj);

// Temp OTP store
let pendingOTP   = null;
let pendingPhone = null;

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── UTILS ─────────────────────────────────────────────────────────────────────
const uid     = ()      => Math.random().toString(36).slice(2, 10);
const today   = ()      => new Date().toISOString().slice(0, 10);
const nowTime = ()      => new Date().toTimeString().slice(0, 5);
const fmtDate = (iso)   => { const [y,m,d] = iso.split('-'); return `${d}/${m}/${y}`; };
const escHtml = (s)     => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const calcHours = (i,o) => {
  if (!i || !o) return '—';
  const [ih,im] = i.split(':').map(Number);
  const [oh,om] = o.split(':').map(Number);
  const diff = (oh*60+om)-(ih*60+im);
  if (diff <= 0) return '—';
  const h = Math.floor(diff/60), m = diff%60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

function setMsg(elId, text, type='') {
  const el = $(elId);
  el.textContent = text;
  el.className = 'msg ' + type + (elId === 'mark-msg' ? ' text-center' : '');
  if (text && type !== 'error') setTimeout(() => { el.textContent=''; el.className='msg'+(elId==='mark-msg'?' text-center':''); }, 4000);
}

// ── GPS ───────────────────────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function checkGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject('GPS not supported on this device.'); return; }
    $('gps-overlay').style.display = 'flex';
    $('gps-msg').textContent = 'Verifying your location…';
    navigator.geolocation.getCurrentPosition(
      pos => {
        $('gps-overlay').style.display = 'none';
        const dist = haversine(pos.coords.latitude, pos.coords.longitude, CONFIG.LAB_LAT, CONFIG.LAB_LNG);
        if (dist <= CONFIG.LAB_RADIUS_M) resolve(dist);
        else reject(`You appear to be ${Math.round(dist)}m away from the lab. You must be inside the lab to mark attendance.`);
      },
      err => {
        $('gps-overlay').style.display = 'none';
        const msgs = { 1:'Location permission denied. Please allow location access.', 2:'Unable to determine location. Try moving closer to a window.', 3:'Location request timed out. Please try again.' };
        reject(msgs[err.code] || 'Location error. Please try again.');
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  });
}

// ── OTP (Fast2SMS) ────────────────────────────────────────────────────────────
function generateOTP() { return String(Math.floor(100000 + Math.random() * 900000)); }

async function sendOTP(phone) {
  const otp = generateOTP();
  const message = `Your LabAttend OTP is: ${otp}. Valid for 10 minutes. Do not share with anyone.`;
  try {
    const res = await fetch(`https://www.fast2sms.com/dev/bulkV2?authorization=${CONFIG.FAST2SMS_KEY}&route=q&message=${encodeURIComponent(message)}&language=english&flash=0&numbers=${phone}`, {
      method: 'GET',
      headers: { 'cache-control': 'no-cache' }
    });
    const data = await res.json();
    if (data.return === true) { return otp; }
    else { throw new Error(data.message || 'SMS failed'); }
  } catch (e) {
    throw new Error('Could not send OTP. Please check your connection.');
  }
}

// ── VERIFY SCREEN ─────────────────────────────────────────────────────────────
function showVerifyScreen() {
  $('screen-verify').style.display = 'block';
  $('screen-main').style.display   = 'none';
  $('verify-step-phone').style.display = 'block';
  $('verify-step-otp').style.display   = 'none';
}

function showMainScreen() {
  $('screen-verify').style.display = 'none';
  $('screen-main').style.display   = 'block';
}

$('btn-send-otp').addEventListener('click', async () => {
  const phone = $('input-phone').value.trim();
  setMsg('verify-msg', '');

  if (!/^\d{10}$/.test(phone)) { setMsg('verify-msg','Enter a valid 10-digit phone number.','error'); return; }

  // Check if number is registered
  const members = getMembers();
  const member  = members.find(m => m.phone === phone);
  if (!member) {
    setMsg('verify-msg', 'This number is not registered. Please contact your lab admin.', 'error');
    return;
  }

  const btn = $('btn-send-otp');
  btn.disabled = true; btn.textContent = 'Sending…';

  try {
    pendingOTP   = await sendOTP(phone);
    pendingPhone = phone;
    $('otp-sent-to').textContent = '+91 ' + phone;
    $('verify-step-phone').style.display = 'none';
    $('verify-step-otp').style.display   = 'block';
    $('input-otp').value = '';
    $('input-otp').focus();
    setMsg('otp-msg', '');

    // Auto-expire OTP after 10 min
    setTimeout(() => { pendingOTP = null; }, 10 * 60 * 1000);
  } catch(e) {
    setMsg('verify-msg', e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Send OTP';
  }
});

$('btn-change-phone').addEventListener('click', () => {
  pendingOTP = null; pendingPhone = null;
  $('verify-step-phone').style.display = 'block';
  $('verify-step-otp').style.display   = 'none';
  setMsg('verify-msg', '');
});

$('input-phone').addEventListener('keydown', e => { if(e.key==='Enter') $('btn-send-otp').click(); });
$('input-otp').addEventListener('keydown',   e => { if(e.key==='Enter') $('btn-verify-otp').click(); });

$('btn-verify-otp').addEventListener('click', () => {
  const entered = $('input-otp').value.trim();
  setMsg('otp-msg', '');

  if (!pendingOTP) { setMsg('otp-msg','OTP expired. Please request a new one.','error'); return; }
  if (entered !== pendingOTP) { setMsg('otp-msg','Incorrect OTP. Please try again.','error'); return; }

  // OTP correct — save device
  const member = getMembers().find(m => m.phone === pendingPhone);
  setDevice({ memberId: member.id, phone: pendingPhone });
  pendingOTP = null; pendingPhone = null;

  showMainScreen();
  initMainScreen();
});

// ── MAIN SCREEN ───────────────────────────────────────────────────────────────
function initMainScreen() {
  const device = getDevice();
  if (!device) { showVerifyScreen(); return; }

  const members = getMembers();
  const member  = members.find(m => m.id === device.memberId);
  if (!member) {
    // Member was removed by admin
    store.del('la_device');
    showVerifyScreen();
    return;
  }

  // Show member card
  $('mcard-name').textContent = member.name;
  $('mcard-role').textContent = member.role;
  updateMcardStatus(member);

  // Header date
  const d = new Date();
  $('header-date').textContent = d.toLocaleDateString('en-IN', { day:'numeric', month:'short' });

  renderBoard();
}

function updateMcardStatus(member) {
  const rec = getRecords().find(r => r.id === member.id && r.date === today());
  const el  = $('mcard-status');
  if (!rec)      { el.textContent='Not checked in'; el.className='mcard-status status-none'; }
  else if(rec.out){ el.textContent='Checked out';   el.className='mcard-status status-out'; }
  else            { el.textContent='Present';        el.className='mcard-status status-in'; }
}

// ── CHECK IN / OUT ────────────────────────────────────────────────────────────
$('checkin-btn').addEventListener('click',  () => markAttendance('in'));
$('checkout-btn').addEventListener('click', () => markAttendance('out'));

async function markAttendance(type) {
  const device = getDevice();
  if (!device) { showVerifyScreen(); return; }
  const member = getMembers().find(m => m.id === device.memberId);
  if (!member) { setMsg('mark-msg','You are no longer registered. Contact admin.','error'); return; }

  const tod     = today();
  const records = getRecords();
  const existing= records.find(r => r.id === member.id && r.date === tod);

  if (type === 'in'  && existing)      { setMsg('mark-msg',`Already checked in today at ${existing.in}.`,'error'); return; }
  if (type === 'out' && !existing)     { setMsg('mark-msg','You haven\'t checked in today yet.','error'); return; }
  if (type === 'out' && existing?.out) { setMsg('mark-msg',`Already checked out today at ${existing.out}.`,'error'); return; }

  // GPS check
  try {
    await checkGPS();
  } catch(err) {
    setMsg('mark-msg', err, 'error');
    return;
  }

  const time = nowTime();
  if (type === 'in') {
    records.push({ id: member.id, name: member.name, role: member.role, date: tod, in: time, out: null });
  } else {
    existing.out = time;
  }
  setRecords(records);

  const label = type === 'in' ? 'Check-in' : 'Check-out';
  setMsg('mark-msg', `✓ ${label} recorded at ${time}`, 'success');
  updateMcardStatus(member);
  renderBoard();
}

// ── BOARD ─────────────────────────────────────────────────────────────────────
function renderBoard() {
  const members  = getMembers();
  const records  = getRecords();
  const todayRec = records.filter(r => r.date === today());
  const tbody    = $('board-tbody');
  tbody.innerHTML = '';

  if (members.length === 0) {
    $('board-empty').style.display = 'block';
    $('board-table').style.display = 'none';
    $('stat-present').textContent = $('stat-absent').textContent = $('stat-total').textContent = '0';
    return;
  }
  $('board-empty').style.display = 'none';
  $('board-table').style.display = 'table';

  let present = 0;
  members.forEach(m => {
    const rec = todayRec.find(r => r.id === m.id);
    let badge, cls;
    if (!rec)      { badge='Absent';       cls='badge-absent';     }
    else if(rec.out){ badge='Checked out'; cls='badge-checkedout'; present++; }
    else            { badge='Present';     cls='badge-present';    present++; }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escHtml(m.name)}</td>
      <td style="font-family:var(--font-body);font-size:12px;color:var(--grey-4)">${escHtml(m.role)}</td>
      <td><span class="status-badge ${cls}">${badge}</span></td>
      <td>${rec ? rec.in : '—'}</td>
      <td>${rec?.out || '—'}</td>
    `;
    tbody.appendChild(tr);
  });

  $('stat-present').textContent = present;
  $('stat-absent').textContent  = members.length - present;
  $('stat-total').textContent   = members.length;
}

let adminUnlocked = false;

$('close-overlay').addEventListener('click', closeOverlay);
$('admin-overlay').addEventListener('click', e => { if(e.target === $('admin-overlay')) closeOverlay(); });
function closeOverlay() { $('admin-overlay').style.display = 'none'; }

// ── ADMIN SCREENS ─────────────────────────────────────────────────────────────
// Admin entry from verify screen
$('btn-admin-entry').addEventListener('click', () => {
  $('screen-verify').style.display      = 'none';
  $('screen-admin-login').style.display = 'block';
  $('admin-login-pass').value = '';
  $('admin-login-err').textContent = '';
});

$('btn-back-to-verify').addEventListener('click', () => {
  $('screen-admin-login').style.display = 'none';
  $('screen-verify').style.display      = 'block';
});

$('btn-admin-login').addEventListener('click', unlockAdmin);
$('admin-login-pass').addEventListener('keydown', e => { if(e.key==='Enter') unlockAdmin(); });

function unlockAdmin() {
  if ($('admin-login-pass').value === CONFIG.ADMIN_PASS) {
    $('screen-admin-login').style.display = 'none';
    $('screen-main').style.display        = 'block';
    // Show admin overlay immediately
    $('admin-overlay').style.display = 'flex';
    adminUnlocked = true;
    renderBoard();
    renderMemberList();
    $('history-date').value = today();
    renderHistory();
    // Update header date
    const d = new Date();
    $('header-date').textContent = d.toLocaleDateString('en-IN', { day:'numeric', month:'short' });
    // Hide member card for admin view
    $('member-card').style.display = 'none';
  } else {
    $('admin-login-err').textContent = 'Incorrect password.';
  }
}

// Admin button (from main screen, if already unlocked)
$('admin-btn').addEventListener('click', () => {
  $('admin-overlay').style.display = 'flex';
  renderMemberList();
  renderHistory();
});

// ── TABS ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.style.display = 'none');
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).style.display = 'block';
    if (btn.dataset.tab === 'history') renderHistory();
  });
});

// ── ROLE CUSTOM ───────────────────────────────────────────────────────────────
$('new-role').addEventListener('change', () => {
  $('new-role-custom').style.display = $('new-role').value === '__custom__' ? 'block' : 'none';
});

// ── ADD MEMBER ────────────────────────────────────────────────────────────────
$('add-member-btn').addEventListener('click', addMember);

function addMember() {
  const name  = $('new-name').value.trim();
  const phone = $('new-phone').value.trim();
  const roleEl= $('new-role').value;
  const role  = roleEl === '__custom__' ? $('new-role-custom').value.trim() : roleEl;
  const errEl = $('add-err');

  if (!name)               { errEl.textContent='Name is required.'; return; }
  if (!/^\d{10}$/.test(phone)) { errEl.textContent='Enter a valid 10-digit phone number.'; return; }
  if (!role)               { errEl.textContent='Role is required.'; return; }

  const members = getMembers();
  if (members.find(m => m.phone === phone)) { errEl.textContent='This phone number is already registered.'; return; }
  if (members.find(m => m.name.toLowerCase() === name.toLowerCase())) { errEl.textContent='A member with this name already exists.'; return; }

  members.push({ id: uid(), name, phone, role });
  setMembers(members);
  $('new-name').value = ''; $('new-phone').value = '';
  $('new-role').value = ''; $('new-role-custom').value = '';
  $('new-role-custom').style.display = 'none';
  errEl.textContent = '';
  renderMemberList();
  renderBoard();
}

function renderMemberList() {
  const members = getMembers();
  const ul = $('member-list');
  ul.innerHTML = '';
  $('member-empty').style.display = members.length === 0 ? 'block' : 'none';
  members.forEach(m => {
    const li = document.createElement('li');
    li.className = 'member-item';
    li.innerHTML = `
      <div class="member-info">
        <span class="member-name">${escHtml(m.name)}</span>
        <span class="member-meta">${escHtml(m.role)} · +91 ${escHtml(m.phone)}</span>
      </div>
      <button class="btn-remove" data-id="${m.id}" aria-label="Remove">×</button>
    `;
    ul.appendChild(li);
  });
}

$('member-list').addEventListener('click', e => {
  const btn = e.target.closest('.btn-remove');
  if (!btn) return;
  const member = getMembers().find(m => m.id === btn.dataset.id);
  if (!member || !confirm(`Remove ${member.name}? Their records will be kept.`)) return;
  setMembers(getMembers().filter(m => m.id !== btn.dataset.id));
  renderMemberList();
  renderBoard();
});

// ── HISTORY ───────────────────────────────────────────────────────────────────
$('history-date').addEventListener('change', renderHistory);

function renderHistory() {
  const date    = $('history-date').value || today();
  const records = getRecords().filter(r => r.date === date);
  const tbody   = $('history-tbody');
  tbody.innerHTML = '';

  if (records.length === 0) {
    $('history-empty').style.display = 'block';
    $('history-table').style.display = 'none';
  } else {
    $('history-empty').style.display = 'none';
    $('history-table').style.display = 'table';
    records.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-family:var(--font-body)">${escHtml(r.name)}</td>
        <td style="font-size:11px;color:var(--grey-4)">${escHtml(r.role||'')}</td>
        <td>${fmtDate(r.date)}</td>
        <td>${r.in}</td>
        <td>${r.out||'—'}</td>
        <td>${calcHours(r.in,r.out)}</td>
      `;
      tbody.appendChild(tr);
    });
  }
}

// ── EXPORT CSV ────────────────────────────────────────────────────────────────
$('export-btn').addEventListener('click', () => {
  const date    = $('history-date').value || today();
  const records = getRecords().filter(r => r.date === date);
  if (!records.length) { alert('No records for this date.'); return; }
  const header = ['Name','Role','Date','Check-in','Check-out','Hours'];
  const rows   = records.map(r => [`"${r.name}"`,`"${r.role||''}"`,r.date,r.in,r.out||'',calcHours(r.in,r.out)]);
  const csv    = [header,...rows].map(r=>r.join(',')).join('\n');
  const a      = document.createElement('a');
  a.href       = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download   = `attendance_${date}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── INIT ──────────────────────────────────────────────────────────────────────
const device = getDevice();
if (!device) {
  showVerifyScreen();
} else {
  showMainScreen();
  initMainScreen();
}

// Service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(()=>{}));
}
