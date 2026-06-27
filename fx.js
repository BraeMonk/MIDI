/* ─────────────────────────────────────────────
   RELAY — Guitar FX Pedal Chain  ·  fx.js v1.0
   Inserts between amp input and amp gate node.
   Depends on amp-looper.js: state.amp, getAudio()
   ───────────────────────────────────────────── */

'use strict';

// ── PEDAL DEFINITIONS ─────────────────────────
// Ordered as a classic guitar signal chain:
// Tuner → Comp → Gate → Wah → Octave → [amp] → Chorus → Flanger → Phaser → Tremolo → Delay → Reverb
// (modulation + time effects go after amp drive in the chain)

const PEDAL_DEFS = [
  {
    id: 'tuner',
    name: 'Tuner',
    desc: 'Chromatic pitch display',
    params: [], // visual only — no audio processing
    build: buildTuner,
  },
  {
    id: 'compressor',
    name: 'Compressor',
    desc: 'Smooth dynamics, add sustain',
    params: [
      { id: 'threshold', label: 'Threshold', min: -60, max: 0,   step: 1,   default: -24, unit: 'dB', fmt: v => v.toFixed(0) + ' dB' },
      { id: 'ratio',     label: 'Ratio',     min: 1,   max: 20,  step: 0.5, default: 4,   unit: ':1', fmt: v => v.toFixed(1) + ':1'  },
      { id: 'attack',    label: 'Attack',    min: 0,   max: 200, step: 1,   default: 10,  unit: 'ms', fmt: v => v.toFixed(0) + ' ms' },
      { id: 'release',   label: 'Release',   min: 10,  max: 500, step: 5,   default: 100, unit: 'ms', fmt: v => v.toFixed(0) + ' ms' },
      { id: 'gain',      label: 'Make-up',   min: 0,   max: 24,  step: 0.5, default: 6,   unit: 'dB', fmt: v => v.toFixed(1) + ' dB' },
    ],
    build: buildCompressor,
  },
  {
    id: 'noisegate',
    name: 'Noise Gate',
    desc: 'Kill hiss between notes',
    params: [
      { id: 'threshold', label: 'Threshold', min: 0, max: 100, step: 1, default: 15, unit: '%', fmt: v => v.toFixed(0) + '%' },
      { id: 'smoothing', label: 'Smoothing', min: 0, max: 100, step: 1, default: 30, unit: '%', fmt: v => v.toFixed(0) + '%' },
    ],
    build: buildNoiseGate,
  },
  {
    id: 'overdrive',
    name: 'Overdrive',
    desc: 'Warm tube-style soft clipping',
    params: [
      { id: 'drive',  label: 'Drive',  min: 0, max: 100, step: 1, default: 40,  unit: '%', fmt: v => v.toFixed(0) + '%' },
      { id: 'tone',   label: 'Tone',   min: 0, max: 100, step: 1, default: 55,  unit: '%', fmt: v => v.toFixed(0) + '%' },
      { id: 'level',  label: 'Level',  min: 0, max: 100, step: 1, default: 60,  unit: '%', fmt: v => v.toFixed(0) + '%' },
    ],
    build: buildOverdrive,
  },
  {
    id: 'distortion',
    name: 'Distortion',
    desc: 'Hard clipping with mid scoop',
    params: [
      { id: 'drive',  label: 'Drive',  min: 0, max: 100, step: 1, default: 65,  unit: '%', fmt: v => v.toFixed(0) + '%' },
      { id: 'tone',   label: 'Tone',   min: 0, max: 100, step: 1, default: 50,  unit: '%', fmt: v => v.toFixed(0) + '%' },
      { id: 'level',  label: 'Level',  min: 0, max: 100, step: 1, default: 55,  unit: '%', fmt: v => v.toFixed(0) + '%' },
    ],
    build: buildDistortion,
  },
  {
    id: 'fuzz',
    name: 'Fuzz',
    desc: 'Vintage germanium-style clipping',
    params: [
      { id: 'fuzz',   label: 'Fuzz',   min: 0, max: 100, step: 1, default: 75,  unit: '%', fmt: v => v.toFixed(0) + '%' },
      { id: 'tone',   label: 'Tone',   min: 0, max: 100, step: 1, default: 45,  unit: '%', fmt: v => v.toFixed(0) + '%' },
      { id: 'level',  label: 'Level',  min: 0, max: 100, step: 1, default: 60,  unit: '%', fmt: v => v.toFixed(0) + '%' },
    ],
    build: buildFuzz,
  },
  {
    id: 'wah',
    name: 'Auto-Wah',
    desc: 'Envelope-triggered filter sweep',
    params: [
      { id: 'sensitivity', label: 'Sensitivity', min: 1,    max: 20,   step: 0.5, default: 6,    fmt: v => v.toFixed(1) },
      { id: 'freqLo',      label: 'Freq Low',    min: 100,  max: 1000, step: 10,  default: 400,  unit: 'Hz', fmt: v => v.toFixed(0) + ' Hz' },
      { id: 'freqHi',      label: 'Freq High',   min: 1000, max: 6000, step: 50,  default: 3500, unit: 'Hz', fmt: v => v.toFixed(0) + ' Hz' },
      { id: 'resonance',   label: 'Resonance',   min: 1,    max: 20,   step: 0.5, default: 8,    fmt: v => v.toFixed(1) },
      { id: 'speed',       label: 'Attack',      min: 0,    max: 100,  step: 1,   default: 20,   unit: '%',  fmt: v => v.toFixed(0) + '%' },
    ],
    build: buildAutoWah,
  },
  {
    id: 'octaver',
    name: 'Octaver',
    desc: 'Add sub-octave or octave-up layer',
    params: [
      { id: 'subLevel', label: 'Oct Down',  min: 0, max: 100, step: 1, default: 70,  unit: '%', fmt: v => v.toFixed(0) + '%' },
      { id: 'upLevel',  label: 'Oct Up',    min: 0, max: 100, step: 1, default: 0,   unit: '%', fmt: v => v.toFixed(0) + '%' },
      { id: 'dryLevel', label: 'Dry',       min: 0, max: 100, step: 1, default: 100, unit: '%', fmt: v => v.toFixed(0) + '%' },
    ],
    build: buildOctaver,
  },
  {
    id: 'chorus',
    name: 'Chorus',
    desc: 'Lush pitch modulation doubling',
    params: [
      { id: 'rate',  label: 'Rate',  min: 0.1, max: 8,   step: 0.1, default: 1.2, unit: 'Hz', fmt: v => v.toFixed(1) + ' Hz' },
      { id: 'depth', label: 'Depth', min: 0,   max: 100, step: 1,   default: 40,  unit: '%',  fmt: v => v.toFixed(0) + '%'   },
      { id: 'mix',   label: 'Mix',   min: 0,   max: 100, step: 1,   default: 50,  unit: '%',  fmt: v => v.toFixed(0) + '%'   },
    ],
    build: buildChorus,
  },
  {
    id: 'flanger',
    name: 'Flanger',
    desc: 'Jet-sweep comb filtering',
    params: [
      { id: 'rate',      label: 'Rate',      min: 0.05, max: 4,   step: 0.05, default: 0.4, unit: 'Hz', fmt: v => v.toFixed(2) + ' Hz' },
      { id: 'depth',     label: 'Depth',     min: 0,    max: 100, step: 1,    default: 70,  unit: '%',  fmt: v => v.toFixed(0) + '%'   },
      { id: 'feedback',  label: 'Feedback',  min: -90,  max: 90,  step: 1,    default: 50,  unit: '%',  fmt: v => v.toFixed(0) + '%'   },
      { id: 'mix',       label: 'Mix',       min: 0,    max: 100, step: 1,    default: 50,  unit: '%',  fmt: v => v.toFixed(0) + '%'   },
    ],
    build: buildFlanger,
  },
  {
    id: 'phaser',
    name: 'Phaser',
    desc: 'Sweeping all-pass notch filter',
    params: [
      { id: 'rate',     label: 'Rate',     min: 0.05, max: 5,   step: 0.05, default: 0.5, unit: 'Hz', fmt: v => v.toFixed(2) + ' Hz' },
      { id: 'depth',    label: 'Depth',    min: 0,    max: 100, step: 1,    default: 60,  unit: '%',  fmt: v => v.toFixed(0) + '%'   },
      { id: 'feedback', label: 'Feedback', min: 0,    max: 90,  step: 1,    default: 40,  unit: '%',  fmt: v => v.toFixed(0) + '%'   },
      { id: 'stages',   label: 'Stages',   min: 2,    max: 8,   step: 2,    default: 4,   unit: '',   fmt: v => v.toFixed(0)         },
      { id: 'mix',      label: 'Mix',      min: 0,    max: 100, step: 1,    default: 50,  unit: '%',  fmt: v => v.toFixed(0) + '%'   },
    ],
    build: buildPhaser,
  },
  {
    id: 'tremolo',
    name: 'Tremolo',
    desc: 'Rhythmic volume pulsing',
    params: [
      { id: 'rate',  label: 'Rate',  min: 0.5, max: 12,  step: 0.5, default: 5,  unit: 'Hz', fmt: v => v.toFixed(1) + ' Hz' },
      { id: 'depth', label: 'Depth', min: 0,   max: 100, step: 1,   default: 60, unit: '%',  fmt: v => v.toFixed(0) + '%'   },
      { id: 'shape', label: 'Shape', min: 0,   max: 1,   step: 1,   default: 0,  unit: '',   fmt: v => v === 0 ? 'Sine' : 'Square' },
    ],
    build: buildTremolo,
  },
  {
    id: 'delay',
    name: 'Delay',
    desc: 'Tape-style echo repeats',
    params: [
      { id: 'time',     label: 'Time',     min: 10,  max: 1000, step: 5,  default: 375, unit: 'ms', fmt: v => v.toFixed(0) + ' ms' },
      { id: 'feedback', label: 'Feedback', min: 0,   max: 90,   step: 1,  default: 40,  unit: '%',  fmt: v => v.toFixed(0) + '%'   },
      { id: 'tone',     label: 'Tone',     min: 500, max: 8000, step: 50, default: 3000, unit: 'Hz', fmt: v => v.toFixed(0) + ' Hz' },
      { id: 'mix',      label: 'Mix',      min: 0,   max: 100,  step: 1,  default: 35,  unit: '%',  fmt: v => v.toFixed(0) + '%'   },
    ],
    build: buildDelay,
  },
  {
    id: 'reverb',
    name: 'Reverb',
    desc: 'Room / hall / plate ambience',
    params: [
      { id: 'size',     label: 'Size',     min: 0.1, max: 1,   step: 0.01, default: 0.4, fmt: v => (v * 100).toFixed(0) + '%'  },
      { id: 'decay',    label: 'Decay',    min: 0.5, max: 8,   step: 0.1,  default: 2.0, unit: 's', fmt: v => v.toFixed(1) + 's' },
      { id: 'damping',  label: 'Damping',  min: 0,   max: 100, step: 1,    default: 50,  unit: '%', fmt: v => v.toFixed(0) + '%' },
      { id: 'predelay', label: 'Pre-delay',min: 0,   max: 100, step: 1,    default: 10,  unit: 'ms',fmt: v => v.toFixed(0) + ' ms'},
      { id: 'mix',      label: 'Mix',      min: 0,   max: 100, step: 1,    default: 20,  unit: '%', fmt: v => v.toFixed(0) + '%' },
    ],
    build: buildReverb,
  },
];

