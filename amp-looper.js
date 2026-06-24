/* ─────────────────────────────────────────────
   RELAY — Guitar Amp + Layered Looper module
   Depends on app.js: `state`, `getAudio()`
   Routes: instrument sources → state.masterGain → speakers
                                              └────→ state.loopTapNode (looper records THIS)
   ───────────────────────────────────────────── */

'use strict';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/* ============================================================
   GUITAR AMP
   ============================================================ */

const IDENTITY_CURVE = new Float32Array([-1, 1]); // waveshaper pass-through

const AMP_VOICES = {
  clean:    { driveCurve: 'soft', driveMul: 0.5, bass: 1,  mid: 0,  treble: 2,  cabFreq: 3400, preGain: 0.9 },
  crunch:   { driveCurve: 'soft', driveMul: 1.4, bass: 2,  mid: 3,  treble: 1,  cabFreq: 2800, preGain: 1.15 },
  lead:     { driveCurve: 'hard', driveMul: 2.2, bass: 1,  mid: 4,  treble: 3,  cabFreq: 2600, preGain: 1.4 },
  metal:    { driveCurve: 'hard', driveMul: 3.4, bass: 3,  mid: -2, treble: 4,  cabFreq: 2300, preGain: 1.8 },
  bass:     { driveCurve: 'soft', driveMul: 0.6, bass: 6,  mid: 1,  treble: -3, cabFreq: 1500, preGain: 0.95 },
  acoustic: { driveCurve: 'soft', driveMul: 0.08,bass: 1,  mid: 2,  treble: 4,  cabFreq: 5200, preGain: 0.75 },
};

state.amp = {
  on: false,
  voice: 'clean',
  drive: 35,
  bass: 0,
  mid: 0,
  treble: 0,
  volume: 80,
  cabOn: true,
  gateOn: true,
  stream: null,
  sourceNode: null,
  nodes: null,
  deviceId: null,
};

function makeDistortionCurve(amount, type) {
  const n = 4096;
  const curve = new Float32Array(n);
  const k = Math.max(0.0001, amount);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = type === 'hard'
      ? Math.tanh(x * (1 + k * 7)) * 1.05   // sharper, more harmonics
      : Math.tanh(x * (1 + k * 3));         // smoother saturation
  }
  return curve;
}

function makeGateCurve(threshold) {
  const n = 4096;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    const ax = Math.abs(x);
    if (ax < threshold) {
      curve[i] = x * (ax / threshold) * (ax / threshold); // soft knee toward 0
    } else {
      curve[i] = x;
    }
  }
  return curve;
}

function buildAmpChain(ctx) {
  const input   = ctx.createGain();
  const gate    = ctx.createWaveShaper();
  gate.curve = IDENTITY_CURVE;
  const preGain = ctx.createGain();
  const shaper  = ctx.createWaveShaper();
  shaper.oversample = '4x';
  const bassF   = ctx.createBiquadFilter(); bassF.type   = 'lowshelf';   bassF.frequency.value   = 120;
  const midF    = ctx.createBiquadFilter(); midF.type    = 'peaking';    midF.frequency.value    = 800; midF.Q.value = 0.8;
  const trebleF = ctx.createBiquadFilter(); trebleF.type = 'highshelf';  trebleF.frequency.value = 3000;
  const cabHP   = ctx.createBiquadFilter(); cabHP.type   = 'highpass';   cabHP.frequency.value   = 90;  cabHP.Q.value = 0.7;
  const cab     = ctx.createBiquadFilter(); cab.type     = 'lowpass';    cab.Q.value = 0.8;
  const outGain = ctx.createGain(); outGain.gain.value = 0;

  input.connect(gate);
  gate.connect(preGain);
  preGain.connect(shaper);
  shaper.connect(bassF);
  bassF.connect(midF);
  midF.connect(trebleF);
  trebleF.connect(cabHP);
  cabHP.connect(cab);
  cab.connect(outGain);
  outGain.connect(state.masterGain); // joins the bus the looper taps

  return { input, gate, preGain, shaper, bassF, midF, trebleF, cab, cabHP, outGain };
}

