/* ─────────────────────────────────────────────
   RELAY — Guitar Amp + Layered Looper module
   Depends on app.js: `state`, `getAudio()`
   ───────────────────────────────────────────── */

'use strict';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

const IDENTITY_CURVE = new Float32Array([-1, 1]);

const AMP_VOICES = {
  clean:    { driveCurve: 'soft', driveMul: 0.5,  bass: 1,  mid: 0,  treble: 2,  cabFreq: 3400, preGain: 0.9 },
  crunch:   { driveCurve: 'soft', driveMul: 1.4,  bass: 2,  mid: 3,  treble: 1,  cabFreq: 2800, preGain: 1.15 },
  lead:     { driveCurve: 'hard', driveMul: 2.2,  bass: 1,  mid: 4,  treble: 3,  cabFreq: 2600, preGain: 1.4 },
  metal:    { driveCurve: 'hard', driveMul: 3.4,  bass: 3,  mid: -2, treble: 4,  cabFreq: 2300, preGain: 1.8 },
  bass:     { driveCurve: 'soft', driveMul: 0.6,  bass: 6,  mid: 1,  treble: -3, cabFreq: 1500, preGain: 0.95 },
  acoustic: { driveCurve: 'soft', driveMul: 0.08, bass: 1,  mid: 2,  treble: 4,  cabFreq: 5200, preGain: 0.75 },
};

function makeDistortionCurve(amount, type) {
  const n = 4096, curve = new Float32Array(n), k = Math.max(0.0001, amount);
  // DC bias shifts the operating point so positive/negative halves clip differently —
  // this generates the even-order harmonics (2nd, 4th) that make tube distortion
  // sound warm instead of buzzy. Hard voicing gets more bias = more asymmetry.
  const bias = type === 'hard' ? 0.18 : 0.08;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    const xb = x + bias; // shift operating point
    let y;
    if (type === 'hard') {
      // Asymmetric hard clip: positive rail lower than negative (like an overdriven NPN stage)
      const driven = xb * (1 + k * 6);
      y = driven > 0
        ? Math.min( 0.95, Math.tanh(driven * 0.9))   // positive side clips a touch softer
        : Math.max(-1.05, Math.tanh(driven * 1.1));   // negative side clips harder/deeper
    } else {
      // Asymmetric soft clip: even-order richness without harshness
      const driven = xb * (1 + k * 3);
      y = driven > 0
        ? Math.tanh(driven * 0.85) / Math.tanh(1 + k * 3) * 0.95
        : Math.tanh(driven * 1.05) / Math.tanh(1 + k * 3);
    }
    // Remove DC offset from the curve itself so we don't need a post filter
    curve[i] = y - bias * 0.5;
  }
  return curve;
}

function makeGateCurve(threshold) {
  const n = 4096, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1, ax = Math.abs(x);
    curve[i] = ax < threshold ? x * (ax / threshold) * (ax / threshold) : x;
  }
  return curve;
}

// ── CABINET IR SIMULATION ─────────────────────
// Generates a synthetic cabinet impulse response using cascaded modal resonators.
// Each cabinet voice models: speaker cone resonance, cabinet box modes, mic
// proximity roll-off, and air absorption at high frequencies.
// This is not a captured IR but a physics-informed approximation — far richer
// than a single biquad, and loads instantly with no external files.
//
// Users can also load a real IR WAV via the file input for maximum realism.

const CAB_IR_PARAMS = {
  //           boxHz  boxQ   coneHz  coneQ  proximity  airLoss  length
  clean:    { box: 130, bQ: 1.8, cone: 2800, cQ: 0.7, prox: 0.55, air: 0.30, ms: 140 },
  crunch:   { box: 120, bQ: 2.0, cone: 2600, cQ: 0.8, prox: 0.50, air: 0.28, ms: 120 },
  lead:     { box: 110, bQ: 2.2, cone: 2400, cQ: 0.9, prox: 0.45, air: 0.26, ms:  95 },
  metal:    { box: 100, bQ: 2.5, cone: 2200, cQ: 1.0, prox: 0.40, air: 0.22, ms:  80 },
  bass:     { box: 80,  bQ: 2.8, cone: 1000, cQ: 0.6, prox: 0.70, air: 0.40, ms: 200 },
  acoustic: { box: 160, bQ: 1.4, cone: 4000, cQ: 0.5, prox: 0.65, air: 0.35, ms: 220 },
};