// ── FX STATE ──────────────────────────────────
const fxState = {
  pedals: {}, // id → { active, open, params:{}, nodes:{} }
  chainInput:  null, // GainNode — receives signal from amp sourceNode
  chainOutput: null, // GainNode — feeds into amp.nodes.input
};

// ── CHAIN WIRING ──────────────────────────────
// Inserts the FX chain between the guitar source and the amp input.
// Called once when the first amp input connects (patched via amp-looper.js).
function initFXChain() {
  const ctx = getAudio();
  fxState.chainInput  = ctx.createGain();
  fxState.chainOutput = ctx.createGain();

  // Build each pedal's audio nodes (bypassed by default)
  PEDAL_DEFS.forEach(def => {
    if (def.id === 'tuner') {
      fxState.pedals[def.id] = { active: false, open: false, params: {}, nodes: null };
      return;
    }
    const params = {};
    (def.params || []).forEach(p => { params[p.id] = p.default; });
    const nodes = def.build(ctx, params);
    fxState.pedals[def.id] = { active: false, open: false, params, nodes };
  });

  rewireChain(ctx);
}

// Connect all pedals in series, bypassing inactive ones via passthrough gains.
function rewireChain(ctx) {
  // Only disconnect inter-pedal connections (output/bypass downstream).
  // Do NOT call p.nodes.input.disconnect() — it has no args and would also
  // sever the internal graph (input→preGain etc), killing the pedal's audio.
  try { fxState.chainInput.disconnect(); } catch(e) {}
  Object.values(fxState.pedals).forEach(p => {
    if (!p.nodes) return;
    try { p.nodes.output.disconnect(); } catch(e) {}
    try { p.nodes.bypass.disconnect(); } catch(e) {}
  });

  let prev = fxState.chainInput;

  PEDAL_DEFS.forEach(def => {
    if (def.id === 'tuner') return; // analyser node taps separately
    const p = fxState.pedals[def.id];
    if (!p || !p.nodes) return;
    if (p.active) {
      prev.connect(p.nodes.input);
      prev = p.nodes.output;
    } else {
      // Bypass: connect through the pedal's dry pass node
      prev.connect(p.nodes.bypass);
      prev = p.nodes.bypass;
    }
  });

  prev.connect(fxState.chainOutput);

  // Reconnect sourceNode → chainInput (disconnected above during the teardown pass)
  if (state.amp && state.amp.sourceNode) {
    state.amp.sourceNode.connect(fxState.chainInput);
  }

  // Hook chainOutput into the amp input node (if amp is set up)
  if (state.amp && state.amp.nodes) {
    try { fxState.chainOutput.disconnect(state.amp.nodes.input); } catch(e) {}
    fxState.chainOutput.connect(state.amp.nodes.input);
  }
}

