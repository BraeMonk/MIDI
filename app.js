/* ─────────────────────────────────────────────
   RELAY — MIDI Controller PWA  ·  app.js v0.2.0
   ───────────────────────────────────────────── */

'use strict';

// ── AUDIO CONTEXT ──────────────────────────────
let audioCtx = null;
function getAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Master bus — every live sound source (synths, drums, amp) routes here.
    // The looper taps this bus to record performances in layers.
    state.masterGain = audioCtx.createGain();
    state.masterGain.gain.value = 1;
    state.masterGain.connect(audioCtx.destination);
    state.loopTapNode = audioCtx.createMediaStreamDestination();
    state.masterGain.connect(state.loopTapNode);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// ── MIDI NOTE MATH ─────────────────────────────
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function noteName(n)  { return NOTE_NAMES[n % 12] + Math.floor(n / 12 - 1); }
function noteFreq(n)  { return 440 * Math.pow(2, (n - 69) / 12); }

// ── SCALE DEFINITIONS ──────────────────────────
const SCALES = {
  none:  null,
  major: [0,2,4,5,7,9,11],
  minor: [0,2,3,5,7,8,10],
  penta: [0,2,4,7,9],
  blues: [0,3,5,6,7,10],
  dorian:[0,2,3,5,7,9,10],
};
const NOTE_ROOT_MAP = { C:0,'C#':1,D:2,'D#':3,E:4,F:5,'F#':6,G:7,'G#':8,A:9,'A#':10,B:11 };

// ── CHORD DEFINITIONS ──────────────────────────
const CHORD_INTERVALS = {
  maj:  [0,4,7],
  min:  [0,3,7],
  '7':  [0,4,7,10],
  maj7: [0,4,7,11],
  sus2: [0,2,7],
  sus4: [0,5,7],
};

// ── STATE ──────────────────────────────────────
const state = {
  octave:    4,
  channel:   1,
  velCurve:  'linear',
  transpose: 0,
  showLabels: true,
  synthType: 'lead',
  scaleRoot: 'C',
  scaleType: 'none',
  chordMode: false,
  chordType: 'maj',
  ws:        null,
  wsUrl:     localStorage.getItem('relay-ws-url') || '',
  activeKeys: new Map(),   // note → { nodes… }
  recording:  false,
  recStart:   null,
  mediaRecorder: null,
  recChunks:  [],
  samples:    [],          // {id, name, blob, url, duration}
  // drum pad assignment: index → { note, sample? }
  padDefs: [
    { name:'Kick',    note:36, color:'amber'  },
    { name:'Snare',   note:38, color:'teal'   },
    { name:'Hi-Hat',  note:42, color:'purple' },
    { name:'Open HH', note:46, color:'teal'   },
    { name:'Low Tom', note:41, color:null      },
    { name:'Mid Tom', note:45, color:null      },
    { name:'Hi Tom',  note:50, color:null      },
    { name:'Crash',   note:49, color:'danger'  },
  ],
  kitName: 'classic',
  tapTimes: [],
  keyEls: new Map(),
  // assign modal state
  assignSampleId: null,
  assignPadIndex: null,
};

// ── KIT DEFINITIONS ────────────────────────────
const KITS = {
  classic:    [36,38,42,46,41,45,50,49],
  electronic: [36,40,42,46,37,43,48,55],
  hiphop:     [35,38,44,46,41,43,50,49],
  acoustic:   [36,38,42,46,41,45,50,57],
};
const KIT_NAMES = {
  classic:    ['Kick','Snare','Hi-Hat','Open HH','Low Tom','Mid Tom','Hi Tom','Crash'],
  electronic: ['Kick','Snare','HH Cl.','HH Op.','Rim','Mid Tom','Hi Tom','Cowbell'],
  hiphop:     ['Kick','Snare','HH Cl.','HH Op.','Low Tom','Mid Tom','Hi Tom','Crash'],
  acoustic:   ['Kick','Snare','HH Cl.','HH Op.','Low Tom','Mid Tom','Hi Tom','Ride'],
};