function buildCabIR(ctx, voice) {
  const p   = CAB_IR_PARAMS[voice] || CAB_IR_PARAMS.clean;
  const len = Math.floor(ctx.sampleRate * p.ms / 1000);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);

  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    const sr   = ctx.sampleRate;

    // Layer 1: Early reflections — sparse impulses in the first 8ms
    // model the wavefront bouncing off the cabinet baffle and back wall
    const earlyMs = [0, 1.2, 2.8, 4.1, 5.9, 7.3];
    earlyMs.forEach((ms, i) => {
      const idx = Math.floor(ms / 1000 * sr);
      if (idx < len) {
        const sign = i % 2 === 0 ? 1 : -0.7; // alternating polarity from reflections
        data[idx] += sign * Math.pow(0.72, i) * (ch === 0 ? 1 : 0.96); // slight L/R difference
      }
    });

    // Layer 2: Speaker cone resonance — decaying sine at cone breakup frequency
    // This is the primary character of the speaker (e.g. Celestion G12)
    const coneFreq = p.cone;
    const coneStep = 2 * Math.PI * coneFreq / sr;
    for (let i = 0; i < len; i++) {
      const env = Math.pow(0.9998, i) * Math.exp(-i / (sr * 0.04));
      data[i] += Math.sin(i * coneStep) * env * 0.35;
    }

    // Layer 3: Box resonance — cabinet body mode (lower frequency, longer decay)
    const boxFreq = p.box;
    for (let i = 0; i < len; i++) {
      const env = Math.exp(-i / (sr * 0.12)) * Math.pow(0.9999, i);
      data[i] += Math.sin(2 * Math.PI * boxFreq * i / sr) * env * 0.25;
    }

    // Layer 4: Diffuse tail — exponentially decaying noise models late reflections
    // inside the cabinet and mic room ambience
    for (let i = 0; i < len; i++) {
      const noise = (Math.random() * 2 - 1);
      const env   = Math.exp(-i / (sr * p.ms * 0.001 * 0.4));
      data[i] += noise * env * 0.08;
    }

    // Layer 5: Air absorption — high-frequency rolloff increases with distance/time
    // Apply a simple first-order IIR LPF that gets progressively stronger
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const fc = 1 - (i / len) * p.air; // cutoff drifts from 1.0 down to (1-air)
      lp = lp + fc * (data[i] - lp);
      data[i] = lp;
    }

    // Layer 6: Proximity effect — boost low-end in early samples (mic close to cone)
    // Simple running average adds warmth to the attack
    let proximity = 0;
    for (let i = 0; i < len; i++) {
      const blend = p.prox * Math.exp(-i / (sr * 0.003)); // fades out in ~3ms
      proximity = proximity * 0.85 + data[i] * 0.15;
      data[i] += proximity * blend;
    }

    // RMS-normalize to a consistent target level so cab-on and cab-off match in
    // perceived loudness. Peak normalization (what Web Audio does with normalize=true)
    // gets thrown off by the early-reflection spikes and makes the cab signal too quiet.
    const TARGET_RMS = 0.18;
    let sumSq = 0;
    for (let i = 0; i < len; i++) sumSq += data[i] * data[i];
    const rms = Math.sqrt(sumSq / len);
    const scale = rms > 0 ? TARGET_RMS / rms : 1;
    for (let i = 0; i < len; i++) data[i] *= scale;
  }

  return buf;
}

// Cache built IRs so voice switches are instant
const _irCache = {};
function getCabIR(ctx, voice) {
  if (!_irCache[voice]) _irCache[voice] = buildCabIR(ctx, voice);
  return _irCache[voice];
}

// Load a real IR WAV file and decode it into an AudioBuffer
function loadIRFile(ctx, file, onLoaded) {
  const reader = new FileReader();
  reader.onload = function(e) {
    ctx.decodeAudioData(e.target.result, function(buffer) {
      onLoaded(buffer);
    }, function(err) {
      console.warn('[RELAY cab] IR decode failed:', err);
    });
  };
  reader.readAsArrayBuffer(file);
}