// Patch amp-looper's connectAmpInput/connectDefaultInput to route through FX chain.
// We intercept by wrapping the amp sourceNode connect after the fact.
function patchAmpSourceIntoFX() {
  if (!state.amp || !state.amp.sourceNode) return;
  try { state.amp.sourceNode.disconnect(); } catch(e) {}
  if (!fxState.chainInput) initFXChain();
  state.amp.sourceNode.connect(fxState.chainInput);
  // Also ensure chainOutput feeds the amp
  if (state.amp.nodes) {
    fxState.chainOutput.connect(state.amp.nodes.input);
  }
}

// ── PEDAL BUILDERS ────────────────────────────
// Each returns { input, output, bypass, update(params) }
// input  — receives audio in
// output — sends processed audio out
// bypass — dry passthrough (used when pedal is off)
// update — called when params change while active

function makeBypass(ctx) {
  const bypass = ctx.createGain();
  return bypass;
}

function buildCompressor(ctx, params) {
  const input    = ctx.createGain();
  const comp     = ctx.createDynamicsCompressor();
  const makeupG  = ctx.createGain();
  const output   = ctx.createGain();
  const bypass   = makeBypass(ctx);

  input.connect(comp);
  comp.connect(makeupG);
  makeupG.connect(output);

  function update(p) {
    comp.threshold.value = p.threshold;
    comp.ratio.value     = p.ratio;
    comp.attack.value    = p.attack / 1000;
    comp.release.value   = p.release / 1000;
    comp.knee.value      = 6;
    makeupG.gain.value   = Math.pow(10, p.gain / 20);
  }
  update(params);
  return { input, output, bypass, update };
}

function buildNoiseGate(ctx, params) {
  const input    = ctx.createGain();
  const shaper   = ctx.createWaveShaper();
  const output   = ctx.createGain();
  const bypass   = makeBypass(ctx);

  input.connect(shaper);
  shaper.connect(output);

  function makeCurve(threshold, smoothing) {
    const n = 4096, curve = new Float32Array(n);
    const t  = threshold / 100;
    const sm = 1 - (smoothing / 100) * 0.98; // smoothing → slope steepness
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1, ax = Math.abs(x);
      if (ax < t) {
        curve[i] = x * Math.pow(ax / t, 1 / sm) * 0.05;
      } else {
        curve[i] = x;
      }
    }
    return curve;
  }

  function update(p) {
    shaper.curve = makeCurve(p.threshold, p.smoothing);
  }
  update(params);
  return { input, output, bypass, update };
}