function applyKit(kitName) {
  state.kitName = kitName;
  const notes = KITS[kitName] || KITS.classic;
  const names = KIT_NAMES[kitName] || KIT_NAMES.classic;
  const colors = ['amber','teal','purple','teal',null,null,null,'danger'];
  state.padDefs = names.map((name, i) => ({ name, note: notes[i], color: colors[i] || null }));
  buildDrumGrid();
  buildPadAssignmentList();
}

// ── SETTINGS PERSISTENCE ───────────────────────
function loadSettings() {
  const ch  = localStorage.getItem('relay-channel');   if (ch)  state.channel   = parseInt(ch);
  const vc  = localStorage.getItem('relay-vel-curve'); if (vc)  state.velCurve  = vc;
  const oct = localStorage.getItem('relay-octave');    if (oct) state.octave     = parseInt(oct);
  const tr  = localStorage.getItem('relay-transpose'); if (tr)  state.transpose  = parseInt(tr);
  const sl  = localStorage.getItem('relay-show-labels');
  if (sl !== null) state.showLabels = sl === 'true';
}
function saveSettings() {
  localStorage.setItem('relay-channel',     state.channel);
  localStorage.setItem('relay-vel-curve',   state.velCurve);
  localStorage.setItem('relay-octave',      state.octave);
  localStorage.setItem('relay-transpose',   state.transpose);
  localStorage.setItem('relay-show-labels', state.showLabels);
  if (state.wsUrl) localStorage.setItem('relay-ws-url', state.wsUrl);
}

// ── VELOCITY CURVE ─────────────────────────────
function applyVelCurve(raw /* 0–1 */) {
  if (state.velCurve === 'fixed') return 100;
  let v;
  switch (state.velCurve) {
    case 'exp': v = Math.pow(raw, 2); break;
    case 'log': v = Math.sqrt(raw);   break;
    default:    v = raw;
  }
  return Math.max(1, Math.min(127, Math.round(v * 126 + 1)));
}

// ── SYNTH VOICE ────────────────────────────────
function buildSynthVoice(ctx, freq, vel01, type) {
  const gain   = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';

  let osc, osc2;

  switch (type) {
    case 'pad': {
      osc  = ctx.createOscillator(); osc.type  = 'sine';
      osc2 = ctx.createOscillator(); osc2.type = 'triangle';
      osc.frequency.value  = freq;
      osc2.frequency.value = freq * 0.998;
      filter.frequency.value = 600 + vel01 * 1200;
      filter.Q.value = 0.8;
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(vel01 * 0.3, ctx.currentTime + 0.08);
      break;
    }
    case 'bass': {
      osc  = ctx.createOscillator(); osc.type  = 'sawtooth';
      osc2 = ctx.createOscillator(); osc2.type = 'square';
      osc.frequency.value  = freq;
      osc2.frequency.value = freq * 2;
      filter.frequency.value = 300 + vel01 * 800;
      filter.Q.value = 2;
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(vel01 * 0.4, ctx.currentTime + 0.01);
      break;
    }
    case 'keys': {
      osc  = ctx.createOscillator(); osc.type  = 'triangle';
      osc2 = ctx.createOscillator(); osc2.type = 'sine';
      osc.frequency.value  = freq;
      osc2.frequency.value = freq * 2.001;
      filter.frequency.value = 2000 + vel01 * 4000;
      filter.Q.value = 0.5;
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(vel01 * 0.28, ctx.currentTime + 0.003);
      break;
    }
    default: /* lead */ {
      osc  = ctx.createOscillator(); osc.type  = 'sawtooth';
      osc2 = ctx.createOscillator(); osc2.type = 'triangle';
      osc.frequency.value  = freq;
      osc2.frequency.value = freq * 1.003;
      filter.frequency.value = 800 + vel01 * 3000;
      filter.Q.value = 1.2;
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(vel01 * 0.35, ctx.currentTime + 0.005);
    }
  }

  osc.connect(filter);
  osc2.connect(filter);
  filter.connect(gain);
  gain.connect(state.masterGain);

  osc.start();
  osc2.start();

  return { osc, osc2, filter, gain };
}