function buildAmpChain(ctx) {
  const input   = ctx.createGain();
  const gate    = ctx.createWaveShaper(); gate.curve = IDENTITY_CURVE;
  const preGain = ctx.createGain();
  const preHP   = ctx.createBiquadFilter(); preHP.type = 'highpass'; preHP.frequency.value = 180; preHP.Q.value = 0.6;
  const shaper  = ctx.createWaveShaper(); shaper.oversample = '4x';
  const lowSplit  = ctx.createGain();  lowSplit.gain.value = 1;
  const lowLPF    = ctx.createBiquadFilter(); lowLPF.type = 'lowpass'; lowLPF.frequency.value = 160; lowLPF.Q.value = 0.5;
  const lowBlend  = ctx.createGain();  lowBlend.gain.value = 0.6;
  const merge     = ctx.createGain();
  const bassF   = ctx.createBiquadFilter(); bassF.type = 'lowshelf';  bassF.frequency.value = 120;
  const midF    = ctx.createBiquadFilter(); midF.type  = 'peaking';   midF.frequency.value  = 800; midF.Q.value = 0.8;
  const trebleF = ctx.createBiquadFilter(); trebleF.type = 'highshelf'; trebleF.frequency.value = 3000;

  // Cabinet: ConvolverNode with synthetic IR (or user-loaded real IR)
  // cabDry is the bypass path for when cab sim is off
  const convolver = ctx.createConvolver(); convolver.normalize = false;
  const cabGain   = ctx.createGain(); cabGain.gain.value = 1;    // cab wet
  const cabDry    = ctx.createGain(); cabDry.gain.value  = 0;    // cab bypass (flat)
  const cabMerge  = ctx.createGain();
  const outGain   = ctx.createGain(); outGain.gain.value = 0;

  // Wire driven path
  input.connect(gate); gate.connect(preGain); preGain.connect(preHP); preHP.connect(shaper);
  shaper.connect(merge);
  // Parallel clean low path
  input.connect(lowSplit); lowSplit.connect(lowLPF); lowLPF.connect(lowBlend); lowBlend.connect(merge);
  // Tone stack
  merge.connect(bassF); bassF.connect(midF); midF.connect(trebleF);
  // Cabinet split: convolver path + dry bypass path
  trebleF.connect(convolver); convolver.connect(cabGain); cabGain.connect(cabMerge);
  trebleF.connect(cabDry);    cabDry.connect(cabMerge);
  cabMerge.connect(outGain);
  outGain.connect(state.masterGain);

  // Load the initial IR for the default voice
  convolver.buffer = getCabIR(ctx, 'clean');

  return { input, gate, preGain, preHP, shaper, lowBlend, merge, bassF, midF, trebleF, convolver, cabGain, cabDry, outGain };
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

function connectDefaultInput() {
  ampLog('Requesting mic access…', 'msg');

  if (!navigator.mediaDevices) {
    ampLog('FAIL: navigator.mediaDevices undefined — must be HTTPS', 'err');
    return;
  }

  navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  }).then(function(stream) {
    const ctx = getAudio();
    if (state.amp.stream) state.amp.stream.getTracks().forEach(t => t.stop());
    state.amp.stream = stream;
    state.amp.deviceId = null;
    if (state.amp.sourceNode) { try { state.amp.sourceNode.disconnect(); } catch(e){} }
    state.amp.sourceNode = ctx.createMediaStreamSource(stream);
    if (!state.amp.nodes) state.amp.nodes = buildAmpChain(ctx);
    // Route through FX chain if available, else connect directly
    if (typeof patchAmpSourceIntoFX === 'function') patchAmpSourceIntoFX();
    else state.amp.sourceNode.connect(state.amp.nodes.input);
    const track = stream.getAudioTracks()[0];
    ampLog('Connected: ' + (track ? track.label : 'audio input') + ' ✓', 'ok');
    setAmpPower(true);
  }).catch(function(err) {
    ampLog('FAILED: ' + err.name, 'err');
    ampLog(err.message || '(no message)', 'err');
    if (err.name === 'NotAllowedError') {
      ampLog('→ Go to Settings → Safari → [this site] → Microphone → Allow', 'err');
    } else if (err.name === 'NotFoundError') {
      ampLog('→ No audio input found. Is the Scarlett plugged in?', 'err');
    } else if (err.name === 'NotReadableError') {
      ampLog('→ Input busy. Close other audio apps and try again.', 'err');
    }
  });
}

