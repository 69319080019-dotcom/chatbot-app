const DAYS_TH = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์'];
const RING_CIRCUMFERENCE = 238.76; // 2 * PI * r(38)

const PROCESSING_MESSAGES = [
  'กำลังอัปโหลดไฟล์...',
  'AI กำลังอ่านตัวหนังสือในตาราง...',
  'กำลังจัดหมวดหมู่รายวิชา...',
  'ใกล้เสร็จแล้ว...',
];

function getSessionId() {
  // sessionStorage (not localStorage) so closing the browser/tab clears the
  // session and the next visit starts fresh at the landing page. A simple
  // page refresh (same tab) still keeps the session, so mid-review reloads
  // don't lose data.
  let id = sessionStorage.getItem('schedule_bot_session_id');
  if (!id) {
    id = 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem('schedule_bot_session_id', id);
  }
  return id;
}

const SESSION_ID = getSessionId();

const els = {
  landingView: document.getElementById('landingView'),
  landingUploadZone: document.getElementById('landingUploadZone'),
  fileInput: document.getElementById('fileInput'),
  landingError: document.getElementById('landingError'),
  progressWrap: document.getElementById('progressWrap'),
  progressRingWrap: document.getElementById('progressRingWrap'),
  progressRing: document.getElementById('progressRing'),
  progressPercent: document.getElementById('progressPercent'),
  progressCheckmark: document.getElementById('progressCheckmark'),
  progressStatus: document.getElementById('progressStatus'),

  chatView: document.getElementById('chatView'),
  backBtn: document.getElementById('backBtn'),
  uploadZoneSmall: document.getElementById('uploadZoneSmall'),
  fileInputSmall: document.getElementById('fileInputSmall'),
  mergeConfirm: document.getElementById('mergeConfirm'),
  replaceBtn: document.getElementById('replaceBtn'),
  mergeBtn: document.getElementById('mergeBtn'),
  cancelMergeBtn: document.getElementById('cancelMergeBtn'),
  uploadIconSmall: document.getElementById('uploadIconSmall'),
  uploadLabelSmall: document.getElementById('uploadLabelSmall'),
  errorBox: document.getElementById('errorBox'),
  scheduleList: document.getElementById('scheduleList'),
  chatMessages: document.getElementById('chatMessages'),
  chatInput: document.getElementById('chatInput'),
  sendBtn: document.getElementById('sendBtn'),
  clearBtn: document.getElementById('clearBtn'),
};

let schedule = [];
let chatLoading = false;

function apiUrl(path) {
  return (window.API_BASE || '') + path;
}

/* ---------------- view switching ---------------- */
function showLanding() {
  els.landingView.classList.remove('hidden', 'leaving');
  els.chatView.classList.add('hidden');
  els.chatView.classList.remove('entering');
}

// Plays: checkmark pop -> landing card fades/scales out -> chat view
// slides/fades in. Falls back to an instant switch if anything goes wrong.
function transitionToChat() {
  els.landingView.classList.add('leaving');
  const onLandingExitEnd = () => {
    els.landingView.removeEventListener('animationend', onLandingExitEnd);
    els.landingView.classList.add('hidden');
    els.landingView.classList.remove('leaving');

    els.chatView.classList.remove('hidden');
    els.chatView.classList.add('entering');
    const onChatEnterEnd = () => {
      els.chatView.removeEventListener('animationend', onChatEnterEnd);
      els.chatView.classList.remove('entering');
    };
    els.chatView.addEventListener('animationend', onChatEnterEnd);
  };
  els.landingView.addEventListener('animationend', onLandingExitEnd);
}

function showChatInstant() {
  els.landingView.classList.add('hidden');
  els.chatView.classList.remove('hidden', 'entering');
}

/* ---------------- progress ring ---------------- */
let simInterval = null;
let currentPct = 0;
let msgIndex = 0;
let msgInterval = null;

function setProgress(pct) {
  currentPct = Math.max(0, Math.min(100, pct));
  const offset = RING_CIRCUMFERENCE * (1 - currentPct / 100);
  els.progressRing.style.strokeDashoffset = offset;
  els.progressPercent.textContent = Math.round(currentPct) + '%';
}

function startProgress() {
  els.progressWrap.classList.remove('hidden');
  els.landingUploadZone.style.visibility = 'hidden';
  setProgress(0);
  msgIndex = 0;
  els.progressStatus.textContent = PROCESSING_MESSAGES[0];
  msgInterval = setInterval(() => {
    msgIndex = Math.min(msgIndex + 1, PROCESSING_MESSAGES.length - 1);
    els.progressStatus.textContent = PROCESSING_MESSAGES[msgIndex];
  }, 1800);
}

function startSimulatedCreep(fromPct) {
  clearInterval(simInterval);
  simInterval = setInterval(() => {
    const target = 92;
    const remain = target - currentPct;
    if (remain <= 0.5) return;
    setProgress(currentPct + remain * 0.06);
  }, 200);
}

function finishProgress(success) {
  clearInterval(simInterval);
  clearInterval(msgInterval);
  if (success) {
    setProgress(100);
    els.progressStatus.textContent = 'เสร็จแล้ว!';
    els.progressRingWrap.classList.add('success');
    els.progressCheckmark.classList.add('show');
  }
}