function startNote(note, velocity) {
  if (state.activeKeys.has(note)) return;
  const ctx    = getAudio();
  const tNote  = note + state.transpose;
  const freq   = noteFreq(Math.max(0, Math.min(127, tNote)));
  const vel01  = velocity / 127;

  const voice = buildSynthVoice(ctx, freq, vel01, state.synthType);
  state.activeKeys.set(note, voice);

  sendMIDI(0x90, Math.max(0, Math.min(127, tNote)), velocity);
  updateVelDisplay(velocity);

  // Highlight key element
  const el = state.keyEls.get(note);
  if (el) el.classList.add('active');
}

function startChord(rootNote, velocity) {
  const intervals = CHORD_INTERVALS[state.chordType] || [0];
  intervals.forEach(interval => startNote(rootNote + interval, velocity));
}

function stopNote(note) {
  const v = state.activeKeys.get(note);
  if (!v) return;
  const ctx = getAudio();
  v.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
  setTimeout(() => { try { v.osc.stop(); v.osc2.stop(); } catch(e){} }, 300);
  state.activeKeys.delete(note);

  const tNote = note + state.transpose;
  sendMIDI(0x80, Math.max(0, Math.min(127, tNote)), 0);

  const el = state.keyEls.get(note);
  if (el) el.classList.remove('active');
}

function stopChord(rootNote) {
  const intervals = CHORD_INTERVALS[state.chordType] || [0];
  intervals.forEach(interval => stopNote(rootNote + interval));
}

// ── PANIC ──────────────────────────────────────
function panicAllNotes() {
  state.activeKeys.forEach((_, note) => stopNote(note));
  // Send MIDI all-notes-off on all channels
  for (let ch = 0; ch < 16; ch++) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'midi', data: [0xB0 | ch, 123, 0] }));
    }
  }
}