async function refreshAmpInputDevices() {
  ampLog('Scanning for devices…', 'msg');
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs  = devices.filter(d => d.kind === 'audioinput');
    const sel = document.getElementById('amp-input-select');
    if (!sel) return;
    sel.innerHTML = '';
    if (inputs.length === 0) {
      sel.innerHTML = '<option value="">No inputs found</option>';
      ampLog('No inputs found — use ⚡ button instead.', 'err');
      return;
    }
    inputs.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || ('Input ' + (i + 1));
      sel.appendChild(opt);
    });
    ampLog('Found ' + inputs.length + ' input(s). Select or use ⚡.', 'ok');
  } catch (err) {
    ampLog('Enumerate failed: ' + err.message, 'err');
  }
}

async function connectAmpInput(deviceId) {
  try {
    const ctx = getAudio();
    if (state.amp.stream) state.amp.stream.getTracks().forEach(t => t.stop());
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: { ideal: 1 },
      }
    });
    state.amp.stream = stream;
    state.amp.deviceId = deviceId || null;
    if (state.amp.sourceNode) { try { state.amp.sourceNode.disconnect(); } catch(e){} }
    state.amp.sourceNode = ctx.createMediaStreamSource(stream);
    if (!state.amp.nodes) state.amp.nodes = buildAmpChain(ctx);
    // Route through FX chain if available, else connect directly
    if (typeof patchAmpSourceIntoFX === 'function') patchAmpSourceIntoFX();
    else state.amp.sourceNode.connect(state.amp.nodes.input);
    const track = stream.getAudioTracks()[0];
    ampLog('Connected: ' + (track ? track.label : 'audio input') + ' ✓', 'ok');
    setAmpPower(true);
  } catch (err) {
    ampLog('Input error: ' + err.name + ' — ' + err.message, 'err');
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
  const { gate, shaper, bassF, midF, trebleF, convolver, cabGain, cabDry, outGain, preGain, lowBlend } = state.amp.nodes;
  const ctx = getAudio();
  const driveAmt = (state.amp.drive / 100) * preset.driveMul;
  shaper.curve = makeDistortionCurve(driveAmt, preset.driveCurve);
  preGain.gain.value = preset.preGain * clamp(0.6 + Math.sqrt(driveAmt) * 0.4, 0.6, 2.0);
  gate.curve = state.amp.gateOn ? makeGateCurve(0.012) : IDENTITY_CURVE;
  bassF.gain.value   = clamp(state.amp.bass   + preset.bass,   -15, 15);
  midF.gain.value    = clamp(state.amp.mid    + preset.mid,    -15, 15);
  trebleF.gain.value = clamp(state.amp.treble + preset.treble, -15, 15);
  // Swap IR when voice changes (cached after first build per voice)
  if (convolver) convolver.buffer = getCabIR(ctx, state.amp.voice);
  // cabOn: crossfade between convolver (wet) and dry bypass
  if (cabGain && cabDry) {
    cabGain.gain.value = state.amp.cabOn ? 1 : 0;
    cabDry.gain.value  = state.amp.cabOn ? 0 : 1;
  }
  outGain.gain.value  = state.amp.on ? (state.amp.volume / 100) : 0;
  if (lowBlend) lowBlend.gain.value = 0.3 + (state.amp.drive / 100) * 0.5;
}

// iOS Safari sometimes won't fire 'click' when ancestors have user-select:none.
// This helper fires on touchend (with no movement) AND click, whichever comes first.
function onTap(el, fn) {
  if (!el) return;
  let moved = false;
  el.addEventListener('touchstart', function() { moved = false; }, { passive: true });
  el.addEventListener('touchmove',  function() { moved = true;  }, { passive: true });
  el.addEventListener('touchend', function(e) {
    if (!moved) { e.preventDefault(); fn(e); }
  });
  el.addEventListener('click', fn);
}

