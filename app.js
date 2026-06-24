/* ─────────────────────────────────────────────
   RELAY — MIDI Controller PWA  ·  app.js
   ───────────────────────────────────────────── */

'use strict';

// ── AUDIO CONTEXT ──────────────────────────────
let audioCtx = null;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// ── MIDI NOTE MATH ─────────────────────────────
// Note 60 = C4
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function noteName(n) { return NOTE_NAMES[n % 12] + Math.floor(n / 12 - 1); }
function noteFreq(n) { return 440 * Math.pow(2, (n - 69) / 12); }

// ── STATE ──────────────────────────────────────
const state = {
  octave: 4,
  channel: 1,
  velCurve: 'linear',
  ws: null,
  wsUrl: localStorage.getItem('relay-ws-url') || '',
  activeKeys: new Map(),   // note → { osc, gain, el }
  activePads: new Set(),
  recording: false,
  recStart: null,
  recTimer: null,
  mediaRecorder: null,
  recChunks: [],
  samples: [],             // {id, name, blob, url, duration}
};

// ── SETTINGS PERSISTENCE ───────────────────────
function loadSettings() {
  const ch = localStorage.getItem('relay-channel');
  if (ch) state.channel = parseInt(ch);
  const vc = localStorage.getItem('relay-vel-curve');
  if (vc) state.velCurve = vc;
  const oct = localStorage.getItem('relay-octave');
  if (oct) state.octave = parseInt(oct);
}
function saveSettings() {
  localStorage.setItem('relay-channel', state.channel);
  localStorage.setItem('relay-vel-curve', state.velCurve);
  localStorage.setItem('relay-octave', state.octave);
  if (state.wsUrl) localStorage.setItem('relay-ws-url', state.wsUrl);
}

// ── VELOCITY CURVE ─────────────────────────────
// y: 0 (top of key) → 1 (bottom) → velocity 0–127
function applyVelCurve(raw /* 0–1 */) {
  let v;
  switch (state.velCurve) {
    case 'exp': v = Math.pow(raw, 2); break;
    case 'log': v = Math.sqrt(raw); break;
    default:    v = raw;
  }
  return Math.max(1, Math.min(127, Math.round(v * 126 + 1)));
}

// ── SYNTH VOICE ────────────────────────────────
function startNote(note, velocity) {
  if (state.activeKeys.has(note)) return;
  const ctx = getAudio();

  const freq = noteFreq(note);
  const vel01 = velocity / 127;

  // Sawtooth through lowpass — basic but cuts through
  const osc  = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();

  osc.type  = 'sawtooth';
  osc2.type = 'triangle';
  osc.frequency.value  = freq;
  osc2.frequency.value = freq * 1.003; // slight detune

  filter.type = 'lowpass';
  filter.frequency.value = 800 + vel01 * 3000;
  filter.Q.value = 1.2;

  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(vel01 * 0.35, ctx.currentTime + 0.005);

  osc.connect(filter);
  osc2.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);

  osc.start();
  osc2.start();

  state.activeKeys.set(note, { osc, osc2, filter, gain });

  sendMIDI(0x90, note, velocity);
  updateVelDisplay(velocity);
}

function stopNote(note) {
  const v = state.activeKeys.get(note);
  if (!v) return;
  const ctx = getAudio();
  v.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
  setTimeout(() => { try { v.osc.stop(); v.osc2.stop(); } catch(e){} }, 300);
  state.activeKeys.delete(note);
  sendMIDI(0x80, note, 0);
}

// ── DRUM SYNTH ─────────────────────────────────
const DRUM_DEFS = [
  { name: 'Kick',    note: 36, color: null },
  { name: 'Snare',   note: 38, color: null },
  { name: 'Hi-Hat',  note: 42, color: null },
  { name: 'Open HH', note: 46, color: null },
  { name: 'Low Tom', note: 41, color: null },
  { name: 'Mid Tom', note: 45, color: null },
  { name: 'Hi Tom',  note: 50, color: null },
  { name: 'Crash',   note: 49, color: null },
];