// ── DRUM SYNTH ─────────────────────────────────
function triggerDrum(def, velocity, el) {
  const ctx   = getAudio();
  const vel01 = velocity / 127;

  if (def.note === 36 || def.note === 35) {
    // Kick
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(180, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(vel01, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain); gain.connect(state.masterGain);
    osc.start(); osc.stop(ctx.currentTime + 0.4);
  } else if (def.note === 38 || def.note === 40) {
    // Snare
    const buf  = ctx.createBuffer(1, ctx.sampleRate * 0.25, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src  = ctx.createBufferSource();
    const filt = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = buf;
    filt.type = 'bandpass'; filt.frequency.value = 3000; filt.Q.value = 0.7;
    gain.gain.setValueAtTime(vel01 * 0.7, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    src.connect(filt); filt.connect(gain); gain.connect(state.masterGain);
    src.start();
  } else if ([42, 44, 46].includes(def.note)) {
    // Hi-hat
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
    src.connect(filt); filt.connect(gain); gain.connect(state.masterGain);
    src.start();
  } else if (def.note === 37) {
    // Rim / sidestick
    const buf  = ctx.createBuffer(1, ctx.sampleRate * 0.08, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src  = ctx.createBufferSource();
    const filt = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = buf;
    filt.type = 'bandpass'; filt.frequency.value = 1800; filt.Q.value = 2;
    gain.gain.setValueAtTime(vel01 * 0.6, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.07);
    src.connect(filt); filt.connect(gain); gain.connect(state.masterGain);
    src.start();
  } else if (def.note === 55) {
    // Cowbell
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 562;
    gain.gain.setValueAtTime(vel01 * 0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
    osc.connect(gain); gain.connect(state.masterGain);
    osc.start(); osc.stop(ctx.currentTime + 0.45);
  } else {
    // Toms / ride / crash — pitched sine
    const pitchMap = { 41:100, 43:120, 45:140, 48:170, 50:200, 49:220, 57:300 };
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(pitchMap[def.note] || 150, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.25);
    gain.gain.setValueAtTime(vel01 * 0.5, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.connect(gain); gain.connect(state.masterGain);
    osc.start(); osc.stop(ctx.currentTime + 0.35);
  }

  sendMIDI(0x99, def.note, velocity); // ch 10

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
      wsLog('Connected ✓', 'ok');
      setLed('connected', 'ONLINE');
      state.wsUrl = url;
      saveSettings();
    };
    state.ws.onclose = () => { wsLog('Connection closed.', 'err'); setLed('error', 'OFFLINE'); };
    state.ws.onerror = () => { wsLog('Connection error.',  'err'); setLed('error', 'ERROR');   };
    state.ws.onmessage = (e) => wsLog(`← ${e.data}`, 'msg');
  } catch(err) {
    wsLog(`Failed: ${err.message}`, 'err');
    setLed('error', 'ERROR');
  }
}

function sendMIDI(status, note, velocity) {
  const msg = { type:'midi', data:[(status & 0xF0) | (state.channel - 1), note, velocity] };
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function setLed(cls, label) {
  document.getElementById('relay-led').className = 'led ' + cls;
  document.getElementById('relay-label').textContent = label;
}

function wsLog(msg, type) {
  const log  = document.getElementById('ws-log');
  const span = document.createElement('span');
  span.className = 'log-' + type;
  span.textContent = msg + '\n';
  log.appendChild(span);
  log.scrollTop = log.scrollHeight;
}

// ── UI HELPERS ─────────────────────────────────
function updateVelDisplay(v) {
  const el = document.getElementById('hdr-vel');
  if (el) { el.textContent = v; el.classList.remove('dim'); }
}

function updateOctaveDisplay() {
  const octDisp = document.getElementById('oct-display');
  const hdrOct  = document.getElementById('hdr-oct');
  const hdrCh   = document.getElementById('hdr-ch');
  if (octDisp) octDisp.textContent = state.octave;
  if (hdrOct)  hdrOct.textContent  = state.octave;
  if (hdrCh)   hdrCh.textContent   = String(state.channel).padStart(2, '0');
}

// ── SCALE HELPERS ──────────────────────────────
function isInScale(note) {
  const intervals = SCALES[state.scaleType];
  if (!intervals) return true;
  const root = NOTE_ROOT_MAP[state.scaleRoot] ?? 0;
  return intervals.includes((note - root + 120) % 12);
}

// ── KEYBOARD BUILD ─────────────────────────────
const WHITE_PATTERN = [0,2,4,5,7,9,11];
const KEY_W = 52; // must match CSS .key.white width

function buildKeyboard() {
  const kb = document.getElementById('keyboard');
  kb.innerHTML = '';

  const startOct = state.octave - 1;
  const endOct   = state.octave + 1;

  const whites = [];
  for (let o = startOct; o <= endOct; o++) {
    for (const semi of WHITE_PATTERN) {
      whites.push(o * 12 + semi + 12);
    }
  }

  const whiteContainer = document.createElement('div');
  whiteContainer.id = 'keyboard-white';

  const keyEls = new Map();

  whites.forEach(note => {
    const el    = document.createElement('div');
    el.className = 'key white';
    if (!isInScale(note)) el.classList.add('out-of-scale');

    const label = document.createElement('span');
    label.className = 'note-label';
    const nn = noteName(note);
    if (state.showLabels && nn.startsWith('C')) label.textContent = nn;
    el.appendChild(label);

    attachKeyEvents(el, note, false);
    whiteContainer.appendChild(el);
    keyEls.set(note, el);
  });

  kb.appendChild(whiteContainer);

  // Black keys — absolutely positioned over white container
  for (let o = startOct; o <= endOct; o++) {
    for (let semi = 0; semi < 12; semi++) {
      if (WHITE_PATTERN.includes(semi)) continue;
      const note = o * 12 + semi + 12;
      const prevSemi = WHITE_PATTERN.filter(s => s < semi).pop();
      if (prevSemi === undefined) continue;
      const prevNote = o * 12 + prevSemi + 12;
      const prevIdx  = whites.indexOf(prevNote);
      if (prevIdx < 0) continue;

      const el = document.createElement('div');
      el.className = 'key black';
      if (!isInScale(note)) el.classList.add('out-of-scale');
      el.style.left = (prevIdx * KEY_W + KEY_W - 15) + 'px';
      attachKeyEvents(el, note, true);
      kb.appendChild(el);
      keyEls.set(note, el);
    }
  }

  state.keyEls = keyEls;
}

function attachKeyEvents(el, note, isBlack) {
  const onPress = (e) => {
    e.preventDefault();
    let relY = 0.5;
    if (e.touches) {
      const t = e.changedTouches[0];
      const r = el.getBoundingClientRect();
      relY = (t.clientY - r.top) / r.height;
    } else {
      const r = el.getBoundingClientRect();
      relY = (e.clientY - r.top) / r.height;
    }
    const vel = applyVelCurve(Math.max(0, Math.min(1, relY)));
    if (state.chordMode) {
      startChord(note, vel);
    } else {
      startNote(note, vel);
    }
  };

  const onRelease = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (state.chordMode) {
      stopChord(note);
    } else {
      stopNote(note);
    }
  };

  el.addEventListener('touchstart',  onPress,   { passive: false });
  el.addEventListener('touchend',    onRelease, { passive: false });
  el.addEventListener('touchcancel', onRelease, { passive: false });
  el.addEventListener('mousedown',   onPress);
  el.addEventListener('mouseup',     onRelease);
  el.addEventListener('mouseleave',  (e) => { if (el.classList.contains('active')) onRelease(e); });
}

// ── DRUM GRID BUILD ────────────────────────────
function buildDrumGrid() {
  const grid = document.getElementById('drum-grid');
  if (!grid) return;
  grid.innerHTML = '';

  state.padDefs.forEach((def, i) => {
    const el = document.createElement('div');
    el.className = 'pad';
    if (def.color) el.dataset.color = def.color;
    el.innerHTML = `
      <span class="pad-num">PAD ${i + 1}</span>
      <span class="pad-name">${def.name}</span>
      <span class="pad-note">${noteName(def.note)}</span>
      <div class="pad-vel-bar"></div>
    `;

    const fire = (e) => {
      e.preventDefault();
      getAudio();
      let vel = 100;
      if (e.touches) {
        const touch = e.changedTouches[0];
        const rect  = el.getBoundingClientRect();
        const relY  = (touch.clientY - rect.top) / rect.height;
        vel = applyVelCurve(Math.max(0, Math.min(1, relY)));
      } else {
        const rect = el.getBoundingClientRect();
        const relY = (e.clientY - rect.top) / rect.height;
        vel = applyVelCurve(Math.max(0, Math.min(1, relY)));
      }
      triggerDrum(def, vel, el);
    };

    el.addEventListener('touchstart', fire, { passive: false });
    el.addEventListener('mousedown',  fire);
    grid.appendChild(el);
  });
}

// ── TAP TEMPO ──────────────────────────────────
function tapTempo() {
  const now = Date.now();
  state.tapTimes.push(now);
  if (state.tapTimes.length > 8) state.tapTimes.shift();
  if (state.tapTimes.length < 2) return;
  const diffs = [];
  for (let i = 1; i < state.tapTimes.length; i++) {
    diffs.push(state.tapTimes[i] - state.tapTimes[i - 1]);
  }
  // Discard outliers (>2s gap = restart)
  if (diffs[diffs.length - 1] > 2000) { state.tapTimes = [now]; return; }
  const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const bpm = Math.round(60000 / avg);
  document.getElementById('bpm-display').textContent = `${bpm} BPM`;
}

// ── SAMPLE RECORDER ────────────────────────────
let recInterval = null;

async function toggleRecord() {
  if (state.recording) stopRecord();
  else await startRecord();
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
    state.recStart  = Date.now();
    const btn = document.getElementById('record-btn');
    btn.classList.add('recording');
    btn.innerHTML = '<span class="rec-dot"></span>Stop';
    recInterval = setInterval(updateRecTimer, 100);
  } catch(e) {
    alert('Microphone access denied.');
  }
}

function stopRecord() {
  if (state.mediaRecorder) state.mediaRecorder.stop();
  state.recording = false;
  clearInterval(recInterval);
  const btn = document.getElementById('record-btn');
  btn.classList.remove('recording');
  btn.innerHTML = '<span class="rec-dot"></span>Record';
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
  const url  = URL.createObjectURL(blob);
  const dur  = (Date.now() - state.recStart) / 1000;
  const id   = Date.now();
  const name = `Sample ${state.samples.length + 1}`;
  state.samples.push({ id, name, blob, url, duration: dur });
  saveSampleToDB({ id, name, blob, duration: dur });
  renderSampleList();
}

function renderSampleList() {
  const list = document.getElementById('sample-list');
  if (!list) return;
  if (state.samples.length === 0) {
    list.innerHTML = '<div class="empty-state">No samples yet.<br>Hit Record above, then assign to a pad.</div>';
    return;
  }
  list.innerHTML = '';
  state.samples.forEach(s => {
    const dur = s.duration.toFixed(1);
    const el  = document.createElement('div');
    el.className = 'sample-item';
    el.innerHTML = `
      <div class="sample-info">
        <span class="sample-name">${s.name}</span>
        <span class="sample-meta">${dur}s · webm</span>
      </div>
      <button class="sample-assign" data-assign="${s.id}">Assign</button>
      <button class="btn-icon" title="Play" data-play="${s.id}">▶</button>
      <button class="btn-icon danger" title="Delete" data-del="${s.id}">✕</button>
    `;
    el.querySelector('[data-play]').addEventListener('click', () => playSample(s));
    el.querySelector('[data-del]').addEventListener('click',  () => deleteSample(s.id));
    el.querySelector('[data-assign]').addEventListener('click', () => openAssignModal(s.id));
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

// ── ASSIGN MODAL ───────────────────────────────
function openAssignModal(sampleId) {
  state.assignSampleId = sampleId;
  state.assignPadIndex = null;
  const sample = state.samples.find(s => s.id === sampleId);
  document.getElementById('assign-sample-name').textContent = sample ? sample.name : '';

  const grid = document.getElementById('pad-pick-grid');
  grid.innerHTML = '';
  state.padDefs.forEach((def, i) => {
    const btn = document.createElement('div');
    btn.className = 'pad-pick';
    btn.innerHTML = `PAD ${i+1}<div class="pad-pick-name">${def.name}</div>`;
    btn.addEventListener('click', () => {
      grid.querySelectorAll('.pad-pick').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.assignPadIndex = i;
    });
    grid.appendChild(btn);
  });

  document.getElementById('assign-modal').classList.add('open');
}

function closeAssignModal() {
  document.getElementById('assign-modal').classList.remove('open');
  state.assignSampleId = null;
  state.assignPadIndex = null;
}

function confirmAssign() {
  if (state.assignPadIndex === null || state.assignSampleId === null) { closeAssignModal(); return; }
  // Store assignment — note: actual sample-triggered pads can be extended here
  state.padDefs[state.assignPadIndex].sampleId = state.assignSampleId;
  closeAssignModal();
  buildPadAssignmentList();
}

// ── PAD ASSIGNMENT CONFIG LIST ─────────────────
function buildPadAssignmentList() {
  const container = document.getElementById('pad-assignment-list');
  if (!container) return;
  container.innerHTML = '';
  state.padDefs.forEach((def, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
    const label = document.createElement('span');
    label.style.cssText = 'font-size:11px;color:var(--text-mid);';
    label.textContent = `PAD ${i+1} — ${def.name}`;
    const noteInput = document.createElement('input');
    noteInput.type = 'number'; noteInput.min = 0; noteInput.max = 127;
    noteInput.value = def.note;
    noteInput.style.width = '64px';
    noteInput.addEventListener('change', () => {
      const n = Math.max(0, Math.min(127, parseInt(noteInput.value) || def.note));
      def.note = n;
      noteInput.value = n;
      buildDrumGrid();
    });
    row.appendChild(label);
    row.appendChild(noteInput);
    container.appendChild(row);
  });
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
  const tx  = db.transaction('samples', 'readonly');
  const req = tx.objectStore('samples').getAll();
  req.onsuccess = (e) => {
    (e.target.result || []).forEach(row => {
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
      document.querySelectorAll('.tab').forEach(t  => t.classList.remove('active'));
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

// ── PIANO TOOLBAR ──────────────────────────────
function initPianoToolbar() {
  // Synth type pills
  document.querySelectorAll('#synth-type-group .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#synth-type-group .pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.synthType = btn.dataset.type;
    });
  });

  // Scale root
  document.getElementById('scale-root').addEventListener('change', (e) => {
    state.scaleRoot = e.target.value;
    buildKeyboard();
  });

  // Scale type
  document.getElementById('scale-type').addEventListener('change', (e) => {
    state.scaleType = e.target.value;
    buildKeyboard();
  });

  // Chord mode toggle
  const chordBtn = document.getElementById('chord-btn');
  chordBtn.addEventListener('click', () => {
    state.chordMode = !state.chordMode;
    chordBtn.classList.toggle('active', state.chordMode);
    chordBtn.dataset.mode = state.chordMode ? 'on' : 'off';
  });

  // Chord type
  document.getElementById('chord-type').addEventListener('change', (e) => {
    state.chordType = e.target.value;
  });
}

// ── DRUM TOOLBAR ───────────────────────────────
function initDrumToolbar() {
  document.querySelectorAll('#kit-group .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#kit-group .pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyKit(btn.dataset.kit);
    });
  });

  document.getElementById('tap-btn').addEventListener('click', tapTempo);
}

// ── CONFIG / SETTINGS ──────────────────────────
function initSettings() {
  // WebSocket
  const wsInput = document.getElementById('ws-url-input');
  const wsBtn   = document.getElementById('ws-connect-btn');
  if (state.wsUrl) wsInput.value = state.wsUrl;
  wsBtn.addEventListener('click', () => {
    const url = wsInput.value.trim();
    if (url) connectWS(url);
  });

  // Channel
  const chInput = document.getElementById('channel-input');
  chInput.value = state.channel;
  chInput.addEventListener('change', () => {
    state.channel = Math.max(1, Math.min(16, parseInt(chInput.value) || 1));
    chInput.value = state.channel;
    saveSettings();
    updateOctaveDisplay();
  });

  // Velocity curve
  const vcSelect = document.getElementById('vel-curve');
  vcSelect.value = state.velCurve;
  vcSelect.addEventListener('change', () => {
    state.velCurve = vcSelect.value;
    saveSettings();
  });

  // Transpose
  const trInput = document.getElementById('transpose-input');
  trInput.value = state.transpose;
  trInput.addEventListener('change', () => {
    state.transpose = Math.max(-12, Math.min(12, parseInt(trInput.value) || 0));
    trInput.value   = state.transpose;
    saveSettings();
  });

  // Note labels toggle
  const labelsToggle = document.getElementById('labels-toggle');
  labelsToggle.classList.toggle('on', state.showLabels);
  labelsToggle.addEventListener('click', () => {
    state.showLabels = !state.showLabels;
    labelsToggle.classList.toggle('on', state.showLabels);
    saveSettings();
    buildKeyboard();
  });

  // Record button
  document.getElementById('record-btn').addEventListener('click', toggleRecord);

  // Panic button
  document.getElementById('panic-btn').addEventListener('click', panicAllNotes);
}

// ── ASSIGN MODAL WIRING ────────────────────────
function initAssignModal() {
  document.getElementById('assign-cancel').addEventListener('click',  closeAssignModal);
  document.getElementById('assign-confirm').addEventListener('click', confirmAssign);
  document.getElementById('assign-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeAssignModal();
  });
}

// ── TOUCH CANCEL CLEANUP ───────────────────────
document.addEventListener('touchcancel', () => {
  state.activeKeys.forEach((_, note) => stopNote(note));
});

// ── INIT ───────────────────────────────────────
function init() {
  loadSettings();
  initTabs();
  initOctaveControls();
  initPianoToolbar();
  initDrumToolbar();
  initSettings();
  initAssignModal();
  buildKeyboard();
  buildDrumGrid();
  buildPadAssignmentList();
  openDB();
  updateOctaveDisplay();
  if (window.initAmp)    window.initAmp();
  if (window.initLooper) window.initLooper();

  document.addEventListener('touchstart', () => getAudio(), { once: true });
  document.addEventListener('mousedown',  () => getAudio(), { once: true });
}

init();