function buildOverdrive(ctx, params) {
  const input    = ctx.createGain();
  const preGain  = ctx.createGain();
  // Pre-drive bass rolloff: cuts low-end before saturation to prevent mud,
  // mirrors what a real tube input cap does (think TS-808 input filter).
  const preHP    = ctx.createBiquadFilter(); preHP.type = 'highpass'; preHP.frequency.value = 140; preHP.Q.value = 0.55;
  const shaper   = ctx.createWaveShaper(); shaper.oversample = '4x';
  // Parallel clean low restore — blends in unclipped bass after the shaper
  const lowSplit = ctx.createGain(); lowSplit.gain.value = 1;
  const lowLPF   = ctx.createBiquadFilter(); lowLPF.type = 'lowpass'; lowLPF.frequency.value = 150;
  const lowBlend = ctx.createGain(); lowBlend.gain.value = 0.5;
  const merge    = ctx.createGain();
  const toneF    = ctx.createBiquadFilter(); toneF.type = 'highshelf'; toneF.frequency.value = 1800;
  const outGain  = ctx.createGain();
  const output   = ctx.createGain();
  const bypass   = makeBypass(ctx);

  input.connect(preGain);
  preGain.connect(preHP);
  preHP.connect(shaper);
  shaper.connect(merge);
  // Parallel low path
  input.connect(lowSplit); lowSplit.connect(lowLPF); lowLPF.connect(lowBlend); lowBlend.connect(merge);
  merge.connect(toneF);
  toneF.connect(outGain);
  outGain.connect(output);

  function makeCurve(drive) {
    const n = 4096, curve = new Float32Array(n);
    const k = drive * 0.10;
    // Asymmetric soft clip with DC bias — models a single-ended tube stage.
    // Positive half saturates more gently (like the grid), negative clips harder (plate).
    const bias = 0.06;
    for (let i = 0; i < n; i++) {
      const x  = (i * 2) / n - 1;
      const xb = x + bias;
      const y  = xb > 0
        ? Math.tanh(xb * (1 + k * 0.8)) / Math.tanh(1 + k * 0.8) * 0.92
        : Math.tanh(xb * (1 + k * 1.2)) / Math.tanh(1 + k * 1.2);
      curve[i] = y - bias * 0.4; // subtract most of the DC shift back out
    }
    return curve;
  }

  function update(p) {
    preGain.gain.value  = 1 + Math.sqrt(p.drive / 100) * 3;
    shaper.curve        = makeCurve(p.drive);
    lowBlend.gain.value = 0.3 + (p.drive / 100) * 0.4; // more drive = more low restore needed
    toneF.gain.value    = (p.tone - 50) / 50 * 10;
    outGain.gain.value  = (p.level / 100) * 1.5;
  }
  update(params);
  return { input, output, bypass, update };
}

function buildDistortion(ctx, params) {
  const input    = ctx.createGain();
  const preGain  = ctx.createGain();
  // Pre-drive high-pass: kills bass before hard clipping prevents low-end flab
  const preHP    = ctx.createBiquadFilter(); preHP.type = 'highpass'; preHP.frequency.value = 200; preHP.Q.value = 0.7;
  const shaper   = ctx.createWaveShaper(); shaper.oversample = '4x';
  // Parallel clean low blend to restore body after hard clipping
  const lowSplit = ctx.createGain(); lowSplit.gain.value = 1;
  const lowLPF   = ctx.createBiquadFilter(); lowLPF.type = 'lowpass'; lowLPF.frequency.value = 140;
  const lowBlend = ctx.createGain(); lowBlend.gain.value = 0.55;
  const merge    = ctx.createGain();
  const midCut   = ctx.createBiquadFilter(); midCut.type = 'peaking'; midCut.frequency.value = 700; midCut.Q.value = 0.8;
  const toneF    = ctx.createBiquadFilter(); toneF.type = 'lowpass';
  const outGain  = ctx.createGain();
  const output   = ctx.createGain();
  const bypass   = makeBypass(ctx);

  input.connect(preGain);
  preGain.connect(preHP);
  preHP.connect(shaper);
  shaper.connect(merge);
  // Parallel low path
  input.connect(lowSplit); lowSplit.connect(lowLPF); lowLPF.connect(lowBlend); lowBlend.connect(merge);
  merge.connect(midCut);
  midCut.connect(toneF);
  toneF.connect(outGain);
  outGain.connect(output);

  function makeCurve(drive) {
    const n = 4096, curve = new Float32Array(n);
    const k = 1 + (drive / 100) * 18;
    // Asymmetric hard clip with bias — models diode asymmetry in a DS-1/MXR style circuit.
    // Positive clips at 0.92 (silicon diode drop), negative at -1.0 (harder rail).
    const bias = 0.10;
    for (let i = 0; i < n; i++) {
      const x  = (i * 2) / n - 1;
      const xb = (x + bias) * k;
      const y  = xb > 0
        ? Math.min( 0.92, xb * 0.9)   // positive: softer clip (diode forward voltage)
        : Math.max(-1.00, xb * 1.05); // negative: harder clip (rail)
      curve[i] = y - bias * k * 0.35; // compensate DC shift
    }
    return curve;
  }

  function update(p) {
    preGain.gain.value    = 1 + Math.sqrt(p.drive / 100) * 5;
    shaper.curve          = makeCurve(p.drive);
    lowBlend.gain.value   = 0.4 + (p.drive / 100) * 0.35;
    midCut.gain.value     = -8;
    toneF.frequency.value = 800 + (p.tone / 100) * 7200;
    outGain.gain.value    = (p.level / 100) * 1.2;
  }
  update(params);
  return { input, output, bypass, update };
}

function buildFuzz(ctx, params) {
  const input    = ctx.createGain();
  const preGain  = ctx.createGain();
  const shaper   = ctx.createWaveShaper(); shaper.oversample = '4x';
  // Post-shaper: fuzz needs a gentle LP to tame aliasing fizz, plus a resonant
  // mid-peak to give it that classic nasal germanium honk
  const midPeak  = ctx.createBiquadFilter(); midPeak.type = 'peaking'; midPeak.frequency.value = 1000; midPeak.Q.value = 1.2; midPeak.gain.value = 4;
  const toneF    = ctx.createBiquadFilter(); toneF.type = 'lowpass';
  const outGain  = ctx.createGain();
  const output   = ctx.createGain();
  const bypass   = makeBypass(ctx);

  input.connect(preGain);
  preGain.connect(shaper);
  shaper.connect(midPeak);
  midPeak.connect(toneF);
  toneF.connect(outGain);
  outGain.connect(output);

  function makeCurve(fuzz) {
    const n = 4096, curve = new Float32Array(n);
    const k = 0.1 + (fuzz / 100) * 0.88;
    // Germanium transistor bias drift: operating point shifts with fuzz knob,
    // making the clipping highly asymmetric at high settings (classic Fuzz Face behaviour).
    // At low fuzz it's nearly clean; at high fuzz positive clips much harder than negative.
    const bias = (fuzz / 100) * 0.22;
    for (let i = 0; i < n; i++) {
      const x  = (i * 2) / n - 1;
      const xb = x + bias;
      let y;
      if (xb > k) {
        // Positive: hard clip + small overshoot rolloff (germanium softens near rail)
        y = k + (xb - k) * 0.04;
      } else if (xb < -(k * 0.7)) {
        // Negative: clips at a lower threshold — asymmetric, gets more 2nd harmonic
        y = -(k * 0.7) + (xb + k * 0.7) * 0.06;
      } else {
        y = xb;
      }
      curve[i] = y - bias * 0.5;
    }
    return curve;
  }

  function update(p) {
    preGain.gain.value    = 2 + Math.sqrt(p.fuzz / 100) * 6;
    shaper.curve          = makeCurve(p.fuzz);
    toneF.frequency.value = 500 + (p.tone / 100) * 4500;
    outGain.gain.value    = (p.level / 100) * 1.0;
  }
  update(params);
  return { input, output, bypass, update };
}