function triggerDrum(def, velocity, el) {
  const ctx = getAudio();
  const vel01 = velocity / 127;

  if (def.note === 36) {
    // Kick — pitched sine with fast pitch drop
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(180, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(vel01, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.4);
  } else if (def.note === 38) {
    // Snare — noise burst + tone
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.25, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src  = ctx.createBufferSource();
    const filt = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = buf;
    filt.type = 'bandpass'; filt.frequency.value = 3000; filt.Q.value = 0.7;
    gain.gain.setValueAtTime(vel01 * 0.7, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    src.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
    src.start();
  } else if (def.note === 42 || def.note === 46) {
    // Hi-hat — filtered noise
    const buf  = ctx.createBuffer(1, ctx.sampleRate * 0.3, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src  = ctx.createBufferSource();
    const filt = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = buf;
    filt.type = 'highpass'; filt.frequency.value = 7000;
    const dur = def.note === 46 ? 0.25 : 0.05;
    gain.gain.setValueAtTime(vel01 * 0.5, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    src.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
    src.start();
  } else {
    // Generic tom / cymbal — pitched noise
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    const pitchMap = { 41: 100, 45: 140, 50: 180, 49: 220 };
    osc.frequency.setValueAtTime(pitchMap[def.note] || 150, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.2);
    osc.type = 'sine';
    gain.gain.setValueAtTime(vel01 * 0.5, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.3);
  }

  sendMIDI(0x99, def.note, velocity); // channel 10

  // Visual flash
  el.classList.add('active');
  const bar = el.querySelector('.pad-vel-bar');
  if (bar) bar.style.width = (velocity / 127 * 100) + '%';
  setTimeout(() => {
    el.classList.remove('active');
    if (bar) bar.style.width = '0%';
  }, 120);

  updateVelDisplay(velocity);
}

// ── WEBSOCKET / RELAY ──────────────────────────
function connectWS(url) {
  if (state.ws) { try { state.ws.close(); } catch(e){} }
  wsLog(`Connecting to ${url}…`, 'msg');
  setLed('warning', 'CONNECTING');

  try {
    state.ws = new WebSocket(url);
    state.ws.onopen = () => {
      wsLog(`Connected ✓`, 'ok');
      setLed('connected', 'ONLINE');
      state.wsUrl = url;
      saveSettings();
    };
    state.ws.onclose = () => {
      wsLog('Connection closed.', 'err');
      setLed('error', 'OFFLINE');
    };
    state.ws.onerror = () => {
      wsLog('Connection error.', 'err');
      setLed('error', 'ERROR');
    };
    state.ws.onmessage = (e) => {
      wsLog(`← ${e.data}`, 'msg');
    };
  } catch(err) {
    wsLog(`Failed: ${err.message}`, 'err');
    setLed('error', 'ERROR');
  }
}

function sendMIDI(status, note, velocity) {
  const msg = { type: 'midi', data: [status | (state.channel - 1), note, velocity] };
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function setLed(cls, label) {
  const led = document.getElementById('relay-led');
  const lbl = document.getElementById('relay-label');
  led.className = 'led ' + cls;
  lbl.textContent = label;
}

function wsLog(msg, type) {
  const log = document.getElementById('ws-log');
  const span = document.createElement('span');
  span.className = 'log-' + type;
  span.textContent = msg + '\n';
  log.appendChild(span);
  log.scrollTop = log.scrollHeight;
}

// ── UI HELPERS ─────────────────────────────────
function updateVelDisplay(v) {
  document.getElementById('vel-readout').textContent = v;
  document.getElementById('vel-display-strip').textContent = v;
}

function updateOctaveDisplay() {
  document.getElementById('octave-display').textContent = state.octave;
  document.getElementById('oct-display-strip').textContent = state.octave;
  document.getElementById('ch-display').textContent = String(state.channel).padStart(2,'0');
}

// ── KEYBOARD BUILD ─────────────────────────────
const WHITE_PATTERN = [0,2,4,5,7,9,11]; // semitones that are white
const BLACK_OFFSETS = { 1:0, 3:1, 6:3, 8:4, 10:5 }; // semitone → which gap

function buildKeyboard() {
  const kb = document.getElementById('keyboard');
  kb.innerHTML = '';

  // 3 octaves
  const startOct = state.octave - 1;
  const endOct   = state.octave + 1;

  const whites = [];
  for (let o = startOct; o <= endOct; o++) {
    for (const semi of WHITE_PATTERN) {
      whites.push(o * 12 + semi + 12); // +12 because note 0 = C-1
    }
  }

  // White keys container
  const whiteContainer = document.createElement('div');
  whiteContainer.style.cssText = 'display:flex;height:100%;position:relative;';

  const keyEls = new Map();

  whites.forEach((note, i) => {
    const el = document.createElement('div');
    el.className = 'key white';
    const label = document.createElement('span');
    label.className = 'note-label';
    const nn = noteName(note);
    if (nn.startsWith('C')) label.textContent = nn;
    el.appendChild(label);
    attachKeyEvents(el, note, false);
    whiteContainer.appendChild(el);
    keyEls.set(note, el);
  });

  kb.appendChild(whiteContainer);

  // Black keys — positioned absolutely
  const KEY_W = 48;
  let wIdx = 0;
  for (let o = startOct; o <= endOct; o++) {
    for (let semi = 0; semi < 12; semi++) {
      const note = o * 12 + semi + 12;
      if (!WHITE_PATTERN.includes(semi)) {
        // find adjacent white key index
        const prevWhite = WHITE_PATTERN.filter(s => s < semi && s >= 0).pop();
        const prevWhiteNote = o * 12 + prevWhite + 12;
        const prevIdx = whites.indexOf(prevWhiteNote);
        if (prevIdx < 0) continue;

        const el = document.createElement('div');
        el.className = 'key black';
        el.style.left = (prevIdx * KEY_W + KEY_W - 14) + 'px';
        attachKeyEvents(el, note, true);
        kb.appendChild(el);
        keyEls.set(note, el);
      }
    }
    wIdx += 7;
  }

  // Store for active highlighting
  state.keyEls = keyEls;
}

function attachKeyEvents(el, note, isBlack) {
  // Touch
  el.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.changedTouches[0];
    const rect = el.getBoundingClientRect();
    const relY = (touch.clientY - rect.top) / rect.height;
    const vel = applyVelCurve(Math.max(0, Math.min(1, relY)));
    el.classList.add('active');
    el.style.setProperty('--vel', vel / 127);
    startNote(note, vel);
  }, { passive: false });

  el.addEventListener('touchend', (e) => {
    e.preventDefault();
    el.classList.remove('active');
    stopNote(note);
  }, { passive: false });

  // Mouse (desktop testing)
  el.addEventListener('mousedown', (e) => {
    const rect = el.getBoundingClientRect();
    const relY = (e.clientY - rect.top) / rect.height;
    const vel = applyVelCurve(Math.max(0, Math.min(1, relY)));
    el.classList.add('active');
    startNote(note, vel);
  });

  el.addEventListener('mouseup', () => {
    el.classList.remove('active');
    stopNote(note);
  });

  el.addEventListener('mouseleave', () => {
    if (el.classList.contains('active')) {
      el.classList.remove('active');
      stopNote(note);
    }
  });
}

// ── DRUM GRID BUILD ────────────────────────────
function buildDrumGrid() {
  const grid = document.getElementById('drum-panel');
  grid.innerHTML = '';

  DRUM_DEFS.forEach((def, i) => {
    const el = document.createElement('div');
    el.className = 'drum-pad';
    el.innerHTML = `
      <span class="pad-num">PAD ${i + 1}</span>
      <span class="pad-name">${def.name}</span>
      <span class="pad-note">${noteName(def.note)}</span>
      <div class="pad-vel-bar"></div>
    `;

    const fire = (e) => {
      e.preventDefault();
      getAudio(); // ensure unlocked
      let vel = 100;
      if (e.touches) {
        const touch = e.changedTouches[0];
        const rect = el.getBoundingClientRect();
        const relY = (touch.clientY - rect.top) / rect.height;
        vel = applyVelCurve(Math.max(0, Math.min(1, relY)));
      }
      triggerDrum(def, vel, el);
    };

    el.addEventListener('touchstart', fire, { passive: false });
    el.addEventListener('mousedown', fire);

    grid.appendChild(el);
  });
}

// ── SAMPLE RECORDER ────────────────────────────
let recInterval = null;

async function toggleRecord() {
  if (state.recording) {
    stopRecord();
  } else {
    await startRecord();
  }
}

async function startRecord() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.recChunks = [];
    state.mediaRecorder = new MediaRecorder(stream);
    state.mediaRecorder.ondataavailable = (e) => state.recChunks.push(e.data);
    state.mediaRecorder.onstop = finishRecord;
    state.mediaRecorder.start();
    state.recording = true;
    state.recStart = Date.now();
    document.getElementById('record-btn').classList.add('recording');
    document.getElementById('record-btn').innerHTML = '<span class="rec-dot"></span>Stop';
    recInterval = setInterval(updateRecTimer, 100);
  } catch(e) {
    alert('Microphone access denied.');
  }
}

function stopRecord() {
  if (state.mediaRecorder) state.mediaRecorder.stop();
  state.recording = false;
  clearInterval(recInterval);
  document.getElementById('record-btn').classList.remove('recording');
  document.getElementById('record-btn').innerHTML = '<span class="rec-dot"></span>Record';
  document.getElementById('rec-timer').textContent = '0:00';
}

function updateRecTimer() {
  const elapsed = (Date.now() - state.recStart) / 1000;
  const m = Math.floor(elapsed / 60);
  const s = Math.floor(elapsed % 60).toString().padStart(2, '0');
  document.getElementById('rec-timer').textContent = `${m}:${s}`;
}

function finishRecord() {
  const blob = new Blob(state.recChunks, { type: 'audio/webm' });
  const url = URL.createObjectURL(blob);
  const dur = (Date.now() - state.recStart) / 1000;
  const id = Date.now();
  const name = `Sample ${state.samples.length + 1}`;
  state.samples.push({ id, name, blob, url, duration: dur });
  saveSampleToDB({ id, name, blob, duration: dur });
  renderSampleList();
}

function renderSampleList() {
  const list = document.getElementById('sample-list');
  if (state.samples.length === 0) {
    list.innerHTML = '<div class="empty-state">No samples yet.<br>Record audio above.</div>';
    return;
  }
  list.innerHTML = '';
  state.samples.forEach(s => {
    const dur = s.duration.toFixed(1);
    const el = document.createElement('div');
    el.className = 'sample-item';
    el.innerHTML = `
      <span class="sample-item-name">${s.name}</span>
      <span class="sample-item-dur">${dur}s</span>
      <button class="btn-icon" title="Play" data-id="${s.id}">▶</button>
      <button class="btn-icon danger" title="Delete" data-del="${s.id}">✕</button>
    `;
    el.querySelector('[data-id]').addEventListener('click', () => playSample(s));
    el.querySelector('[data-del]').addEventListener('click', () => deleteSample(s.id));
    list.appendChild(el);
  });
}

function playSample(s) {
  const audio = new Audio(s.url);
  audio.play();
}

function deleteSample(id) {
  state.samples = state.samples.filter(s => s.id !== id);
  deleteSampleFromDB(id);
  renderSampleList();
}

// ── INDEXEDDB ──────────────────────────────────
let db = null;
function openDB() {
  const req = indexedDB.open('relay-samples', 1);
  req.onupgradeneeded = (e) => {
    const d = e.target.result;
    if (!d.objectStoreNames.contains('samples')) {
      d.createObjectStore('samples', { keyPath: 'id' });
    }
  };
  req.onsuccess = (e) => {
    db = e.target.result;
    loadSamplesFromDB();
  };
}

function saveSampleToDB(sample) {
  if (!db) return;
  const tx = db.transaction('samples', 'readwrite');
  tx.objectStore('samples').put(sample);
}

function loadSamplesFromDB() {
  if (!db) return;
  const tx = db.transaction('samples', 'readonly');
  const req = tx.objectStore('samples').getAll();
  req.onsuccess = (e) => {
    const rows = e.target.result || [];
    rows.forEach(row => {
      const url = URL.createObjectURL(row.blob);
      state.samples.push({ ...row, url });
    });
    renderSampleList();
  };
}

function deleteSampleFromDB(id) {
  if (!db) return;
  const tx = db.transaction('samples', 'readwrite');
  tx.objectStore('samples').delete(id);
}

// ── TAB SWITCHING ──────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(target + '-panel').classList.add('active');
    });
  });
}

