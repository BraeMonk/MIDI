/* ─────────────────────────────────────────────
   RELAY — MIDI Controller PWA  ·  app.js v0.2.1
   ───────────────────────────────────────────── */

'use strict';

// ── AUDIO CONTEXT ──────────────────────────────
let audioCtx = null;
function getAudio() {
  if (!audioCtx) {
    // Explicit 48kHz: most USB audio interfaces (including the Scarlett Solo)
    // run natively at 48kHz. Letting the browser pick its own default risked
    // a 44.1k context fighting a 48k input — that 160:147 resample ratio is
    // one of the worst cases for audio resamplers and is a common source of
    // grainy/aliased-sounding live input.
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
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

// ── DRUM NOISE BUFFER CACHE ────────────────────
// Snare and hi-hat synthesis fill a noise buffer on every hit.
// Pre-generating once and reusing avoids per-hit allocation spikes
// that can nuke the audio graph when a drum bot fires rapidly.
const _noiseCache = {};
function getNoiseBuf(ctx, seconds, key) {
  if (_noiseCache[key] && _noiseCache[key].ctx === ctx) return _noiseCache[key].buf;
  const len = Math.ceil(ctx.sampleRate * seconds);
  const buf  = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  if (key === 'hat') {
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.7 +
                Math.sin(i * 0.29) * 0.15 +
                Math.sin(i * 0.47) * 0.15;
    }
  } else {
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }
  _noiseCache[key] = { ctx, buf };
  return buf;
}


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
  bpm: 120,
  bpmIsDefault: true,  // becomes false once the user taps in a real tempo
  tapTimes: [],
  clockOrigin: null,   // AudioContext time the global bar grid started
  loopLen: 0,          // shared bar length in seconds (set from BPM on first arm)
  keyEls: new Map(),
  // assign modal state
  assignSampleId: null,
  assignPadIndex: null,
  // pad loop sequencer
  loopMode: false,
  padLoops: new Map(), // padIndex -> { status, taps:[{t,vel}], nextIdx }
  loopSchedulerId: null,
};