function resetProgressUI() {
  els.progressWrap.classList.add('hidden');
  els.landingUploadZone.style.visibility = 'visible';
  els.progressRingWrap.classList.remove('success');
  els.progressCheckmark.classList.remove('show');
  setProgress(0);
}

/* ---------------- error boxes ---------------- */
function showLandingError(msg) {
  els.landingError.textContent = msg;
  els.landingError.classList.remove('hidden');
}
function hideLandingError() {
  els.landingError.classList.add('hidden');
}
function showError(msg) {
  els.errorBox.textContent = msg;
  els.errorBox.classList.remove('hidden');
}
function hideError() {
  els.errorBox.classList.add('hidden');
}

/* ---------------- chat rendering ---------------- */
function addMessage(role, content) {
  const row = document.createElement('div');
  row.className = `bubble-row ${role}`;
  const bubble = document.createElement('div');
  bubble.className = `bubble ${role}`;
  bubble.textContent = content;
  row.appendChild(bubble);
  els.chatMessages.appendChild(row);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function setLoadingBubble(show) {
  let existing = document.getElementById('loadingBubble');
  if (show) {
    if (existing) return;
    const row = document.createElement('div');
    row.className = 'bubble-row assistant';
    row.id = 'loadingBubble';
    row.innerHTML = `<div class="bubble assistant loading"><span class="spinner"></span> กำลังตอบ...</div>`;
    els.chatMessages.appendChild(row);
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  } else if (existing) {
    existing.remove();
  }
}

/* ---------------- schedule rendering ---------------- */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderSchedule() {
  els.scheduleList.innerHTML = '';
  const activeDays = DAYS_TH.filter((d) => schedule.some((s) => s.day === d));

  if (activeDays.length === 0) {
    els.scheduleList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">✦</div>
        <div>ยังไม่มีตารางเรียน<br />อัปโหลดรูปเพื่อเริ่มต้น</div>
      </div>`;
    els.clearBtn.classList.add('hidden');
    return;
  }

  els.clearBtn.classList.remove('hidden');

  activeDays.forEach((day) => {
    const items = schedule
      .filter((s) => s.day === day)
      .sort((a, b) => (a.start || '').localeCompare(b.start || ''));

    const group = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'day-group-title';
    title.textContent = day;
    group.appendChild(title);

    items.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'class-card';
      const metaParts = [];
      if (item.room) metaParts.push(`ห้อง ${item.room}`);
      if (item.instructor) metaParts.push(item.instructor);
      card.innerHTML = `
        <div class="class-time">${item.start || ''} – ${item.end || ''}</div>
        <div class="class-subject">${escapeHtml(item.subject || '')}</div>
        ${metaParts.length ? `<div class="class-meta">${escapeHtml(metaParts.join(' · '))}</div>` : ''}
      `;
      group.appendChild(card);
    });

    els.scheduleList.appendChild(group);
  });
}

/* ---------------- API calls ---------------- */
async function loadSchedule() {
  try {
    const resp = await fetch(apiUrl('/api/schedule'), {
      headers: { 'X-Session-Id': SESSION_ID },
    });
    const data = await resp.json();
    schedule = data.schedule || [];
    renderSchedule();
    return schedule.length > 0;
  } catch (e) {
    console.error(e);
    return false;
  }
}

// Uses XMLHttpRequest (instead of fetch) so we get real upload-progress
// events for the first part of the progress bar.
function uploadWithProgress(file, onUploadProgress) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/api/upload'));
    xhr.setRequestHeader('X-Session-Id', SESSION_ID);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onUploadProgress) {
        onUploadProgress((e.loaded / e.total) * 100);
      }
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          reject(new Error(data.detail || 'อัปโหลดไม่สำเร็จ'));
        }
      } catch (e) {
        reject(new Error('อัปโหลดไม่สำเร็จ (รูปแบบข้อมูลจากเซิร์ฟเวอร์ผิดพลาด)'));
      }
    };
    xhr.onerror = () => reject(new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'));
    xhr.send(formData);
  });
}

/* ---------------- landing upload flow ---------------- */
async function handleLandingUpload(file) {
  hideLandingError();
  startProgress();

  try {
    const data = await uploadWithProgress(file, (uploadPct) => {
      // Upload transfer maps to the first 30% of the bar.
      setProgress(Math.min(30, uploadPct * 0.3));
      if (uploadPct >= 100) startSimulatedCreep();
    });

    finishProgress(true);
    schedule = data.schedule || [];
    renderSchedule();

    setTimeout(() => {
      transitionToChat();
      resetProgressUI();
      if (data.added > 0) {
        addMessage('assistant', `อ่านตารางเรียบร้อยค่ะ พบ ${data.added} วิชา ลองถามได้เลยค่ะ`);
      } else {
        addMessage(
          'assistant',
          'สวัสดีค่ะ อ่านไฟล์สำเร็จแต่ไม่พบตารางเรียนในไฟล์นี้ ลองอัปโหลดไฟล์อื่นดูค่ะ'
        );
      }
    }, 900);
  } catch (e) {
    console.error(e);
    finishProgress(false);
    resetProgressUI();
    showLandingError(e.message || 'อ่านไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง');
  } finally {
    els.fileInput.value = '';
  }
}

/* ---------------- chat-view small upload flow ---------------- */
let pendingSmallFile = null;

function hideMergeConfirm() {
  els.mergeConfirm.classList.add('hidden');
  pendingSmallFile = null;
  els.fileInputSmall.value = '';
}

async function runSmallUpload(file, { replaceFirst } = {}) {
  hideError();
  hideMergeConfirm();
  els.uploadIconSmall.innerHTML = '<span class="spinner"></span>';
  els.uploadLabelSmall.textContent = 'กำลังอ่านตาราง...';
  els.fileInputSmall.disabled = true;

  try {
    if (replaceFirst) {
      await fetch(apiUrl('/api/schedule'), {
        method: 'DELETE',
        headers: { 'X-Session-Id': SESSION_ID },
      });
    }
    const data = await uploadWithProgress(file);
    schedule = data.schedule || [];
    renderSchedule();
    if (data.added > 0) {
      const msg = replaceFirst
        ? `แทนที่ตารางเดิมเรียบร้อยค่ะ พบ ${data.added} วิชาในตารางใหม่ ลองถามได้เลยค่ะ`
        : `เพิ่มตารางเรียบร้อยค่ะ พบ ${data.added} วิชาในไฟล์นี้ ลองถามได้เลยค่ะ`;
      addMessage('assistant', msg);
    } else {
      addMessage('assistant', 'อ่านไฟล์สำเร็จ แต่ไม่พบข้อมูลตารางเรียนในไฟล์นี้ ลองไฟล์อื่นดูค่ะ');
    }
  } catch (e) {
    console.error(e);
    showError(e.message || 'อ่านไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง');
  } finally {
    els.uploadIconSmall.textContent = '⬆';
    els.uploadLabelSmall.textContent = 'อัปโหลดรูปหรือ PDF เพิ่มเติม';
    els.fileInputSmall.disabled = false;
    els.fileInputSmall.value = '';
  }
}

function handleSmallUpload(file) {
  if (schedule.length > 0) {
    // A schedule already exists — ask whether the new file should replace
    // it or be merged in, instead of silently mixing both together.
    pendingSmallFile = file;
    hideError();
    els.mergeConfirm.classList.remove('hidden');
  } else {
    runSmallUpload(file, { replaceFirst: false });
  }
}

/* ---------------- chat ---------------- */
async function sendMessage() {
  const text = els.chatInput.value.trim();
  if (!text || chatLoading) return;
  addMessage('user', text);
  els.chatInput.value = '';
  chatLoading = true;
  els.sendBtn.disabled = true;
  setLoadingBubble(true);

  try {
    const resp = await fetch(apiUrl('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': SESSION_ID },
      body: JSON.stringify({ message: text }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || 'error');
    setLoadingBubble(false);
    addMessage('assistant', data.reply);
  } catch (e) {
    console.error(e);
    setLoadingBubble(false);
    addMessage('assistant', 'ขออภัยค่ะ เกิดข้อผิดพลาด ลองถามใหม่อีกครั้ง');
  } finally {
    chatLoading = false;
    els.sendBtn.disabled = false;
  }
}

async function clearSchedule() {
  try {
    await fetch(apiUrl('/api/schedule'), {
      method: 'DELETE',
      headers: { 'X-Session-Id': SESSION_ID },
    });
    schedule = [];
    renderSchedule();
    addMessage('assistant', 'ล้างข้อมูลตารางเรียนแล้วค่ะ');
  } catch (e) {
    console.error(e);
  }
}

/* ---------------- events ---------------- */
els.landingUploadZone.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) handleLandingUpload(file);
});

els.uploadZoneSmall.addEventListener('click', () => els.fileInputSmall.click());
els.fileInputSmall.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) handleSmallUpload(file);
});

els.replaceBtn.addEventListener('click', () => {
  if (pendingSmallFile) runSmallUpload(pendingSmallFile, { replaceFirst: true });
});
els.mergeBtn.addEventListener('click', () => {
  if (pendingSmallFile) runSmallUpload(pendingSmallFile, { replaceFirst: false });
});
els.cancelMergeBtn.addEventListener('click', hideMergeConfirm);

els.sendBtn.addEventListener('click', sendMessage);
els.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});
els.clearBtn.addEventListener('click', clearSchedule);
els.backBtn.addEventListener('click', () => {
  showLanding();
  resetProgressUI();
  hideLandingError();
});

/* ---------------- init ---------------- */
addMessage(
  'assistant',
  'สวัสดีค่ะ อัปโหลดรูปตารางเรียนได้เลย แล้วลองถามเช่น "วันจันทร์เรียนอะไรบ้าง" หรือ "วิชา X เรียนห้องไหน"'
);

(async () => {
  const hasSchedule = await loadSchedule();
  if (hasSchedule) {
    showChatInstant();
  } else {
    showLanding();
  }
})();