// ── OCTAVE CONTROLS ────────────────────────────
function initOctaveControls() {
  document.getElementById('oct-down').addEventListener('click', () => {
    if (state.octave > 0) { state.octave--; saveSettings(); updateOctaveDisplay(); buildKeyboard(); }
  });
  document.getElementById('oct-up').addEventListener('click', () => {
    if (state.octave < 8) { state.octave++; saveSettings(); updateOctaveDisplay(); buildKeyboard(); }
  });
}

// ── SETTINGS CONTROLS ──────────────────────────
function initSettings() {
  const wsInput  = document.getElementById('ws-url-input');
  const wsBtn    = document.getElementById('ws-connect-btn');
  const chInput  = document.getElementById('channel-input');
  const vcSelect = document.getElementById('vel-curve');

  if (state.wsUrl) wsInput.value = state.wsUrl;
  chInput.value  = state.channel;
  vcSelect.value = state.velCurve;

  wsBtn.addEventListener('click', () => {
    const url = wsInput.value.trim();
    if (url) connectWS(url);
  });

  chInput.addEventListener('change', () => {
    state.channel = Math.max(1, Math.min(16, parseInt(chInput.value) || 1));
    chInput.value = state.channel;
    saveSettings();
    updateOctaveDisplay();
  });

  vcSelect.addEventListener('change', () => {
    state.velCurve = vcSelect.value;
    saveSettings();
  });

  document.getElementById('record-btn').addEventListener('click', toggleRecord);
}

// ── KEYBOARD POLYPHONY (multi-touch) ───────────
// Handled per-element; global touchcancel cleanup
document.addEventListener('touchcancel', () => {
  state.activeKeys.forEach((v, note) => stopNote(note));
});

// ── INIT ───────────────────────────────────────
function init() {
  loadSettings();
  initTabs();
  initOctaveControls();
  initSettings();
  buildKeyboard();
  buildDrumGrid();
  openDB();
  updateOctaveDisplay();

  // Unlock audio on first interaction
  document.addEventListener('touchstart', () => getAudio(), { once: true });
  document.addEventListener('mousedown',  () => getAudio(), { once: true });
}

init();