const LONG_PRESS_MS = 550;
const LOOP_TICK_MS  = 30;

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
  // Restore scale
  const sr = localStorage.getItem('relay-scale-root'); if (sr) state.scaleRoot = sr;
  const st = localStorage.getItem('relay-scale-type'); if (st) state.scaleType = st;
  // Restore tempo
  const bpm = localStorage.getItem('relay-bpm');
  if (bpm) { state.bpm = parseInt(bpm); state.bpmIsDefault = false; }
}
function saveSettings() {
  localStorage.setItem('relay-channel',     state.channel);
  localStorage.setItem('relay-vel-curve',   state.velCurve);
  localStorage.setItem('relay-octave',      state.octave);
  localStorage.setItem('relay-transpose',   state.transpose);
  localStorage.setItem('relay-show-labels', state.showLabels);
  if (state.wsUrl) localStorage.setItem('relay-ws-url', state.wsUrl);
  // Session persistence — scale and tempo
  localStorage.setItem('relay-scale-root', state.scaleRoot);
  localStorage.setItem('relay-scale-type', state.scaleType);
  if (!state.bpmIsDefault) localStorage.setItem('relay-bpm', state.bpm);
  // Active bots — save codes so they can be restored on next load
  if (window.RelayPeer && window.RelayPeer.activeBotCodes) {
    localStorage.setItem('relay-bots', JSON.stringify(window.RelayPeer.activeBotCodes()));
  }
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
      // Sine + detuned triangle for a warm, airy pad — not muffled
      osc  = ctx.createOscillator(); osc.type  = 'sine';
      osc2 = ctx.createOscillator(); osc2.type = 'triangle';
      osc.frequency.value  = freq;
      osc2.frequency.value = freq * 0.998; // slight detune for chorus width
      filter.frequency.value = 1800 + vel01 * 2000; // much more open — not muddy
      filter.Q.value = 0.4; // low Q, no resonant peak
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(vel01 * 0.22, ctx.currentTime + 0.18); // slow bloom
      break;
    }
    case 'bass': {
      // Sawtooth root + detuned sine sub — warm and full, not buzzy
      osc  = ctx.createOscillator(); osc.type  = 'sawtooth';
      osc2 = ctx.createOscillator(); osc2.type = 'sine'; // sine sub instead of square
      osc.frequency.value  = freq;
      osc2.frequency.value = freq * 0.5; // one octave DOWN for sub warmth, not up
      filter.frequency.value = 500 + vel01 * 1200; // tighter, punchy
      filter.Q.value = 0.8; // low Q — no farty resonance
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(vel01 * 0.35, ctx.currentTime + 0.012); // fast attack
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
  if (window.RelayPeer && !window._p2pReceiving) window.RelayPeer.broadcast({ type: 'noteOn', note, velocity });

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
  if (window.RelayPeer && !window._p2pReceiving) window.RelayPeer.broadcast({ type: 'noteOff', note });

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
// ── KIT SYNTH PROFILES ─────────────────────────
// Each kit defines synthesis parameters per voice category.
// freqStart/freqEnd: kick pitch sweep. decay: envelope length in seconds.
// noiseFreq/noiseQ/noiseType: snare/hat filter. body: sine layer mix on snare (0=off).
// tomPitches: [low,mid,hi] frequencies. crashDecay/rideDecay: cymbal lengths.
const KIT_PROFILES = {
  classic: {
    // Warm, punchy 70s/80s rock kit — round kick, crisp snare, bright hats
    kick:      { freqStart: 160, freqEnd: 42,  pitchTime: 0.10, decay: 0.45, drive: 1.0  },
    snare:     { noiseFreq: 2800, noiseQ: 0.6, noiseType: 'bandpass', decay: 0.20, body: 0.35, bodyFreq: 200 },
    hhClosed:  { hipass: 7500,  decay: 0.055, vol: 0.5 },
    hhOpen:    { hipass: 6500,  decay: 0.30,  vol: 0.45 },
    tom:       { pitches: [95, 135, 185], decay: 0.32, endFreq: 38 },
    crash:     { decay: 0.9,  hipass: 5000, vol: 0.5 },
    ride:      { decay: 0.5,  hipass: 6000, vol: 0.38 },
    rim:       { freq: 1800,  Q: 2.0, decay: 0.07 },
    cowbell:   { freq: 562,   decay: 0.45 },
  },
  electronic: {
    // Tight, punchy electronic/dance kit — sub kick, sharp snare, metallic hats
    kick:      { freqStart: 220, freqEnd: 28,  pitchTime: 0.06, decay: 0.30, drive: 1.3  },
    snare:     { noiseFreq: 4500, noiseQ: 1.2, noiseType: 'bandpass', decay: 0.10, body: 0.15, bodyFreq: 240 },
    hhClosed:  { hipass: 9000,  decay: 0.025, vol: 0.55 },
    hhOpen:    { hipass: 8500,  decay: 0.18,  vol: 0.5  },
    tom:       { pitches: [110, 155, 210], decay: 0.18, endFreq: 45 },
    crash:     { decay: 0.55, hipass: 6500, vol: 0.45 },
    ride:      { decay: 0.3,  hipass: 7500, vol: 0.4  },
    rim:       { freq: 2200,  Q: 3.0, decay: 0.04 },
    cowbell:   { freq: 800,   decay: 0.22 },
  },
  hiphop: {
    // Boomy, slow-decay, lo-fi hip-hop — massive low kick, fat snare, dusty hats
    kick:      { freqStart: 120, freqEnd: 32,  pitchTime: 0.18, decay: 0.70, drive: 0.9  },
    snare:     { noiseFreq: 1800, noiseQ: 0.4, noiseType: 'bandpass', decay: 0.32, body: 0.6, bodyFreq: 155 },
    hhClosed:  { hipass: 5500,  decay: 0.09,  vol: 0.35 },
    hhOpen:    { hipass: 5000,  decay: 0.40,  vol: 0.32 },
    tom:       { pitches: [70,  105, 150], decay: 0.50, endFreq: 28 },
    crash:     { decay: 1.1,  hipass: 4000, vol: 0.4  },
    ride:      { decay: 0.65, hipass: 5000, vol: 0.3  },
    rim:       { freq: 1200,  Q: 1.5, decay: 0.10 },
    cowbell:   { freq: 420,   decay: 0.60 },
  },
  acoustic: {
    // Natural, roomy acoustic kit — woody toms, snappy snare with body, washy cymbals
    kick:      { freqStart: 100, freqEnd: 48,  pitchTime: 0.14, decay: 0.55, drive: 0.85 },
    snare:     { noiseFreq: 3500, noiseQ: 0.5, noiseType: 'bandpass', decay: 0.28, body: 0.8, bodyFreq: 175 },
    hhClosed:  { hipass: 8000,  decay: 0.07,  vol: 0.42 },
    hhOpen:    { hipass: 7000,  decay: 0.50,  vol: 0.38 },
    tom:       { pitches: [88,  125, 170], decay: 0.45, endFreq: 42 },
    crash:     { decay: 1.4,  hipass: 4500, vol: 0.55 },
    ride:      { decay: 0.9,  hipass: 5500, vol: 0.45 },
    rim:       { freq: 1500,  Q: 1.8, decay: 0.09 },
    cowbell:   { freq: 562,   decay: 0.45 },
  },
};

function triggerDrum(def, velocity, el) {
  if (window.RelayPeer && !window._p2pReceiving) window.RelayPeer.broadcast({ type: 'drum', note: def.note, velocity });
  // ── SAMPLE OVERRIDE ───────────────────────────
  if (def.sampleId) {
    const s = state.samples.find(smpl => smpl.id === def.sampleId);
    if (s) {
      const ctx   = getAudio();
      const vel01 = velocity / 127;
      const play  = (buf) => {
        const src  = ctx.createBufferSource();
        const gain = ctx.createGain();
        src.buffer     = buf;
        gain.gain.value = vel01;
        src.connect(gain);
        gain.connect(state.masterGain);
        src.start();
      };
      if (s.buffer) {
        play(s.buffer);
      } else {
        s.blob.arrayBuffer()
          .then(ab => ctx.decodeAudioData(ab))
          .then(buf => { s.buffer = buf; play(buf); });
      }
      return; // skip synth
    }
  }

  const ctx    = getAudio();
  const vel01  = velocity / 127;
  const now    = ctx.currentTime;
  const prof   = KIT_PROFILES[state.kitName] || KIT_PROFILES.classic;

  if (def.note === 36 || def.note === 35) {
    // ── KICK ──────────────────────────────────────
    const p = prof.kick;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    // Add a click transient layer for punch
    const click = ctx.createOscillator();
    const cGain = ctx.createGain();
    click.frequency.value = 1800;
    cGain.gain.setValueAtTime(vel01 * 0.3 * p.drive, now);
    cGain.gain.exponentialRampToValueAtTime(0.001, now + 0.012);
    click.connect(cGain); cGain.connect(state.masterGain);
    click.start(now); click.stop(now + 0.02);
    // Main body
    osc.frequency.setValueAtTime(p.freqStart, now);
    osc.frequency.exponentialRampToValueAtTime(p.freqEnd, now + p.pitchTime);
    gain.gain.setValueAtTime(vel01 * p.drive, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + p.decay);
    osc.connect(gain); gain.connect(state.masterGain);
    osc.start(now); osc.stop(now + p.decay);

  } else if (def.note === 38 || def.note === 40) {
    // ── SNARE ─────────────────────────────────────
    const p = prof.snare;
    // Noise layer (buffer pre-generated and cached — avoids per-hit allocation)
    const buf  = getNoiseBuf(ctx, 0.4, 'snare');
    const src  = ctx.createBufferSource();
    const filt = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = buf;
    filt.type = p.noiseType; filt.frequency.value = p.noiseFreq; filt.Q.value = p.noiseQ;
    gain.gain.setValueAtTime(vel01 * 0.7, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + p.decay);
    src.connect(filt); filt.connect(gain); gain.connect(state.masterGain);
    src.start(now);
    // Tonal body (gives snare its "crack" weight — more prominent in acoustic/hiphop)
    if (p.body > 0) {
      const osc  = ctx.createOscillator();
      const oGain = ctx.createGain();
      osc.frequency.setValueAtTime(p.bodyFreq, now);
      osc.frequency.exponentialRampToValueAtTime(p.bodyFreq * 0.5, now + p.decay * 0.5);
      oGain.gain.setValueAtTime(vel01 * p.body, now);
      oGain.gain.exponentialRampToValueAtTime(0.001, now + p.decay * 0.6);
      osc.connect(oGain); oGain.connect(state.masterGain);
      osc.start(now); osc.stop(now + p.decay);
    }

  } else if ([42, 44, 46].includes(def.note)) {
    // ── HI-HAT ────────────────────────────────────
    const p = def.note === 46 ? prof.hhOpen : prof.hhClosed;
    const buf  = getNoiseBuf(ctx, 0.5, 'hat');
    const src  = ctx.createBufferSource();
    const filt = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = buf;
    filt.type = 'highpass'; filt.frequency.value = p.hipass;
    gain.gain.setValueAtTime(vel01 * p.vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + p.decay);
    src.connect(filt); filt.connect(gain); gain.connect(state.masterGain);
    src.start(now);

  } else if (def.note === 37) {
    // ── RIM / SIDESTICK ───────────────────────────
    const p = prof.rim;
    const buf  = getNoiseBuf(ctx, 0.12, 'rim');
    const src  = ctx.createBufferSource();
    const filt = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = buf;
    filt.type = 'bandpass'; filt.frequency.value = p.freq; filt.Q.value = p.Q;
    gain.gain.setValueAtTime(vel01 * 0.6, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + p.decay);
    src.connect(filt); filt.connect(gain); gain.connect(state.masterGain);
    src.start(now);

  } else if (def.note === 55) {
    // ── COWBELL ───────────────────────────────────
    const p = prof.cowbell;
    const osc  = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';  osc.frequency.value  = p.freq;
    osc2.type = 'square'; osc2.frequency.value = p.freq * 1.47; // inharmonic partial
    gain.gain.setValueAtTime(vel01 * 0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + p.decay);
    osc.connect(gain); osc2.connect(gain); gain.connect(state.masterGain);
    osc.start(now); osc2.start(now);
    osc.stop(now + p.decay); osc2.stop(now + p.decay);

  } else {
    // ── TOMS / CRASH / RIDE ───────────────────────
    const isCrash = def.note === 49;
    const isRide  = def.note === 57;

    if (isCrash || isRide) {
      // Cymbal — layered noise with long decay
      const cp = isCrash ? prof.crash : prof.ride;
      const buf  = ctx.createBuffer(1, ctx.sampleRate * cp.decay * 1.2, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        data[i] = (Math.random() * 2 - 1) * 0.6 +
                  Math.sin(i * 0.31) * 0.2 +
                  Math.sin(i * 0.53) * 0.2;
      }
      const src  = ctx.createBufferSource();
      const filt = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      src.buffer = buf;
      filt.type = 'highpass'; filt.frequency.value = cp.hipass;
      gain.gain.setValueAtTime(vel01 * cp.vol, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + cp.decay);
      src.connect(filt); filt.connect(gain); gain.connect(state.masterGain);
      src.start(now);
    } else {
      // Toms — pitched sine with kit-specific tuning
      const tp = prof.tom;
      const tomNoteToIdx = { 41:0, 43:0, 45:1, 48:1, 50:2 };
      const pitchIdx = tomNoteToIdx[def.note] ?? 1;
      const freq = tp.pitches[pitchIdx] || 130;
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(tp.endFreq, now + tp.decay * 0.7);
      gain.gain.setValueAtTime(vel01 * 0.55, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + tp.decay);
      osc.connect(gain); gain.connect(state.masterGain);
      osc.start(now); osc.stop(now + tp.decay + 0.05);
    }
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
    if (e && e.cancelable) e.preventDefault();
    if (state.chordMode) {
      stopChord(note);
    } else {
      stopNote(note);
    }
  };

  el.addEventListener('touchstart',  onPress,   { passive: true });
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
      <button class="pad-loop-dot" type="button" aria-label="Loop control"><span class="dot-ring"></span></button>
    `;
    applyPadLoopVisual(i, el);

    const fire = (e) => {
      getAudio();
      let vel = 100;
      const point = e.changedTouches ? e.changedTouches[0] : e;
      const rect  = el.getBoundingClientRect();
      const relY  = (point.clientY - rect.top) / rect.height;
      vel = applyVelCurve(Math.max(0, Math.min(1, relY)));

      triggerDrum(def, vel, el);

      if (state.loopMode) {
        const loop = state.padLoops.get(i);
        if (loop && loop.status === 'recording' && state.clockOrigin !== null) {
          const ctx  = getAudio();
          const raw  = (ctx.currentTime - state.clockOrigin) % state.loopLen;
          const t    = quantizePhase(raw);
          loop.taps.push({ t, vel });
          loop.taps.sort((a, b) => a.t - b.t);
        }
      }
    };

    el.addEventListener('touchstart', fire, { passive: true });
    el.addEventListener('touchend', function(e) { e.preventDefault(); }, { passive: false });
    el.addEventListener('mousedown',  fire);

    wireLoopDot(el.querySelector('.pad-loop-dot'), i, def, el);

    grid.appendChild(el);
  });
}

function wireLoopDot(dot, padIndex, def, padEl) {
  if (!dot) return;
  let timer = null;
  let longFired = false;

  const start = (e) => {
    longFired = false;
    timer = setTimeout(() => {
      longFired = true;
      clearPadLoop(padIndex, padEl);
    }, LONG_PRESS_MS);
  };
  const end = (e) => {
    clearTimeout(timer);
    if (longFired) return;
    cyclePadLoop(padIndex, padEl);
  };

  dot.addEventListener('touchstart', start, { passive: true });
  dot.addEventListener('touchend',   end,   { passive: true });
  dot.addEventListener('touchcancel', () => clearTimeout(timer), { passive: true });
  dot.addEventListener('mousedown', start);
  dot.addEventListener('mouseup',   end);
}

// ── PAD LOOP SEQUENCER ─────────────────────────
// Clock-first design: the grid is established from BPM before any recording
// starts. Every hit is stamped against that running clock, so bar length,
// quantization, and multi-pad sync are all derived from one source of truth
// and never need to be inferred from performance timing.
//
// state.clockOrigin  — AudioContext time when the global clock started (set
//                      on first loop arm, never changes while loops are live)
// state.loopLen      — bar length in seconds (beatLen * 4), shared by all pads
//
// Per-pad loop object: { status, taps:[{t,vel}], nextIdx }
//   status: 'idle' | 'recording' | 'playing' | 'paused'
//   taps:   [{t: offset-within-bar-in-seconds, vel: 1-127}]
//   nextIdx: scheduler cursor into taps[]

function gridBeatLen()  { return 60 / state.bpm; }
function gridLoopLen()  { return gridBeatLen() * 4; }   // one 4/4 bar
function gridSixteenth(){ return gridBeatLen() / 4; }

// Current position within the bar, in seconds [0, loopLen)
function gridPhase(ctx) {
  if (state.clockOrigin === null) return 0;
  return (ctx.currentTime - state.clockOrigin) % state.loopLen;
}

// How many seconds until the next bar boundary
function timeToNextBar(ctx) {
  const elapsed = ctx.currentTime - state.clockOrigin;
  const barsDone = Math.floor(elapsed / state.loopLen);
  return state.clockOrigin + (barsDone + 1) * state.loopLen - ctx.currentTime;
}

function getOrInitLoop(i) {
  let loop = state.padLoops.get(i);
  if (!loop) {
    loop = { status: 'idle', taps: [], nextIdx: 0, cycleStart: 0 };
    state.padLoops.set(i, loop);
  }
  return loop;
}

function cyclePadLoop(padIndex, padEl) {
  const ctx  = getAudio();
  const loop = getOrInitLoop(padIndex);

  if (loop.status === 'idle') {
    // Start the global clock on the first ever arm, anchored to now.
    // All subsequent pads share this same origin so they're always in phase.
    if (state.clockOrigin === null) {
      if (state.bpmIsDefault) {
        // Never silently quantize to a guessed 120 BPM grid — that's what
        // made loops feel like they were "assuming the beat." Make the user
        // tap their actual tempo first so the grid matches what they play.
        flashTapTempoPrompt();
        return;
      }
      state.loopLen      = gridLoopLen();
      state.clockOrigin  = ctx.currentTime;
    }
    loop.taps   = [];
    loop.status = 'recording';

  } else if (loop.status === 'recording') {
    if (loop.taps.length === 0) {
      // Nothing recorded — just cancel
      loop.status = 'idle';
    } else {
      loop.nextIdx   = 0;
      loop.cycleStart = state.clockOrigin +
        Math.floor((ctx.currentTime - state.clockOrigin) / state.loopLen) * state.loopLen;
      loop.status    = 'playing';
    }

  } else if (loop.status === 'playing') {
    loop.status = 'paused';

  } else if (loop.status === 'paused') {
    loop.nextIdx    = advanceNextIdx(loop, gridPhase(ctx));
    loop.cycleStart = state.clockOrigin +
      Math.floor((ctx.currentTime - state.clockOrigin) / state.loopLen) * state.loopLen;
    loop.status     = 'playing';
  }

  applyPadLoopVisual(padIndex, padEl);
  ensureLoopScheduler();
}

function flashTapTempoPrompt() {
  const btn = document.getElementById('tap-btn');
  if (!btn) return;
  btn.classList.add('prompt-flash');
  setTimeout(() => btn.classList.remove('prompt-flash'), 1200);
}

function clearPadLoop(padIndex, padEl) {
  const loop = getOrInitLoop(padIndex);
  loop.status  = 'idle';
  loop.taps    = [];
  loop.nextIdx = 0;
  applyPadLoopVisual(padIndex, padEl);

  // If no loops are active any more, reset the global clock so the next
  // session starts fresh with a clean origin.
  let anyLive = false;
  state.padLoops.forEach(l => { if (l.status !== 'idle') anyLive = true; });
  if (!anyLive) state.clockOrigin = null;
}

// Quantize a raw phase offset (seconds within bar) to the nearest 16th slot.
function quantizePhase(rawPhase) {
  const s          = gridSixteenth();
  const totalSlots = Math.round(state.loopLen / s);
  let slot         = Math.round(rawPhase / s);
  slot             = ((slot % totalSlots) + totalSlots) % totalSlots; // wrap, never clamp
  return slot * s;
}

// Find the nextIdx cursor for a loop resuming at currentPhase.
function advanceNextIdx(loop, currentPhase) {
  for (let i = 0; i < loop.taps.length; i++) {
    if (loop.taps[i].t >= currentPhase) return i;
  }
  return 0; // all taps are behind us — next hit is tap[0] in the next cycle
}

function applyPadLoopVisual(padIndex, el) {
  if (!el) el = document.querySelectorAll('#drum-grid .pad')[padIndex];
  if (!el) return;
  const loop   = state.padLoops.get(padIndex);
  const status = loop ? loop.status : 'idle';
  const dot    = el.querySelector('.pad-loop-dot');
  el.classList.toggle('loop-recording', status === 'recording');
  el.classList.toggle('loop-playing',   status === 'playing');
  el.classList.toggle('loop-paused',    status === 'paused');
  if (dot) {
    dot.classList.toggle('rec',     status === 'recording');
    dot.classList.toggle('playing', status === 'playing');
    dot.classList.toggle('paused',  status === 'paused');
  }
}

function ensureLoopScheduler() {
  if (state.loopSchedulerId) return;
  state.loopSchedulerId = setInterval(loopSchedulerTick, LOOP_TICK_MS);
}

function loopSchedulerTick() {
  const ctx      = getAudio();
  let anyActive  = false;

  state.padLoops.forEach((loop, padIndex) => {
    if (loop.status !== 'playing' && loop.status !== 'recording') return;
    anyActive = true;
    if (loop.status !== 'playing' || !loop.taps.length) return;

    const def = state.padDefs[padIndex];
    const el  = document.querySelectorAll('#drum-grid .pad')[padIndex];
    if (!def || state.clockOrigin === null) return;

    // Resync if tab was backgrounded and we fell way behind.
    if (ctx.currentTime - loop.cycleStart > state.loopLen * 4) {
      loop.cycleStart = state.clockOrigin +
        Math.floor((ctx.currentTime - state.clockOrigin) / state.loopLen) * state.loopLen;
      loop.nextIdx = advanceNextIdx(loop, gridPhase(ctx));
    }

    let guard = 0;
    while (guard++ < loop.taps.length + 1) {
      const tap        = loop.taps[loop.nextIdx];
      const tapAbsTime = loop.cycleStart + tap.t;

      if (ctx.currentTime < tapAbsTime) break;

      triggerDrum(def, tap.vel, el);
      loop.nextIdx = (loop.nextIdx + 1) % loop.taps.length;

      // Wrapped — advance cycleStart by one bar and stop;
      // remaining taps belong to the new cycle.
      if (loop.nextIdx === 0) {
        loop.cycleStart += state.loopLen;
        break;
      }
    }
  });

  if (!anyActive) {
    clearInterval(state.loopSchedulerId);
    state.loopSchedulerId = null;
  }
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
  setBpm(bpm);
}

function setBpm(bpm) {
  state.bpm = bpm;
  state.bpmIsDefault = false;
  const input = document.getElementById('bpm-input');
  if (input && document.activeElement !== input) input.value = bpm;
  if (window.RelayPeer) window.RelayPeer.broadcast({ type: 'bpm', bpm });
  saveSettings();
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

async function playSample(s) {
  const ctx = getAudio();
  if (!s.buffer) {
    const arrayBuf = await s.blob.arrayBuffer();
    s.buffer = await ctx.decodeAudioData(arrayBuf);
  }
  const src = ctx.createBufferSource();
  src.buffer = s.buffer;
  src.connect(state.masterGain);
  src.start();
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

function clearAssign() {
  if (state.assignPadIndex === null) { closeAssignModal(); return; }
  delete state.padDefs[state.assignPadIndex].sampleId;
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
    saveSettings();
  });

  // Scale type
  document.getElementById('scale-type').addEventListener('change', (e) => {
    state.scaleType = e.target.value;
    buildKeyboard();
    saveSettings();
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

  // Typeable BPM input
  const bpmInput = document.getElementById('bpm-input');
  if (bpmInput) {
    const commitBpm = () => {
      const v = Math.round(parseFloat(bpmInput.value));
      if (!isNaN(v) && v >= 20 && v <= 300) {
        setBpm(v);
      } else if (bpmInput.value === '') {
        // blank = reset to default state
        state.bpmIsDefault = true;
      } else {
        bpmInput.value = state.bpmIsDefault ? '' : state.bpm;
      }
    };
    bpmInput.addEventListener('change', commitBpm);
    bpmInput.addEventListener('input', () => {
      const v = Math.round(parseFloat(bpmInput.value));
      if (!isNaN(v) && v >= 20 && v <= 300) setBpm(v);
    });
    bpmInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') bpmInput.blur();
    });
  }

  const loopBtn = document.getElementById('loop-mode-btn');
  if (loopBtn) {
    loopBtn.addEventListener('click', () => {
      state.loopMode = !state.loopMode;
      loopBtn.classList.toggle('active', state.loopMode);
      const grid = document.getElementById('drum-grid');
      if (grid) grid.classList.toggle('loop-mode', state.loopMode);
    });
  }
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
  document.getElementById('assign-clear').addEventListener('click',   clearAssign);
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

  // Sync scale/bpm UI to restored values
  const scaleRootEl = document.getElementById('scale-root');
  const scaleTypeEl = document.getElementById('scale-type');
  const bpmInputEl  = document.getElementById('bpm-input');
  if (scaleRootEl) scaleRootEl.value = state.scaleRoot;
  if (scaleTypeEl) scaleTypeEl.value = state.scaleType;
  if (bpmInputEl && !state.bpmIsDefault) bpmInputEl.value = state.bpm;

  // Auto-jam + session restore + shareable link — all need a user gesture
  // first (browser AudioContext policy). Hook into the existing gesture
  // listeners and fire once.
  const onFirstGesture = () => {
    getAudio(); // unlock audio context

    // ── Shareable link: ?join=XXXXXX auto-connects as joiner ──
    const joinCode = new URLSearchParams(window.location.search).get('join');
    if (joinCode && window.RelayPeer) {
      setTimeout(() => window.RelayPeer.joinSession(joinCode), 300);
      return; // joining a real session — skip auto-jam and bot restore
    }

    // ── Restore previously active bots ──
    const savedBots = localStorage.getItem('relay-bots');
    let botsToLoad = [];
    if (savedBots) {
      try { botsToLoad = JSON.parse(savedBots); } catch (e) {}
    }

    // ── Auto-jam: default band if no saved bots and no join code ──
    if (botsToLoad.length === 0) {
      botsToLoad = ['AI0007', 'AI0003', 'AI0002']; // drums + bass + pad
    }

    if (window.RelayPeer) {
      // Stagger bot starts slightly so audio context is fully ready
      botsToLoad.forEach((code, i) => {
        setTimeout(() => window.RelayPeer.joinSession(code), 200 + i * 150);
      });
    }
  };

  document.addEventListener('touchstart', onFirstGesture, { once: true });
  document.addEventListener('mousedown',  onFirstGesture, { once: true });


}

init();
window.state = state; // relay-peer.js reads padDefs for drum lookup
