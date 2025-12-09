// game.js

// ── Safe, non-colliding storage helpers (shared with index.html) ──
function rtGameLoadUsers() {
  try { return JSON.parse(localStorage.getItem('rt_users') || '{}'); }
  catch { return {}; }
}
function rtGameSaveUsers(u) {
  try { localStorage.setItem('rt_users', JSON.stringify(u)); } catch {}
}
function rtGameGetCurrentUser() {
  try { return JSON.parse(localStorage.getItem('rt_currentUser') || 'null'); }
  catch { return null; }
}
function rtGamePersistHighScoreIfPossible(newScore) {
  const curr = rtGameGetCurrentUser();
  if (!curr) return; // no logged-in user
  const users = rtGameLoadUsers();
  if (!users[curr.username]) return;
  if (typeof users[curr.username].highScore !== 'number' || newScore > users[curr.username].highScore) {
    users[curr.username].highScore = newScore;
    rtGameSaveUsers(users);
  }
}
function rtGamePersistBestStreakIfPossible(newStreak) {
  const curr = rtGameGetCurrentUser();
  if (!curr) return;
  const users = rtGameLoadUsers();
  const u = users[curr.username];
  if (!u) return;
  if (typeof u.highStreak !== 'number' || newStreak > u.highStreak) {
    u.highStreak = newStreak;
    rtGameSaveUsers(users);
  }
}

// ── Public API ───────────────────────────────────────────────────────
function initGame(playerName, isLeftHanded = true) {
  console.log("Starting game for", playerName);
  window.playerName = playerName;
  window.isLeftHanded = !!isLeftHanded;

  const playerImg = new Image();
  const alienImg = new Image();
  let loaded = 0;

  function tryStart() {
    if (++loaded === 2) startGame(playerImg, alienImg);
  }

  [playerImg, alienImg].forEach(img => {
    img.onload = tryStart;
    img.onerror = tryStart;
  });

  playerImg.src = 'img/player.png';
  alienImg.src = 'img/alien.png';
}

window.initGame = initGame;

