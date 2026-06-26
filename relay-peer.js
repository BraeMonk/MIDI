/* ─────────────────────────────────────────────────────────────────
   relay-peer.js  ·  P2P Jam Session  ·  v1.0.0
   Uses PeerJS (CDN) for WebRTC signaling + data channels.

   API (window.RelayPeer):
     .hostSession()       → generates 6-char code, waits for joiner
     .joinSession(code)   → connects to host by code, OR adds an AI band
                             member if code is an AI code (AI0001 etc) —
                             multiple AI codes can be joined at once and
                             play together off one shared clock ("band mode")
     .leaveBot(code)      → removes a single AI band member, leaves the rest
     .leave()             → cleanly closes everything (peer + all AI bots)
     .broadcast(msg)      → send action to peer (called by app.js hooks)
     .onReceive(fn)       → app.js registers handler for incoming msgs

   Message schema (JSON over data channel):
     { type: 'drum',   note, velocity }
     { type: 'noteOn',  note, velocity, synthType? }  ← synthType only used by AI bots
     { type: 'noteOff', note }
     { type: 'bpm',    bpm }
     { type: 'sync',   bpm, ts }       ← host→joiner on connect
   ──────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── PEERJS CDN (loaded lazily on first use) ─────────────────────
  const PEERJS_CDN = 'https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js';

  let peerInstance = null;   // Peer object
  let dataConn     = null;   // DataConnection
  let role         = null;   // 'host' | 'joiner' | 'ai' | null
  let receiveHandler = () => {};

  // ── AI JAM PARTNERS ──────────────────────────────────────────────
  // Reserved codes that never touch PeerJS — they spin up a local bot
  // that listens to what you play (via broadcast) and answers back
  // (via receiveHandler), using the exact same message schema as a
  // real human peer. app.js doesn't know the difference.
  //
  // Each code is a specific instrument voice rather than a generic
  // "personality" — AI0001 Piano, AI0002 Pad, AI0003 Bass — matching
  // the synthType options app.js already exposes (keys/pad/bass/lead).
  let aiTimer       = null;
  let aiStepIdx     = 0;
  let aiBarIdx      = 0;
  let aiHumanBuf    = [];     // { step, note, velocity } hits the human played this bar
  let aiPrevBarBuf  = [];     // human's pattern from the previous bar (for gap-aware comping)
  const activeBots   = new Map(); // code -> bot def, all driven by the same shared clock
  const aiHeldNotes  = new Map(); // code -> [notes] currently sustained by that bot

  // Local copy of the scale math app.js uses internally (not exposed on window),
  // kept in sync by name with app.js's SCALES / NOTE_ROOT_MAP.
  const AI_SCALES = {
    none:  null,
    major: [0,2,4,5,7,9,11],
    minor: [0,2,3,5,7,8,10],
    penta: [0,2,4,7,9],
    blues: [0,3,5,6,7,10],
    dorian:[0,2,3,5,7,9,10],
  };
  const AI_NOTE_ROOT_MAP = { C:0,'C#':1,D:2,'D#':3,E:4,F:5,'F#':6,G:7,'G#':8,A:9,'A#':10,B:11 };

  function stepDurMs() {
    const bpm = (window.state && window.state.bpm) ? window.state.bpm : 120;
    return (60 / bpm / 4) * 1000; // one 16th note
  }

  // degree 0 = scale root at the user's current octave; positive degrees climb the scale.
  function scaleNote(degree, octaveOffset) {
    const s = window.state || {};
    const root = AI_NOTE_ROOT_MAP[s.scaleRoot] ?? 0;
    const intervals = AI_SCALES[s.scaleType] || AI_SCALES.major; // fall back to major if scale is 'none'
    const baseOctave = (s.octave ?? 4) + (octaveOffset || 0);
    const baseMidi = (baseOctave + 1) * 12 + root;
    const span = intervals.length;
    const within = ((degree % span) + span) % span;
    const octJump = Math.floor(degree / span);
    return baseMidi + intervals[within] + 12 * octJump;
  }

  // Emit a note with a specific synthType. wireReceiveHandler swaps
  // window.state.synthType for the duration of the startNote() call only,
  // so the bot always sounds like its instrument regardless of what synth
  // you currently have selected for your own playing.
  function aiNoteOn(code, note, velocity, synthType) {
    receiveHandler({ type: 'noteOn', note, velocity: velocity || 100, synthType });
    if (!aiHeldNotes.has(code)) aiHeldNotes.set(code, []);
    aiHeldNotes.get(code).push(note);
  }
  function aiNoteOff(code, note) {
    receiveHandler({ type: 'noteOff', note });
    const arr = aiHeldNotes.get(code);
    if (arr) aiHeldNotes.set(code, arr.filter(n => n !== note));
  }
  function aiBotNotesOff(code) {
    const arr = aiHeldNotes.get(code);
    if (!arr) return;
    arr.slice().forEach(n => aiNoteOff(code, n));
  }
  function aiAllNotesOff() {
    Array.from(aiHeldNotes.keys()).forEach(aiBotNotesOff);
  }

  const AI_BOTS = {
    AI0001: {
      name: 'Piano',
      desc: 'Comps melodic lines from the current scale into the gaps you leave.',
      synthType: 'keys',
      onStep(step) {
        const humanHitThisStep = aiPrevBarBuf.some(h => h.step === step);
        if (humanHitThisStep) return; // don't step on what you just played
        const fxMod = fxIntensityMod();
        // FX-reactive density: distorted = more aggressive comping
        const strongThresh = 0.5 - fxMod * 0.2;   // 0.5 → 0.3 as FX gets hotter
        const weakThresh   = 0.22 + fxMod * 0.18;  // 0.22 → 0.40
        if ([0, 4, 8, 12].includes(step) ? Math.random() < strongThresh : Math.random() < weakThresh) {
          const degree = [0, 2, 4, 7][Math.floor(Math.random() * 4)];
          const note = scaleNote(degree, 0);
          const vel = Math.round(95 + Math.random() * 25 + fxMod * 20);
          aiNoteOn(this._code, note, vel, this.synthType);
          setTimeout(() => aiNoteOff(this._code, note), stepDurMs() * 1.5);
        }
      },
    },
    AI0002: {
      name: 'Pad',
      desc: 'Holds a sustained chord under you, changing every couple bars.',
      synthType: 'pad',
      onBarStart(barIdx) {
        // New chord voicing every 2 bars; alternate root-triad and 4th-degree triad
        if (barIdx % 2 !== 0) return;
        aiBotNotesOff(this._code);
        const rootDegree = (Math.floor(barIdx / 2) % 2 === 0) ? 0 : 3;
        const fxMod = fxIntensityMod();
        // Lay back (softer, slower change) on clean tone; push (louder) when dirty
        const vel = Math.round(75 + fxMod * 30);
        [0, 2, 4].forEach(third => {
          const note = scaleNote(rootDegree + third, -1); // sit an octave below lead register
          aiNoteOn(this._code, note, vel, this.synthType);
        });
      },
      onStep() { /* sustain only changes at bar boundaries */ },
    },
    AI0003: {
      name: 'Bass',
      desc: 'Locks a simple root-note groove to the beat.',
      synthType: 'bass',
      onStep(step) {
        // Classic root-on-the-downbeat, fifth-on-the-and groove, two octaves down
        const fxMod = fxIntensityMod();
        if (step === 0 || step === 8) {
          const note = scaleNote(0, -2);
          const vel = Math.round(110 + fxMod * 15);
          aiNoteOn(this._code, note, vel, this.synthType); // downbeat root — strong and present
          setTimeout(() => aiNoteOff(this._code, note), stepDurMs() * 1.2);
        } else if (step === 6 || step === 14) {
          const note = scaleNote(4, -2);
          aiNoteOn(this._code, note, Math.round(88 + fxMod * 12), this.synthType);  // off-beat fifth
          setTimeout(() => aiNoteOff(this._code, note), stepDurMs() * 0.8);
        }
        // Extra passing note on step 2 when distortion is active
        if (fxMod > 0.4 && (step === 2 || step === 10) && Math.random() < 0.4) {
          const note = scaleNote(2, -2);
          aiNoteOn(this._code, note, Math.round(70 + fxMod * 20), this.synthType);
          setTimeout(() => aiNoteOff(this._code, note), stepDurMs() * 0.6);
        }
      },
    },

    // ── Progression-driven variants ──
    // Same instruments, but the chord ROOT moves through a real progression
    // (one chord per bar) instead of sitting still. Scale degrees are
    // relative to the user's current scale/root, so "I" always means
    // whatever key they're actually in.
    AI0004: {
      name: 'Piano — I–V–vi–IV',
      desc: 'Comps over a moving pop progression (I–V–vi–IV), one chord per bar.',
      synthType: 'keys',
      progression: [0, 4, 5, 3],
      onStep(step) {
        const humanHitThisStep = aiPrevBarBuf.some(h => h.step === step);
        if (humanHitThisStep) return;
        const fxMod = fxIntensityMod();
        const strongThresh = 0.5 - fxMod * 0.2;
        const weakThresh   = 0.22 + fxMod * 0.18;
        if ([0, 4, 8, 12].includes(step) ? Math.random() < strongThresh : Math.random() < weakThresh) {
          const chordRoot = this.progression[aiBarIdx % this.progression.length];
          const tone = [0, 2, 4][Math.floor(Math.random() * 3)]; // chord-tone, not random scale degree
          const note = scaleNote(chordRoot + tone, 0);
          aiNoteOn(this._code, note, Math.round(95 + Math.random() * 25 + fxMod * 20), this.synthType);
          setTimeout(() => aiNoteOff(this._code, note), stepDurMs() * 1.5);
        }
      },
    },
    AI0005: {
      name: 'Pad — ii–V–I',
      desc: 'Sustains a jazz turnaround (ii–V–I), a new chord every bar.',
      synthType: 'pad',
      progression: [1, 4, 0],
      onBarStart(barIdx) {
        aiBotNotesOff(this._code);
        const chordRoot = this.progression[barIdx % this.progression.length];
        const fxMod = fxIntensityMod();
        const vel = Math.round(75 + fxMod * 30);
        [0, 2, 4].forEach(third => {
          const note = scaleNote(chordRoot + third, -1);
          aiNoteOn(this._code, note, vel, this.synthType);
        });
      },
      onStep() { /* sustain only changes at bar boundaries */ },
    },
    AI0006: {
      name: 'Bass — I–IV–V–IV (walking)',
      desc: 'Walks a I–IV–V–IV groove with a passing tone into each new chord.',
      synthType: 'bass',
      progression: [0, 3, 4, 3],
      onStep(step) {
        const chordRoot = this.progression[aiBarIdx % this.progression.length];
        const fxMod = fxIntensityMod();
        if (step === 0 || step === 8) {
          const note = scaleNote(chordRoot, -2);
          aiNoteOn(this._code, note, Math.round(110 + fxMod * 15), this.synthType);
          setTimeout(() => aiNoteOff(this._code, note), stepDurMs() * 1.2);
        } else if (step === 6) {
          const note = scaleNote(chordRoot + 4, -2); // fifth, mid-bar lift
          aiNoteOn(this._code, note, Math.round(88 + fxMod * 12), this.synthType);
          setTimeout(() => aiNoteOff(this._code, note), stepDurMs() * 0.8);
        } else if (step === 14) {
          // Passing tone walking toward NEXT bar's chord root
          const nextRoot = this.progression[(aiBarIdx + 1) % this.progression.length];
          const note = scaleNote(nextRoot - 1, -2);
          aiNoteOn(this._code, note, Math.round(93 + fxMod * 12), this.synthType);
          setTimeout(() => aiNoteOff(this._code, note), stepDurMs() * 0.8);
        }
      },
    },
    // ── Drum bot ──────────────────────────────────────────────────
    // AI0007 reads window.state.padDefs and triggers kick/snare/hat
    // via receiveHandler({ type:'drum', note, velocity }) — same path
    // as a real human drum hit. Pattern is a classic 4-on-the-floor with
    // snare on 2&4 and an 8th-note hi-hat, with FX-reactive variations.
    AI0007: {
      name: 'Drums',
      desc: 'Kick/snare/hat groove that reacts to your FX pedal state.',
      synthType: null, // drums use triggerDrum, not synthType
      onStep(step) {
        const pads  = (window.state && window.state.padDefs) || [];
        const fxMod = fxIntensityMod();

        // Resolve drum notes by exact padDef name (app.js: 'Kick', 'Snare', 'Hi-Hat').
        // Falls back to index-based lookup if names differ in a custom kit.
        const find = (exact, fallbackIdx) => {
          const p = pads.find(d => d.name && d.name.toLowerCase() === exact.toLowerCase());
          return p ? p.note : (pads[fallbackIdx] ? pads[fallbackIdx].note : null);
        };

        const kickNote  = find('Kick',   0);
        const snareNote = find('Snare',  1);
        const hatNote   = find('Hi-Hat', 2);

        const loud  = () => Math.round(105 + Math.random() * 15 + fxMod * 15);
        const soft  = () => Math.round(70  + Math.random() * 20 + fxMod * 10);

        const drum = (note, vel) => {
          if (note == null) return;
          receiveHandler({ type: 'drum', note, velocity: vel });
        };

        // ── Kick: beats 0 & 8 (1 & 3), extra on 10 when distorted ──
        if (step === 0 || step === 8) drum(kickNote, loud());
        if (step === 10 && fxMod > 0.4 && Math.random() < 0.45) drum(kickNote, soft());

        // ── Snare: beats 4 & 12 (2 & 4) ──
        if (step === 4 || step === 12) drum(snareNote, loud());
        // Ghost note on step 3 or 11 when distortion is hot
        if ((step === 3 || step === 11) && fxMod > 0.5 && Math.random() < 0.35) drum(snareNote, Math.round(45 + Math.random() * 20));

        // ── Hi-hat: every 2 steps (8th notes); open on off-beats when clean ──
        if (step % 2 === 0) {
          const vel = (step % 4 === 0) ? loud() : soft();
          drum(hatNote, vel);
        }
        // Extra 16th hat subdivisions when in high-energy FX state
        if (fxMod > 0.6 && step % 2 === 1 && Math.random() < 0.5) drum(hatNote, Math.round(40 + Math.random() * 20));
      },
    },

    // ── Pitch-tracking lead bot ────────────────────────────────────
    // AI0008 listens to the *actual audio* you're outputting through
    // an AnalyserNode and picks up your fundamental frequency in real
    // time (the same autoCorrelate approach the octaver already uses).
    // It then responds with a complementary lead line — a scale-snapped
    // interval (third or fifth) above what you're playing — so the
    // response tracks your pitch rather than only your MIDI events.
    AI0008: {
      name: 'Lead (pitch)',
      desc: 'Tracks your live pitch and answers with a third/fifth above.',
      synthType: 'lead',

      // Internal per-instance state (set fresh in addAIBot via Object.assign)
      _analyser:   null,
      _buf:        null,
      _rafId:      null,
      _lastNote:   null,
      _cooldownMs: 0,
      _heldNote:   null,

      onStep(step) {
        // Clock tick is used only to release stale held notes at phrase
        // boundaries; the actual note triggering happens in _pitchLoop.
        if (step === 0) {
          // New phrase — clear held note so the loop will re-trigger cleanly
          if (this._heldNote !== null) {
            aiNoteOff(this._code, this._heldNote);
            this._heldNote = null;
          }
        }
      },

      onBarStart() { /* nothing extra */ },

      // Called once when the bot is first added (via addAIBot extension below)
      _start() {
        // fx.js mounts a passive analyser tap on window._relayAnalyser once
        // fxState.chainInput exists. Poll briefly until it appears.
        const tryBind = () => {
          const analyser = window._relayAnalyser;
          if (!analyser) return false;
          this._analyser = analyser;
          this._buf = new Float32Array(analyser.fftSize);
          this._pitchLoop();
          return true;
        };

        if (!tryBind()) {
          let attempts = 0;
          const poll = setInterval(() => {
            attempts++;
            if (tryBind() || attempts > 20 || !activeBots.has(this._code)) {
              clearInterval(poll);
            }
          }, 300);
        }
      },

      _pitchLoop() {
        if (!activeBots.has(this._code)) return; // bot was removed

        const rafCallback = () => {
          if (!activeBots.has(this._code)) return;
          this._rafId = requestAnimationFrame(rafCallback);

          const now = performance.now();
          if (now < this._cooldownMs) return;

          this._analyser.getFloatTimeDomainData(this._buf);
          const freq = autoCorrelateBuffer(this._buf, this._analyser.context.sampleRate);

          if (freq < 50 || freq > 1500) {
            // No pitch detected (silence or noise) — release any held note
            if (this._heldNote !== null) {
              aiNoteOff(this._code, this._heldNote);
              this._heldNote = null;
            }
            return;
          }

          // Convert frequency → nearest MIDI note
          const detectedMidi = Math.round(69 + 12 * Math.log2(freq / 440));

          // Snap to current scale, then offset up by a third or fifth
          const snapped = snapToScale(detectedMidi);
          const fxMod   = fxIntensityMod();
          // Prefer fifths when distortion is hot (power-chord flavour)
          const interval = fxMod > 0.5 ? 7 : 4; // semitones: major third = 4, fifth = 7
          const targetNote = snapped + interval;

          if (targetNote === this._heldNote) return; // same note, keep holding

          // Release previous
          if (this._heldNote !== null) aiNoteOff(this._code, this._heldNote);

          // Trigger new
          const vel = Math.round(85 + fxMod * 30);
          aiNoteOn(this._code, targetNote, vel, this.synthType);
          this._heldNote = targetNote;

          // Debounce: don't re-trigger for at least 80 ms
          this._cooldownMs = now + 80;
        };

        this._rafId = requestAnimationFrame(rafCallback);
      },

      _stop() {
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        if (this._heldNote !== null) { aiNoteOff(this._code, this._heldNote); this._heldNote = null; }
      },
    },

    // ── More drum feels ───────────────────────────────────────────

    AI0009: {
      name: 'Drums — Half-time',
      desc: 'Kick on 1, snare on 3 only. Big, slow, hip-hop feel.',
      synthType: null,
      onStep(step) {
        const pads  = (window.state && window.state.padDefs) || [];
        const fxMod = fxIntensityMod();
        const find  = (exact, fb) => { const p = pads.find(d => d.name && d.name.toLowerCase() === exact.toLowerCase()); return p ? p.note : (pads[fb] ? pads[fb].note : null); };
        const kickNote  = find('Kick',   0);
        const snareNote = find('Snare',  1);
        const hatNote   = find('Hi-Hat', 2);
        const drum = (note, vel) => { if (note == null) return; receiveHandler({ type: 'drum', note, velocity: vel }); };
        const loud = () => Math.round(108 + Math.random() * 15 + fxMod * 12);
        const soft = () => Math.round(55  + Math.random() * 20);

        // Kick: beat 1 (step 0) and a syncopated hit on step 10
        if (step === 0)  drum(kickNote, loud());
        if (step === 10) drum(kickNote, Math.round(90 + fxMod * 15));

        // Snare: only on beat 3 (step 8) — the half-time feel
        if (step === 8)  drum(snareNote, loud());

        // Ghost snares around the snare when fx is hot
        if (fxMod > 0.4 && step === 7  && Math.random() < 0.5) drum(snareNote, soft());
        if (fxMod > 0.4 && step === 9  && Math.random() < 0.4) drum(snareNote, soft());

        // Hi-hat: quarter notes (every 4 steps), opened up on off-beats when clean
        if (step % 4 === 0) drum(hatNote, Math.round(72 + Math.random() * 18));
        // Extra 8th-note hats when distortion kicks in
        if (fxMod > 0.5 && step % 4 === 2) drum(hatNote, soft());
      },
    },

    AI0010: {
      name: 'Drums — Shuffle',
      desc: 'Swung 8th-note hi-hats with a backbeat snare. Blues/rock feel.',
      synthType: null,
      onStep(step) {
        const pads  = (window.state && window.state.padDefs) || [];
        const fxMod = fxIntensityMod();
        const find  = (exact, fb) => { const p = pads.find(d => d.name && d.name.toLowerCase() === exact.toLowerCase()); return p ? p.note : (pads[fb] ? pads[fb].note : null); };
        const kickNote  = find('Kick',   0);
        const snareNote = find('Snare',  1);
        const hatNote   = find('Hi-Hat', 2);
        const drum = (note, vel) => { if (note == null) return; receiveHandler({ type: 'drum', note, velocity: vel }); };
        const loud = () => Math.round(105 + Math.random() * 15 + fxMod * 12);
        const soft = () => Math.round(50  + Math.random() * 25);

        // Kick: 1 and the-and-of-2 (steps 0, 6)
        if (step === 0) drum(kickNote, loud());
        if (step === 6) drum(kickNote, Math.round(85 + fxMod * 15));

        // Snare: 2 and 4 (steps 4, 12)
        if (step === 4 || step === 12) drum(snareNote, loud());

        // Shuffle hi-hat: triplet feel approximated in 16th grid —
        // hit on steps 0, 2, 4, 6, 8, 10, 12, 14 BUT accent the
        // downbeats (0,4,8,12) and ghost the "and" (2,6,10,14)
        // to create a lilt without actual time-stretching.
        if (step % 2 === 0) {
          const isDown = step % 4 === 0;
          drum(hatNote, isDown ? Math.round(88 + fxMod * 15) : soft());
        }
        // Extra 16th fills on upbeats when dirty
        if (fxMod > 0.5 && step % 4 === 3 && Math.random() < 0.55) drum(hatNote, soft());
      },
    },

    AI0011: {
      name: 'Drums — Jazz',
      desc: 'Sparse ride pattern with light snare ghosts. Lays back on clean tone.',
      synthType: null,
      onStep(step) {
        const pads  = (window.state && window.state.padDefs) || [];
        const fxMod = fxIntensityMod();
        const find  = (exact, fb) => { const p = pads.find(d => d.name && d.name.toLowerCase() === exact.toLowerCase()); return p ? p.note : (pads[fb] ? pads[fb].note : null); };
        const kickNote  = find('Kick',   0);
        const snareNote = find('Snare',  1);
        const hatNote   = find('Hi-Hat', 2);
        const drum = (note, vel) => { if (note == null) return; receiveHandler({ type: 'drum', note, velocity: vel }); };

        // Jazz ride: quarter notes with a light "and" on 2 and 4
        // Steps: 0(1), 4(2), 6(2+), 8(3), 12(4), 14(4+)
        const rideSteps = new Set([0, 4, 6, 8, 12, 14]);
        if (rideSteps.has(step)) {
          const isAnd = step === 6 || step === 14;
          drum(hatNote, isAnd ? Math.round(50 + Math.random() * 20) : Math.round(70 + Math.random() * 20));
        }

        // Ghost snares — very light, very random
        if (Math.random() < 0.12 && ![0, 4, 8, 12].includes(step)) {
          drum(snareNote, Math.round(30 + Math.random() * 25));
        }

        // Kick: just on 1, very occasionally on the-and-of-4
        if (step === 0) drum(kickNote, Math.round(75 + Math.random() * 20));
        if (step === 14 && Math.random() < 0.25) drum(kickNote, Math.round(60 + Math.random() * 20));

        // When FX gets dirtier, add more energy — more kick and snare
        if (fxMod > 0.4 && step === 8 && Math.random() < 0.4) drum(kickNote, Math.round(70 + fxMod * 20));
        if (fxMod > 0.5 && step === 4 && Math.random() < 0.35) drum(snareNote, Math.round(55 + fxMod * 25));
      },
    },

    // ── Melodic additions ─────────────────────────────────────────

    AI0012: {
      name: 'Arpeggio',
      desc: 'Climbs and descends chord arpeggios in 16th notes. Locks to your scale.',
      synthType: 'keys',
      _dir: 1,   // 1 = ascending, -1 = descending
      _pos: 0,   // position within current arp pattern
      _pattern: null,

      onBarStart(barIdx) {
        // Rebuild the arp pattern each bar: triad of the current chord degree
        // Alternate ascending and descending every bar for shape
        this._dir = (barIdx % 2 === 0) ? 1 : -1;
        this._pos = this._dir === 1 ? 0 : 5; // 6-note pattern (2 octaves of triad)
        // [root, 3rd, 5th, root+oct, 3rd+oct, 5th+oct] scale degrees
        this._pattern = [0, 2, 4, 7, 9, 11];
      },

      onStep(step) {
        if (!this._pattern) return;
        const fxMod = fxIntensityMod();

        // Density: always on even steps (8th notes), add odd steps when hot
        const fire = step % 2 === 0 || (fxMod > 0.5 && Math.random() < 0.6);
        if (!fire) return;

        aiBotNotesOff(this._code);

        const degree = this._pattern[this._pos];
        const note   = scaleNote(degree, 0);
        const vel    = Math.round(88 + Math.random() * 20 + fxMod * 15);
        aiNoteOn(this._code, note, vel, this.synthType);
        setTimeout(() => aiNoteOff(this._code, note), stepDurMs() * 0.85);

        // Advance position, bounce at ends
        this._pos += this._dir;
        if (this._pos >= this._pattern.length) { this._pos = this._pattern.length - 2; this._dir = -1; }
        if (this._pos < 0)                     { this._pos = 1;                        this._dir =  1; }
      },
    },

    AI0013: {
      name: 'Rhythm Stabs',
      desc: 'Off-beat chord stabs like a rhythm guitar. Lays back when clean.',
      synthType: 'keys',
      onStep(step) {
        const fxMod = fxIntensityMod();

        // Core stab positions: the "and" of 1 and "and" of 3 (steps 2, 10)
        // Add "and" of 2 and 4 (steps 6, 14) when more energy
        const coreStabs  = new Set([2, 10]);
        const extraStabs = new Set([6, 14]);
        const isCore  = coreStabs.has(step);
        const isExtra = extraStabs.has(step) && fxMod > 0.3;

        if (!isCore && !isExtra) return;
        if (isExtra && Math.random() < 0.35) return; // extra stabs are probabilistic

        // Strum a 2-note voicing (root + fifth) for a guitar-stab feel
        const root  = scaleNote(0, 0);
        const fifth = scaleNote(4, 0);
        const vel   = Math.round(90 + fxMod * 25 + Math.random() * 15);
        const dur   = stepDurMs() * (fxMod > 0.5 ? 0.4 : 0.6); // tighter when dirty

        [root, fifth].forEach(note => {
          aiNoteOn(this._code, note, vel, this.synthType);
          setTimeout(() => aiNoteOff(this._code, note), dur);
        });
      },
    },

    // ── Call & response ───────────────────────────────────────────

    AI0014: {
      name: 'Call & Response',
      desc: 'Listens to your phrase, then echoes it back transposed up a third.',
      synthType: 'lead',

      // Per-instance state
      _listenBar:  true,   // true = recording your phrase, false = playing it back
      _phrase:     [],     // { stepOffset, note, velocity, durSteps } captured this bar
      _replyPhrase: [],    // transposed version to play back

      onBarStart(barIdx) {
        if (this._listenBar) {
          // We just finished listening — build the reply (transpose up a third = +4 semitones,
          // then snap to scale so it stays musical)
          this._replyPhrase = this._phrase.map(h => ({
            ...h,
            note: snapToScale(h.note + 4),
          }));
          this._phrase = [];
        }
        // Alternate: listen one bar, respond the next
        this._listenBar = !this._listenBar;
      },

      onStep(step) {
        if (this._listenBar) {
          // Capture what the human played this step from aiHumanBuf
          // (aiHumanBuf accumulates hits in real time during the bar)
          aiHumanBuf
            .filter(h => h.step === step)
            .forEach(h => {
              this._phrase.push({ stepOffset: step, note: h.note, velocity: h.velocity, durSteps: 1.5 });
            });
        } else {
          // Play back the reply phrase — trigger notes whose stepOffset matches this step
          this._replyPhrase
            .filter(h => h.stepOffset === step)
            .forEach(h => {
              const vel = Math.round(h.velocity * 0.85); // slightly softer than original
              aiNoteOn(this._code, h.note, vel, this.synthType);
              setTimeout(() => aiNoteOff(this._code, h.note), stepDurMs() * h.durSteps);
            });
        }
      },
    },
  };

  // ── Pitch helpers for AI0008 ──────────────────────────────────────
  // Self-contained autoCorrelate so we don't depend on the octaver's
  // internal function being globally exposed.
  function autoCorrelateBuffer(buf, sampleRate) {
    const SIZE = buf.length;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.008) return -1; // too quiet

    let r1 = 0, r2 = SIZE - 1;
    for (let i = 0; i < SIZE / 2; i++) if (Math.abs(buf[i]) < 0.2) { r1 = i; break; }
    for (let i = 1; i < SIZE / 2; i++) if (Math.abs(buf[SIZE - i]) < 0.2) { r2 = SIZE - i; break; }
    const trimmed = buf.slice(r1, r2);
    const len = trimmed.length;

    const c = new Float32Array(len);
    for (let i = 0; i < len; i++)
      for (let j = 0; j < len - i; j++)
        c[i] += trimmed[j] * trimmed[j + i];

    let d = 0;
    while (d < len - 1 && c[d] > c[d + 1]) d++;
    let maxVal = -1, maxPos = -1;
    for (let i = d; i < len; i++) {
      if (c[i] > maxVal) { maxVal = c[i]; maxPos = i; }
    }
    if (maxPos < 0) return -1;

    // Parabolic interpolation for sub-sample accuracy
    const x1 = maxPos - 1, x2 = maxPos, x3 = maxPos + 1;
    const a = (c[x1] - 2 * c[x2] + (c[x3] || 0)) / 2;
    const b = (c[x3 || x2] - c[x1]) / 2;
    const refined = (a !== 0) ? x2 - b / (2 * a) : x2;
    return sampleRate / refined;
  }

  // Snap a MIDI note to the nearest note in the current scale
  function snapToScale(midi) {
    const s = window.state || {};
    const root = AI_NOTE_ROOT_MAP[s.scaleRoot] ?? 0;
    const intervals = AI_SCALES[s.scaleType] || AI_SCALES.major;
    const octave = Math.floor(midi / 12);
    const pc = midi % 12;
    // Find closest interval
    let bestDist = 12, bestPc = pc;
    for (const iv of intervals) {
      const candidate = (root + iv) % 12;
      const dist = Math.min(Math.abs(pc - candidate), 12 - Math.abs(pc - candidate));
      if (dist < bestDist) { bestDist = dist; bestPc = candidate; }
    }
    return octave * 12 + bestPc;
  }

  // ── FX intensity helper (shared across all bots) ─────────────────
  // Returns 0.0 (clean) → 1.0 (max aggression) based on active pedals.
  // Reads window.fxState.pedals — exposed by fx.js after initFX().
  // Pedal IDs from PEDAL_DEFS: overdrive, distortion, fuzz, wah,
  // octaver, chorus, flanger, phaser, tremolo, delay, reverb.
  function fxIntensityMod() {
    const pedals = window.fxState && window.fxState.pedals;
    if (!pedals) return 0;

    let score = 0;
    if (pedals.distortion && pedals.distortion.active) score += 0.55;
    if (pedals.overdrive  && pedals.overdrive.active)  score += 0.40;
    if (pedals.fuzz       && pedals.fuzz.active)       score += 0.55;
    if (pedals.octaver    && pedals.octaver.active)    score += 0.20; // adds girth
    if (pedals.wah        && pedals.wah.active)        score += 0.10;
    if (pedals.chorus     && pedals.chorus.active)     score += 0.10;
    if (pedals.phaser     && pedals.phaser.active)     score += 0.10;
    if (pedals.flanger    && pedals.flanger.active)    score += 0.10;
    if (pedals.tremolo    && pedals.tremolo.active)    score += 0.05;
    if (pedals.reverb     && pedals.reverb.active)     score -= 0.05; // spacious = lay back
    if (pedals.delay      && pedals.delay.active)      score -= 0.05;
    return Math.max(0, Math.min(1, score));
  }

  function isAICode(code) {
    return /^AI\d{4}$/.test(code) && !!AI_BOTS[code];
  }

  // Shared clock tick — drives every active bot in lockstep so they can
  // never drift relative to each other, no matter when each was added.
  function aiTick() {
    activeBots.forEach((bot) => { if (bot.onStep) bot.onStep.call(bot, aiStepIdx); });
    aiStepIdx++;
    if (aiStepIdx >= 16) {
      aiStepIdx = 0;
      aiBarIdx++;
      aiPrevBarBuf = aiHumanBuf;
      aiHumanBuf = [];
      activeBots.forEach((bot) => { if (bot.onBarStart) bot.onBarStart.call(bot, aiBarIdx); });
    }
    aiTimer = setTimeout(aiTick, stepDurMs());
  }

  function addAIBot(code) {
    if (activeBots.has(code)) { showToast(AI_BOTS[code].name + ' is already in the jam'); return; }

    const startingFresh = activeBots.size === 0;
    const bot = Object.assign({ _code: code }, AI_BOTS[code]); // per-instance copy, tagged with its own code
    activeBots.set(code, bot);

    if (startingFresh) {
      role = 'ai';
      aiStepIdx = 0;
      aiBarIdx = 0;
      aiHumanBuf = [];
      aiPrevBarBuf = [];

      // Fake dataConn so existing UI/connected checks keep working untouched.
      dataConn = {
        open: true,
        send: (raw) => {
          // This is what broadcast() calls when YOU play something — capture
          // it as "what the human just played" instead of sending over the wire.
          try {
            const msg = JSON.parse(raw);
            if (msg.type === 'drum' || msg.type === 'noteOn') {
              aiHumanBuf.push({ step: aiStepIdx, note: msg.note, velocity: msg.velocity });
            }
          } catch (e) {}
        },
        close: () => { stopAllAIBots(); },
      };

      setStatus('connected');
      aiTick(); // starts the shared clock
    }

    if (bot.onBarStart) bot.onBarStart.call(bot, aiBarIdx); // sound immediately, don't wait a full bar
    if (bot._start) bot._start();  // AI0008: kick off pitch-tracking RAF loop
    refreshAIStatusLabel();
    updateUI();
    showToast(`${bot.name} joined the jam — ${bot.desc}`);
  }

  function removeAIBot(code) {
    const bot = activeBots.get(code);
    if (!bot) return;
    if (bot._stop) bot._stop();   // AI0008: cancel RAF pitch loop before clearing notes
    aiBotNotesOff(code);
    aiHeldNotes.delete(code);
    activeBots.delete(code);

    if (activeBots.size === 0) {
      stopAllAIBots();
      dataConn = null;
      role = null;
      setStatus('idle');
      updateUI();
    } else {
      refreshAIStatusLabel();
      updateUI();
    }
  }

  function stopAllAIBots() {
    if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
    aiAllNotesOff();
    aiHeldNotes.clear();
    activeBots.clear();
    aiHumanBuf = [];
    aiPrevBarBuf = [];
  }

  function refreshAIStatusLabel() {
    const lb = document.getElementById('rp-status-label');
    if (!lb) return;
    const names = Array.from(activeBots.values()).map(b => b.name);
    lb.textContent = names.length ? `Jamming: ${names.join(' + ')}` : 'No session';
  }

  // ── INTERNAL HELPERS ────────────────────────────────────────────
  function genCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
    let c = '';
    for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
    return c;
  }

  function loadPeerJS() {
    return new Promise((resolve, reject) => {
      if (window.Peer) { resolve(); return; }
      const s = document.createElement('script');
      s.src = PEERJS_CDN;
      s.onload  = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function makePeerId(code) {
    // Prefix avoids collision with other PeerJS users on the public server
    return 'relay-jam-' + code.toUpperCase();
  }

  function wireConnection(conn) {
    dataConn = conn;

    conn.on('open', () => {
      setStatus('connected');
      updateUI();
      if (role === 'host') {
        // Send initial sync so joiner aligns to host BPM
        sendSync();
      }
    });

    conn.on('data', (raw) => {
      try {
        const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
        window._p2pReceiving = true;
        receiveHandler(msg);
      } catch (e) {
        console.warn('[relay-peer] bad message', raw);
      } finally {
        window._p2pReceiving = false;
      }
    });

    conn.on('close', () => {
      dataConn = null;
      setStatus('disconnected');
      updateUI();
      showToast('Peer disconnected');
    });

    conn.on('error', (err) => {
      console.error('[relay-peer] conn error', err);
      setStatus('error');
    });
  }

  function setStatus(s) {
    const el = document.getElementById('rp-status-dot');
    const lb = document.getElementById('rp-status-label');
    if (!el || !lb) return;
    el.className = 'rp-dot ' + s;
    const labels = {
      idle:         'No session',
      hosting:      'Waiting for peer…',
      connecting:   'Connecting…',
      connected:    'Peer connected ✓',
      disconnected: 'Peer left',
      error:        'Connection error',
    };
    lb.textContent = labels[s] || s;
  }

  function sendSync() {
    // Send host BPM so joiner can align loop grid
    if (!dataConn || !dataConn.open) return;
    const bpm = (window.state && window.state.bpm) ? window.state.bpm : 120;
    dataConn.send(JSON.stringify({ type: 'sync', bpm, ts: Date.now() }));
  }

  function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'rp-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('rp-toast-show'), 10);
    setTimeout(() => {
      t.classList.remove('rp-toast-show');
      setTimeout(() => t.remove(), 400);
    }, 2800);
  }

  function updateUI() {
    const codeRow   = document.getElementById('rp-code-row');
    const joinRow   = document.getElementById('rp-join-row');
    const aiHint    = document.getElementById('rp-ai-hint');
    const botList   = document.getElementById('rp-bot-list');
    const leaveBtn  = document.getElementById('rp-leave-btn');
    const hostBtn   = document.getElementById('rp-host-btn');
    const joinBtn   = document.getElementById('rp-join-btn');
    if (!codeRow) return;

    const inBand = role === 'ai';

    codeRow.style.display  = (role === 'host') ? 'flex' : 'none';
    // Join row stays open in band mode so more bots can be stacked in;
    // hidden only once a real human peer connection exists.
    joinRow.style.display  = (!role || inBand) ? 'flex' : 'none';
    if (aiHint) aiHint.style.display = (!role || inBand) ? 'block' : 'none';
    leaveBtn.style.display = (role)            ? 'inline-flex' : 'none';
    hostBtn.style.display  = (!role)           ? 'inline-flex' : 'none';
    joinBtn.style.display  = (!role || inBand) ? 'inline-flex' : 'none';

    if (botList) {
      if (!inBand || activeBots.size === 0) {
        botList.style.display = 'none';
        botList.innerHTML = '';
      } else {
        botList.style.display = 'flex';
        botList.innerHTML = Array.from(activeBots.entries()).map(([code, bot]) => `
          <span class="rp-bot-chip">
            <span class="rp-bot-chip-name">${bot.name}</span>
            <button class="rp-bot-chip-x" data-code="${code}" title="Remove">✕</button>
          </span>
        `).join('');
        botList.querySelectorAll('.rp-bot-chip-x').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            RelayPeer.leaveBot(btn.dataset.code);
          });
        });
      }
    }
  }

  // ── PUBLIC API ──────────────────────────────────────────────────
  const RelayPeer = {

    async hostSession() {
      stopAllAIBots();
      await loadPeerJS();
      if (peerInstance) this.leave();

      const code = genCode();
      const id   = makePeerId(code);

      document.getElementById('rp-code-val').textContent = code;
      role = 'host';
      setStatus('hosting');
      updateUI();

      peerInstance = new window.Peer(id, { debug: 1 });

      peerInstance.on('open', () => {
        showToast('Session ' + code + ' open — share code with your jam partner');
      });

      peerInstance.on('connection', (conn) => {
        wireConnection(conn);
        showToast('Peer joined!');
      });

      peerInstance.on('error', (err) => {
        console.error('[relay-peer] peer error', err);
        setStatus('error');
        showToast('Session error: ' + err.type);
      });
    },

    async joinSession(code) {
      if (!code) return;
      code = code.toUpperCase().trim();

      if (isAICode(code)) {
        // Joining a bot only kicks out a REAL peer connection, never other
        // active bots — that's the whole point of band mode.
        if (peerInstance) { try { peerInstance.destroy(); } catch (e) {} peerInstance = null; }
        addAIBot(code);
        return;
      }

      // Joining a real peer always clears the band first — can't mix live
      // P2P with local bots on one data channel.
      stopAllAIBots();
      await loadPeerJS();
      if (peerInstance) this.leave();

      role = 'joiner';
      setStatus('connecting');
      updateUI();

      peerInstance = new window.Peer(undefined, { debug: 1 });

      peerInstance.on('open', () => {
        const conn = peerInstance.connect(makePeerId(code), {
          reliable: true,
          serialization: 'json',
        });
        wireConnection(conn);
      });

      peerInstance.on('error', (err) => {
        console.error('[relay-peer] peer error', err);
        setStatus('error');
        showToast('Could not connect: ' + err.type);
        role = null;
        updateUI();
      });
    },

    leaveBot(code) {
      removeAIBot(code);
    },

    leave() {
      stopAllAIBots();
      if (dataConn) { try { if (dataConn.close) dataConn.close(); } catch (e) {} dataConn = null; }
      if (peerInstance) { try { peerInstance.destroy(); } catch (e) {} peerInstance = null; }
      role = null;
      setStatus('idle');
      updateUI();
    },

    broadcast(msg) {
      if (!dataConn || !dataConn.open) return;
      try { dataConn.send(JSON.stringify(msg)); } catch (e) {}
    },

    onReceive(fn) {
      receiveHandler = fn;
    },

    get connected() {
      return !!(dataConn && dataConn.open);
    },
  };

  window.RelayPeer = RelayPeer;

  // ── SESSION OVERLAY UI ─────────────────────────────────────────
  // Injected into the page as a floating panel anchored top-right.
  // Fits within RELAY's existing dark-monochrome design language.
  function buildUI() {
    // ── Styles ──
    const style = document.createElement('style');
    style.textContent = `
      /* ── Jam Panel ─────────────────────────────── */
      #rp-panel {
        position: fixed;
        top: 10px; right: 10px;
        z-index: 9000;
        background: var(--surface, #16181D);
        border: 1px solid var(--border, #252830);
        border-radius: 8px;
        padding: 10px 12px;
        min-width: 220px;
        max-width: 280px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        color: var(--text, #E4E2DF);
        box-shadow: 0 4px 24px rgba(0,0,0,0.5);
        user-select: none;
      }
      #rp-panel.rp-collapsed #rp-body { display: none; }
      #rp-header {
        display: flex;
        align-items: center;
        gap: 7px;
        cursor: pointer;
        padding-bottom: 4px;
      }
      #rp-header-label {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.12em;
        color: var(--teal, #3DD6C8);
        flex: 1;
      }
      #rp-chevron {
        font-size: 9px;
        color: var(--text-dim, #5A5D66);
        transition: transform 0.2s;
      }
      #rp-panel.rp-collapsed #rp-chevron { transform: rotate(-90deg); }
      #rp-body { padding-top: 8px; display: flex; flex-direction: column; gap: 8px; }
      .rp-status-row {
        display: flex; align-items: center; gap: 6px;
        color: var(--text-mid, #9DA0A8); font-size: 10px;
      }
      .rp-dot {
        width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
        background: var(--text-dim, #5A5D66);
      }
      .rp-dot.hosting    { background: var(--amber, #F0A500); box-shadow: 0 0 5px var(--amber, #F0A500); animation: rp-pulse 1.2s infinite; }
      .rp-dot.connecting { background: var(--amber, #F0A500); }
      .rp-dot.connected  { background: var(--teal,  #3DD6C8); box-shadow: 0 0 5px var(--teal, #3DD6C8); }
      .rp-dot.error      { background: var(--danger, #F05C5C); }
      @keyframes rp-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

      /* Code display */
      #rp-code-row {
        display: none; align-items: center; gap: 6px;
        background: var(--raised, #1D2027);
        border: 1px solid var(--border, #252830);
        border-radius: 5px; padding: 6px 10px;
      }
      #rp-code-label { color: var(--text-dim, #5A5D66); font-size: 9px; }
      #rp-code-val {
        letter-spacing: 0.25em; font-size: 16px; font-weight: 700;
        color: var(--amber, #F0A500); flex: 1; text-align: center;
      }
      #rp-copy-btn {
        background: none; border: none; cursor: pointer; padding: 2px 4px;
        color: var(--text-dim, #5A5D66); font-size: 12px;
      }
      #rp-copy-btn:hover { color: var(--text, #E4E2DF); }

      /* Join row */
      #rp-join-row { display: flex; gap: 5px; }

      /* Band-mode bot roster */
      #rp-bot-list { display: flex; flex-wrap: wrap; gap: 5px; }
      .rp-bot-chip {
        display: inline-flex; align-items: center; gap: 5px;
        background: var(--teal-dim, rgba(61,214,200,0.12));
        border: 1px solid var(--teal, #3DD6C8);
        color: var(--teal, #3DD6C8);
        border-radius: 12px; padding: 3px 8px; font-size: 10px; font-weight: 700;
      }
      .rp-bot-chip-x {
        background: none; border: none; cursor: pointer; padding: 0;
        color: var(--teal, #3DD6C8); font-size: 10px; line-height: 1; opacity: 0.7;
      }
      .rp-bot-chip-x:hover { opacity: 1; }      #rp-join-input {
        flex: 1; background: var(--raised, #1D2027);
        border: 1px solid var(--border, #252830); border-radius: 4px;
        padding: 5px 8px; font-family: 'JetBrains Mono', monospace;
        font-size: 12px; font-weight: 700; letter-spacing: 0.2em;
        color: var(--text, #E4E2DF); text-transform: uppercase;
        outline: none;
      }
      #rp-join-input:focus { border-color: var(--teal, #3DD6C8); }
      #rp-join-input::placeholder { color: var(--text-dim, #5A5D66); letter-spacing: 0.1em; font-weight: 400; }

      /* Buttons */
      .rp-btn {
        border: none; border-radius: 4px; padding: 5px 10px;
        font-family: 'JetBrains Mono', monospace; font-size: 10px;
        font-weight: 700; cursor: pointer; letter-spacing: 0.05em;
        display: inline-flex; align-items: center; gap: 4px;
        transition: opacity 0.15s;
      }
      .rp-btn:hover { opacity: 0.82; }
      .rp-btn.host  { background: var(--teal-dim, rgba(61,214,200,0.15)); color: var(--teal, #3DD6C8); border: 1px solid var(--teal, #3DD6C8); }
      .rp-btn.join  { background: var(--amber-dim, rgba(240,165,0,0.10)); color: var(--amber, #F0A500); border: 1px solid var(--amber, #F0A500); }
      .rp-btn.leave { background: var(--danger-dim, rgba(240,92,92,0.12)); color: var(--danger, #F05C5C); border: 1px solid var(--danger, #F05C5C); }
      #rp-action-row { display: flex; gap: 5px; }

      /* Toast */
      .rp-toast {
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(12px);
        background: var(--raised, #1D2027); border: 1px solid var(--border-hi, #363A46);
        color: var(--text, #E4E2DF); font-family: 'JetBrains Mono', monospace;
        font-size: 11px; padding: 8px 16px; border-radius: 6px;
        opacity: 0; transition: opacity 0.3s, transform 0.3s;
        z-index: 9999; pointer-events: none;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      }
      .rp-toast.rp-toast-show { opacity: 1; transform: translateX(-50%) translateY(0); }
    `;
    document.head.appendChild(style);

    // ── Panel HTML ──
    const panel = document.createElement('div');
    panel.id = 'rp-panel';
    panel.innerHTML = `
      <div id="rp-header">
        <span id="rp-header-label">⟡ JAM SESSION</span>
        <span id="rp-chevron">▼</span>
      </div>
      <div id="rp-body">
        <div class="rp-status-row">
          <span class="rp-dot idle" id="rp-status-dot"></span>
          <span id="rp-status-label">No session</span>
        </div>

        <!-- Code display (host only) -->
        <div id="rp-code-row">
          <span id="rp-code-label">CODE</span>
          <span id="rp-code-val">——————</span>
          <button id="rp-copy-btn" title="Copy code">⎘</button>
        </div>

        <!-- Join input row (before session) -->
        <div id="rp-join-row">
          <input id="rp-join-input" maxlength="6" placeholder="Enter code" autocomplete="off" spellcheck="false" />
        </div>
        <div id="rp-ai-hint" style="display:none; font-size:9px; color:var(--text-dim, #5A5D66); line-height:1.6;">
          AI0001 Piano · AI0002 Pad · AI0003 Bass<br/>
          AI0004 Piano (I–V–vi–IV) · AI0005 Pad (ii–V–I) · AI0006 Bass (walking)<br/>
          AI0007 Drums · AI0008 Lead (pitch-tracks you)<br/>
          AI0009 Drums (half-time) · AI0010 Drums (shuffle) · AI0011 Drums (jazz)<br/>
          AI0012 Arpeggio · AI0013 Rhythm Stabs · AI0014 Call &amp; Response
        </div>

        <!-- Active AI band members (band mode) -->
        <div id="rp-bot-list" style="display:none;"></div>

        <!-- Action buttons -->
        <div id="rp-action-row">
          <button class="rp-btn host" id="rp-host-btn">⟡ Host</button>
          <button class="rp-btn join" id="rp-join-btn">→ Join</button>
          <button class="rp-btn leave" id="rp-leave-btn" style="display:none;">✕ Leave</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // ── Wire panel interactions ──
    document.getElementById('rp-header').addEventListener('click', () => {
      panel.classList.toggle('rp-collapsed');
    });

    document.getElementById('rp-host-btn').addEventListener('click', () => {
      RelayPeer.hostSession();
    });

    document.getElementById('rp-join-btn').addEventListener('click', () => {
      const input = document.getElementById('rp-join-input');
      const code = input.value.trim();
      if (code.length === 6) {
        RelayPeer.joinSession(code);
        input.value = '';
      } else {
        showToast('Enter a 6-character session code');
      }
    });

    document.getElementById('rp-join-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('rp-join-btn').click();
    });

    document.getElementById('rp-leave-btn').addEventListener('click', () => {
      RelayPeer.leave();
    });

    document.getElementById('rp-copy-btn').addEventListener('click', () => {
      const code = document.getElementById('rp-code-val').textContent;
      navigator.clipboard.writeText(code).then(() => showToast('Code copied: ' + code));
    });
  }

  // ── RECEIVE HANDLER ─────────────────────────────────────────────
  // Wired after app.js initialises (window.load), so all functions exist
  function wireReceiveHandler() {
    RelayPeer.onReceive((msg) => {
      switch (msg.type) {
        case 'sync':
        case 'bpm':
          if (msg.bpm && typeof setBpm === 'function') {
            setBpm(msg.bpm);
          }
          break;
        case 'drum':
          if (typeof triggerDrum === 'function' && window.state) {
            const def = window.state.padDefs.find(d => d.note === msg.note);
            // triggerDrum unconditionally calls el.classList — pass a no-op stub
            // so bot-triggered hits don't throw and nuke the audio context.
            const elStub = { classList: { add() {}, remove() {} }, querySelector() { return null; } };
            if (def) triggerDrum(def, msg.velocity, elStub);
          }
          break;
        case 'noteOn':
          if (typeof startNote === 'function') {
            if (msg.synthType && window.state) {
              const prevType = window.state.synthType;
              window.state.synthType = msg.synthType;
              startNote(msg.note, msg.velocity);
              window.state.synthType = prevType; // restore — startNote reads synthType synchronously
            } else {
              startNote(msg.note, msg.velocity);
            }
          }
          break;
        case 'noteOff':
          if (typeof stopNote === 'function') {
            stopNote(msg.note);
          }
          break;
      }
    });
  }

  // ── INIT ────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildUI);
  } else {
    buildUI();
  }

  window.addEventListener('load', wireReceiveHandler);

})();
