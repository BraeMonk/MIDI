/* ─────────────────────────────────────────────────────────────────
   relay-peer.js  ·  P2P Jam Session  ·  v1.0.0
   Uses PeerJS (CDN) for WebRTC signaling + data channels.

   API (window.RelayPeer):
     .hostSession()       → generates 6-char code, waits for joiner
     .joinSession(code)   → connects to host by code
     .leave()             → cleanly closes the connection
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
  let aiHeldNotes   = [];     // notes the bot currently has sustained, for clean noteOff

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
  function aiNoteOn(note, velocity, synthType) {
    receiveHandler({ type: 'noteOn', note, velocity: velocity || 0.8, synthType });
    aiHeldNotes.push(note);
  }
  function aiNoteOff(note) {
    receiveHandler({ type: 'noteOff', note });
    aiHeldNotes = aiHeldNotes.filter(n => n !== note);
  }
  function aiAllNotesOff() {
    aiHeldNotes.slice().forEach(aiNoteOff);
  }

  const AI_BOTS = {
    AI0001: {
      name: 'Piano',
      desc: 'Comps melodic lines from the current scale into the gaps you leave.',
      synthType: 'keys',
      onStep(step) {
        const humanHitThisStep = aiPrevBarBuf.some(h => h.step === step);
        if (humanHitThisStep) return; // don't step on what you just played
        // Light comping: occasional single notes on weaker beats
        if ([0, 4, 8, 12].includes(step) ? Math.random() < 0.5 : Math.random() < 0.22) {
          const degree = [0, 2, 4, 7][Math.floor(Math.random() * 4)];
          const note = scaleNote(degree, 0);
          aiNoteOn(note, 0.55 + Math.random() * 0.25, this.synthType);
          setTimeout(() => aiNoteOff(note), stepDurMs() * 1.5);
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
        aiAllNotesOff();
        const rootDegree = (Math.floor(barIdx / 2) % 2 === 0) ? 0 : 3;
        [0, 2, 4].forEach(third => {
          const note = scaleNote(rootDegree + third, -1); // sit an octave below lead register
          aiNoteOn(note, 0.4, this.synthType);
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
        if (step === 0 || step === 8) {
          const note = scaleNote(0, -2);
          aiNoteOn(note, 0.85, this.synthType);
          setTimeout(() => aiNoteOff(note), stepDurMs() * 1.2);
        } else if (step === 6 || step === 14) {
          const note = scaleNote(4, -2);
          aiNoteOn(note, 0.6, this.synthType);
          setTimeout(() => aiNoteOff(note), stepDurMs() * 0.8);
        }
      },
    },
  };

  function isAICode(code) {
    return /^AI\d{4}$/.test(code) && !!AI_BOTS[code];
  }

  function startAIBot(code) {
    const bot = AI_BOTS[code];
    role = 'ai';
    aiStepIdx = 0;
    aiBarIdx = 0;
    aiHumanBuf = [];
    aiPrevBarBuf = [];
    aiHeldNotes = [];

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
      close: () => { stopAIBot(); },
    };

    setStatus('connected');
    document.getElementById('rp-status-label').textContent = `Jamming with ${bot.name}`;
    updateUI();
    showToast(`AI partner connected: ${bot.name} — ${bot.desc}`);

    if (bot.onBarStart) bot.onBarStart(aiBarIdx);

    function tick() {
      if (bot.onStep) bot.onStep(aiStepIdx);
      aiStepIdx++;
      if (aiStepIdx >= 16) {
        aiStepIdx = 0;
        aiBarIdx++;
        aiPrevBarBuf = aiHumanBuf;
        aiHumanBuf = [];
        if (bot.onBarStart) bot.onBarStart(aiBarIdx);
      }
      aiTimer = setTimeout(tick, stepDurMs());
    }
    tick();
  }

  function stopAIBot() {
    if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
    aiAllNotesOff();
    aiHumanBuf = [];
    aiPrevBarBuf = [];
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
    const leaveBtn  = document.getElementById('rp-leave-btn');
    const hostBtn   = document.getElementById('rp-host-btn');
    const joinBtn   = document.getElementById('rp-join-btn');
    if (!codeRow) return;

    const connected = dataConn && dataConn.open;
    const hosting   = role === 'host' && !connected;
    const joining   = role === 'joiner' && !connected;

    codeRow.style.display  = (role === 'host') ? 'flex' : 'none';
    joinRow.style.display  = (!role)           ? 'flex' : 'none';
    if (aiHint) aiHint.style.display = (!role) ? 'block' : 'none';
    leaveBtn.style.display = (role)            ? 'inline-flex' : 'none';
    hostBtn.style.display  = (!role)           ? 'inline-flex' : 'none';
    joinBtn.style.display  = (!role)           ? 'inline-flex' : 'none';
  }

  // ── PUBLIC API ──────────────────────────────────────────────────
  const RelayPeer = {

    async hostSession() {
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
        if (peerInstance) this.leave();
        startAIBot(code);
        return;
      }

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

    leave() {
      stopAIBot();
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
      #rp-join-input {
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
        <div id="rp-ai-hint" style="display:none; font-size:9px; color:var(--text-dim, #5A5D66); line-height:1.5;">
          AI partners: AI0001 (Piano) · AI0002 (Pad) · AI0003 (Bass)
        </div>

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
      const code = document.getElementById('rp-join-input').value.trim();
      if (code.length === 6) RelayPeer.joinSession(code);
      else showToast('Enter a 6-character session code');
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
            if (def) triggerDrum(def, msg.velocity, null);
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