// ── Internal: once assets are loaded, kick off the actual game ──────
function startGame(playerImg, alienImg) {
  const canvas = document.getElementById('canvas');
  if (!canvas) {
    console.error('Canvas element #canvas not found');
    return;
  }

  // Make sure the game canvas is visible
  canvas.style.display = 'block';

  // 🚫 Hide login / intro / leaderboard when the game starts
  const auth        = document.getElementById('auth');
  const intro       = document.getElementById('intro');
  const leaderboard = document.getElementById('leaderboard');
  if (auth)        auth.style.display = 'none';
  if (intro)       intro.style.display = 'none';
  if (leaderboard) leaderboard.style.display = 'none';

  const ctx = canvas.getContext('2d');

  // Pause UI refs
  const pauseMenu      = document.getElementById('pauseMenu');
  const btnPauseResume = document.getElementById('btn-pause-resume');
  const btnPauseBack   = document.getElementById('btn-pause-back');

  const cols = 12;
  let cellWidth;
  let ship;

  // --- Speed tuning (increase/decrease here) ---
  const SPEED = {
    BULLET_VY: -18,       // was -8  → faster bullets (more negative = faster upward)
    ENEMY_SPEED_MULT: 1.9 // 1.0 = old speed; >1.0 = faster enemies
  };

  let paused = false;
  let pausedSnapshot = { withinPhase: false, quarter: null, hadWaiting: false };

  // default in-memory high score & best streak
  if (typeof window.highScore   !== 'number') window.highScore   = 0;
  if (typeof window.bestStreak  !== 'number') window.bestStreak  = 0;

  // Load saved high score / best streak for the current logged-in user (if any)
  (function initHighScoreFromStorage(){
    const curr = rtGameGetCurrentUser();
    if (curr) {
      const users = rtGameLoadUsers();
      const rec = users[curr.username];
      if (rec && typeof rec.highScore === 'number') {
        window.highScore = rec.highScore;
      }
      if (rec && typeof rec.highStreak === 'number') {
        window.bestStreak = rec.highStreak;
      }
    }
  })();

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    cellWidth = canvas.width / cols;
    if (ship) ship.updatePos();
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // Middle cell index of each quarter (0..3)
  const groupOffsets = [1, 4, 7, 10];

  // ── Quarter-run limiter: no more than 3 in a row ───────────────────
  let lastQuarter = null;
  let quarterRunLength = 0;

  function chooseNextQuarter() {
    const ALL_Q = [0, 1, 2, 3];

    // If we've already used the same quarter 3 times in a row,
    // we must choose a different one.
    let allowed = ALL_Q;
    if (lastQuarter !== null && quarterRunLength >= 3) {
      allowed = ALL_Q.filter(q => q !== lastQuarter);
    }

    const idx = Math.floor(Math.random() * allowed.length);
    const q = allowed[idx];

    if (q === lastQuarter) {
      quarterRunLength += 1;
    } else {
      lastQuarter = q;
      quarterRunLength = 1;
    }

    return q;
  }

  // ── Quarter tone parameters (Gaussian per quarter) ─────────────────
  const quarterToneParams = [
    { min: 427.65, max: 508.57, peak: 466.16 }, // Q1
    { min: 359.61, max: 427.65, peak: 392.00 }, // Q2
    { min: 302.40, max: 359.61, peak: 329.63 }, // Q3
    { min: 254.29, max: 302.40, peak: 277.18 }  // Q4
  ];

  // Grouping rules by LEVEL (quarter-based)
  function prefireIsGroupedForQuarter(qi, lvl) {
    if (lvl < 4) return true;                           // Lv 1–4 grouped everywhere
    if (lvl < 6) return (qi === 1 || qi === 3);         // Lv 5–6 grouped in Q2 & Q4
    return false;                                       // Lv 7+ exact everywhere
  }
  // NOTE: regular-shot grouping is now irrelevant (always triple-shot).

  // ── Audio + Piano Sample Loader (WAV-only) ─────────────────────────
  const audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  const SAMPLE_PATH = 'audio';
  const PIANO_SAMPLE_LIST = [
    261.63, 277.18, 293.66, 311.13, 329.63, 349.23,
    369.99, 392.00, 415.30, 440.00, 466.16, 493.88
  ];
  const piano = { buffers: new Map(), ready: false };

  const pianoComp = audioCtx.createDynamicsCompressor();
  pianoComp.threshold.setValueAtTime(-30, audioCtx.currentTime);
  pianoComp.knee.setValueAtTime(30, audioCtx.currentTime);
  pianoComp.ratio.setValueAtTime(3, audioCtx.currentTime);
  pianoComp.attack.setValueAtTime(0.003, audioCtx.currentTime);
  pianoComp.release.setValueAtTime(0.25, audioCtx.currentTime);

  const pianoMaster = audioCtx.createGain();
  pianoMaster.gain.setValueAtTime(2.3, audioCtx.currentTime);
  pianoComp.connect(pianoMaster).connect(audioCtx.destination);

  function decodeAudioDataP(ab) {
    return new Promise((resolve, reject) => {
      audioCtx.decodeAudioData(ab, resolve, reject);
    });
  }

  let samplesLoadPromise = null;
  function loadPianoSamples() {
    if (samplesLoadPromise) return samplesLoadPromise;
    samplesLoadPromise = (async () => {
      let ok = 0;
      for (const f of PIANO_SAMPLE_LIST) {
        const fname = f.toFixed(2);
        const url = `${SAMPLE_PATH}/${fname}.wav`;
        try {
          const res = await fetch(url);
          if (!res.ok) { console.warn(`[piano] fetch failed ${res.status}: ${url}`); continue; }
          const arr = await res.arrayBuffer();
          const buf = await decodeAudioDataP(arr);
          piano.buffers.set(f, buf);
          ok++;
        } catch (err) {
          console.warn('[piano] sample failed to load:', url, err);
        }
      }
      piano.ready = piano.buffers.size > 0;
      console.log(`Piano samples loaded: ${ok}/${PIANO_SAMPLE_LIST.length}`, { loaded: [...piano.buffers.keys()] });
      window.PIANO_DEBUG = piano;
    })();
    return samplesLoadPromise;
  }

  function waitForPianoReady(timeoutMs = 20000) {
    return new Promise(resolve => {
      if (piano.ready) return resolve();
      const start = performance.now();
      const id = setInterval(() => {
        if (piano.ready || (performance.now() - start) > timeoutMs) {
          clearInterval(id);
          resolve();
        }
      }, 25);
    });
  }

  // ── RNG & frequency sampling by QUARTER ────────────────────────────
  function randn_bm() {
    let u=0,v=0;
    while(!u) u=Math.random();
    while(!v) v=Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
function sampleFreqForQuarter(qi) {
  const { min, max, peak } = quarterToneParams[qi];
  const sigma = (max - min) / 6;

  // Start from the base (quarter-specific) Gaussian
  let freq = peak + randn_bm() * sigma;
  freq = Math.max(min, Math.min(max, freq));

  const midRange = (min + max) / 2;
  let shifts;

  if (qi === 0) {
    // QUADRANT 1: strong bias to LOWER octaves (down to -4)
    // Most picks are -4, -3, or -2; occasional -1 or 0
    shifts = [-4, -4, -3, -3, -2, -2, -1, 0];
  } else if (qi === 3) {
    // QUADRANT 4: strong bias to HIGHER octaves (up to +4)
    // Most picks are +2, +3, or +4; occasional +1 or 0
    shifts = [0, 1, 2, 2, 3, 3, 4, 4];
  } else {
    // QUADRANTS 2 & 3: keep the existing, more balanced behavior
    shifts = (freq > midRange)
      ? [-3, -2, -2, 0,  2]
      : [ 3,  2,  2, 0, -2];
  }

  const octaveShift = shifts[Math.floor(Math.random() * shifts.length)];
  return freq * Math.pow(2, octaveShift);
}

  // ── Tone timing controls ───────────────────────────────────────────
  const noteDur = 0.95;
  const NEXT_NOTE_LEAD = 0.35;
  const toneCloudDuration = 2;

  function getClosestSample(targetHz) {
    if (piano.buffers.size === 0) return null;
    const bases = [...piano.buffers.keys()].sort((a,b)=>a-b);
    let t = targetHz;
    const minHz = bases[0], maxHz = bases[bases.length-1];
    while (t < minHz) t *= 2;
    while (t >= maxHz*2) t /= 2;
    let best = null, bestDist = Infinity;
    for (const b of bases) {
      const d = Math.abs(Math.log2(t / b));
      if (d < bestDist) { bestDist = d; best = b; }
    }
    return { baseHz: best, buf: piano.buffers.get(best), tunedTarget: t };
  }

  function playPianoTone(targetHz, dur = noteDur, startTime = audioCtx.currentTime) {
    if (!piano.ready || piano.buffers.size === 0) {
      console.warn('[piano] not ready yet; tone skipped');
      return;
    }
    const choice = getClosestSample(targetHz);
    if (!choice) return;

    const rate = choice.tunedTarget ? (choice.tunedTarget / choice.baseHz) : (targetHz / choice.baseHz);

    const src = audioCtx.createBufferSource();
    src.buffer = choice.buf;
    src.playbackRate.setValueAtTime(rate, startTime);
    src.loop = false;

    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    const startCut = Math.min(9000, Math.max(1500, targetHz * 3));
    const endCut   = Math.min(6000, Math.max( 900, targetHz * 1.2));
    lp.frequency.setValueAtTime(startCut, startTime);
    lp.frequency.exponentialRampToValueAtTime(endCut, startTime + dur * 0.8);
    lp.Q.value = 0.7;

    const g = audioCtx.createGain();
    const A = 0.006, D = 0.08, R = 0.10, S = 0.80;
    g.gain.setValueAtTime(0.0001, startTime);
    g.gain.exponentialRampToValueAtTime(1.15, startTime + A);
    g.gain.exponentialRampToValueAtTime(S, startTime + A + D);
    const sustainEnd = Math.max(startTime + A + D + 0.02, startTime + dur - R);
    g.gain.setValueAtTime(S, sustainEnd);
    g.gain.exponentialRampToValueAtTime(0.0001, startTime + dur);

    src.connect(lp).connect(g).connect(pianoComp);
    src.start(startTime);
    src.stop(startTime + dur + 0.02);
  }

  function playStatic(d = 2) {
    const sr = audioCtx.sampleRate;
    const len = sr * d;
    const buf = audioCtx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.02;
    const src = audioCtx.createBufferSource();
    const g = audioCtx.createGain();
    src.buffer = buf; g.gain.value = 0.1;
    src.connect(g).connect(audioCtx.destination);
    src.start();
  }

  function playLaser() {
    const now = audioCtx.currentTime;
    const size = audioCtx.sampleRate * 0.1;
    const buf = audioCtx.createBuffer(1, size, audioCtx.sampleRate), data = buf.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * 0.3;
    const src = audioCtx.createBufferSource(), g = audioCtx.createGain();
    g.gain.setValueAtTime(1, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    src.buffer = buf; src.connect(g).connect(audioCtx.destination); src.start(now);
  }

  function playPew() {
    const now = audioCtx.currentTime;
    const size = audioCtx.sampleRate * 0.3;
    const buf = audioCtx.createBuffer(1, size, audioCtx.sampleRate), data = buf.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * 0.25;
    const src = audioCtx.createBufferSource(), g = audioCtx.createGain();
    g.gain.setValueAtTime(1, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    src.buffer = buf; src.connect(g).connect(audioCtx.destination); src.start(now);
  }

  function playCloudTone(freq, dur, startTime) {
    const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
    osc.type = 'square'; osc.frequency.setValueAtTime(freq, startTime);
    g.gain.setValueAtTime(0, startTime);
    g.gain.linearRampToValueAtTime(0.15, startTime + 0.005);
    g.gain.linearRampToValueAtTime(0, startTime + dur);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(startTime);
    osc.stop(startTime + dur);
  }

  function playToneCloud(dur) {
    const start = audioCtx.currentTime, end = start + dur;
    for (let t = start; t < end; t += 1/3) playCloudTone(440, 0.1, t);
    const rate = 15, interval = 1 / rate;
    for (let t = start; t < end; t += interval) {
      const sign = Math.random() < 0.5 ? -1 : 1;
      const oct = 0.5 + Math.random() * 2;
      playCloudTone(440 * Math.pow(2, sign * oct), 0.1, t);
    }
  }

  // ── Score multiplier for enemy kills based on streak ───────────────
  function getKillPointsForStreak(streakValue) {
    const base = 100;
    const s = Math.max(0, streakValue || 0);          // ensure non-negative
    const multiplier = Math.pow(1.25, s);             // 1.25^streak
    return Math.round(base * multiplier);             // round to nearest int
  }

  // ── NOTE SCHEDULER ─────────────────────────────────────────────────
  let toneLoopTimer = null;
  let lastToneHz = null;

  function centsBetween(a, b) { return Math.abs(1200 * Math.log2(a / b)); }
  function pickNonRepeatingFreqForQuarter(qi) {
    let tries = 0;
    while (tries < 8) {
      const f = sampleFreqForQuarter(qi);
      if (lastToneHz == null || centsBetween(f, lastToneHz) >= 25) {
        lastToneHz = f; return f;
      }
      tries++;
    }
    lastToneHz = sampleFreqForQuarter(qi);
    return lastToneHz;
  }

  function startToneSequence(qi) {
    stopToneSequence();
    if (!piano.ready) { console.warn('[piano] tried to start before ready'); return; }
    const IOI = Math.max(0.03, noteDur - NEXT_NOTE_LEAD);
    const scheduleNext = (startTime) => {
      const f = pickNonRepeatingFreqForQuarter(qi);
      playPianoTone(f, noteDur, startTime);
      const nextStart = startTime + IOI;
      const delayMs   = Math.max(0, (nextStart - audioCtx.currentTime - 0.01) * 1000);
      toneLoopTimer = setTimeout(() => scheduleNext(nextStart), delayMs);
    };
    const firstStart = audioCtx.currentTime + 0.02;
    scheduleNext(firstStart);
  }

  function stopToneSequence() {
    if (toneLoopTimer) { clearTimeout(toneLoopTimer); toneLoopTimer = null; }
    lastToneHz = null;
  }

  // ── Timers to fully stop activity on pause/death/restart ───────────
  let prefireTimer = null;       // 2s before prediction phase
  let spawnTimer   = null;       // 4s prediction window until spawn
  let cloudTimerId = null;       // playToneCloud() timer
  let afterCloudTimerId = null;  // resume after cloud

  function clearAllTimers() {
    if (prefireTimer) { clearTimeout(prefireTimer); prefireTimer = null; }
    if (spawnTimer)   { clearTimeout(spawnTimer);   spawnTimer = null; }
    if (cloudTimerId) { clearTimeout(cloudTimerId); cloudTimerId = null; }
    if (afterCloudTimerId) { clearTimeout(afterCloudTimerId); afterCloudTimerId = null; }
  }

  // Draw the High Score + Best Streak box (top-right)
  function drawHighScoreBox() {
    const label1 = `High Score: ${window.highScore  || 0}`;
    const label2 = `Best Streak: ${window.bestStreak || 0}`;

    ctx.save();
    ctx.font = '18px sans-serif';
    const pad = 10;

    const w = Math.max(
      ctx.measureText(label1).width,
      ctx.measureText(label2).width
    ) + pad * 2;

    const lineHeight = 22;
    const h = lineHeight * 2 + pad * 2;
    const x = canvas.width - w - 10;
    const y = 10;

    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'cyan';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    ctx.fillStyle = 'white';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(label1, x + pad, y + pad);
    ctx.fillText(label2, x + pad, y + pad + lineHeight);

    ctx.restore();
  }

  // ── Pause helpers ──────────────────────────────────────────────────
  function togglePause() {
    if (over) return;

    if (!paused) {
      pausedSnapshot.withinPhase = (withinPhase && !enemy);
      pausedSnapshot.quarter     = expectedQuarter;
      pausedSnapshot.hadWaiting  = (waiting && !enemy);
    }

    paused = !paused;

    if (paused) {
      clearAllTimers();
      stopToneSequence();
      audioCtx.suspend().catch(()=>{});
      if (pauseMenu) pauseMenu.style.display = 'flex';
    } else {
      if (pauseMenu) pauseMenu.style.display = 'none';
      audioCtx.resume().catch(()=>{});

      // If paused during the prediction phase, resume tones immediately
      if (pausedSnapshot.withinPhase && !enemy) {
        withinPhase = true;
        waiting = true;
        startToneSequence(pausedSnapshot.quarter);

        if (spawnTimer) { clearTimeout(spawnTimer); }
        spawnTimer = setTimeout(()=>{
          if (over || paused) return;
          if(!phaseShot)streak=0;
          const spawnCell = groupOffsets[pausedSnapshot.quarter];
          enemy=new Enemy(spawnCell,levels[lvl].s);
          waiting=false;
          withinPhase=false;
        },4000);
        return; // don't scheduleWave() here or we'd interrupt tones
      }

      // If we paused during a waiting period, allow a fresh wave
      if (waiting && !enemy && !inTransition) waiting = false;
      scheduleWave();
    }
  }

  function exitToLogin() {
    // Persist best score seen this session
    const best = Math.max(score || 0, window.highScore || 0);
    if (best > (window.highScore || 0)) {
      window.highScore = best;
      rtGamePersistHighScoreIfPossible(window.highScore);
    }

    // Persist best streak seen this session
    if (bestStreak > (window.bestStreak || 0)) {
      window.bestStreak = bestStreak;
    }
    rtGamePersistBestStreakIfPossible(window.bestStreak);

    over = true;
    paused = false;

    clearAllTimers();
    stopToneSequence();
    audioCtx.suspend().catch(()=>{});

    if (pauseMenu) pauseMenu.style.display = 'none';
    const overlay = document.getElementById('overlay');
    if (overlay) overlay.style.display = 'none';

    // Remove key handler to avoid Esc affecting login screen
    if (window._rtKeyHandlerRef) {
      document.removeEventListener('keydown', window._rtKeyHandlerRef);
      window._rtKeyHandlerRef = null;
    }

    // Hide game, show auth
    canvas.style.display = 'none';
    const intro = document.getElementById('intro');
    const leaderboard = document.getElementById('leaderboard');
    const auth = document.getElementById('auth');
    if (intro) intro.style.display = 'none';
    if (leaderboard) leaderboard.style.display = 'none';
    if (auth) auth.style.display = 'flex';
  }

  // ── Entities ───────────────────────────────────────────────────────
  class Ship {
    constructor() {
      this.group = 1;        // 0..3 (quarters)
      this.blockOffset = 0;  // always MID; lane movement disabled
      this.w = cellWidth * 2.5;
      const ratio = playerImg.naturalWidth
        ? playerImg.naturalHeight / playerImg.naturalWidth
        : 0.5;
      this.h = this.w * ratio;
      this.updatePos();
    }
    updatePos() {
      const baseMid = groupOffsets[this.group];
      this.cell = baseMid; // always mid cell of the quarter
      this.x = (this.cell + 0.5) * cellWidth;
      this.y = canvas.height - this.h / 2;
    }
    draw() {
      ctx.drawImage(playerImg, this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);
    }
    move(d) {
      // Only quarter movement (no lane changes)
      this.group = Math.max(0, Math.min(groupOffsets.length - 1, this.group + d));
      this.blockOffset = 0; // keep mid
      this.updatePos();
    }
  }

  class Bullet {
    constructor(x,y) { 
      this.x = x; 
      this.y = y; 
      this.r = 4; 
      this.vy = SPEED.BULLET_VY; // faster bullets
    }
    update() { this.y += this.vy; }
    draw() {
      ctx.beginPath();
      ctx.arc(this.x,this.y,this.r,0,2*Math.PI);
      ctx.fillStyle='yellow'; ctx.fill();
    }
    off() { return this.y < 0; }
  }

  class Enemy {
    constructor(cellIndex,s) {
      this.x=(cellIndex+0.5)*cellWidth;
      this.y=-20;
      this.vy = (s/60) * SPEED.ENEMY_SPEED_MULT;  // faster descent
      this.r=16;
    }
    update() { this.y += this.vy; }
    draw() {
      const sz=this.r*2;
      ctx.drawImage(alienImg, this.x-sz/2, this.y-sz/2, sz, sz);
    }
    hit() { return this.y+this.r >= ship.y-ship.h/2; }
  }

  // Levels kept as-is
  const levels=[
    {s:50,w:['topLeft','bottomRight']},
    {s:60,w:['topLeft','bottomRight']},
    {s:70,w:['topLeft','bottomRight','bottomLeft']},
    {s:80,w:['topLeft','bottomRight','bottomLeft']},
    {s:80,w:['topLeft','bottomRight','bottomLeft','topRight']},
    {s:80,w:['topLeft','bottomRight','bottomLeft','topRight']},
    {s:80,w:['topLeft','bottomRight']},
    {s:80,w:['topLeft','bottomRight','bottomLeft','topRight']}
  ];

  let bullets,enemy,lvl,score,waiting,over,inTransition,
      expectedQuarter,withinPhase,phaseShot,streak=0,
      explosions=[],effects=[];
  let bestStreak = window.bestStreak || 0;
    // Track last chosen quarter and how many times it's been repeated
  function chooseNextQuarter() {
    const ALL_Q = [0, 1, 2, 3];

    // If we've already used the same quarter 3 times in a row,
    // we must choose a different one.
    let allowed = ALL_Q;
    if (lastQuarter !== null && quarterRunLength >= 3) {
      allowed = ALL_Q.filter(q => q !== lastQuarter);
    }

    const idx = Math.floor(Math.random() * allowed.length);
    const q = allowed[idx];

    // Update run-length tracking
    if (q === lastQuarter) {
      quarterRunLength += 1;
    } else {
      lastQuarter = q;
      quarterRunLength = 1;
    }

    return q;
  }


  const overlay=document.getElementById('overlay'),
        transition=document.getElementById('transition');

  function initState(){
    ship=new Ship(); bullets=[]; enemy=null; score=0; lvl=0;
    waiting=false; over=false; inTransition=false; streak=0;
    explosions=[]; effects=[];
    // bestStreak stays as-is across runs until a new user logs in
  }  

  function initLoop(){
    initState();
    document.addEventListener('keydown', unlock, { once:true });
    requestAnimationFrame(loop);
  }

  async function unlock(){
    try {
      await audioCtx.resume();   // user gesture
    } catch {}
    // Fire-and-forget: start loading samples but DO NOT await readiness
    loadPianoSamples();
    // Start the game flow right away
    scheduleWave();
  }

  function scheduleWave() {
    if (over || waiting || enemy || inTransition || paused) return;

    stopToneSequence();

    const req = 5 + lvl;
    if (streak >= req) { startTransition(); return; }

    waiting = true;
    withinPhase = false;
    phaseShot = false;

    // Pick a quarter 0..3, with safety: no more than 3 in a row
    expectedQuarter = chooseNextQuarter();
    const spawnCell = groupOffsets[expectedQuarter];

    playStatic(2);
    prefireTimer = setTimeout(async ()=>{
      if (inTransition || over || paused) return;
      await waitForPianoReady();
      withinPhase = true;

      // Start the continuous sequence for THIS quarter
      startToneSequence(expectedQuarter);

      // Spawn alien after prefire window
      spawnTimer=setTimeout(()=>{
        if (over || paused) return;
        if(!phaseShot)streak=0;
        enemy=new Enemy(spawnCell,levels[lvl].s);
        waiting=false;
        withinPhase=false;
      },4000);
    },2000);
  }

  function startTransition(){
    inTransition=true;waiting=true;
    stopToneSequence();
    transition.textContent='Level Completed!';transition.style.display='block';
    setTimeout(()=>transition.textContent=`Level ${lvl+2}`,2000);
    setTimeout(()=>{
      transition.style.display='none';
      lvl=Math.min(lvl+1,levels.length-1);
      streak=0;waiting=false;inTransition=false;
      scheduleWave();
    },5000);
  }

  // restart routine (used by 'R' on death)
  function restartGame() {
    clearAllTimers();
    stopToneSequence();
    overlay.style.display='none';

    paused = false;
    if (pauseMenu) pauseMenu.style.display = 'none';

    initState();

    // resume audio immediately (R key is a user gesture)
    audioCtx.resume().catch(()=>{});

    requestAnimationFrame(loop);
    scheduleWave();
  }

  function loop(){
    if(over) return;

    // If paused, keep RAF alive but skip updates/draw
    if (paused) { requestAnimationFrame(loop); return; }

    ctx.clearRect(0,0,canvas.width,canvas.height);

    // Left-top HUD
    ctx.fillStyle='white';
    ctx.font='20px sans-serif';ctx.textAlign='left';
    ctx.fillText(`Score: ${score}`,10,30);ctx.fillText(`Streak: ${streak}`,10,60);

    // Top-right High Score box
    drawHighScoreBox();

    // Bottom quarter markers 1–4
    ctx.font='12px monospace';ctx.textAlign='center';
    groupOffsets.forEach((c,i)=>{const x=(c+0.5)*cellWidth,y=canvas.height-5;ctx.fillStyle=(ship.group===i?'yellow':'gray');ctx.fillText(i+1,x,y);});

    const now=Date.now();
    explosions=explosions.filter(e=>now-e.time<500);
    explosions.forEach(e=>{
      const exX=(e.cell+0.5)*cellWidth,p=8,pat=[[0,1,0],[1,1,1],[0,1,0]];
      ctx.fillStyle='orange';
      for(let ry=0;ry<3;ry++)for(let rx=0;rx<3;rx++)if(pat[ry][rx])ctx.fillRect(exX-p+rx*p,p+ry*p,p,p);
    });
    effects=effects.filter(e=>!e.completed);
    effects.forEach(effect=>{
      const p=Math.min(1,(Date.now()-effect.startTime)/effect.duration);
      if(p>=1){effect.completed=true;return;}
      const exX=(effect.cell+0.5)*cellWidth,exY=0;
      ctx.save();
      if(p<0.5){
        const sz=60,gl=sz/1.8+10;ctx.globalAlpha=0.9;ctx.fillStyle='rgba(0,200,255,0.7)';
        ctx.beginPath();ctx.arc(exX,exY,sz/1.8,0,2*Math.PI);ctx.fill();
        const g=ctx.createRadialGradient(exX,exY,0,exX,exY,gl);
        g.addColorStop(0,'rgba(0,220,255,0.6)');g.addColorStop(0.7,'rgba(0,255,255,0.4)');g.addColorStop(1,'transparent');
        ctx.fillStyle=g;ctx.beginPath();ctx.arc(exX,exY,gl,0,2*Math.PI);ctx.fill();ctx.globalAlpha=1;
      }
      ctx.strokeStyle=`rgba(0,255,255,${1-p*0.7})`;ctx.lineWidth=3-p*2;
      ctx.beginPath();ctx.moveTo(exX,exY);ctx.lineTo(exX,ship.y-ship.h/2);ctx.stroke();ctx.restore();
    });

    if(!inTransition)ship.draw();
    bullets?.forEach(b=>{b.update();b.draw();});

    if(enemy){
      enemy.update();enemy.draw();
      if(enemy.hit()){
        // Persist high score on death
        if (score > (window.highScore || 0)) {
          window.highScore = score;
          rtGamePersistHighScoreIfPossible(window.highScore);
        }

        // Persist best streak on death
        if (bestStreak > (window.bestStreak || 0)) {
          window.bestStreak = bestStreak;
        }
        rtGamePersistBestStreakIfPossible(window.bestStreak);

        over = true;
        clearAllTimers();
        stopToneSequence();
        audioCtx.suspend().catch(()=>{});

        overlay.style.display='block';
        return;
      }
    }

    bullets = (bullets || []).filter(b=>{
      if(b.off())return false;
      if (enemy && Math.hypot(enemy.x - b.x, enemy.y - b.y) < enemy.r + b.r) {
        // Score for destroying this enemy scales with current streak:
        // base 100 × 1.25^streak
        const killPoints = getKillPointsForStreak(streak);
        score += killPoints;

        enemy = null;
        stopToneSequence(); // stop tone when alien dies (before cloud)
        waiting = true;

        // Track these so they can be cancelled if the player dies/pauses
        cloudTimerId = setTimeout(() => playToneCloud(toneCloudDuration), 1000);
        afterCloudTimerId = setTimeout(() => {
          if (over) return;
          waiting = false;
          scheduleWave();
        }, 1000 + toneCloudDuration * 1000 + 1000);

        return false;
      }
      return true;
    });

    if(!enemy&&!waiting&&!inTransition)scheduleWave();
    requestAnimationFrame(loop);
  } // end of loop()

  // Hook pause buttons
  if (btnPauseResume) btnPauseResume.addEventListener('click', () => { if (paused) togglePause(); });
  if (btnPauseBack)   btnPauseBack.addEventListener('click', () => { exitToLogin(); });

  // Movement & shooting parameters (dedup across restarts)
  if (window._rtKeyHandlerRef) {
    document.removeEventListener('keydown', window._rtKeyHandlerRef);
  }

  const keyHandler = (e) => {
    const k = (e.key || '').toLowerCase();

    // Pause toggle on Esc
    if (e.key === 'Escape' || k === 'escape') { togglePause(); return; }

    // Ignore all other input while paused
    if (paused) return;

    // Restart: if dead, 'r' resets immediately (and resumes audio)
    if (k === 'r' && over) { restartGame(); return; }

    // Move between quarters (no lane movement)
    {
      const kRaw = e.key || '';
      const kLower = kRaw.toLowerCase();

      // Left-handed keys: 1–4
      const LEFT_KEYS  = new Map([['1',0], ['2',1], ['3',2], ['4',3]]);
      // Right-handed keys: P, [, ], \
      const RIGHT_KEYS = new Map([['p',0], ['[',1], [']',2], ['\\',3]]);

      let movementIndex;
      if (window.isLeftHanded) {
        movementIndex = LEFT_KEYS.get(kRaw);          // digits come through as raw '1'..'4'
      } else {
        movementIndex = RIGHT_KEYS.get(kRaw) ?? RIGHT_KEYS.get(kLower); // handle 'p' or 'P'
      }

      if (movementIndex !== undefined) {
        ship.group = movementIndex;
        ship.blockOffset = 0; // always mid
        ship.updatePos();
        return;
      }
    }

    if (k === 'c') {
      streak++;
      if (streak > bestStreak) {
        bestStreak = streak;
        window.bestStreak = bestStreak;
      }
      return;
    }

    // ── 1) PREDICTION PHASE (pre-fire) — quarter-based
    if (withinPhase && !enemy) {
      const alienQuarter  = expectedQuarter;
      const playerQuarter = ship.group;
      const groupedPhase  = prefireIsGroupedForQuarter(alienQuarter, lvl);

      // Wrong quarter on F → reset & lockout
      if (k === 'f' && playerQuarter !== alienQuarter) {
        streak = 0;
        withinPhase = false;
        return;
      }

      if (groupedPhase) {
        if (k !== 'f' || playerQuarter !== alienQuarter) return;

        score += 75;
        streak++;
        if (streak > bestStreak) {
          bestStreak = streak;
          window.bestStreak = bestStreak;
        }
        phaseShot = true;
        stopToneSequence();
        clearTimeout(spawnTimer);
        playPew();
        const spawnCell = groupOffsets[alienQuarter];
        effects.push({ type: 'precogScreenFlash', cell: spawnCell, startTime: Date.now(), duration: 600 });
        waiting = true; withinPhase = false;

        cloudTimerId = setTimeout(() => playToneCloud(toneCloudDuration), 1000);
        afterCloudTimerId = setTimeout(() => { if(!over){ waiting = false; scheduleWave(); } }, (1 + toneCloudDuration + 1) * 1000);
        return;
      }

      // Exact phases (Lv 7+): require MID lane in the correct quarter — always mid now.
      if (k === 'f') {
        if (playerQuarter === alienQuarter /* and mid by design */) {
          score += 75;
          streak++;
          if (streak > bestStreak) {
            bestStreak = streak;
            window.bestStreak = bestStreak;
          }
          phaseShot = true;
          stopToneSequence();
          clearTimeout(spawnTimer);
          playPew();
          const spawnCell = groupOffsets[alienQuarter];
          effects.push({ type: 'precogScreenFlash', cell: spawnCell, startTime: Date.now(), duration: 600 });
          waiting = true; withinPhase = false;

          cloudTimerId = setTimeout(() => playToneCloud(toneCloudDuration), 1000);
          afterCloudTimerId = setTimeout(() => { if(!over){ waiting = false; scheduleWave(); } }, (1 + toneCloudDuration + 1) * 1000);
        } else {
          streak = 0;
          withinPhase = false;
        }
        return;
      }
      return;
    }

    // ── 2) REGULAR SHOOTING — ALWAYS TRIPLE SHOT ─────────────────────
    if (k === 'f') {
      const base = groupOffsets[ship.group];
      [-1, 0, 1].forEach(off => {
        const c = base + off;
        playLaser();
        bullets = bullets || [];
        bullets.push(new Bullet((c + 0.5) * cellWidth, ship.y - ship.h / 2));
      });
    }
  };

  document.addEventListener('keydown', keyHandler);
  window._rtKeyHandlerRef = keyHandler;

  // ── finally, kick off the animation loop ────────────────────────────
  initLoop();
}