function buildAutoWah(ctx, params) {
  const input    = ctx.createGain();
  const analyser = ctx.createAnalyser();
  const filter   = ctx.createBiquadFilter();
  const makeup   = ctx.createGain();
  const output   = ctx.createGain();
  const bypass   = makeBypass(ctx);

  filter.type = 'bandpass';
  input.connect(analyser);
  input.connect(filter);
  filter.connect(makeup);
  makeup.connect(output);

  analyser.fftSize = 256;
  const buf = new Uint8Array(analyser.fftSize); // was frequencyBinCount (half size) — undersampled the envelope

  let raf = null;
  function tick() {
    raf = requestAnimationFrame(tick);
    analyser.getByteTimeDomainData(buf);
    let rms = 0;
    for (let i = 0; i < buf.length; i++) {
      const s = (buf[i] - 128) / 128;
      rms += s * s;
    }
    rms = Math.sqrt(rms / buf.length);
    const p  = fxState.pedals['wah'] ? fxState.pedals['wah'].params : params;
    const env = Math.min(1, rms * p.sensitivity);
    const freq = p.freqLo + env * (p.freqHi - p.freqLo);
    filter.frequency.setTargetAtTime(freq, ctx.currentTime, p.speed / 1000 + 0.001);
    filter.Q.value = p.resonance;
  }
  tick();

  function update(p) {
    filter.Q.value = p.resonance;
    makeup.gain.value = 1 + p.resonance / 3;
  }
  update(params);

  // Store cancel so we can stop when pedal is removed
  return { input, output, bypass, update, _stopRAF: () => cancelAnimationFrame(raf) };
}

function buildOctaver(ctx, params) {
  const input    = ctx.createGain();
  const output   = ctx.createGain();
  const bypass   = makeBypass(ctx);

  // Dry path
  const dryGain  = ctx.createGain();
  // Sub-octave: ring modulate with a sine that TRACKS the detected pitch ÷2
  const subOsc   = ctx.createOscillator();
  const subRing  = ctx.createGain();
  const subGain  = ctx.createGain();
  // Oct-up: full-wave rectify approximation via waveshaper
  const upShaper = ctx.createWaveShaper();
  const upGain   = ctx.createGain();

  // Pitch-tracking analyser feeding subOsc.frequency
  const trackAnalyser = ctx.createAnalyser();
  trackAnalyser.fftSize = 2048;
  input.connect(trackAnalyser);
  const trackBuf = new Float32Array(trackAnalyser.fftSize);
  let trackRAF = null;
  function trackPitch() {
    trackRAF = requestAnimationFrame(trackPitch);
    trackAnalyser.getFloatTimeDomainData(trackBuf);
    const freq = autoCorrelate(trackBuf, ctx.sampleRate);
    if (freq > 20 && freq < 1500) {
      subOsc.frequency.setTargetAtTime(freq / 2, ctx.currentTime, 0.03);
    }
  }
  trackPitch();

  // Sub octave via ring mod trick
  subOsc.frequency.value = 55; // initial guess until pitch tracking kicks in
  subOsc.type = 'sine';
  subOsc.start();

  const upCurve = new Float32Array(4096);
  for (let i = 0; i < 4096; i++) {
    const x = (i * 2) / 4096 - 1;
    upCurve[i] = Math.abs(x) * 2 - 1; // full-wave rectify → octave up
  }
  upShaper.curve = upCurve;

  input.connect(dryGain);
  subRing.gain.value = 0;            // base offset for true ring-mod (multiplicative)
  input.connect(subRing);            // signal → audio input
  subOsc.connect(subRing.gain);      // oscillator → gain PARAM = actual ring modulation
  subRing.connect(subGain);
  input.connect(upShaper);  upShaper.connect(upGain);
  dryGain.connect(output);
  subGain.connect(output);
  upGain.connect(output);

  function update(p) {
    dryGain.gain.value = p.dryLevel / 100;
    subGain.gain.value = p.subLevel / 100;
    upGain.gain.value  = p.upLevel  / 100;
  }
  update(params);
  return { input, output, bypass, update, _stopRAF: () => cancelAnimationFrame(trackRAF) };
}

function buildChorus(ctx, params) {
  const input   = ctx.createGain();
  const output  = ctx.createGain();
  const bypass  = makeBypass(ctx);
  const dry     = ctx.createGain();
  const wet     = ctx.createGain();
  const delay   = ctx.createDelay(0.05);
  const lfo     = ctx.createOscillator();
  const lfoGain = ctx.createGain();

  lfo.type = 'sine';
  lfo.start();
  lfo.connect(lfoGain);
  lfoGain.connect(delay.delayTime);
  delay.delayTime.value = 0.02;

  input.connect(dry);
  input.connect(delay); delay.connect(wet);
  dry.connect(output);
  wet.connect(output);

  function update(p) {
    lfo.frequency.value  = p.rate;
    lfoGain.gain.value   = (p.depth / 100) * 0.008;
    delay.delayTime.value = 0.015 + (p.depth / 100) * 0.010;
    const wetAmt = p.mix / 100;
    wet.gain.value = wetAmt;
    dry.gain.value = 1 - wetAmt * 0.5;
  }
  update(params);
  return { input, output, bypass, update };
}