function initAmp() {
  state.amp = {
    on: false, voice: 'clean', drive: 35, bass: 0, mid: 0, treble: 0,
    volume: 80, cabOn: true, gateOn: true,
    stream: null, sourceNode: null, nodes: null, deviceId: null,
  };

  ampLog('Tap ⚡ to connect your input.', 'msg');

  onTap(document.getElementById('amp-connect-default'), connectDefaultInput);
  onTap(document.getElementById('amp-input-refresh'), refreshAmpInputDevices);
  document.getElementById('amp-input-select').addEventListener('change', function(e) {
    if (e.target.value) connectAmpInput(e.target.value);
  });

  document.querySelectorAll('#amp-voice-group .pill').forEach(function(btn) {
    onTap(btn, function() {
      document.querySelectorAll('#amp-voice-group .pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.amp.voice = btn.dataset.voice;
      updateAmpParams();
    });
  });

  onTap(document.getElementById('amp-power-btn'), function() {
    getAudio();
    if (!state.amp.on && !state.amp.stream) {
      connectDefaultInput();
    } else {
      setAmpPower(!state.amp.on);
    }
  });

  ['drive', 'bass', 'mid', 'treble', 'volume'].forEach(function(param) {
    const el = document.getElementById('amp-' + param);
    el.addEventListener('input', function() {
      state.amp[param] = parseFloat(el.value);
      updateAmpParams();
    });
  });

  onTap(document.getElementById('amp-cab-toggle'), function(e) {
    state.amp.cabOn = !state.amp.cabOn;
    e.currentTarget.classList.toggle('on', state.amp.cabOn);
    updateAmpParams();
  });

  // IR file loader — drag a real cabinet IR WAV onto the input for maximum realism
  const irInput = document.getElementById('amp-ir-file');
  if (irInput) {
    irInput.addEventListener('change', function(e) {
      const file = e.target.files[0];
      if (!file || !state.amp.nodes) return;
      const ctx = getAudio();
      loadIRFile(ctx, file, function(buffer) {
        state.amp.nodes.convolver.buffer = buffer;
        // Bypass the voice IR cache for this session — user IR takes priority
        ampLog('IR loaded: ' + file.name + ' ✓', 'ok');
      });
    });
  }

  onTap(document.getElementById('amp-gate-toggle'), function(e) {
    state.amp.gateOn = !state.amp.gateOn;
    e.currentTarget.classList.toggle('on', state.amp.gateOn);
    updateAmpParams();
  });
}
window.initAmp    = initAmp;
window.onTap      = onTap;

/* ============================================================
   LAYERED LOOPER
   ============================================================ */

function looperLog(msg) { console.warn('[Looper]', msg); }

function initLooper() {
  state.looper = {
    layers: [], loopLength: null, loopStartTime: null,
    isRecording: false, recorder: null, pendingTimer: null,
    autoStopTimer: null, nextLayerNum: 1, recStartCtxTime: 0, _timerInterval: null,
  };
  document.getElementById('looper-record-btn').addEventListener('click', toggleLooperRecord);
  document.getElementById('looper-play-all').addEventListener('click', playAllLayers);
  document.getElementById('looper-stop-all').addEventListener('click', stopAllLayers);
  document.getElementById('looper-clear-all').addEventListener('click', clearAllLayers);
  document.getElementById('looper-bounce-btn').addEventListener('click', bounceLoop);

  // Floating record button — works from any tab
  var floatBtn = document.getElementById('float-rec-btn');
  if (floatBtn) {
    floatBtn.addEventListener('touchend', function(e) { e.preventDefault(); toggleLooperRecord(); });
    floatBtn.addEventListener('click', toggleLooperRecord);
  }
}
window.initLooper = initLooper;

function toggleLooperRecord() {
  getAudio();
  if (state.looper.pendingTimer || state.looper.isRecording) stopLayerRecording();
  else startLayerRecording();
}

function startLayerRecording() {
  const ctx = getAudio();
  if (!state.loopTapNode) return;
  if (state.looper.isRecording || state.looper.pendingTimer) return;

  const recorder = new MediaRecorder(state.loopTapNode.stream);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  if (state.looper.layers.length === 0) {
    recorder.onstop = () => finishLayerRecording(chunks, true);
    recorder.start();
    state.looper.isRecording = true;
    state.looper.recorder = recorder;
    state.looper.recStartCtxTime = ctx.currentTime;
    updateLooperRecUI(true);
    state.looper._timerInterval = setInterval(updateLooperRecTimer, 100);
  } else {
    const loopLen = state.looper.loopLength;
    const now = ctx.currentTime;
    const phase = ((now - state.looper.loopStartTime) % loopLen + loopLen) % loopLen;
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
  if (state.looper.isRecording && state.looper.recorder) state.looper.recorder.stop();
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
    buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch (err) { looperLog('Decode failed: ' + err.message); return; }
  if (!buffer || buffer.duration < 0.05) { looperLog('Too short, discarded.'); return; }
  if (isFirst) {
    state.looper.loopLength = buffer.duration;
    state.looper.loopStartTime = ctx.currentTime;
    updateLooperLengthDisplay();
  }
  addLooperLayer(buffer);
}

function addLooperLayer(buffer) {
  const ctx = getAudio();
  const gainNode = ctx.createGain();
  gainNode.connect(ctx.destination);
  const layer = {
    id: Date.now() + Math.random(), name: 'Layer ' + state.looper.nextLayerNum++,
    buffer, gainNode, muted: false, source: null,
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
  src.loop = true; src.loopStart = 0; src.loopEnd = loopLen;
  src.connect(layer.gainNode);
  layer.gainNode.gain.value = layer.muted ? 0 : 1;
  const now = ctx.currentTime;
  const phase = ((now - state.looper.loopStartTime) % loopLen + loopLen) % loopLen;
  src.start(now, phase);
  layer.source = src;
}

function playAllLayers() {
  if (!state.looper.loopLength) return;
  state.looper.loopStartTime = getAudio().currentTime;
  state.looper.layers.forEach(layer => {
    if (layer.source) { try { layer.source.stop(); } catch(e){} }
    playLooperLayer(layer);
  });
}

function stopAllLayers() {
  state.looper.layers.forEach(layer => {
    if (layer.source) { try { layer.source.stop(); } catch(e){} layer.source = null; }
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
  if (layer && layer.source) { try { layer.source.stop(); } catch(e){} }
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
    list.innerHTML = '<div class="empty-state">No layers yet.<br>Play a sound and hit Record Layer.</div>';
    return;
  }
  list.innerHTML = '';
  state.looper.layers.forEach(layer => {
    const el = document.createElement('div');
    el.className = 'layer-item';
    el.innerHTML =
      '<div class="layer-info"><span class="layer-name">' + layer.name + '</span>' +
      '<span class="layer-meta">' + (state.looper.loopLength ? state.looper.loopLength.toFixed(2) : '0.00') + 's</span></div>' +
      '<input type="range" class="amp-slider layer-vol" min="0" max="100" value="100" />' +
      '<button class="layer-mute' + (layer.muted ? ' active' : '') + '">' + (layer.muted ? 'Muted' : 'Mute') + '</button>' +
      '<button class="btn-icon danger" title="Delete">✕</button>';
    el.querySelector('.layer-mute').addEventListener('click', () => toggleMuteLayer(layer.id));
    el.querySelector('.btn-icon').addEventListener('click', () => deleteLayer(layer.id));
    el.querySelector('.layer-vol').addEventListener('input', (e) => setLayerVolume(layer.id, parseFloat(e.target.value)));
    list.appendChild(el);
  });
}

function updateLooperLengthDisplay() {
  const el = document.getElementById('looper-length-display');
  if (el) el.textContent = state.looper.loopLength ? state.looper.loopLength.toFixed(2) + 's loop' : 'No loop set';
}

function updateLooperRecUI(mode) {
  const btn = document.getElementById('looper-record-btn');
  const floatBtn = document.getElementById('float-rec-btn');
  const floatLabel = floatBtn ? floatBtn.querySelector('.float-label') : null;

  if (btn) {
    btn.classList.toggle('recording', mode === true);
    if (mode === true) btn.innerHTML = '<span class="rec-dot"></span>Stop';
    else if (mode === 'armed') btn.innerHTML = '<span class="rec-dot"></span>Armed… (tap to cancel)';
    else {
      btn.innerHTML = '<span class="rec-dot"></span>Record Layer';
      const t = document.getElementById('looper-rec-timer');
      if (t) t.textContent = '0:00';
    }
  }

  if (floatBtn) {
    floatBtn.classList.toggle('recording', mode === true);
    floatBtn.classList.toggle('armed', mode === 'armed');
    if (floatLabel) {
      if (mode === true)       floatLabel.textContent = 'STOP';
      else if (mode === 'armed') floatLabel.textContent = 'WAIT';
      else                     floatLabel.textContent = 'REC';
    }
  }
}

function updateLooperRecTimer() {
  const ctx = getAudio();
  const elapsed = ctx.currentTime - state.looper.recStartCtxTime;
  const m = Math.floor(elapsed / 60);
  const s = Math.floor(elapsed % 60).toString().padStart(2, '0');
  const t = document.getElementById('looper-rec-timer');
  if (t) t.textContent = m + ':' + s;
}

// ── BOUNCE TO WAV ────────────────────────────────────────────────
// Mixes all looper layers offline into a single stereo WAV and
// triggers a download. Uses OfflineAudioContext so it's instant —
// no re-recording, no timing drift, no waiting for playback.

async function bounceLoop() {
  const layers = state.looper.layers;
  const loopLen = state.looper.loopLength;

  if (!loopLen || layers.length === 0) {
    looperLog('Nothing to bounce — record at least one layer first.');
    return;
  }

  const ctx = getAudio();
  const sr  = ctx.sampleRate;
  const frameCount = Math.ceil(sr * loopLen);

  // OfflineAudioContext renders to a buffer without playing audio
  const offline = new OfflineAudioContext(2, frameCount, sr);

  layers.forEach(layer => {
    if (layer.muted) return; // respect mute state
    const src  = offline.createBufferSource();
    const gain = offline.createGain();
    src.buffer    = layer.buffer;
    src.loop      = true;
    src.loopStart = 0;
    src.loopEnd   = loopLen;
    gain.gain.value = layer.gainNode.gain.value; // match live volume
    src.connect(gain);
    gain.connect(offline.destination);
    src.start(0);
  });

  looperLog('Bouncing…');
  const rendered = await offline.startRendering();
  const wav = encodeWAV(rendered);
  const blob = new Blob([wav], { type: 'audio/wav' });
  const url  = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href     = url;
  a.download = 'relay-loop-' + Date.now() + '.wav';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  looperLog('Bounced ' + layers.filter(l => !l.muted).length + ' layer(s) → WAV ↓');
}

// Encode an AudioBuffer to a 16-bit stereo WAV ArrayBuffer (pure JS, no library)
function encodeWAV(buffer) {
  const numCh  = buffer.numberOfChannels;
  const sr     = buffer.sampleRate;
  const frames = buffer.length;
  const bitsPerSample = 16;
  const byteRate  = sr * numCh * bitsPerSample / 8;
  const blockAlign = numCh * bitsPerSample / 8;
  const dataBytes  = frames * blockAlign;
  const ab = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(ab);

  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0,  'RIFF');
  view.setUint32(4,  36 + dataBytes, true);
  str(8,  'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);           // PCM chunk size
  view.setUint16(20, 1,  true);           // PCM format
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  str(36, 'data');
  view.setUint32(40, dataBytes, true);

  // Interleave channels and clamp to 16-bit
  const channels = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
  }
  return ab;
}

window.bounceLoop = bounceLoop; // expose for console access too

// app.js executes init() before this file loads, so window.initAmp/initLooper
// are not set in time. Call them directly here instead.
try {
  initAmp();
} catch(e) {
  // Force the error into the amp-log even if ampLog itself isn't working
  var _log = document.getElementById('amp-log');
  if (_log) {
    _log.innerHTML = '<span style="color:#F05C5C;font-weight:700;white-space:pre-wrap;">initAmp CRASHED:\n' + e.name + ': ' + e.message + '\nLine: ' + (e.stack || '').split('\n').slice(0,3).join('\n') + '</span>';
  }
}
try {
  initLooper();
} catch(e) {
  var _log2 = document.getElementById('amp-log');
  if (_log2) {
    var _s = document.createElement('span');
    _s.style.cssText = 'color:#F05C5C;font-weight:700;white-space:pre-wrap;';
    _s.textContent = 'initLooper CRASHED:\n' + e.name + ': ' + e.message;
    _log2.appendChild(_s);
  }
}