async function refreshAmpInputDevices() {
  try {
    if (!state._micPermAsked) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
        state._micPermAsked = true;
      } catch (permErr) {
        ampLog('Mic permission denied or blocked: ' + permErr.message, 'err');
        ampLog('Check Settings → Safari → Microphone, or the site permission icon in the address bar.', 'msg');
        return; // don't bother enumerating — labels will be blank anyway
      }
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs  = devices.filter(d => d.kind === 'audioinput');
    const sel = document.getElementById('amp-input-select');
    if (!sel) return;
    sel.innerHTML = '';
    if (inputs.length === 0) {
      sel.innerHTML = '<option value="">No audio inputs found</option>';
      ampLog('No audio inputs detected by the browser.', 'err');
      return;
    }
    inputs.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Input ${i + 1}`;
      sel.appendChild(opt);
    });
    ampLog(`Found ${inputs.length} input device(s).`, 'ok');
    const usbMatch = inputs.find(d => /usb|interface|audio/i.test(d.label));
    if (usbMatch) sel.value = usbMatch.deviceId;
  } catch (err) {
    ampLog('Could not list devices: ' + err.message, 'err');
  }
}

async function connectAmpInput(deviceId) {
  try {
    const ctx = getAudio();
    if (state.amp.stream) state.amp.stream.getTracks().forEach(t => t.stop());

    // echoCancellation/noiseSuppression/AGC are tuned for voice calls and
    // actively damage instrument signal — keep them off for guitar input.
    const constraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 1 },
      }
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.amp.stream   = stream;
    state.amp.deviceId = deviceId || null;

    if (state.amp.sourceNode) { try { state.amp.sourceNode.disconnect(); } catch (e) {} }
    state.amp.sourceNode = ctx.createMediaStreamSource(stream);
    if (!state.amp.nodes) state.amp.nodes = buildAmpChain(ctx);
    state.amp.sourceNode.connect(state.amp.nodes.input);

    const track = stream.getAudioTracks()[0];
    ampLog(`Connected: ${track ? track.label : 'audio input'} ✓`, 'ok');
    setAmpPower(true);
  } catch (err) {
    ampLog('Input error: ' + err.message, 'err');
  }
}

function setAmpPower(on) {
  state.amp.on = on;
  const btn = document.getElementById('amp-power-btn');
  if (btn) {
    btn.dataset.on = on ? 'on' : 'off';
    btn.textContent = on ? '⏻ On' : '⏻ Off';
    btn.classList.toggle('active', on);
  }
  updateAmpParams();
}

function updateAmpParams() {
  if (!state.amp.nodes) return;
  const preset = AMP_VOICES[state.amp.voice] || AMP_VOICES.clean;
  const { gate, shaper, bassF, midF, trebleF, cab, outGain, preGain } = state.amp.nodes;

  const driveAmt = (state.amp.drive / 100) * preset.driveMul;
  shaper.curve = makeDistortionCurve(driveAmt, preset.driveCurve);
  preGain.gain.value = preset.preGain * (0.6 + driveAmt * 0.5);

  gate.curve = state.amp.gateOn ? makeGateCurve(0.012) : IDENTITY_CURVE;

  bassF.gain.value   = clamp(state.amp.bass   + preset.bass,   -15, 15);
  midF.gain.value    = clamp(state.amp.mid    + preset.mid,    -15, 15);
  trebleF.gain.value = clamp(state.amp.treble + preset.treble, -15, 15);

  cab.frequency.value = state.amp.cabOn ? preset.cabFreq : 19000;
  cab.Q.value          = state.amp.cabOn ? 0.9 : 0.3;

  outGain.gain.value = state.amp.on ? (state.amp.volume / 100) : 0;
}

function ampLog(msg, type) {
  const log = document.getElementById('amp-log');
  if (!log) return;
  const span = document.createElement('span');
  span.className = 'log-' + (type || 'msg');
  span.textContent = msg + '\n';
  log.appendChild(span);
  log.scrollTop = log.scrollHeight;
}

async function connectDefaultInput() {
  try {
    const ctx = getAudio();
    if (state.amp.stream) state.amp.stream.getTracks().forEach(t => t.stop());

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 1 },
      }
    });

    state.amp.stream = stream;
    state.amp.deviceId = null;
    if (state.amp.sourceNode) { try { state.amp.sourceNode.disconnect(); } catch(e){} }
    state.amp.sourceNode = ctx.createMediaStreamSource(stream);
    if (!state.amp.nodes) state.amp.nodes = buildAmpChain(ctx);
    state.amp.sourceNode.connect(state.amp.nodes.input);

    const track = stream.getAudioTracks()[0];
    ampLog(`Connected: ${track ? track.label : 'default input'} ✓`, 'ok');
    setAmpPower(true);
  } catch (err) {
    ampLog('Input error: ' + err.message, 'err');
  }
}

function initAmp() {
  ampLog('Tap Refresh to detect your USB interface, or use the iOS button below.', 'msg');

  document.getElementById('amp-input-refresh').addEventListener('click', refreshAmpInputDevices);
  document.getElementById('amp-input-select').addEventListener('change', (e) => {
    connectAmpInput(e.target.value || undefined);
  });
  document.getElementById('amp-connect-default').addEventListener('click', connectDefaultInput);

  document.querySelectorAll('#amp-voice-group .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#amp-voice-group .pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.amp.voice = btn.dataset.voice;
      updateAmpParams();
    });
  });

  const powerBtn = document.getElementById('amp-power-btn');
  powerBtn.addEventListener('click', () => {
    getAudio();
    if (!state.amp.on && !state.amp.stream) {
      const sel = document.getElementById('amp-input-select');
      connectAmpInput(sel.value || undefined);
    } else {
      setAmpPower(!state.amp.on);
    }
  });

  ['drive', 'bass', 'mid', 'treble', 'volume'].forEach(param => {
    const el = document.getElementById('amp-' + param);
    el.addEventListener('input', () => {
      state.amp[param] = parseFloat(el.value);
      updateAmpParams();
    });
  });

  document.getElementById('amp-cab-toggle').addEventListener('click', (e) => {
    state.amp.cabOn = !state.amp.cabOn;
    e.currentTarget.classList.toggle('on', state.amp.cabOn);
    updateAmpParams();
  });
  document.getElementById('amp-gate-toggle').addEventListener('click', (e) => {
    state.amp.gateOn = !state.amp.gateOn;
    e.currentTarget.classList.toggle('on', state.amp.gateOn);
    updateAmpParams();
  });
}
window.initAmp = initAmp;

/* ============================================================
   LAYERED LOOPER
   Layer 1: free-length recording — defines the loop length when stopped.
   Layer 2+: auto-quantized to the next loop boundary, auto-stops after
             exactly one loop length, then joins playback in phase.
   Records from state.loopTapNode, which only carries LIVE sources
   (synths, pads, amp) — not other loop layers — so layers stay independent.
   ============================================================ */

function looperLog(msg) { console.warn('[Looper]', msg); }

function initLooper() {
  state.looper = {
    layers: [],
    loopLength: null,
    loopStartTime: null,
    isRecording: false,
    recorder: null,
    pendingTimer: null,
    autoStopTimer: null,
    nextLayerNum: 1,
    recStartCtxTime: 0,
    _timerInterval: null,
  };

  document.getElementById('looper-record-btn').addEventListener('click', toggleLooperRecord);
  document.getElementById('looper-play-all').addEventListener('click', playAllLayers);
  document.getElementById('looper-stop-all').addEventListener('click', stopAllLayers);
  document.getElementById('looper-clear-all').addEventListener('click', clearAllLayers);
}
window.initLooper = initLooper;

function toggleLooperRecord() {
  getAudio();
  if (state.looper.pendingTimer || state.looper.isRecording) {
    stopLayerRecording();
  } else {
    startLayerRecording();
  }
}

function startLayerRecording() {
  const ctx = getAudio();
  if (!state.loopTapNode) return;
  if (state.looper.isRecording || state.looper.pendingTimer) return;

  const recorder = new MediaRecorder(state.loopTapNode.stream);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  if (state.looper.layers.length === 0) {
    // First layer: free length, ends when the user taps Stop.
    recorder.onstop = () => finishLayerRecording(chunks, true);
    recorder.start();
    state.looper.isRecording = true;
    state.looper.recorder = recorder;
    state.looper.recStartCtxTime = ctx.currentTime;
    updateLooperRecUI(true);
    state.looper._timerInterval = setInterval(updateLooperRecTimer, 100);
  } else {
    // Overdub layer: wait for the next loop boundary, then record exactly one loop.
    const loopLen = state.looper.loopLength;
    const now     = ctx.currentTime;
    const phase   = ((now - state.looper.loopStartTime) % loopLen + loopLen) % loopLen;
    const waitSec = (loopLen - phase) % loopLen;

    updateLooperRecUI('armed');
    state.looper.pendingTimer = setTimeout(() => {
      state.looper.pendingTimer = null;
      recorder.onstop = () => finishLayerRecording(chunks, false);
      recorder.start();
      state.looper.isRecording = true;
      state.looper.recorder = recorder;
      state.looper.recStartCtxTime = getAudio().currentTime;
      updateLooperRecUI(true);
      state.looper._timerInterval = setInterval(updateLooperRecTimer, 100);

      state.looper.autoStopTimer = setTimeout(() => {
        if (state.looper.recorder === recorder) recorder.stop();
      }, loopLen * 1000);
    }, Math.max(0, waitSec * 1000));
  }
}

function stopLayerRecording() {
  if (state.looper.pendingTimer) {
    clearTimeout(state.looper.pendingTimer);
    state.looper.pendingTimer = null;
    updateLooperRecUI(false);
    return;
  }
  if (state.looper.autoStopTimer) { clearTimeout(state.looper.autoStopTimer); state.looper.autoStopTimer = null; }
  if (state.looper.isRecording && state.looper.recorder) {
    state.looper.recorder.stop();
  }
}

async function finishLayerRecording(chunks, isFirst) {
  clearInterval(state.looper._timerInterval);
  state.looper.isRecording = false;
  state.looper.recorder = null;
  updateLooperRecUI(false);

  const ctx = getAudio();
  const blob = new Blob(chunks, { type: 'audio/webm' });
  let buffer;
  try {
    const arrBuf = await blob.arrayBuffer();
    buffer = await ctx.decodeAudioData(arrBuf);
  } catch (err) {
    looperLog('Could not decode layer audio: ' + err.message);
    return;
  }
  if (!buffer || buffer.duration < 0.05) { looperLog('Layer too short, discarded.'); return; }

  if (isFirst) {
    state.looper.loopLength   = buffer.duration;
    state.looper.loopStartTime = ctx.currentTime;
    updateLooperLengthDisplay();
  }
  addLooperLayer(buffer);
}

function addLooperLayer(buffer) {
  const ctx = getAudio();
  const gainNode = ctx.createGain();
  gainNode.connect(ctx.destination); // monitor only — does NOT feed loopTapNode, avoiding layer-on-layer bleed
  const layer = {
    id: Date.now() + Math.random(),
    name: `Layer ${state.looper.nextLayerNum++}`,
    buffer,
    gainNode,
    muted: false,
    source: null,
  };
  state.looper.layers.push(layer);
  playLooperLayer(layer);
  renderLooperLayers();
}

function playLooperLayer(layer) {
  const ctx = getAudio();
  const loopLen = state.looper.loopLength;
  if (!loopLen) return;
  const src = ctx.createBufferSource();
  src.buffer = layer.buffer;
  src.loop = true;
  src.loopStart = 0;
  src.loopEnd = loopLen;
  src.connect(layer.gainNode);
  layer.gainNode.gain.value = layer.muted ? 0 : 1;

  const now = ctx.currentTime;
  const phase = ((now - state.looper.loopStartTime) % loopLen + loopLen) % loopLen;
  src.start(now, phase);
  layer.source = src;
}

function playAllLayers() {
  if (!state.looper.loopLength) return;
  state.looper.loopStartTime = getAudio().currentTime; // re-sync phase
  state.looper.layers.forEach(layer => {
    if (layer.source) { try { layer.source.stop(); } catch (e) {} }
    playLooperLayer(layer);
  });
}

function stopAllLayers() {
  state.looper.layers.forEach(layer => {
    if (layer.source) { try { layer.source.stop(); } catch (e) {} layer.source = null; }
  });
}

function clearAllLayers() {
  stopAllLayers();
  state.looper.layers = [];
  state.looper.loopLength = null;
  state.looper.loopStartTime = null;
  state.looper.nextLayerNum = 1;
  renderLooperLayers();
  updateLooperLengthDisplay();
}

function deleteLayer(id) {
  const layer = state.looper.layers.find(l => l.id === id);
  if (layer && layer.source) { try { layer.source.stop(); } catch (e) {} }
  state.looper.layers = state.looper.layers.filter(l => l.id !== id);
  if (state.looper.layers.length === 0) {
    state.looper.loopLength = null;
    state.looper.loopStartTime = null;
    updateLooperLengthDisplay();
  }
  renderLooperLayers();
}

function toggleMuteLayer(id) {
  const layer = state.looper.layers.find(l => l.id === id);
  if (!layer) return;
  layer.muted = !layer.muted;
  layer.gainNode.gain.value = layer.muted ? 0 : 1;
  renderLooperLayers();
}

function setLayerVolume(id, val) {
  const layer = state.looper.layers.find(l => l.id === id);
  if (!layer) return;
  if (!layer.muted) layer.gainNode.gain.value = clamp(val, 0, 100) / 100;
}

function renderLooperLayers() {
  const list = document.getElementById('looper-layer-list');
  if (!list) return;
  if (state.looper.layers.length === 0) {
    list.innerHTML = '<div class="empty-state">No layers yet.<br>Play a sound (keys, pads, or the amp) and hit Record Layer.</div>';
    return;
  }
  list.innerHTML = '';
  state.looper.layers.forEach(layer => {
    const el = document.createElement('div');
    el.className = 'layer-item';
    el.innerHTML = `
      <div class="layer-info">
        <span class="layer-name">${layer.name}</span>
        <span class="layer-meta">${state.looper.loopLength ? state.looper.loopLength.toFixed(2) : '0.00'}s</span>
      </div>
      <input type="range" class="amp-slider layer-vol" min="0" max="100" value="100" />
      <button class="layer-mute${layer.muted ? ' active' : ''}">${layer.muted ? 'Muted' : 'Mute'}</button>
      <button class="btn-icon danger" title="Delete layer">✕</button>
    `;
    el.querySelector('.layer-mute').addEventListener('click', () => toggleMuteLayer(layer.id));
    el.querySelector('.btn-icon').addEventListener('click', () => deleteLayer(layer.id));
    el.querySelector('.layer-vol').addEventListener('input', (e) => setLayerVolume(layer.id, parseFloat(e.target.value)));
    list.appendChild(el);
  });
}

function updateLooperLengthDisplay() {
  const el = document.getElementById('looper-length-display');
  if (!el) return;
  el.textContent = state.looper.loopLength ? `${state.looper.loopLength.toFixed(2)}s loop` : 'No loop set';
}

function updateLooperRecUI(mode) {
  const btn = document.getElementById('looper-record-btn');
  if (!btn) return;
  btn.classList.toggle('recording', mode === true);
  if (mode === true) {
    btn.innerHTML = '<span class="rec-dot"></span>Stop';
  } else if (mode === 'armed') {
    btn.innerHTML = '<span class="rec-dot"></span>Armed… (tap to cancel)';
  } else {
    btn.innerHTML = '<span class="rec-dot"></span>Record Layer';
    const t = document.getElementById('looper-rec-timer');
    if (t) t.textContent = '0:00';
  }
}

function updateLooperRecTimer() {
  const ctx = getAudio();
  const elapsed = ctx.currentTime - state.looper.recStartCtxTime;
  const m = Math.floor(elapsed / 60);
  const s = Math.floor(elapsed % 60).toString().padStart(2, '0');
  const t = document.getElementById('looper-rec-timer');
  if (t) t.textContent = `${m}:${s}`;
}