function buildFlanger(ctx, params) {
  const input    = ctx.createGain();
  const output   = ctx.createGain();
  const bypass   = makeBypass(ctx);
  const dry      = ctx.createGain();
  const wet      = ctx.createGain();
  const delay    = ctx.createDelay(0.02);
  const feedback = ctx.createGain();
  const lfo      = ctx.createOscillator();
  const lfoGain  = ctx.createGain();

  lfo.type = 'sine';
  lfo.start();
  lfo.connect(lfoGain);
  lfoGain.connect(delay.delayTime);

  input.connect(dry);
  input.connect(delay);
  delay.connect(feedback); feedback.connect(delay);
  delay.connect(wet);
  dry.connect(output);
  wet.connect(output);

  function update(p) {
    lfo.frequency.value  = p.rate;
    lfoGain.gain.value   = (p.depth / 100) * 0.004;
    delay.delayTime.value = 0.003;
    feedback.gain.value  = (p.feedback / 100) * 0.8;
    const wetAmt = p.mix / 100;
    wet.gain.value = wetAmt;
    dry.gain.value = 1 - wetAmt * 0.4;
  }
  update(params);
  return { input, output, bypass, update };
}

function buildPhaser(ctx, params) {
  const input    = ctx.createGain();
  const output   = ctx.createGain();
  const bypass   = makeBypass(ctx);
  const dry      = ctx.createGain();
  const wet      = ctx.createGain();
  const lfo      = ctx.createOscillator();
  const lfoGain  = ctx.createGain();
  const fbGain   = ctx.createGain();

  lfo.type = 'sine';
  lfo.start();
  lfo.connect(lfoGain);

  // Build 4 all-pass stages max; extras are bypassed
  const stages = [];
  for (let i = 0; i < 4; i++) {
    const ap = ctx.createBiquadFilter();
    ap.type = 'allpass';
    ap.frequency.value = 800 + i * 200;
    ap.Q.value = 0.5;
    lfoGain.connect(ap.frequency);
    stages.push(ap);
  }

  // Chain stages
  let prev = input;
  stages.forEach(ap => { prev.connect(ap); prev = ap; });
  prev.connect(fbGain); fbGain.connect(input); // feedback path
  input.connect(dry);
  prev.connect(wet);
  dry.connect(output);
  wet.connect(output);

  function update(p) {
    lfo.frequency.value = p.rate;
    const sweep = (p.depth / 100) * 600;
    lfoGain.gain.value  = sweep;
    fbGain.gain.value   = (p.feedback / 100) * 0.7;
    const wetAmt = p.mix / 100;
    wet.gain.value = wetAmt;
    dry.gain.value = 1 - wetAmt * 0.5;
  }
  update(params);
  return { input, output, bypass, update };
}

function buildTremolo(ctx, params) {
  const input   = ctx.createGain();
  const output  = ctx.createGain();
  const bypass  = makeBypass(ctx);
  const ampMod  = ctx.createGain();
  const lfo     = ctx.createOscillator();
  const lfoGain = ctx.createGain();

  lfo.type = 'sine';
  lfo.start();
  lfo.connect(lfoGain);
  lfoGain.connect(ampMod.gain);
  ampMod.gain.value = 1;

  input.connect(ampMod);
  ampMod.connect(output);

  function update(p) {
    lfo.type = p.shape === 0 ? 'sine' : 'square';
    lfo.frequency.value = p.rate;
    const depth = p.depth / 100;
    lfoGain.gain.value  = depth * 0.5;
    ampMod.gain.value   = 1 - depth * 0.5;
  }
  update(params);
  return { input, output, bypass, update };
}

function buildDelay(ctx, params) {
  const input    = ctx.createGain();
  const output   = ctx.createGain();
  const bypass   = makeBypass(ctx);
  const dry      = ctx.createGain();
  const wet      = ctx.createGain();
  const delay    = ctx.createDelay(2.0);
  const feedback = ctx.createGain();
  const toneF    = ctx.createBiquadFilter();

  toneF.type = 'lowpass';
  input.connect(dry);
  input.connect(delay);
  delay.connect(toneF); toneF.connect(feedback);
  feedback.connect(delay);
  toneF.connect(wet);
  dry.connect(output);
  wet.connect(output);

  function update(p) {
    delay.delayTime.setTargetAtTime(p.time / 1000, ctx.currentTime, 0.01);
    feedback.gain.value  = (p.feedback / 100) * 0.95;
    toneF.frequency.value = p.tone;
    const wetAmt = p.mix / 100;
    wet.gain.value = wetAmt;
    dry.gain.value = 1;
  }
  update(params);
  return { input, output, bypass, update };
}

function buildReverb(ctx, params) {
  const input     = ctx.createGain();
  const output    = ctx.createGain();
  const bypass    = makeBypass(ctx);
  const dry       = ctx.createGain();
  const wet       = ctx.createGain();
  const preDelay  = ctx.createDelay(0.2);
  const convolver = ctx.createConvolver();
  const dampF     = ctx.createBiquadFilter();

  dampF.type = 'lowpass';
  input.connect(dry);
  input.connect(preDelay);
  preDelay.connect(convolver);
  convolver.connect(dampF);
  dampF.connect(wet);
  dry.connect(output);
  wet.connect(output);

  function makeIR(decay, size, damping) {
    const len    = Math.max(0.1, decay) * ctx.sampleRate;
    const buf    = ctx.createBuffer(2, len, ctx.sampleRate);
    const damp   = 1 - (damping / 100) * 0.9;
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const n = Math.random() * 2 - 1;
        data[i] = n * Math.pow(1 - i / len, 1 / (size * 2 + 0.5)) * Math.pow(damp, i / ctx.sampleRate * 10);
      }
    }
    return buf;
  }

  function update(p) {
    convolver.buffer = makeIR(p.decay, p.size, p.damping);
    preDelay.delayTime.value = p.predelay / 1000;
    dampF.frequency.value    = 3000 - (p.damping / 100) * 2500;
    const wetAmt = p.mix / 100;
    wet.gain.value = wetAmt;
    dry.gain.value = 1;
  }
  update(params);
  return { input, output, bypass, update };
}

// Tuner — analyser only, no audio routing node needed
function buildTuner(ctx) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 8192;
  return analyser;
}

// ── TUNER ENGINE ──────────────────────────────
let tunerRAF = null;
let tunerAnalyser = null;

function startTuner(ctx) {
  if (tunerRAF) return;

  // chainInput may not exist yet if the amp source hasn't connected through
  // initFXChain() yet. Fall back to tapping the raw amp source directly so
  // the tuner still works instead of throwing and silently dying.
  const tapNode = fxState.chainInput || (state.amp && state.amp.sourceNode) || null;
  if (!tapNode) {
    updateTunerDisplay(-1);
    const noteEl = document.getElementById('tuner-cents');
    if (noteEl) noteEl.textContent = 'No input connected';
    return;
  }

  tunerAnalyser = ctx.createAnalyser();
  tunerAnalyser.fftSize = 8192;

  const tunerBoost = ctx.createGain();
  tunerBoost.gain.value = 6;                 // raw input is too quiet to autocorrelate reliably
  tapNode.connect(tunerBoost);
  tunerBoost.connect(tunerAnalyser);
  tunerAnalyser._boost = tunerBoost;         // so we can clean up

  const buf = new Float32Array(tunerAnalyser.fftSize);
  function tick() {
    tunerRAF = requestAnimationFrame(tick);
    tunerAnalyser.getFloatTimeDomainData(buf);
    const freq = autoCorrelate(buf, ctx.sampleRate);
    updateTunerDisplay(freq);
  }
  tick();
}

function stopTuner() {
  if (tunerRAF) { cancelAnimationFrame(tunerRAF); tunerRAF = null; }
  if (tunerAnalyser) {
    try { if (tunerAnalyser._boost) tunerAnalyser._boost.disconnect(); } catch(e){}
    try { tunerAnalyser.disconnect(); } catch(e){}
    tunerAnalyser = null;
  }
}

function autoCorrelate(buf, sampleRate) {
  // RMS check — if signal is too quiet, bail
  let rms = 0;
  for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / buf.length);
  if (rms < 0.01) return -1;

  // Autocorrelation pitch detection
  let r1 = 0, r2 = buf.length - 1;
  const thres = 0.2;
  for (let i = 0; i < buf.length / 2; i++) { if (Math.abs(buf[i]) < thres) { r1 = i; break; } }
  for (let i = 1; i < buf.length / 2; i++) { if (Math.abs(buf[buf.length - i]) < thres) { r2 = buf.length - i; break; } }

  const slice = buf.slice(r1, r2);
  const n = slice.length;
  // True autocorrelation: c[lag] = Σ slice[i] * slice[i+lag]
  const c = new Float32Array(n);
  for (let lag = 0; lag < n; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) sum += slice[i] * slice[i + lag];
    c[lag] = sum;
  }

  // Walk past the initial downslope from lag 0, then find the first/best peak
  let d = 0;
  while (d + 1 < n && c[d] > c[d + 1]) d++;
  let maxVal = -1, maxIdx = -1;
  for (let i = d; i < n; i++) { if (c[i] > maxVal) { maxVal = c[i]; maxIdx = i; } }
  if (maxIdx < 1 || maxIdx >= n - 1) return -1;

  // Parabolic interpolation for sub-sample accuracy
  let y1 = c[maxIdx - 1], y2 = c[maxIdx], y3 = c[maxIdx + 1];
  let shift = (y3 - y1) / (2 * (2 * y2 - y1 - y3));
  return sampleRate / (maxIdx + shift);
}

function updateTunerDisplay(freq) {
  const noteEl  = document.getElementById('tuner-note');
  const centsEl = document.getElementById('tuner-cents');
  const bar     = document.getElementById('tuner-bar');
  if (!noteEl) return;

  if (freq < 20) {
    noteEl.textContent  = '—';
    centsEl.textContent = 'No signal';
    if (bar) { bar.style.left = '50%'; bar.classList.remove('in-tune'); }
    return;
  }

  const noteNum  = 69 + 12 * Math.log2(freq / 440);
  const rounded  = Math.round(noteNum);
  const cents    = Math.round((noteNum - rounded) * 100);
  const names    = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const noteName = names[((rounded % 12) + 12) % 12];
  const octave   = Math.floor(rounded / 12) - 1;

  noteEl.textContent  = noteName + octave;
  centsEl.textContent = (cents >= 0 ? '+' : '') + cents + ' cents';
  if (bar) {
    bar.style.left = (50 + cents / 2) + '%';
    bar.classList.toggle('in-tune', Math.abs(cents) <= 5);
  }
}

// ── UI BUILD ──────────────────────────────────
function buildFXUI() {
  const list = document.getElementById('fx-pedal-list');
  if (!list) return;
  list.innerHTML = '';

  PEDAL_DEFS.forEach(def => {
    const pedal = fxState.pedals[def.id];
    const el    = document.createElement('div');
    el.className = 'pedal';
    el.id = 'pedal-' + def.id;

    if (def.id === 'tuner') {
      el.innerHTML = `
        <div class="pedal-header">
          <div class="pedal-bypass"><div class="pedal-bypass-dot"></div></div>
          <span class="pedal-name">${def.name}</span>
          <span class="pedal-desc">${def.desc}</span>
        </div>
        <div class="tuner-display">
          <div class="tuner-note" id="tuner-note">—</div>
          <div class="tuner-cents" id="tuner-cents">No signal</div>
          <div class="tuner-bar-wrap"><div class="tuner-bar" id="tuner-bar"></div></div>
        </div>
      `;
      const bypassDot = el.querySelector('.pedal-bypass');
      bypassDot.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePedal(def.id, el);
      });
      list.appendChild(el);
      return;
    }

    // Param rows
    const paramRows = (def.params || []).map(p => `
      <div class="pedal-row" data-param="${p.id}">
        <span class="pedal-row-label">${p.label}</span>
        <input type="range" class="fx-slider"
          min="${p.min}" max="${p.max}" step="${p.step}" value="${p.default}" />
        <span class="pedal-row-value">${p.fmt(p.default)}</span>
      </div>
    `).join('');

    el.innerHTML = `
      <div class="pedal-header">
        <div class="pedal-bypass"><div class="pedal-bypass-dot"></div></div>
        <span class="pedal-name">${def.name}</span>
        <span class="pedal-desc">${def.desc}</span>
      </div>
      <div class="pedal-controls">${paramRows}</div>
    `;

    const header = el.querySelector('.pedal-header');
    const bypassDot = el.querySelector('.pedal-bypass');

    // Footswitch dot: ONLY thing that turns the pedal on/off.
    bypassDot.addEventListener('click', (e) => {
      e.stopPropagation();
      setPedalActive(def.id, el, !pedal.active);
    });

    // Header (name/desc area): ONLY expands/collapses the controls.
    // Does not touch active state, so there's no on/off ambiguity to fight with.
    header.addEventListener('click', (e) => {
      if (e.target === bypassDot || bypassDot.contains(e.target)) return;
      pedal.open = !pedal.open;
      el.classList.toggle('open', pedal.open);
    });

    // Wire sliders
    (def.params || []).forEach((p, i) => {
      const row    = el.querySelectorAll('.pedal-row')[i];
      const slider = row.querySelector('.fx-slider');
      const valEl  = row.querySelector('.pedal-row-value');
      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        pedal.params[p.id] = v;
        valEl.textContent   = p.fmt(v);
        if (pedal.active && pedal.nodes && pedal.nodes.update) {
          pedal.nodes.update(pedal.params);
        }
      });
    });

    list.appendChild(el);
  });

  // Bypass all button
  document.getElementById('fx-bypass-all').addEventListener('click', () => {
    const anyActive = Object.values(fxState.pedals).some(p => p.active);
    PEDAL_DEFS.forEach(def => {
      const el = document.getElementById('pedal-' + def.id);
      if (el) setPedalActive(def.id, el, !anyActive);
    });
  });
}

function togglePedal(id, el) {
  const pedal = fxState.pedals[id];
  if (!pedal) return;

  if (id === 'tuner') {
    pedal.active = !pedal.active;
    pedal.open   = pedal.active;
    el.classList.toggle('active', pedal.active);
    el.classList.toggle('open', pedal.open);
    const ctx = getAudio();
    if (pedal.active) startTuner(ctx);
    else              stopTuner();
    return;
  }
}

function setPedalActive(id, el, active) {
  const pedal = fxState.pedals[id];
  if (!pedal) return;
  pedal.active = active;
  if (!active) pedal.open = false;
  el.classList.toggle('active', active);
  el.classList.toggle('open', pedal.open);
  if (fxState.chainInput) rewireChain(getAudio());
}

// (Per-pedal on/off is now handled entirely by the footswitch dot's click
// handler in buildFXUI — no long-press needed, and no race with the
// browser's synthetic click-after-touchend that used to re-enable pedals.)

// ── PATCH AMP CONNECTION ──────────────────────
// Override the amp module's source connection to route through FX.
// We do this by polling for amp source readiness.
function watchForAmpSource() {
  const interval = setInterval(() => {
    if (state.amp && state.amp.sourceNode) {
      clearInterval(interval);
      if (!fxState.chainInput) initFXChain();
      patchAmpSourceIntoFX();
    }
  }, 200);
}

// Also patch the original connect functions so re-connections go through FX.
(function patchAmpConnectors() {
  const origDefault  = window.connectDefaultInput;
  const origDeviceId = window.connectAmpInput;

  if (origDefault) {
    window.connectDefaultInput = async function() {
      await origDefault.apply(this, arguments);
      setTimeout(patchAmpSourceIntoFX, 200);
    };
  }
  if (origDeviceId) {
    window.connectAmpInput = async function() {
      await origDeviceId.apply(this, arguments);
      setTimeout(patchAmpSourceIntoFX, 200);
    };
  }
})();

// ── INIT ─────────────────────────────────────
function initFX() {
  // Initialize pedal state map (no audio yet — ctx may not exist)
  PEDAL_DEFS.forEach(def => {
    if (!fxState.pedals[def.id]) {
      const params = {};
      (def.params || []).forEach(p => { params[p.id] = p.default; });
      fxState.pedals[def.id] = { active: false, open: false, params, nodes: null };
    }
  });

  buildFXUI();

  // Watch for amp source to patch into FX chain
  watchForAmpSource();
}

initFX();

// ── Expose FX state for relay-peer.js AI bots ──────────────────
// fxState.pedals is the live map of { active, params } per pedal ID.
// relay-peer reads this to modulate bot intensity based on your FX chain.
window.fxState = fxState;

// Also create a post-chain analyser tap that AI0008 (pitch-tracking lead
// bot) can read. We create it lazily once chainInput exists, so it always
// taps the signal AFTER your guitar input hits the FX chain — same signal
// the octaver's own pitch tracker uses, just exposed on window.
(function mountRelayAnalyser() {
  function tryMount() {
    if (!fxState.chainInput) return; // chain not wired yet — retry shortly
    if (window._relayAnalyser) return; // already mounted

    const ctx = getAudio ? getAudio() : (window.state && window.state.amp && window.state.amp.ctx);
    if (!ctx) return;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    fxState.chainInput.connect(analyser); // passive tap — doesn't affect routing
    window._relayAnalyser = analyser;
  }

  // Try immediately, then poll until chainInput exists
  tryMount();
  const poll = setInterval(() => {
    tryMount();
    if (window._relayAnalyser) clearInterval(poll);
  }, 500);
})();
