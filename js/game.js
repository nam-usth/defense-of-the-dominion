// ─── GAME ────────────────────────────────────────────────────────────────────
const G = (() => {
  // Three.js
  const canvas = document.getElementById('gc');
  const chCanvas = document.getElementById('crosshair-canvas');
  const chCtx = chCanvas.getContext('2d');
  let W, H;
  let _logW = 0, _logH = 0; // logical (CSS) canvas dimensions — never multiplied by devicePixelRatio

  let gfxQuality = 'HIGH'; // 'LOW' | 'HIGH'
  let _ambientLight, _sunLight, _fillLight, _bunkerLight, _fireLight, _muzzleLight, _gunLight, _nukeLight;
  let _gunI = 0;   // its strength before the night's share (muzzleFlash)

  // ── Day/Night cycle (experimental) ──────────────────────────────────────
  let dnEnabled = false;     // opt-in toggle
  let _dnTime   = 0;         // seconds into current cycle (0..DN_CYCLE)
  let _dnFactor = 0;         // 0=full day, 1=full night (smooth blend)
  let _dnLitF   = 0;         // effective factor the lights / fog were last applied at (a Viking flare lifts it)
  // One cycle (3 min): day 78 s → dusk 24 s → night 54 s → dawn 24 s
  const DN_DAY = 78, DN_FADE = 24, DN_NIGHT = 54;
  const DN_CYCLE = DN_DAY + DN_FADE + DN_NIGHT + DN_FADE;
  const DN_SLEW = 2.5;       // turning the cycle on / off blends over at most this many seconds
  const DN_NIGHT_FOG_NEAR = 2.5;
  const DN_NIGHT_FOG_FAR  = 9.0;
  const DN_DAY_FOG_NEAR   = 45;
  const DN_DAY_FOG_FAR    = 90;
  // Interpolation helpers (reused temps — called every frame)
  const _dnColA = new THREE.Color(), _dnColB = new THREE.Color();
  function _dnLerpCol(hexA, hexB, t) {
    _dnColA.set(hexA); _dnColB.set(hexB);
    return _dnColA.lerp(_dnColB, t);
  }

  // A float render target (WebGL2 + EXT_color_buffer_float) runs the HDR post-processing (see there), whose
  // scene target is multisampled itself: the canvas then only takes the composite and needs no MSAA of its own
  const HDR_OK = (() => {
    try {
      const gl = document.createElement('canvas').getContext('webgl2'), ok = !!(gl && gl.getExtension('EXT_color_buffer_float'));
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      return ok;
    } catch (e) { return false; }
  })();
  const renderer = new THREE.WebGLRenderer({canvas, antialias:!HDR_OK, powerPreference:'high-performance'});   // (a laptop's discrete GPU, if the browser lets us)
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2a3a18);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
  camera.position.set(0, 22, 8);
  camera.lookAt(0, 0, 0);
  const clock = new THREE.Clock();

  // ── Camera rig ─────────────────────────────────────────────────────────────
  // The view always looks at the bunker (as in SC2). Mouse wheel / + − zoom
  // from the tactical overview down to a close-up of the bunker (the camera
  // also lowers its angle as it comes in); Insert / Delete rotate the view 90°
  // left / right; Home resets. Zoom and rotation ease toward their targets.
  const CAM = { farDist: Math.hypot(22, 8), farElev: Math.atan2(22, 8),   // overview = the original (0, 22, 8)
                nearDist: 6.5, nearElev: 0.62, nearLookY: 1.0 };
  let _zoom = 0, _zoomT = 0, _camYaw = 0, _camYawT = 0;
  function updateCamera(dt) {
    const k = Math.min(1, dt * 9);
    _zoom += (_zoomT - _zoom) * k;
    _camYaw += (_camYawT - _camYaw) * k;
    const z = _zoom * _zoom * (3 - 2 * _zoom);                  // smoothstep
    const dist = CAM.farDist + (CAM.nearDist - CAM.farDist) * z;
    const elev = CAM.farElev + (CAM.nearElev - CAM.farElev) * z;
    const ly = CAM.nearLookY * z, hz = Math.cos(elev) * dist;
    camera.position.set(Math.sin(_camYaw) * hz, ly + Math.sin(elev) * dist, Math.cos(_camYaw) * hz);
    camera.lookAt(0, ly, 0);
    camera.updateMatrixWorld(); // HP bars / crosshair / slot bar project with this frame's camera
  }
  function zoomView(delta) { _zoomT = Math.max(0, Math.min(1, _zoomT + delta)); }
  function rotateView(dir) {                                     // -1 = left (Insert), +1 = right (Delete)
    const q = Math.PI / 2;
    _camYawT = Math.round(_camYawT / q) * q + dir * q;              // always lands on a 90° step
  }
  function resetView() {
    _zoomT = 0;
    _camYawT = Math.round(_camYaw / (2 * Math.PI)) * 2 * Math.PI; // back to north-up the short way
  }
  const RC = new THREE.Raycaster();
  const MV = new THREE.Vector2();
  let groundMesh;

  // State
  let phase='menu', score=0, wave=1, kills=0;
  let victoryAchieved = false;      // campaign won (this run)
  let gameMode = 'campaign';        // 'campaign' (win at CFG.victory_wave) | 'endless'
  // Game clock: advances only while playing and unpaused (a hidden tab stops
  // requestAnimationFrame, so it freezes too). Drives the survival timer,
  // cooldowns, slows and every scheduled game event.
  let _gameT = 0;

  // ── Game-time scheduler ────────────────────────────────────────────────────
  // Gameplay sequences (wave countdown, Viking run, bombs, nuke) used to run on
  // setTimeout/setInterval: they kept going while paused and fired into the
  // next game after Restart/Load. They now run here, ticked by loop() only when
  // the game is live, and are dropped by start().
  //   after(sec, fn)        — one-shot
  //   addTicker(fn, clean)  — fn(dt) every live frame until it returns false;
  //                           clean() runs when it ends or is dropped
  let _timers = [], _tickers = [];
  function after(sec, fn) { _timers.push({ t: sec, fn }); }
  function addTicker(fn, clean) { _tickers.push({ fn, clean }); }
  function tickScheduler(dt) {
    const due = [];
    _timers = _timers.filter(tm => { tm.t -= dt; if (tm.t <= 0) { due.push(tm.fn); return false; } return true; });
    due.forEach(fn => fn());
    _tickers = _tickers.filter(tk => {
      if (tk.fn(dt) !== false) return true;
      tk.clean?.(); return false;
    });
  }
  function clearScheduler() {
    _tickers.forEach(tk => tk.clean?.());
    _timers = []; _tickers = [];
  }

  // ── Sound effects (Web Audio, synthesised — no audio files) ───────────────
  // Every sound is built from two primitives — a filtered noise burst and a
  // pitch-swept oscillator — routed through a compressor. The context is
  // created/resumed on a user gesture (browsers block autoplay); frequent
  // sounds are rate-limited so a late-wave volley doesn't turn into noise.
  const SFX = (() => {
    let ctx = null, master = null, noiseBuf = null, muted = false, volume = 0.6;
    const last = {};
    try {
      const v = localStorage.getItem('dotd_volume');
      if (v !== null) volume = Math.max(0, Math.min(1, +v));
      muted = localStorage.getItem('dotd_muted') === '1';
    } catch (e) {}
    function ensure() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 6;
        master = ctx.createGain(); master.gain.value = muted ? 0 : volume;
        master.connect(comp); comp.connect(ctx.destination);
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      if (ctx.state === 'suspended') ctx.resume();
    }
    function env(t, dur, gain) {   // fast attack, exponential decay
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      g.connect(master);
      return g;
    }
    function noise(t, dur, f0, f1, gain, type = 'bandpass', q = 1.2) {
      const src = ctx.createBufferSource(); src.buffer = noiseBuf;
      src.playbackRate.value = 0.8 + Math.random() * 0.4;
      const flt = ctx.createBiquadFilter(); flt.type = type; flt.Q.value = q;
      flt.frequency.setValueAtTime(f0, t); flt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      src.connect(flt); flt.connect(env(t, dur, gain));
      src.start(t); src.stop(t + dur + 0.02);
    }
    function tone(t, dur, f0, f1, gain, type = 'square') {
      const o = ctx.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      o.connect(env(t, dur, gain));
      o.start(t); o.stop(t + dur + 0.02);
    }
    const SOUNDS = {
      marine:   t => { noise(t, .07, 1800, 900, .32); tone(t, .05, 140, 60, .06); },
      marauder: t => { tone(t, .18, 120, 45, .45, 'sine'); noise(t, .14, 900, 200, .28, 'lowpass'); },
      ghost:    t => { tone(t, .12, 900, 180, .14, 'sawtooth'); noise(t, .05, 3000, 2500, .14, 'highpass'); },
      shrike:   t => { noise(t, .06, 1300, 650, .28); tone(t, .06, 95, 50, .08); },
      hit:      t => noise(t, .03, 2600, 2000, .1, 'highpass'),
      zdie:     t => { tone(t, .16, 650, 140, .09, 'sawtooth'); noise(t, .15, 700, 260, .2); },
      rdie:     t => { noise(t, .35, 600, 110, .38, 'lowpass'); tone(t, .3, 80, 38, .28, 'sine'); },
      boom:     t => { noise(t, .7, 1200, 55, .75, 'lowpass', .7); tone(t, .6, 62, 30, .55, 'sine'); },
      nukeWarn: t => { for (let i = 0; i < 4; i++) { tone(t + i * .5, .14, 880, 860, .09); tone(t + i * .5 + .2, .14, 660, 650, .07); } },
      nukeBoom: t => { noise(t, 2.2, 2200, 38, 1.0, 'lowpass', .6); tone(t, 2.0, 48, 24, .9, 'sine'); noise(t + .05, .5, 4000, 900, .35, 'highpass'); },
      nukeShock: t => { noise(t, 1.0, 3200, 45, .8, 'lowpass', .6); noise(t, .3, 5000, 900, .4, 'highpass'); tone(t, 2.2, 46, 21, .8, 'sine'); tone(t + .02, .8, 90, 35, .35, 'triangle'); },   // the shock front passing the bunker: a crack, then a deep thud
      nukeRumble: t => { for (let i = 0; i < 5; i++) noise(t + i * .75, 1.1, 520 * .8 ** i, 60, .4 * .78 ** i, 'lowpass', .4); tone(t, 4.5, 31, 20, .35, 'sine'); },   // the long rumble after it (a noise voice lasts ~1 s: chained)
      wave:     t => { tone(t, .55, 110, 108, .07, 'sawtooth'); tone(t, .55, 165, 162, .06, 'sawtooth'); tone(t + .3, .5, 220, 218, .05, 'sawtooth'); },
      clear:    t => { [523, 659, 784, 1046].forEach((fq, i) => tone(t + i * .09, .16, fq, fq, .12, 'sine')); },
      bite:     t => { tone(t, .08, 230, 140, .1, 'triangle'); noise(t, .06, 420, 300, .14); },
      stim:     t => { tone(t, .28, 260, 900, .07, 'sawtooth'); noise(t, .22, 1500, 4500, .1, 'highpass'); },   // Stimpack rush
      spit:     t => { noise(t, .13, 700, 2400, .2, 'bandpass', 2.5); tone(t, .07, 320, 150, .05, 'sine'); },   // Roach acid leaves
      acid:     t => { noise(t, .3, 5200, 2400, .15, 'highpass'); noise(t, .1, 650, 260, .12, 'lowpass'); },  // acid sizzles on the hull
      buy:      t => { tone(t, .07, 660, 660, .12, 'sine'); tone(t + .07, .09, 990, 990, .12, 'sine'); },
      deny:     t => tone(t, .14, 190, 150, .09, 'square'),
      crate:    t => tone(t, .16, 440, 880, .12, 'sine'),
      snipe:    t => { tone(t, .25, 1600, 300, .16, 'sine'); noise(t, .08, 3500, 3000, .16, 'highpass'); },
      rocket:   t => { noise(t, .45, 900, 2600, .2, 'bandpass', 1.5); tone(t, .1, 160, 70, .12, 'sine'); },   // Viking missile off the rail
      mblast:   t => { noise(t, .26, 1400, 110, .32, 'lowpass', .8); tone(t, .22, 90, 38, .3, 'sine'); },      // a punisher grenade bursts
      achieve:  t => { [784, 988, 1175, 1568].forEach((fq, i) => tone(t + i * .07, .32 - i * .04, fq, fq, .1, 'sine'));   // an achievement: a rising G major arpeggio
                       tone(t + .21, .5, 3136, 3136, .025, 'triangle'); noise(t + .18, .35, 6000, 9000, .05, 'highpass'); },   // over a soft shimmer
    };
    const MIN_GAP = { hit: .045, bite: .22, spit: .07, acid: .06, marine: .03, marauder: .05, ghost: .05, shrike: .05, zdie: .035, rdie: .06, boom: .07, rocket: .06, mblast: .06,
      nukeShock: .4, nukeRumble: 1 };   // blasts stacked by cheats: one shock, one rumble
    function play(name) {
      if (!ctx || muted || ctx.state !== 'running' || !SOUNDS[name]) return;
      const t = ctx.currentTime, gap = MIN_GAP[name];
      if (gap && t - (last[name] ?? -1) < gap) return;
      last[name] = t;
      SOUNDS[name](t);
    }
    function apply() { if (master) master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.02); }
    function save() { try { localStorage.setItem('dotd_volume', String(volume)); localStorage.setItem('dotd_muted', muted ? '1' : '0'); } catch (e) {} }
    return {
      ensure, play,
      get context() { return ctx; }, get output() { return master; },
      setVolume(v) { volume = Math.max(0, Math.min(1, v)); if (volume > 0) muted = false; apply(); save(); },
      setMuted(m) { muted = !!m; apply(); save(); },
      get muted() { return muted; },
      get volume() { return volume; },
    };
  })();
  // ── Rain ambience ─────────────────────────────────────────────────────────
  // A hiss of band-limited stereo noise (~0.3-4 kHz, each side its own) and the
  // patter of near drops (short ticks panned at random, more of them as it rains
  // harder), as loud as the rain; it eases to a new level over ~0.6 s (desktop
  // RainBed). Through the effects' master gain (volume, mute). loop() feeds it
  // the rain while a game is on (paused too), else 0; a hidden page hears none.
  // Its noise is made by prime() on a click (a game started with the weather
  // on, the weather switched on), not in a frame at the first shower mid-fight.
  const RainBed = (() => {
    let gain = null, ticks = null, lvl = 0, aim = 0, next = 0;
    function build(ctx) {
      const sr = ctx.sampleRate, buf = ctx.createBuffer(2, sr * 2, sr);   // 2 s of noise, looped
      for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4000;
      gain = ctx.createGain(); gain.gain.value = 0;
      src.connect(hp); hp.connect(lp); lp.connect(gain); gain.connect(SFX.output);
      src.start();
      // 12 drop ticks (4 ms decay), each its own loudness and pan; through the same gain (0.28 × the rain)
      ticks = Array.from({ length: 12 }, () => {
        const n = Math.round(sr * .03), b = ctx.createBuffer(2, n, sr), pan = Math.random(), amp = (.3 + .7 * Math.random()) * .12 / .28;
        const L = b.getChannelData(0), R = b.getChannelData(1);
        for (let i = 0; i < n; i++) { const v = amp * (Math.random() * 2 - 1) * Math.exp(-i / (.004 * sr)); L[i] = v * (1 - pan); R[i] = v * pan; }
        return b;
      });
    }
    function set(level, dt) {   // every frame: the rain (0..1)
      const ctx = SFX.context;
      if (!ctx || (!gain && !(level > 0))) return;   // not primed: built at the first rain
      if (!gain) build(ctx);
      const t = ctx.currentTime, target = document.hidden ? 0 : level;
      lvl += (target - lvl) * (1 - Math.exp(-dt / .6));
      if (Math.abs(target - aim) > .004 || (target === 0 && aim !== 0)) { aim = target; gain.gain.setTargetAtTime(.28 * aim, t, .6); }
      if (next < t) next = t;
      if (lvl > .005) while (next < t + .1) {   // ticks at a Poisson rate of 20-180 a second
        const s = ctx.createBufferSource(); s.buffer = ticks[Math.random() * ticks.length | 0];
        s.connect(gain); s.start(next);
        next -= Math.log(1 - Math.random()) / (20 + 160 * lvl);
      }
    }
    document.addEventListener('visibilitychange', () => {   // (no frames while hidden: silence it here)
      if (!document.hidden || !gain) return;
      const t = SFX.context.currentTime;
      gain.gain.cancelScheduledValues(t); gain.gain.setValueAtTime(0, t); aim = lvl = 0;
    });
    function prime() { const ctx = SFX.context; if (ctx && !gain) build(ctx); }
    return { set, prime, get gain() { return gain; } };
  })();
  // ── Music ─────────────────────────────────────────────────────────────────
  // The StarCraft soundtrack (MUSIC in config.js), streamed by an <audio>
  // element: preload 'none', so nothing downloads before a track plays and it
  // never competes with the models. It runs through the effects' master gain
  // (volume, mute); the menu's MUSIC switch turns it off. Browsers allow sound
  // only after the first click or key, so the title music starts then.
  const Music = (() => {
    const el = new Audio();
    el.preload = 'none';
    let src = null, list = [], idx = 0, loop = false, scene = null, on = true;
    try { on = localStorage.getItem('dotd_music') !== '0'; } catch (e) {}
    const url = name => AUDIO_DIR + name + '.aac';
    function start() {
      if (!on || !list.length || !SFX.context || document.hidden) return;
      if (!src) {                                    // once: element → music gain → master
        src = SFX.context.createMediaElementSource(el);
        const g = SFX.context.createGain(); g.gain.value = MUSIC.level;
        src.connect(g); g.connect(SFX.output);
      }
      el.play().catch(() => {});
    }
    el.addEventListener('ended', () => {
      if (idx + 1 < list.length) idx++; else if (loop) idx = 0; else { list = []; return; }
      el.src = url(list[idx]); start();
    });
    // scene: 'title' | 'battle' | 'victory' | 'defeat' — a scene already playing keeps going
    function play(name) {
      if (scene === name && list.length) { start(); return; }
      scene = name; list = MUSIC[name] || []; idx = 0; loop = name === 'title' || name === 'battle';
      el.loop = loop && list.length === 1;
      el.pause();
      if (list.length) { el.src = url(list[0]); start(); }
    }
    function setOn(v) {
      on = !!v;
      try { localStorage.setItem('dotd_music', on ? '1' : '0'); } catch (e) {}
      if (on) start(); else el.pause();
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden) el.pause(); else start(); });
    return { play, start, setOn, get on() { return on; }, get scene() { return scene; }, get track() { return list[idx] || null; },
             get playing() { return !el.paused; }, get element() { return el; } };
  })();
  // first click or key anywhere: unlock Web Audio and start whatever music is due
  const _unlockAudio = () => { SFX.ensure(); Music.start(); };
  addEventListener('pointerdown', _unlockAudio, { once: true });
  addEventListener('keydown', _unlockAudio, { once: true });

  let minerals=150, gas=50;
  let ammo=CFG.base_ammo, maxAmmo=CFG.base_ammo;
  let bunkerHp=750, maxHp=750;
  let dmgLvl=0, armorLvl=0, hpLvl=0, ammoLvl=0;
  let bunkerModelRoot = null;
  let bunkerGroup = null;   // scene group holding the bunker (procedural, then the loaded model)
  let airCD=0, nukeCD=0;
  let floatTexts = []; // {x,y,z,txt,life,maxLife,color[,lift (px over x,y,z), on (its enemy), row (its place in that enemy's queue: hitText)]}
  let dmgNumbersOn = true;   // hits and MISSes over the Zerg: Menu → Settings (stored)
  try { dmgNumbersOn = localStorage.getItem('dotd_dmg_numbers') !== '0'; } catch (e) {}
  // ── Bunker roster state ────────────────────────────────────────────────────
  // roster: array of unit type strings filling 6 slots
  // Marine=1slot, Marauder=2slots, Ghost=2slots
  // SC2 unit attributes — drive damage bonuses against enemy flags
  // Zergling: Light, Biological
  // Roach:    Armored, Biological
  // Hydralisk (future): Light, Biological
  const UNIT_DEF = {
    marine:   { slots:1, cost:[50,0],   dmgMult:1.0, bulletColor:0xffee44, bulletSpeed:0.65,
                // No damage bonus — balanced unit, flat damage to all
                bonusVs:[], bonusMult:1.0,
                label:'M',  name:'MARINE',   cls:'m',
                attrs:['light','biological'] },
    marauder: { slots:2, cost:[150,25], dmgMult:1.2, bulletColor:0xff8800, bulletSpeed:0.5,
                // +100% vs Armored (Roach), normal vs Light
                bonusVs:['armored'], bonusMult:2.0,
                label:'Ma', name:'MARAUDER', cls:'ma',
                attrs:['armored','biological','mechanical'] },
    ghost:    { slots:2, cost:[200,50], dmgMult:1.4, bulletColor:0xcc44ff, bulletSpeed:0.75,
                // +150% vs Light (Zergling, Hydralisk), normal vs Armored
                bonusVs:['light'], bonusMult:2.5,
                label:'Gh', name:'GHOST',    cls:'gh',
                attrs:['light','biological','psionic'] },
  };
  // Sensor Tower blip range per level (world units from the bunker centre); the night's lit edge is 9
  const SENSOR_RANGE = [0, 10.75, 12.5, 16];
  // Within its range a Zerg is its blip only (not which kind) until the night leaves it this dark
  // (_nightDark); the blip fades out over the last stretch before, so the two never overlap
  const SENSOR_SHOW_DARK = 0.6, SENSOR_BLIP_FADE = 0.15;
  const UPGRADE_DEF = {
    superstim:  { cost:[250,150], unit:'marine',   name:'Super Stimpack', icon:UI_ICONS.superstim,
                  desc:'Stimpack costs no HP and repairs the bunker while it lasts. Its tiers cut the Marines it needs: 6 → 4 → 2 → 1 (or a Marauder)',
                  tiers:[
                    { cost:[200, 80],  desc:'Stimpack Lv.1 — needs 4 Marines' },
                    { cost:[320,130],  desc:'Stimpack Lv.2 — needs 2 Marines' },
                    { cost:[500,200],  desc:'Stimpack Lv.3 — needs 1 Marine or Marauder (MAX)' },
                  ]},
    concussive: { cost:[300,75],  unit:'marauder', name:'Concussive Shell', icon:UI_ICONS.concussive,
                  desc:'Marauder blasts slow harder: to 40% speed (from 70%) for 2.5s (from 1.5s)',
                  tiers:[
                    { cost:[250, 80],  desc:'AOE Lv.1 — blast radius 1.5 → 2.0' },
                    { cost:[400,130],  desc:'AOE Lv.2 — radius 2.6' },
                    { cost:[600,200],  desc:'AOE Lv.3 — radius 3.2 (MAX)' },
                  ]},
    snipe:      { cost:[250,100], unit:'ghost',    name:'Snipe', icon:UI_ICONS.snipe,
                  desc:'Ghost auto-snipes highest-threat enemy (8s CD)',
                  tiers:[
                    { cost:[200, 80],  desc:'Snipe Lv.1 — CD 8s → 6s' },
                    { cost:[320,130],  desc:'Snipe Lv.2 — CD 6s → 4s' },
                    { cost:[500,200],  desc:'Snipe Lv.3 — CD 4s → 2.5s (MAX)' },
                  ]},
    // SC2's Sensor Tower: Zerg in the dark show as red "!" blips (sensorLvl 0-3). Needs no
    // unit. The research buys Lv.1, so tiers[n] is Lv.n+1 (tiers[0] repeats the research)
    sensor:     { cost:[100,25],  unit:null,       name:'Sensor Tower', icon:UI_ICONS.sensor,   // null: #i-sensor glyph
                  desc:'At night, Zerg in the dark within range show as red ! blips (not which kind). Range 10.75 / 12.5 / 16; the lit area reaches about 9.',
                  tiers:[[100,25],[175,50],[275,100]].map((cost, i) => ({ cost, desc:`Sensor Tower lv.${i+1} — blips out to ${SENSOR_RANGE[i+1]}` })) },
  };
  // Snipe CD per level (ms): base + 3 tiers
  const SNIPE_CD   = [8000, 6000, 4000, 2500];
  // Marauder punisher grenades: the blast radius (base, then per Concussive Shell AOE tier); the rest of
  // the blast takes MG_SPLASH of the round's damage; everyone in it slows to MG_SLOW of their speed for
  // MG_SLOW_DUR s ([1]: Concussive Shells)
  const MG_RADIUS = [1.5, 2.0, 2.6, 3.2], MG_SPLASH = 0.5, MG_SLOW = [0.7, 0.4], MG_SLOW_DUR = [1.5, 2.5];

  let roster = ['marine','marine'];   // start with 2 marines (2 slots used)
  let snipeReady = [];                // per ghost, in roster order: _gameT when it may snipe again
  let runnerIdx = -1;                 // roster index of the elected crate runner (-1: a Marine, else any free unit)
  let marauderReady = [], _marauderShots = 0;   // per Marauder (roster order): _gameT it may fire again · grenades fired (every third costs a round)
  let concussiveUnlocked = false;
  let superStimUnlocked = false;   // Super Stimpack research (Marines)
  let superStimLvl = 0;            // its tiers: each lowers the Marines Stimpack needs (CFG.stim_marines)
  // Endless armory: purchases of each kind (see CFG.armory_*)
  let armory = { hp: 0, dmg: 0, ammo: 0, cd: 0 };
  const ARMORY_DEF = {
    hp:   { name: 'Hull plating',   cost: [300, 75],  icon: UI_DIR + 'btn-upgrade-terran-neosteelframe.png',
            fx: () => `+${CFG.armory_hp} max HP`, total: n => `+${n * CFG.armory_hp} HP` },
    dmg:  { name: 'Weapon tuning',  cost: [400, 100], icon: UI_DIR + 'btn-upgrade-terran-infantryweaponslevel3.png',
            fx: () => `+${Math.round(CFG.armory_dmg * 100)}% damage`, total: n => `+${Math.round(n * CFG.armory_dmg * 100)}% damage` },
    ammo: { name: 'Magazine',       cost: [250, 60],  icon: UI_DIR + 'btn-upgrade-terran-enhancedmunitions.png',
            fx: () => `+${CFG.armory_ammo} rounds`, total: n => `+${n * CFG.armory_ammo} rounds` },
    cd:   { name: 'Fleet logistics', cost: [350, 120], icon: UI_DIR + 'btn-progression-hornerhan-5-fleetcalldown.png',
            fx: () => `strike & nuke cooldowns −${Math.round((1 - CFG.armory_cd) * 100)}%`, total: n => `cooldowns ×${armoryCdMult(n).toFixed(2)}`,
            maxed: () => armoryCdMult() <= CFG.armory_cd_min },
  };
  let snipeUnlocked = false;
  let snipeLvl = 0;       // 0-3 tier within snipe upgrade
  let concussiveLvl = 0;  // 0-3 tier within concussive upgrade
  let sensorLvl = 0;      // 0 = not researched, 1-3 = Sensor Tower level (SENSOR_RANGE)
  let slowedEnemies = new Map();      // enemy mesh uuid → {until (_gameT), factor}
  let rosterHover = false;
  let bunkerHoverTimer = 0;
  let rosterPaused = false;  // game pauses while roster is open
  let _menuOpen = false;     // game pauses while menu is open
  let _cheatOpen = false;    // game pauses while cheat console is open
  let _tutStep = null;       // game pauses while a tutorial hint is open (the step shown)
  function isPaused(){ return rosterPaused||_menuOpen||_cheatOpen||!!_tutStep; }
  let _hudTick = 0;         // throttle for HUD DOM refresh
  let _dmgFlashCD = 0;       // throttle for damage vignette flash
  let zerglings=[], roaches=[], bullets=[], crates=[], beams=[], marines=[];
  let spawnQueue=[], spawnTimer=0, spawnInterval=1.2, wavePhase='idle', shootCD=0;
  let waveKills=0, waveNukes=0, waveAirs=0;
  let mx=0.5, my=0.5;

  // ── Ground ─────────────────────────────────────────────────────────────
  // The field is drawn procedurally (the desktop's TERRAIN shader, render.cpp) from three tiling 512² maps: the
  // noise (R, G two unrelated fields; BA the slope of a fine pebbly height), the grass (thousands of short blades)
  // and the soil (pebbles on crumbly earth), these two R height, G tone, BA slope. assets/textures holds the desktop
  // game's own maps (dotd --dump-ground), the same texels, so both editions draw the same field. Flat until loaded.
  const _flatTex = new THREE.DataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1, THREE.RGBAFormat);
  _flatTex.needsUpdate = true;
  const _groundU = { terrainTex: { value: _flatTex }, grassTex: { value: _flatTex }, soilTex: { value: _flatTex },
    groundHD: { value: 1 },                   // 1 HD, 0 SD (applyGfx: a uniform, no recompile)
    uTime: { value: 0 }, uRain: { value: 0 }, uWet: { value: 0 }, uPuddle: { value: 0 },   // the weather (syncGround)
    uNight: { value: 0 }, uNightDesat: { value: 0 }, uMoonTint: { value: new THREE.Color(.20, .27, .42) }, uMoonDir: { value: new THREE.Vector3(0, 1, 0) },   // the night (_applyDNLights)
    uGrassClear: { value: [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, -1)] } };   // where the grass is gone: x, z, radius
  for (const [u, file] of [['terrainTex', 'ground_noise'], ['grassTex', 'ground_grass'], ['soilTex', 'ground_soil']])
    new THREE.TextureLoader().load(`assets/textures/${file}.png?v=1`, t => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.flipY = false;                        // (the rows as the desktop uploaded them)
      t.anisotropy = Math.min(2, renderer.capabilities.getMaxAnisotropy());   // (the camera is never low: 8 looks the same and costs a close-up 3 ms)
      t.needsUpdate = true;
      _groundU[u].value = t;
      if (u === 'terrainTex') GLOW_LIGHTS.cloudTex.value = t;
    }, undefined, () => console.warn(`Ground map ${file}.png did not load: the field stays plain`));
  // ground(): the field at xz, from the noise at rotated scales: tiles of 150 and 36 units for the broad layers (the
  // field is 120 across: the first never repeats, the second has too many cells to band), 6 for the fine one and 1.3
  // for a speckle, and the detail maps: single blades and pebbles close up, the blades read larger as clumps from
  // afar. Two grass tones in soft patches, lighter and darker swathes, soft dirt patches frayed by the blades with a
  // darker seam, a worn ring round the bunker, a fine slope for the light, shade at the bunker's foot. Every fine term
  // is zero-mean, so a softer read keeps the tone:
  //  - HD (GFX HIGH): all layers; detail (0..1, from the pixel's footprint) raises the fine ones close up;
  //  - SD (GFX LOW): the broad layers a mip softer and no fine ones (two fetches, a flat light);
  //  - lod >= 0: blurred mips (the grass, coloured from the ground at its root).
  // The weather: water stands where the ground is low, in the dirt and the worn ring, rising with the rain that has
  // fallen; the whole field darkens as it wets. The tones are the desktop's: its lights are these, so they carry over.
  const _GROUND_FS = `uniform sampler2D terrainTex, grassTex, soilTex;
uniform float groundHD, uTime, uRain, uWet, uPuddle, uNight, uNightDesat; uniform vec3 uMoonTint, uMoonDir;
const mat2 ROT1 = mat2( 0.825, 0.565, -0.565, 0.825 ), ROT2 = mat2( -0.320, 0.947, -0.947, -0.320 ), ROT3 = mat2( 0.199, -0.980, 0.980, 0.199 ), ROT4 = mat2( 0.545, 0.839, -0.839, 0.545 );
const mat2 ROT5 = mat2( 0.454, 0.891, -0.891, 0.454 ), ROT6 = mat2( 0.921, 0.389, -0.389, 0.921 ), ROT7 = mat2( -0.600, 0.800, -0.800, -0.600 ), ROT8 = mat2( 0.309, 0.951, -0.951, 0.309 );
const mat2 ROT3T = mat2( 0.199, 0.980, -0.980, 0.199 ), ROT6T = mat2( 0.921, -0.389, 0.389, 0.921 ), ROT7T = mat2( -0.600, -0.800, 0.800, -0.600 ), ROT8T = mat2( 0.309, -0.951, 0.951, 0.309 );   // their transposes (none in GLSL ES 1)
const vec3 GRASS_LUSH = vec3( .184, .290, .102 ), GRASS_DRY = vec3( .290, .310, .133 ), DIRT_DARK = vec3( .290, .224, .141 ), DIRT_LIGHT = vec3( .431, .353, .227 );
const vec3 LUMA_G = vec3( 0.299, 0.587, 0.114 );
struct Ground { vec3 alb, dry; vec3 N; float ao, wet, water, dirt; };
Ground ground( vec2 xz, float lod, float wpp ) {
  float detail = 1.0 - smoothstep( 0.011, 0.020, wpp ), soft = 0.5 * ( 1.0 - smoothstep( 0.02, 0.03, wpp ) );
  vec2 u1 = ROT1 * xz / 150.0 + vec2( 0.89, 0.85 ), u2 = ROT2 * xz / 36.0, u3 = ROT3 * xz / 6.0;
  vec4 a, b, c = vec4( 0.5 ), gf = vec4( 0.5 ), gc = vec4( 0.5 ), sf = vec4( 0.5 );
  float s = 0.5;
  bool hd = lod < 0.0 && groundHD > 0.5;
  if ( lod >= 0.0 ) { a = NOISE_LOD( terrainTex, u1, lod ); b = NOISE_LOD( terrainTex, u2, lod ); }
  else if ( hd ) {
    a = texture2D( terrainTex, u1 ); b = texture2D( terrainTex, u2 ); c = texture2D( terrainTex, u3, soft );   // (c, gc: half a mip softer in a large window's overview: their top mips are the dearest reads)
    s = texture2D( terrainTex, ROT4 * xz / 1.3 ).r;
    gf = texture2D( grassTex, ROT6 * xz / 2.7 ); gc = texture2D( grassTex, ROT7 * xz / 7.3, soft ); sf = texture2D( soilTex, ROT8 * xz / 3.1 );
  } else { a = texture2D( terrainTex, u1, 1.0 ); b = texture2D( terrainTex, u2, 1.0 ); }
  float blade = ( gf.r - 0.5 ) * mix( 0.3, 1.0, detail ) + ( gc.r - 0.5 ) * mix( 1.0, 0.5, detail );
  float tone = ( gf.g - 0.5 ) * mix( 0.3, 1.0, detail ) + ( gc.g - 0.5 ) * mix( 0.9, 0.3, detail );
  float r = length( xz );
  vec3 grass = mix( GRASS_LUSH, GRASS_DRY, smoothstep( 0.36, 0.70, 0.6 * b.g + 0.4 * a.g + ( c.g - 0.5 ) * 0.12 + tone * 0.28 ) )
             * ( 0.8 + 0.4 * a.r ) * ( 1.0 + 0.16 * ( c.r - 0.5 ) ) * ( 1.0 + mix( 0.06, 0.24, detail ) * ( s - 0.5 ) ) * ( 1.0 + 0.55 * blade );
  float dn = a.g * 0.65 + b.r * 0.35, ring = 0.85 * ( 1.0 - smoothstep( 2.0, 4.6, r + ( b.r - 0.5 ) * 1.6 + blade * 1.1 ) );
  float dirt = max( smoothstep( 0.632, 0.732, dn + ( c.r - 0.5 ) * 0.05 - blade * 0.09 ), ring );
  // the seam only round dirt the broad layers make (no dark specks where the fine term alone tips over)
  float seam = 0.64 * dirt * ( 1.0 - dirt ) * smoothstep( 0.15, 0.5, max( smoothstep( 0.632, 0.732, dn ), ring ) );
  vec3 soil = mix( DIRT_DARK, DIRT_LIGHT, clamp( 0.5 + ( b.g - 0.5 ) * 1.2 + ( c.r - 0.5 ) * 1.0 + ( sf.g - 0.5 ) * 0.55, 0.0, 1.0 ) ) * ( 0.9 + 0.2 * a.r ) * ( 1.0 + 0.4 * ( sf.r - 0.5 ) );
  Ground G;
  G.alb = mix( grass, soil, dirt ) * ( 1.0 - seam );
  vec2 g = ROT3T * ( c.ba * 2.0 - 1.0 ) * mix( mix( 0.3, 0.45, detail ), 0.75, dirt );
  if ( hd ) {
    vec2 gg = ROT6T * ( gf.ba * 2.0 - 1.0 ) * mix( 0.15, 0.7, detail ) + ROT7T * ( gc.ba * 2.0 - 1.0 ) * mix( 0.4, 0.25, detail );
    g += mix( gg, ROT8T * ( sf.ba * 2.0 - 1.0 ) * mix( 0.35, 0.9, detail ), dirt );
  }
  G.N = normalize( vec3( -g.x, 1.0, -g.y ) );
  G.ao = mix( 0.55, 1.0, smoothstep( 1.4, 2.8, r ) );
  G.dry = G.alb;
  G.wet = uWet;
  G.water = 0.0;
  G.dirt = dirt;
  if ( uWet > 0.0 || uPuddle > 0.0 ) {
    float p = lod < 0.0 ? texture2D( terrainTex, ROT5 * xz / 21.9 ).r : NOISE_LOD( terrainTex, ROT5 * xz / 21.9, lod ).r;
    float low = p * ( 0.55 + 0.45 * dirt ), T = 1.0 - 0.36 * uPuddle;
    G.water = smoothstep( T, T + max( 0.015, lod < 0.0 ? 1.5 * fwidth( low ) : 0.05 ), low );   // a crisp shore, never a jagged one
    G.wet = max( uWet, smoothstep( T - 0.1, T, low ) * min( 1.0, 4.0 * uPuddle ) );
    G.alb *= 1.0 - G.wet * mix( 0.3, 0.45, dirt ) - 0.2 * G.water;
  }
  return G;
}
// What the water mirrors: the sky, brighter toward the horizon, under a cloud deck 40 up drifting with the wind
vec3 skyMirror( vec3 P, vec3 R ) {
  float up = max( R.y, 0.0 );
  vec2 c = ( P.xz + R.xz * ( 40.0 / max( up, 0.2 ) ) + cloudDrift ) / 480.0;
  float cl = texture2D( terrainTex, c, 1.0 ).r;
  return mix( skyHor, skyZen, sqrt( up ) ) * ( 1.0 + cloudAmt * ( cl - 0.5 ) );
}
// The rain's rings on standing water (the slope of the surface): in each 0.45 cell a drop may land every ~0.6 s
vec2 h22( vec2 p ) { vec3 q = fract( vec3( p.xyx ) * vec3( .1031, .1030, .0973 ) ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.xx + q.yz ) * q.zy ); }
vec2 ripples( vec2 p ) {
  const float CELL = 0.45, K = 78.0, S2 = 0.0025;
  vec2 c0 = floor( p / CELL ), g = vec2( 0.0 );
  for ( int j = -1; j <= 1; j++ )
    for ( int i = -1; i <= 1; i++ ) {
      vec2 c = c0 + vec2( float( i ), float( j ) ), h = h22( c );
      float cyc = uTime * ( 1.3 + 0.7 * h.y ) + 7.3 * h.x, life = fract( cyc );
      vec2 q = h22( c + 1.618 * floor( cyc ) );
      if ( fract( q.x * 13.7 + q.y * 7.1 ) > 0.1 + 0.9 * uRain ) continue;
      vec2 d = p - ( c + 0.25 + 0.5 * q ) * CELL;
      float r = length( d ), u = r - 0.3 * life, e = ( 1.0 - life ) * ( 1.0 - life ) * exp( -u * u / S2 );
      g += d / max( r, 1e-4 ) * ( 0.003 * e * ( K * cos( K * u ) - 2.0 * u / S2 * sin( K * u ) ) );
    }
  return g;
}
// a surface's moonlit value at night: its brightness, moon-blue, lit by the moon
vec3 nightOf( vec3 alb, vec3 N ) { return dot( alb, LUMA_G ) * uMoonTint * ( 0.45 + 0.55 * max( dot( N, uMoonDir ), 0.0 ) ); }
vec3 sceneFogT;   // what the night's fog fades this surface to (FOG_TARGET)
`;
  // The shared hooks of the ground and the grass: colour, normal, light and fog from ground()
  const _groundHooks = (fs, colour) => fs
    .replace('#include <fog_pars_fragment>', `#include <fog_pars_fragment>\n${_GROUND_FS}`)
    .replace('#include <color_fragment>', `#include <color_fragment>\n${colour}
  diffuseColor.rgb = mix( G.alb, vec3( dot( G.alb, LUMA_G ) ), uNightDesat );
  sceneFogT = mix( fogColor, nightOf( G.dry, G.N ) * G.ao, uNight );`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  vec3 Nw = G.N;
  if ( G.water > 0.0 ) {   // standing water lies flat, but for the rain's rings on it
    vec3 Nf = vec3( 0.0, 1.0, 0.0 );
    if ( uRain > 0.0 ) { vec2 rg = ripples( vGroundW.xz ) * min( 1.0, 0.4 + uRain ); Nf = normalize( vec3( -rg.x, 1.0, -rg.y ) ); }
    Nw = normalize( mix( Nw, Nf, G.water ) );
  }
  normal = normalize( ( viewMatrix * vec4( Nw, 0.0 ) ).xyz );`)
    // wet ground takes a dull sheen, the water sharp glints of every light
    .replace('#include <lights_phong_fragment>', `#include <lights_phong_fragment>
  float wetSpec = G.wet * mix( 0.3, 1.0, G.water );
  if ( wetSpec > 0.0 ) { material.specularColor = mix( material.specularColor, vec3( 0.25 ), wetSpec ); material.specularShininess = mix( 30.0, 400.0, G.water ); }`)
    // the shade at the bunker's foot dims the ambient light, and a little of the direct (the field faces up: it takes the plain ambient)
    .replace('#include <aomap_fragment>', `#include <aomap_fragment>
  reflectedLight.indirectDiffuse *= G.ao / vec3( 1.05, 1.05, 1.1 ); reflectedLight.directDiffuse *= mix( 1.0, G.ao, 0.35 );`)
    // the water mirrors the sky: by day far brighter than the lit ground, so even from overhead it shows
    .replace('gl_FragColor = vec4( outgoingLight, diffuseColor.a );', `if ( G.water > 0.0 ) {
    vec3 Vw = normalize( cameraPosition - vGroundW );
    float F = 0.02 + 0.98 * pow( 1.0 - clamp( dot( Nw, Vw ), 0.0, 1.0 ), 5.0 );
    outgoingLight = mix( outgoingLight, skyMirror( vGroundW, reflect( -Vw, Nw ) ), G.water * min( 1.0, mix( 0.55, 0.25, uNight ) + F ) );
  }
  gl_FragColor = vec4( outgoingLight, diffuseColor.a );`);
  function groundMaterial() {
    const m = new THREE.MeshPhongMaterial({ color: 0x2d4a18, specular: 0x080808, shininess: 4 });   // (the colour: unused)
    m.extensions = { derivatives: true };   // (WebGL 1: dFdx)
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, _groundU);
      sh.vertexShader = 'varying vec3 vGroundW;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
  vGroundW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`);
      // the close-up detail by the pixel's footprint: crisp grass close up, calm where a pixel spans more of the fine
      // layer (no hatching); the footprint along the screen's axes, the same at any yaw
      sh.fragmentShader = '#define FOG_TARGET sceneFogT\nvarying vec3 vGroundW;\n' + _groundHooks(sh.fragmentShader, `
  float wpp = max( length( dFdx( vGroundW.xz ) ), length( dFdy( vGroundW.xz ) ) );
  Ground G = ground( vGroundW.xz, -1.0, wpp );`);
    };
    m.customProgramCacheKey = () => 'ground';   // (every hook reads the same through radial-fog.js's wrapper)
    return m;
  }

  // ── Grass ──────────────────────────────────────────────────────────────
  // Thousands of little tufts of blades over the field (none under the bunker), one static mesh, drawn on HIGH: the
  // desktop's (Game::buildGrass, the same seed). Each vertex carries its tuft's root and sway in its normal, its tint
  // and how far up the blade it is in its uv. The wind runs through in slow gusts, stronger in the rain. A blade takes
  // the colour of the ground at its tuft's root, dark at the root, pale at the tip; none on bare earth, in water, or
  // where a nuke has scorched the field
  function _grassMesh() {
    let st = 0x2545f491;
    const rn = () => { st ^= st << 13; st ^= st >>> 17; st ^= st << 5; return (st & 0xffffff) / 16777216; };
    const TUFTS = 7500, BLADES = 4, nv = TUFTS * BLADES * 5;
    const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), UV = new Float32Array(nv * 2), I = new Uint32Array(TUFTS * BLADES * 9);
    let v = 0, ii = 0;
    for (let t = 0; t < TUFTS; t++) {
      const a0 = rn() * 2 * Math.PI, r0 = 3.6 + (30 - 3.6) * Math.sqrt(rn()), rx = Math.cos(a0) * r0, rz = Math.sin(a0) * r0;
      const h0 = .14 + .16 * rn(), tint = .84 + .32 * rn();
      for (let b = 0; b < BLADES; b++) {
        const a = rn() * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a), h = h0 * (.7 + .3 * rn()), lean = (.25 + .5 * rn()) * h, w = .016 + .012 * rn();
        const oa = rn() * 2 * Math.PI, od = .08 * rn(), bx = rx + Math.cos(oa) * od, bz = rz + Math.sin(oa) * od, i = v;
        const put = (x, y, z, f) => {
          P.set([x, y, z], v * 3); N.set([rx, .45 * h * f * f, rz], v * 3); UV.set([tint, f], v * 2); v++;
        };
        const ml = lean * .35, mw = w * .65;
        put(bx + s * w, 0, bz - c * w, 0);
        put(bx - s * w, 0, bz + c * w, 0);
        put(bx + c * ml + s * mw, .55 * h, bz + s * ml - c * mw, .55);
        put(bx + c * ml - s * mw, .55 * h, bz + s * ml + c * mw, .55);
        put(bx + c * lean, h, bz + s * lean, 1);
        for (const q of [0, 1, 3, 0, 3, 2, 2, 3, 4]) I[ii++] = i + q;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
    g.setIndex(new THREE.BufferAttribute(I, 1));
    const m = new THREE.MeshPhongMaterial({ color: 0x2d4a18, specular: 0x080808, shininess: 4, side: THREE.DoubleSide });
    m.extensions = { derivatives: true };
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, _groundU);
      sh.vertexShader = `uniform float uTime, uRain;\nvarying vec3 vGroundW; varying vec2 vRoot; varying vec2 vTuft;\n` + sh.vertexShader
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3( 0.0, 1.0, 0.0 );')
        .replace('#include <begin_vertex>', `vec2 root = normal.xz;
  float gust = 0.65 + 0.35 * sin( dot( root, vec2( 0.21, 0.13 ) ) + uTime * 1.3 ) + 0.2 * sin( dot( root, vec2( -0.43, 0.57 ) ) + uTime * 2.9 );
  vec3 transformed = position;
  transformed.xz += vec2( 0.8, 0.6 ) * ( gust * normal.y * ( 1.0 + 1.2 * uRain ) );
  vRoot = root; vTuft = uv; vGroundW = transformed;`);
      sh.fragmentShader = '#define FOG_TARGET sceneFogT\nvarying vec3 vGroundW; varying vec2 vRoot; varying vec2 vTuft;\nuniform vec3 uGrassClear[ 3 ];\n' + _groundHooks(sh.fragmentShader, `
  Ground G = ground( vRoot, 1.5, 1.0 );
  if ( G.dirt > 0.3 || G.water > 0.05 ) discard;
  for ( int i = 0; i < 3; i++ ) if ( distance( vRoot, uGrassClear[ i ].xy ) < uGrassClear[ i ].z ) discard;
  G.alb *= mix( 0.62, 1.32, vTuft.y ) * vTuft.x;`);
    };
    m.customProgramCacheKey = () => 'tuft';
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false; mesh.receiveShadow = true;
    return mesh;
  }
  let _grass = null;
  // A frame's values for the ground and the sky over it
  function syncGround() {
    const U = _groundU, G = GLOW_LIGHTS;
    U.uTime.value = wx.t % 2048; U.uRain.value = wx.rain; U.uWet.value = wx.wet; U.uPuddle.value = wx.puddle;
    G.cloudAmt.value = wx.cloud;
    G.cloudDrift.value.set(wx.driftX % 480, wx.driftZ % 480);
    const dx = wx.driftX + 1.1 * _gameT, dz = wx.driftZ + .45 * _gameT;
    G.shadeDrift.value.set(((dx % 480) + 480) % 480, ((dz % 480) + 480) % 480);   // (it wraps at a whole number of the tiles it reads)
    for (let i = 0; i < 3; i++) {             // the grass is gone where a nuke's front has passed, and grows back as its scar fades
      const s = nukeScars[nukeScars.length - 1 - i], v = U.uGrassClear.value[i];
      if (s) v.set(s.mesh.position.x, s.mesh.position.z, nk.frontR(s.age) * (1 - _sstep(nk.SCAR_END - 5, nk.SCAR_END, s.age)));
      else v.z = -1;
    }
  }

  // ── Contact shadows ─────────────────────────────────────────────────────
  // A soft dark blob under every Zerg, corpse and unit out of the bunker: what the shadow map misses (the
  // ground right under a body; by night and on LOW, with no sun shadow at all). None under a Zerg the night
  // hides (it is not drawn), fainter as the dark takes it, gone as a body rises. One instanced draw that
  // darkens what is under it (dst × (1 − k·blob): a black blob at alpha k), sized per kind.
  const _blobTex = (() => {   // dark in the middle, gone well before the edge
    const N = 32, d = new Uint8Array(N * N * 4);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = (i + .5) / N * 2 - 1, y = (j + .5) / N * 2 - 1, r = Math.hypot(x, y), e = Math.min(1, Math.max(0, (r - .7) / .3));
      d.fill(Math.round(255 * Math.exp(-3.5 * r * r) * (1 - e * e * (3 - 2 * e))), (j * N + i) * 4, (j * N + i) * 4 + 4);
    }
    const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat);
    t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
    return t;
  })();
  const _blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const _blobMat = new THREE.MeshBasicMaterial({ map: _blobTex, transparent: true, depthWrite: false, fog: false,
    blending: THREE.CustomBlending, blendSrc: THREE.ZeroFactor, blendDst: THREE.OneMinusSrcColorFactor });
  let _blobIM = null;
  const _rockBlobs = [];   // the boulders' (buildScene)
  function _growBlobs(cap) {
    if (_blobIM) { scene.remove(_blobIM); _blobIM.dispose?.(); }
    _blobIM = new THREE.InstancedMesh(_blobGeo, _blobMat, cap);
    _blobIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    _blobIM.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);   // its darkness
    _blobIM.frustumCulled = false; _blobIM.count = 0; _blobIM.visible = false;
    _blobIM.renderOrder = -1;   // on the ground before the glows and pools over it
    scene.add(_blobIM);
  }
  _growBlobs(128);
  function syncBlobs() {
    const need = zerglings.length + roaches.length + corpses.length + marines.length + _rockBlobs.length;
    if (need > _blobIM.instanceMatrix.count) _growBlobs(1 << Math.ceil(Math.log2(need)));
    const M = _blobIM.instanceMatrix.array, C = _blobIM.instanceColor.array, f = _dnLitF;
    let n = 0;
    const blob = (p, rotY, w, l, k) => {   // a w x l blob (l along the body) turned by rotY
      const nd = _nightDark(p.x, p.z);
      k *= (1 - _sstep(.1, 1.6, p.y)) * (1 - f * nd) * (1 - nd) * (1 - .25 * f);   // (the last (1 − nd): the desktop's fog on it)
      if (k <= .02) return;
      const c = Math.cos(rotY), s = Math.sin(rotY), o = n * 16;
      M[o] = c * w; M[o + 1] = 0; M[o + 2] = -s * w; M[o + 3] = 0;
      M[o + 4] = 0; M[o + 5] = 1; M[o + 6] = 0; M[o + 7] = 0;
      M[o + 8] = s * l; M[o + 9] = 0; M[o + 10] = c * l; M[o + 11] = 0;
      M[o + 12] = p.x; M[o + 13] = .02; M[o + 14] = p.z; M[o + 15] = 1;
      C[n * 3] = C[n * 3 + 1] = C[n * 3 + 2] = k;
      n++;
    };
    for (const e of zerglings) if (!e.dead && e.pool && e.mesh.visible) blob(e.mesh.position, e.mesh.rotation.y, 1, 1.3, .55);
    for (const e of roaches) if (!e.dead && e.pool && e.mesh.visible) blob(e.mesh.position, e.mesh.rotation.y, 1.5, 1.9, .6);
    for (const c of corpses) if (c.pool && c.mesh.visible) blob(c.mesh.position, c.mesh.rotation.y, 1.1, 1.4, .45 * Math.max(0, 1 - c.t * 1.4));
    for (const m of marines) if (m.mesh.visible) blob(m.mesh.position, m.mesh.rotation.y, .8, .8, .5);
    for (const r of _rockBlobs) blob(r, 0, r.s, r.s, .6);   // the boulders settle into the ground
    _blobIM.count = n; _blobIM.visible = n > 0;
    _blobIM.instanceMatrix.needsUpdate = true; _blobIM.instanceColor.needsUpdate = true;
  }

  // ── Build scene ─────────────────────────────────────────────────────────
  function buildScene() {
    // Ambient — neutral warm-cool so textures read accurately
    _ambientLight = new THREE.AmbientLight(0x99aabb, 0.7);
    scene.add(_ambientLight);

    // Sun — primary directional light with shadow
    _sunLight = new THREE.DirectionalLight(0xfff4cc, 1.8);
    _sunLight.position.set(14, 24, 9);   // (65° before: lower, longer shadows, the shapes stand out)
    _sunLight.castShadow = true;
    _sunLight.shadow.mapSize.set(2048, 2048);
    _sunLight.shadow.camera.near = 1;
    _sunLight.shadow.camera.far  = 70;
    _sunLight.shadow.camera.left = _sunLight.shadow.camera.bottom = -26;
    _sunLight.shadow.camera.right = _sunLight.shadow.camera.top  =  26;
    _sunLight.shadow.bias = -0.0005;
    _sunLight.shadow.normalBias = 0.02;
    scene.add(_sunLight);

    // Fill — cool blue from opposite side, no shadow
    _fillLight = new THREE.DirectionalLight(0x4488cc, 0.5);
    _fillLight.position.set(-8, 10, -6);
    scene.add(_fillLight);

    // Bunker point light — used at night to illuminate the bunker area
    _bunkerLight = new THREE.PointLight(0xffd2a0, 0, 15, 2);   // warm white (on the greyed grass: khaki, not lime)
    _bunkerLight.position.set(0, 2.6, 0);
    scene.add(_bunkerLight);

    // Muzzle light — a brief orange flash on the hull at the firing slit / barrel
    _muzzleLight = new THREE.PointLight(0xffb060, 0, 4.5, 2);
    scene.add(_muzzleLight);
    // Gunfire on the ground: a warm pool of light in front of the port (lime on the grass if yellower)
    _gunLight = new THREE.PointLight(0xffa055, 0, 7, 1.5);
    scene.add(_gunLight);

    // Fire light — flickers on the hull while the bunker burns (HP < 50%)
    _fireLight = new THREE.PointLight(0xff6a1a, 0, 9.5, 1.5);   // the hull round the flames, the ground and the Zerg out to ~7
    _fireLight.position.set(0, 1.8, 0);
    scene.add(_fireLight);

    // Nuke light — the fireball lights the field (strongest at night: updateNukeLight)
    _nukeLight = new THREE.PointLight(0xfff8da, 0, 24, 1.5);
    scene.add(_nukeLight);

    // Fog — day: effectively invisible; night: tight range (set once, updated in updateDayNight)
    scene.fog = new THREE.Fog(0x2a3a18, DN_DAY_FOG_NEAR, DN_DAY_FOG_FAR);

    // Ground
    groundMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(120,120), // large enough that the edge is lost in the fog from the low close-up angle
      // Phong = per-pixel lighting: the bunker light can pool on the ground at night
      // (Lambert lights per vertex — on this 4-vertex quad that was no light at all);
      // drawn procedurally (groundMaterial: two grass tones, soft dirt patches, a worn ring)
      groundMaterial()
    );
    groundMesh.rotation.x = -Math.PI/2; groundMesh.receiveShadow=true;
    scene.add(groundMesh);

    // The grass (HIGH)
    _grass = _grassMesh();
    _grass.visible = gfxQuality === 'HIGH';
    scene.add(_grass);

    // Boulders: clusters of rocks (a big one, two or three small ones) out past the Sensor ring and the Zerg's spawn
    // band (r 17.5-24), sunk a quarter into the ground; three shapes, the desktop's (the same seeds), each a sphere
    // chiselled by random planes into faces that meet in ridges, a little uneven. A corner's normal averages the
    // faces round it within 40° (smooth across a face, a crease along a ridge). Instanced
    const rockGeo = [0, 1, 2].map(k => {
      let st = Math.imul(0x5bd1e995, k + 1);
      const rn = () => { st ^= st << 13; st ^= st >>> 17; st ^= st << 5; return (st & 0xffffff) / 16777216; };
      const cuts = [];
      for (let i = 0; i < 16; i++) {
        const y = 2 * rn() - 1, a = rn() * 2 * Math.PI, h = Math.sqrt(1 - y * y), d = .62 + .33 * rn();
        cuts.push([Math.cos(a) * h, y, Math.sin(a) * h, d]);
      }
      const s1 = rn() * 6.28, s2 = rn() * 6.28, g = new THREE.IcosahedronGeometry(1, 4), p = g.attributes.position, n = p.count;   // (not indexed: a corner per face)
      const d = new THREE.Vector3(), corners = new Map();
      for (let i = 0; i < n; i++) {
        d.set(p.getX(i), p.getY(i), p.getZ(i)).normalize();
        const key = `${Math.round(d.x * 2000)},${Math.round(d.y * 2000)},${Math.round(d.z * 2000)}`;   // (the faces sharing a corner move it alike: it depends on d alone)
        (corners.get(key) || corners.set(key, []).get(key)).push(i);
        let rad = 1;
        for (const c of cuts) { const dc = d.x * c[0] + d.y * c[1] + d.z * c[2]; if (dc > .05) rad = Math.min(rad, c[3] / dc); }
        rad *= 1 + .045 * Math.sin(3.1 * d.x + s1) * Math.sin(2.7 * d.y + s2) + .025 * Math.sin(7.3 * d.z + s2) * Math.sin(6.1 * d.x + s1);
        p.setXYZ(i, d.x * rad, Math.min(d.y * rad, .55) * .68, d.z * rad * .85);   // a flattish top
      }
      g.computeVertexNormals();   // flat facets
      const N = g.attributes.normal, flat = N.array.slice();
      const out = new THREE.Vector3();
      for (const list of corners.values())
        for (const i of list) {
          out.set(0, 0, 0);
          for (const j of list)
            if (flat[i * 3] * flat[j * 3] + flat[i * 3 + 1] * flat[j * 3 + 1] + flat[i * 3 + 2] * flat[j * 3 + 2] > .766) { out.x += flat[j * 3]; out.y += flat[j * 3 + 1]; out.z += flat[j * 3 + 2]; }
          out.normalize();
          N.setXYZ(i, out.x, out.y, out.z);
        }
      return g;
    });
    const ROCK_COL = [0x4a3f32, 0x423e39, 0x534735], rocks = [[], [], []], ro = new THREE.Object3D();   // dark: in the sun their tops still read pale
    const rock = (x, z, s) => {
      const k = Math.min(2, Math.floor(Math.random() * 3));
      ro.position.set(x, .42 * s, z); ro.rotation.set((Math.random() - .5) * .5, Math.random() * 2 * Math.PI, (Math.random() - .5) * .5); ro.scale.setScalar(s);
      ro.updateMatrix();
      rocks[k].push([ro.matrix.clone(), new THREE.Color(ROCK_COL[k]).multiplyScalar(.9 + .2 * Math.random())]);
      _rockBlobs.push({ x, y: 0, z, s: 2.5 * s });
    };
    for (let i = 0; i < 18; i++) {
      const a = i / 18 * 2 * Math.PI + (Math.random() - .5) * .25, r = i % 3 === 2 ? 21 + 3 * Math.random() : 17.5 + 3.5 * Math.random();
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
      rock(cx, cz, .55 + .3 * Math.random());
      for (let j = 0, n = 2 + (Math.random() < .5); j < n; j++) {
        const b = Math.random() * 2 * Math.PI, d = .5 + .5 * Math.random();
        rock(cx + Math.cos(b) * d, cz + Math.sin(b) * d, .18 + .22 * Math.random());
      }
    }
    // Stone (the ground's maps, projected on three axes): mottled, grainy, faintly banded, a chipped surface, lichen on
    // the faces turned up, darker at its foot where the earth is damp. At night the fog leaves its own moonlit, colourless
    // trace, paler than the field: a boulder in the dark reads as a stone, not a crouching Zerg
    const rockMat = new THREE.MeshPhongMaterial({ specular: 0x0a0a0a, shininess: 8 });
    rockMat.extensions = { derivatives: true };
    rockMat.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, _groundU);
      sh.vertexShader = 'varying vec3 vGroundW;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
  vGroundW = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;`);
      sh.fragmentShader = '#define FOG_TARGET sceneFogT\nvarying vec3 vGroundW;\n' + sh.fragmentShader
        .replace('#include <fog_pars_fragment>', `#include <fog_pars_fragment>\n${_GROUND_FS}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  vec3 Nw = inverseTransformDirection( normal, viewMatrix );
  if ( groundHD > 0.5 ) {
    vec3 w = Nw * Nw; w *= w; w /= w.x + w.y + w.z;
    vec2 u1 = vGroundW.zy, u2 = vGroundW.xz, u3 = vGroundW.xy;
    vec4 t = texture2D( terrainTex, u1 / 2.3 ) * w.x + texture2D( terrainTex, u2 / 2.3 ) * w.y + texture2D( terrainTex, u3 / 2.3 ) * w.z;
    vec4 f1 = texture2D( soilTex, u1 / 1.4 ), f2 = texture2D( soilTex, u2 / 1.4 ), f3 = texture2D( soilTex, u3 / 1.4 );
    float grain = f1.r * w.x + f2.r * w.y + f3.r * w.z;
    vec3 stone = diffuseColor.rgb * ( 0.62 + 0.76 * t.r ) * ( 1.0 + 0.55 * ( grain - 0.5 ) ) * ( 1.0 + 0.09 * sin( vGroundW.y * 17.0 + t.g * 6.0 ) );
    float mo = smoothstep( 0.62, 0.92, Nw.y + ( t.g - 0.5 ) * 1.3 ) * 0.6;
    diffuseColor.rgb = mix( stone, GRASS_DRY * ( 0.55 + 0.7 * t.r ), mo ) * mix( 0.55, 1.0, smoothstep( 0.0, 0.32, vGroundW.y ) );
    Nw = normalize( Nw - 0.7 * ( ( vec3( 0.0, f1.a, f1.b ) - vec3( 0.0, 0.5, 0.5 ) ) * w.x + ( vec3( f2.b, 0.0, f2.a ) - vec3( 0.5, 0.0, 0.5 ) ) * w.y + ( vec3( f3.b, f3.a, 0.0 ) - vec3( 0.5, 0.5, 0.0 ) ) * w.z ) );
    normal = normalize( ( viewMatrix * vec4( Nw, 0.0 ) ).xyz );
  }
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( dot( diffuseColor.rgb, LUMA_G ) ), uNightDesat ) * ( 1.0 - 0.3 * uWet );   // (wet stone darkens)
  sceneFogT = mix( fogColor, nightOf( 1.5 * diffuseColor.rgb, Nw ), uNight );`);
    };
    rockMat.customProgramCacheKey = () => 'rock';
    rocks.forEach((list, k) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(rockGeo[k], rockMat, list.length);
      list.forEach(([m, c], i) => { im.setMatrixAt(i, m); im.setColorAt(i, c); });
      im.castShadow = im.receiveShadow = true;
      scene.add(im);
    });

    // Bunker — procedural base always present; OBJ swaps in async when loaded
    function _buildProceduralBunker(parent) {
      const body = new THREE.Mesh(new THREE.BoxGeometry(3,1.5,3),new THREE.MeshLambertMaterial({color:0x556644}));
      body.position.y=.75; body.castShadow=true; parent.add(body);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(3.4,.3,3.4),new THREE.MeshLambertMaterial({color:0x445533}));
      roof.position.y=1.55; parent.add(roof);
      for(let i=0;i<14;i++){
        const a=i/14*Math.PI*2;
        const sb=new THREE.Mesh(new THREE.SphereGeometry(.28,6,4),new THREE.MeshLambertMaterial({color:0x8a7a50}));
        sb.scale.set(1,.55,1); sb.position.set(Math.cos(a)*2.1,.18,Math.sin(a)*2.1); parent.add(sb);
      }
    }
    const bunk = new THREE.Group();
    bunkerGroup = bunk;
    _buildProceduralBunker(bunk);
    ModelLoader.load('bunker').then(template => {
      [...bunk.children].forEach(c => bunk.remove(c));
      const m = template.clone();
      m.traverse(ch => {
        if (!ch.isMesh) return;
        ch.material = ch.material.clone();
        ch.castShadow = true;
        // Team-colour panels: base/top in Terran blue; Mesh.002 (HP-upgrade
        // plates) gets its tier colour in updateBunkerVisual().
        if (ch.material.map) ch.userData.teamColor = addTeamColor(ch.material, BUNKER_TEAM_COL);
      });
      bunk.add(m);
      bunkerModelRoot = m;
      _fireSpots = null; // re-sample fire spots on the real model surface
      updateBunkerVisual();
      _mountShrike();
    }).catch(()=>{});
    ModelLoader.ready('shrike').then(_mountShrike);   // loaded in the last stage (needed from hull Lv3)
    scene.add(bunk);
  }

  // ── Shrike turret (HP Lv3) ───────────────────────────────────────────────
  // SC2 Shrike turret seated on the bunker roof. It picks the nearest enemy in
  // range, leads it, turns toward it and fires twin rounds: the firepower of
  // two extra marines, but automatic — no clicks, no ammo.
  const SHRIKE = { interval: 0.3, range: 14,
                   overdriveInterval: 0.12, overdriveColor: 0xff2a1a,   // six Marines inside: 2.5× rate of fire, red rounds
                   omega: 20, maxTurn: 14,   // yaw spring stiffness (rad/s) and turn-speed cap (rad/s)
                   sink: -0.05 }; // raised: base rests on the frame's top plate with its collar showing (SC2 "full armor w/ Shrike")
  const SHRIKE_GOLD = 0xffb81f;           // Lv3 team colour (frame + turret), matches the hologram
  let shrikeRoot = null;                  // pivot group on the roof (turret model inside, faces +Z)
  let _shrikeY = 1.0, _shrikeYaw = 0, _shrikeVel = 0, _shrikeCD = 0, _shrikeTgt = null, _shrikeRecoil = 0;
  // Barrel muzzles in turret space (yaw 0, +Z forward), measured from the model when it is
  // mounted; this default matches the SC2 BunkerShrikeTurret (±0.52, 0.68, 0.70).
  let _shrikeTips = [new THREE.Vector3(-0.517, 0.681, 0.70), new THREE.Vector3(0.517, 0.681, 0.70)];
  // Centre of each barrel's front face: vertices within 4 cm of the forwardmost
  // point, split left/right (the twin barrels are the turret's forwardmost parts).
  function _measureBarrelTips(root) {
    root.updateMatrixWorld(true);
    const v = new THREE.Vector3(), pts = [];
    root.traverse(ch => {
      if (!ch.isMesh || !ch.geometry?.attributes.position) return;
      const p = ch.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(ch.matrixWorld); pts.push(v.x, v.y, v.z); }
    });
    let zMax = -Infinity;
    for (let i = 2; i < pts.length; i += 3) zMax = Math.max(zMax, pts[i]);
    const tips = [-1, 1].map(side => {
      let n = 0; const c = new THREE.Vector3();
      for (let i = 0; i < pts.length; i += 3) if (pts[i + 2] > zMax - 0.04 && Math.sign(pts[i]) === side) { c.x += pts[i]; c.y += pts[i + 1]; c.z += pts[i + 2]; n++; }
      return n ? c.divideScalar(n).setZ(zMax + 0.02) : null;               // just in front of the muzzle
    });
    if (tips[0] && tips[1] && Math.abs(tips[0].x - tips[1].x) > 0.2) _shrikeTips = tips;
    else console.warn('Shrike: barrel tips not found in the model, using defaults');
  }
  const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  // Turret base height in root space: top of the Neosteel frame (Mesh.002), else the roof
  function _shrikeMountY(root) {
    root.updateMatrixWorld(true);
    const top = root.getObjectByName('Mesh.002') || root.getObjectByName('Mesh.001');
    return (top ? new THREE.Box3().setFromObject(top).max.y : 1.0) - SHRIKE.sink;
  }
  function _mountShrike() {
    if (shrikeRoot || !bunkerModelRoot || !ModelLoader.isReady('shrike')) return;
    const t = ModelLoader.clone('shrike');
    t.traverse(ch => {
      if (!ch.isMesh) return;
      ch.material = ch.material.clone(); ch.castShadow = true;
      if (ch.material.map) ch.userData.teamColor = addTeamColor(ch.material, SHRIKE_GOLD);
    });
    _shrikeY = _shrikeMountY(bunkerGroup);   // on the frame's top plate
    _measureBarrelTips(t);                   // t is still unparented: its matrix = turret space at yaw 0
    shrikeRoot = new THREE.Group();
    shrikeRoot.position.set(0, _shrikeY, 0);
    shrikeRoot.rotation.y = _shrikeYaw;
    shrikeRoot.add(t);
    bunkerGroup.add(shrikeRoot);
    updateBunkerVisual();
    _pBuilt = false; _pBuildTried = false; // hologram rebuilds itself with the turret
  }
  // Target choice: score = distance + how far the gun must turn, with enemies
  // attacking the bunker first. The current target is kept unless another is
  // clearly better — re-picking the nearest every frame made the turret flick
  // between enemies at similar range and whip around after every kill.
  function _shrikeScore(e) {
    const p = e.mesh.position, d = Math.hypot(p.x, p.z);
    if (d > SHRIKE.range) return Infinity;
    const attacking = d < attackReach(e);
    return d + Math.abs(angDiff(Math.atan2(p.x, p.z), _shrikeYaw)) * 1.2 - (attacking ? 3 : 0);
  }
  function _shrikePick() {
    let best = null, bestS = Infinity, curLive = false;
    for (const list of [zerglings, roaches]) for (const e of list) {
      if (e.dead || !(e.mesh.visible || _sensed(e))) continue;   // at night: in the light, or a Sensor Tower blip
      if (e === _shrikeTgt) curLive = true;
      const sc = _shrikeScore(e);
      if (sc < bestS) { bestS = sc; best = e; }
    }
    const cur = _shrikeTgt;
    if (cur && curLive) {                                     // only a target that is still in play
      const sc = _shrikeScore(cur);
      if (sc < Infinity && sc <= bestS + 2.0) return cur;   // hysteresis: stay on target
    }
    return best;
  }
  // Marine overdrive: a bunker full of Marines (6/6) drives the Shrike turret
  // much faster — the Marines' answer to the Marauder's and Ghost's abilities.
  function shrikeOverdrive() { return hpLvl >= 3 && roster.length === 6 && roster.every(u => u === 'marine'); }
  let _shrikeOD = false;

  // Stimpack (T): as in SC2 the Marines and Marauders stim — for 11 s they fire 50%
  // faster (an extra round or grenade every other volley, no extra ammo), at the SC2
  // price of 10 HP per Marine and 20 per Marauder, paid by the bunker. It needs six
  // Marines in the bunker; Super Stimpack's tiers bring that down to 4, 2, 1.
  const STIM_COLOR = 0xff6a3a;
  let stimT = 0, _stimVolley = 0;
  const _count = t => roster.filter(u => u === t).length;
  function stimNeed() { return CFG.stim_marines[Math.max(0, Math.min(3, superStimLvl))]; }
  function stimCount() { return _count('marine') + (superStimLvl >= 3 ? _count('marauder') : 0); }   // the last tier: Marauders count too
  function stimUnlocked() { return stimCount() >= stimNeed(); }
  function stimCost() { return superStimUnlocked ? 0 : CFG.stim_hp * _count('marine') + CFG.stim_hp_marauder * _count('marauder'); }   // Super Stimpack: free
  let stimAuto = false;   // Super Stimpack autocast (right-click STIM): stims as the bunker fires
  function doStim(autocast = false) {   // autocast: quietly, only if it can
    if (phase !== 'playing' || isPaused()) return;
    if (autocast === true && (wavePhase !== 'combat' || !stimUnlocked() || stimT > 0 || stimCost() > 0)) return;
    if (wavePhase !== 'combat') { setStatus('Stimpack only during a wave'); SFX.play('deny'); return; }
    if (!stimUnlocked()) { setStatus(superStimLvl >= 3 ? 'Stimpack needs a Marine or a Marauder in the bunker' : `Stimpack needs ${stimNeed()} Marines in the bunker`); SFX.play('deny'); return; }
    if (stimT > 0) { setStatus('Already stimmed!'); return; }
    const cost = stimCost();
    if (cost && bunkerHp <= cost) { setStatus('Not enough HP to stim'); SFX.play('deny'); return; }
    bunkerHp -= cost; stimT = CFG.stim_duration; _stimVolley = 0;
    if (autocast === true) { SFX.play('stim'); updateHUD(); return; }   // as SC2's autocast: no word, the stim sound
    const who = _count('marauder') ? 'Marines and Marauders' : 'Marines';
    setStatus(superStimUnlocked
      ? `Super Stimpack! ${who} fire 50% faster, bunker repair +${Math.round(repairRate())} HP/s for ${CFG.stim_duration} s`
      : `Stimpack! ${who} fire 50% faster for ${CFG.stim_duration} s (−${cost} HP)`);
    SFX.play('stim');
    updateHUD();
  }
  // Right-click STIM, as SC2's autocast: with Super Stimpack (free) it stims whenever the bunker fires
  function toggleStimAuto() {
    if (!superStimUnlocked) { setStatus('Autocast needs the Super Stimpack research'); SFX.play('deny'); return; }
    if (_tutStep && _tutStep.id === 'autostim') tutDismiss();   // the hint that asks for it
    stimAuto = !stimAuto;
    setStatus(stimAuto ? 'Stimpack autocast on — it stims as you fire' : 'Stimpack autocast off');
    updateHUD();
  }
  function updateShrike(dt) {
    const od = shrikeOverdrive();
    if (od !== _shrikeOD) {
      _shrikeOD = od;
      if (od) achState();
      if (od) setStatus('Six Marines — Shrike overdrive: rate of fire ×2.5!');
    }
    if (hpLvl < 3) { _shrikeTgt = null; return; }
    _shrikeCD = Math.max(0, _shrikeCD - dt);
    const tgt = _shrikeTgt = _shrikePick();
    let want = 0, tx = 0, tz = 0, d = 0;
    if (tgt) {
      const p = tgt.mesh.position;
      d = Math.max(0.01, Math.hypot(p.x, p.z));
      tx = p.x; tz = p.z;
      // Lead moving enemies only (they walk straight at the bunker); attackers stand still
      if (d > attackReach(tgt)) {
        const v = tgt.speed * (slowedEnemies.get(tgt.mesh.uuid)?.factor ?? 1) * 60;
        const lead = v * d / (UNIT_DEF.marine.bulletSpeed * 60);
        tx -= p.x / d * lead; tz -= p.z / d * lead;
      }
      want = Math.atan2(tx, tz);
    }
    if (tgt) {
      // Critically damped spring toward the aim: smooth start and stop instead of
      // snapping at full speed (substeps keep it stable at low frame rates).
      const w = SHRIKE.omega, steps = Math.max(1, Math.ceil(dt / 0.008)), h = dt / steps;
      for (let i = 0; i < steps; i++) {
        _shrikeVel += (w * w * angDiff(want, _shrikeYaw) - 2 * w * _shrikeVel) * h;
        _shrikeVel = Math.max(-SHRIKE.maxTurn, Math.min(SHRIKE.maxTurn, _shrikeVel));
        _shrikeYaw = angDiff(_shrikeYaw + _shrikeVel * h, 0);   // integrate, keep in (-π, π]
      }
    } else {
      // Idle: ease into a slow scanning sweep in the direction it was already turning
      const tv = 0.5 * Math.sign(_shrikeVel || 1);
      _shrikeVel = tv + (_shrikeVel - tv) * Math.exp(-dt * 20);   // brake to the sweep (≈40° overrun at full speed)
      _shrikeYaw = angDiff(_shrikeYaw + _shrikeVel * dt, 0);
    }
    _shrikeRecoil = Math.max(0, _shrikeRecoil - dt * 9);
    if (shrikeRoot) {
      shrikeRoot.rotation.y = _shrikeYaw;
      const gun = shrikeRoot.children[0];
      if (gun) gun.position.z = -0.08 * _shrikeRecoil;            // recoil kick along the barrels
    }
    if (!tgt || _shrikeCD > 0 || wavePhase !== 'combat') return;
    // Fire once the target is inside the gun's line of fire (wider for close targets)
    const hitR = tgt.type === 'r' ? .75 : .5;
    if (Math.abs(angDiff(want, _shrikeYaw)) > Math.max(0.1, Math.atan2(hitR, d))) return;
    _shrikeCD = od ? SHRIKE.overdriveInterval : SHRIKE.interval;
    _shrikeRecoil = 1;
    // Twin barrels = 2 marine rounds. Each leaves its own muzzle and flies at the
    // same aim point (target body height): the tracers converge into a V there
    // and, if they fly on, cross into an X.
    const sy = Math.sin(_shrikeYaw), cy = Math.cos(_shrikeYaw);
    const aimY = tgt.type === 'r' ? 0.55 : AIM_Y;
    for (const tip of _shrikeTips) {
      const ox = cy * tip.x + sy * tip.z, oz = -sy * tip.x + cy * tip.z, oy = _shrikeY + tip.y; // turret yaw → world
      const blt = makeBulletTyped(tx, tz, 0, 'marine', ox, oy, oz, aimY);
      if (od) blt.color = SHRIKE.overdriveColor;
      bullets.push(blt);
      muzzleFlash(ox, oy, oz, blt.vx / blt.speed, blt.vz / blt.speed, od ? 0xff4020 : 0xffb030, false);
    }
    SFX.play('shrike');
  }

  // ── SC2-style team colour ────────────────────────────────────────────────
  // Tints the panels masked by the diffuse alpha (see ModelLoader.teamColor,
  // which also keeps SC2 normal maps working); returns the THREE.Color uniform
  // so the tint can be changed later.
  const BUNKER_TEAM_COL = TEAM_COLOR.terran;
  const addTeamColor = (mat, hex) => ModelLoader.teamColor(mat, hex);

  // ── Shared geometry/material caches ──────────────────────────────────────
  // Procedural entities are spawned constantly (Zerg models are procedural-only),
  // so geometries and materials are cached and shared — never per-instance.
  const _geoCache = new Map(), _lamCache = new Map(), _basCache = new Map();
  function sharedGeo(key, make){ let g=_geoCache.get(key); if(!g){ g=make(); _geoCache.set(key,g);} return g; }
  function lamMat(col){ let m=_lamCache.get(col); if(!m){ m=new THREE.MeshLambertMaterial({color:col}); _lamCache.set(col,m);} return m; }
  function basMat(col){ let m=_basCache.get(col); if(!m){ m=new THREE.MeshBasicMaterial({color:col}); _basCache.set(col,m);} return m; }

  // ── Merge helper ─────────────────────────────────────────────────────────
  // Concatenate non-indexed geometries (shared position/normal/uv attributes)
  // into one, so a group of static parts costs one draw call.
  function mergeGeometries(geos) {
    if (geos.length === 1) return geos[0];
    const out = new THREE.BufferGeometry();
    for (const n of ['position', 'normal', 'uv'].filter(n => geos.every(g => g.attributes[n]))) {
      const k = geos[0].attributes[n].itemSize;
      const arr = new Float32Array(geos.reduce((t, g) => t + g.attributes[n].count * k, 0));
      let o = 0;
      for (const g of geos) {
        const a = g.attributes[n], get = [a.getX, a.getY, a.getZ, a.getW]; // accessors also handle interleaved (GLB) data
        for (let i = 0; i < a.count; i++) for (let c = 0; c < k; c++) arr[o++] = get[c].call(a, i);
      }
      out.setAttribute(n, new THREE.BufferAttribute(arr, k));
    }
    geos.forEach(g => g.dispose());
    return out;
  }
  // Non-indexed copy with plain Float32 position/normal/uv (de-interleaved,
  // de-quantised), safe to transform and concatenate.
  const _QSCALE = { Int8Array: 127, Uint8Array: 255, Int16Array: 32767, Uint16Array: 65535 };
  function plainGeometry(src) {
    const g = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) {
      const a = src.attributes[name];
      if (!a) continue;
      const k = a.itemSize, out = new Float32Array(a.count * k), get = [a.getX, a.getY, a.getZ, a.getW];
      const q = a.normalized ? (_QSCALE[a.array.constructor.name] || 1) : 1;
      for (let i = 0; i < a.count; i++) for (let c = 0; c < k; c++) {
        const v = get[c].call(a, i);
        out[i * k + c] = q === 1 ? v : Math.max(-1, v / q);
      }
      g.setAttribute(name, new THREE.BufferAttribute(out, k));
    }
    if (src.index) g.setIndex(new THREE.BufferAttribute(Uint32Array.from(src.index.array), 1));
    return g.index ? g.toNonIndexed() : g;
  }
  // Bake every mesh of a parentless template into its root space, grouped by
  // material → [{mat, geo, cast}] (one merged geometry per material).
  function bakeTemplate(root) {
    root.updateMatrixWorld(true);
    const groups = new Map();
    root.traverse(ch => {
      if (!ch.isMesh || !ch.geometry?.attributes.position) return;
      const g = plainGeometry(ch.geometry);
      g.applyMatrix4(ch.matrixWorld);
      if (!groups.has(ch.material)) groups.set(ch.material, []);
      groups.get(ch.material).push(g);
    });
    return [...groups].map(([mat, geos]) => ({ mat, geo: mergeGeometries(geos), cast: !mat.isMeshBasicMaterial }));
  }

  // ── Instanced enemy rendering ────────────────────────────────────────────
  // All enemies sharing a look (procedural zergling of a wave tier, a loaded
  // SC2 model, …) are drawn as instances of one InstancedMesh per material:
  // a handful of draw calls for the whole swarm. A procedural zergling used
  // to be 12 meshes = 12 draw calls each (≈1700 calls in late waves). Each
  // enemy keeps a plain Object3D transform holder (e.mesh) that is NOT in the
  // scene; syncEnemyPools() copies its matrix into the instance buffers.
  const _pools = new Map();
  function enemyPool(key, makeTemplate) {
    let pool = _pools.get(key);
    if (!pool) {
      pool = { parts: bakeTemplate(makeTemplate()), ims: [], cap: 0, n: 0 };
      _growPool(pool, 64);
      _pools.set(key, pool);
    }
    return pool;
  }
  function _growPool(pool, cap) {
    pool.ims.forEach(im => { scene.remove(im); im.dispose?.(); });
    pool.ims = pool.parts.map(p => {
      const im = new THREE.InstancedMesh(p.geo, p.mat, cap);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // per-instance colour multiplier: hit flash (>1 brightens), slow tint, corpse fade
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;   // instances roam far from the mesh origin
      im.castShadow = p.cast;     // one shadow draw per material for the whole swarm
      im.count = 0; im.visible = false;   // shown by syncEnemyPools once used
      scene.add(im);
      return im;
    });
    pool.cap = cap;
  }
  function syncEnemyPools() {
    for (const pool of _pools.values()) pool.n = 0;
    const live = e => e.pool && (e.corpse || !e.dead) && e.mesh.visible;
    const lists = [zerglings, roaches, corpses];
    for (const list of lists) for (const e of list) if (live(e)) e.pool.n++;
    for (const pool of _pools.values()) {
      if (pool.n > pool.cap) _growPool(pool, 1 << Math.ceil(Math.log2(pool.n)));
      pool.n = 0;
    }
    for (const list of lists) for (const e of list) {
      if (!live(e)) continue;
      e.mesh.updateMatrix();
      const i = e.pool.n++, o = i * 16, c = i * 3;
      // colour: corpse fades dark (a nuke's burns) · hit flash bright · concussive slow icy blue
      let r = 1, g = 1, b = 1;
      if (e.corpse) { if (e.col) [r, g, b] = e.col; else r = g = b = Math.max(0.25, 1 - e.t * 1.4); }
      else if (e.flash > 0) r = g = b = 2.6;
      else if (slowedEnemies.has(e.mesh.uuid)) { r = 0.6; g = 0.8; b = 1.5; }
      for (const im of e.pool.ims) {
        e.mesh.matrix.toArray(im.instanceMatrix.array, o);
        const ca = im.instanceColor.array; ca[c] = r; ca[c + 1] = g; ca[c + 2] = b;
      }
    }
    for (const pool of _pools.values()) for (const im of pool.ims) {
      im.count = pool.n; im.visible = pool.n > 0;   // walk / attack frames nobody is on: skipped (also in the shadow pass)
      im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true;
    }
    syncBlobs();   // their contact shadows (and the units')
  }

  // Dying enemies: pop, roll onto their side, then sink into the ground (~1.2 s). A nuke's victims
  // catch fire in the flash and run on, slowing and staggering, until its front reaches them, then
  // fly outward burning and tumbling, bounce once, smoulder out and sink (_burnCorpse).
  const CORPSE_CAP = 160;
  const NUKE_FIRE_BODIES = { HIGH: 40, LOW: 20 };   // the flames on all the bodies share this budget (bodies at full rate)
  let corpses = [];
  function updateCorpses(dt) {
    // (a nuke over a big wave must not flood the particles)
    let burning = 0;
    for (const c of corpses) if (c.flung && c.t < c.delay + 2) burning++;   // (before it is thrown: when it should be)
    const share = Math.min(1, NUKE_FIRE_BODIES[gfxQuality] / Math.max(1, burning));
    corpses = corpses.filter(c => {
      c.t += dt;
      if (c.flung) return _burnCorpse(c, dt, share);
      const m = c.mesh;
      if (c.t < 0.12) m.position.y = c.t / 0.12 * 0.18;                                   // pop
      else m.position.y = 0.18 - Math.min(1, (c.t - 0.12) / 1.0) ** 2 * 0.9;               // sink
      m.rotation.z = c.spin * Math.min(1, c.t / 0.3) * Math.PI * 0.5;                       // roll over
      return c.t < 1.2;
    });
  }
  function _burnCorpse(c, dt, share) {
    const m = c.mesh, p = m.position, v = c.vel, R = Math.random;
    if (!c.thrown) {   // the front reaches it where it has run to: thrown outward from there
      const ox = p.x - c.zero[0], oz = p.z - c.zero[1], L = Math.hypot(ox, oz);
      if (nk.frontR(c.t) >= L) {
        c.thrown = true; c.delay = c.t;
        const h = Math.hypot(v[0], v[2]);
        if (L > 1e-3) { v[0] = ox / L * h; v[2] = oz / L * h; }
      }
    }
    const s = c.thrown ? c.t - c.delay : -1;
    // the flash's white-out, then orange-hot, charring black within about a second
    const ch = _sstep(0, 1.2, c.t), wh = 1.2 * Math.exp(-c.t / .12);
    c.col[0] = 1 - .87 * ch + wh; c.col[1] = .62 - .51 * ch + wh; c.col[2] = .38 - .28 * ch + wh;
    if (s < 0) {   // still on its feet: runs on, slowing as it burns, staggering (no further than the hull)
      const k = Math.exp(-c.t / .35);
      if (c.run) {
        let dx = c.run[0] * k * dt, dz = c.run[1] * k * dt;
        const r = Math.hypot(p.x, p.z), L = Math.hypot(dx, dz);
        if (r - L < c.stopR) { const f = Math.max(0, r - c.stopR) / Math.max(L, 1e-6); dx *= f; dz *= f; }
        p.x += dx; p.z += dz;
        if (c.walk && dx * dx + dz * dz > 0) walkStep(c, Math.hypot(dx, dz));
      }
      m.rotation.z = .14 * (1 - k) * Math.sin(c.t * 15 + 3 * c.spin);
    } else if (s < 1.6) {   // flying, tumbling; it bounces once
      v[1] -= 20 * dt;
      p.x += v[0] * dt; p.y += v[1] * dt; p.z += v[2] * dt;
      if (p.y < 0) { p.y = 0; v[0] *= .5; v[1] *= -.25; v[2] *= .5; c.spin *= .5; }
      m.rotation.z += c.spin * dt;
    } else p.y = Math.min(p.y, 0) - .8 * dt;   // smouldering, it sinks
    // flames on the body until about a second after it lands, then smoke as it smoulders out (the
    // flames blended over: added, orange turns lime on the grass and reads as sparks; the smoke greys
    // as it spreads, lit by the scene: left dark, it stains the bright grass in dots; grey, it shows in the night)
    const fire = 1 - _sstep(.9, 1.9, s), smoke = 1 - _sstep(1.4, 2.4, s), tr = s >= 0 && s < 1.6 ? .25 : 0;   // (trailing as it flies)
    for (c.fireAcc += dt * 16 * fire * share; c.fireAcc >= 1; c.fireAcc--)
      emitParticle(_smoke, p.x + (R() - .5) * .5, p.y + .2 + R() * .25, p.z + (R() - .5) * .5, v[0] * 2 * tr + (R() - .5) * .4, v[1] * 2 * tr + .8 + R() * .8, v[2] * 2 * tr + (R() - .5) * .4,
        .25 + R() * .2, (.45 + .25 * R()) * (.6 + .4 * fire), .1, .85, 0xffcc66, 0xe02c04, -1.5, 1, 0);
    for (c.smokeAcc += dt * 4 * smoke * share; c.smokeAcc >= 1; c.smokeAcc--)
      emitParticle(_smoke, p.x + (R() - .5) * .3, p.y + .45, p.z + (R() - .5) * .3, v[0] * tr * .5 + (R() - .5) * .3, .5 + R() * .4, v[2] * tr * .5 + (R() - .5) * .3,
        1.4 + R() * .8, .35, 1.6, .26, 0x24201c, _tmpCol.setHex(0x8a847c).multiplyScalar(1 - .75 * _dnLitF).getHex(), -.2, .4, 1);
    return s < 2.4 && camera.position.distanceTo(p) > 1.5;   // gone once sunk (or as it comes at the close-up camera's lens)
  }

  // ── Entity factories ─────────────────────────────────────────────────────
  function _proceduralMarine(idx) {
    const cols=[0x224488,0x334499,0x1a3377,0x2a3388,0x1a4488,0x223366];
    const g=new THREE.Group(), c=cols[idx%cols.length];
    const body=new THREE.Mesh(sharedGeo('mar-body',()=>new THREE.BoxGeometry(.44,.6,.34)),lamMat(c));
    body.position.y=.55; body.castShadow=true; g.add(body);
    const head=new THREE.Mesh(sharedGeo('mar-head',()=>new THREE.SphereGeometry(.21,8,6)),lamMat(c));
    head.position.y=1.04; g.add(head);
    const gun=new THREE.Mesh(sharedGeo('mar-gun',()=>new THREE.BoxGeometry(.07,.07,.48)),lamMat(0x111111));
    gun.position.set(.27,.73,.18); g.add(gun);
    return g;
  }
  function makeMarine(ox,oz,idx,type){
    const g = new THREE.Group();
    g.position.set(ox,0,oz);
    g.visible = false;  // hidden while inside bunker
    scene.add(g);
    const m = {mesh:g,type:null,state:'bunker',target:null,queue:[],cb:null,homeX:ox,homeZ:oz,leg:Math.random()*6.28};
    setUnitModel(m, type, idx);
    return m;
  }
  // The figure that leaves the bunker wears its unit's SC2 model (marine,
  // marauder, ghost), else a procedural marine. A fallback is swapped for the
  // real model once it has loaded. With a walk cycle, one mesh steps through
  // the frame geometries (see updateMarines).
  const LAMP_CHEST = 0.62;   // its chest lamps (at night: syncUnitLamps), as a share of its height
  function setUnitModel(m, type, idx) {
    if (m.type === type && !(m.fallback && ModelLoader.isReady(type))) return;
    m.mesh.clear();
    const frames = ModelLoader.animFrames(type, 'walk');
    const model = frames ? frames[0].clone() : ModelLoader.clone(type) || ModelLoader.clone('marine', () => _proceduralMarine(idx));
    if (model) m.mesh.add(model);
    m.lampH = model ? new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).y * LAMP_CHEST : 0.8;   // its chest lamps' height
    m.type = type; m.fallback = !ModelLoader.isReady(type);
    m.walk = frames && frames.map(t => t.getObjectByProperty('isMesh', true).geometry);
    m.walkMesh = frames && model.getObjectByProperty('isMesh', true);
    m.stride = frames ? ASSETS[type].stride : 1; m.step = 0;
  }

  function _proceduralZergling() {
    const g=new THREE.Group();
    const col=wave>=7?0x332200:wave>=4?0x1a2a0a:0x223322;
    // Only body + head cast shadows (castShadow on the Group itself is ignored by three.js)
    const body=new THREE.Mesh(sharedGeo('zg-body',()=>new THREE.BoxGeometry(.65,.38,.85)),lamMat(col));
    body.position.y=.3; body.castShadow=true; g.add(body);
    const head=new THREE.Mesh(sharedGeo('zg-head',()=>new THREE.BoxGeometry(.45,.35,.45)),lamMat(0x2a3d22));
    head.position.set(0,.48,.38); head.castShadow=true; g.add(head);
    [-0.2,0.2].forEach(ex=>{
      const eye=new THREE.Mesh(sharedGeo('zg-eye',()=>new THREE.SphereGeometry(.065,5,4)),basMat(wave>=7?0xff8800:0xff2200));
      eye.position.set(ex,.55,.62); g.add(eye);
    });
    [[-0.22,-0.2],[0.22,-0.2],[-0.22,.18],[0.22,.18]].forEach(([lx,lz])=>{
      const leg=new THREE.Mesh(sharedGeo('zg-leg',()=>new THREE.BoxGeometry(.1,.28,.1)),lamMat(0x1a2a1a));
      leg.position.set(lx,.14,lz); g.add(leg);
    });
    for(let i=0;i<4;i++){const f=new THREE.Mesh(sharedGeo('zg-fin',()=>new THREE.ConeGeometry(.06,.24,4)),lamMat(0x334433));f.position.set(0,.65,-.22+i*.16);g.add(f);}
    return g;
  }
  // How an enemy is drawn: its SC2 skin's walk cycle (one instance pool per
  // frame, the enemy hops between them) and attack animation, else the static
  // model, else the procedural look (poolKey, makeProcedural).
  function enemyLook(skin, poolKey, makeProcedural) {
    const framePools = anim => {
      const frames = skin && ModelLoader.animFrames(skin, anim);
      return frames ? frames.map((t, k) => enemyPool(`${skin}:${anim}${k}`, () => t)) : null;
    };
    const walk = framePools('walk'), attack = framePools('attack');
    const pool = walk ? walk[0]
      : skin ? enemyPool(skin + ':model', () => ModelLoader.clone(skin))
      : enemyPool(poolKey, makeProcedural);
    return { pool, model: !!skin, walk, attack, stride: skin ? ASSETS[skin].stride : 1, step: Math.random(), atkT: Math.random() };
  }
  function makeZergling(x,z){
    const g = new THREE.Object3D();   // transform holder — drawn by its instance pool
    g.position.set(x,0,z);
    // Metabolic Boost (wave 8+): the winged SC2 model, its webby skin later, 60% faster.
    // Each falls back to the previous skin, then to the procedural look of the wave tier.
    const boost = wave >= CFG.metabolic_wave;
    const skin = [wave>=CFG.webby_wave&&'zergling_webby', boost&&'zergling_upgrade', 'zergling'].find(k => k && ModelLoader.isReady(k));
    const hp=60+wave*28;
    return {mesh:g,...enemyLook(skin, 'zergling:' + (wave>=7?2:wave>=4?1:0), _proceduralZergling),
            type:'z',hp,maxHp:hp,dead:false,speed:(0.014+wave*0.004)*(boost?CFG.metabolic_boost:1),dmg:10+wave*3,leg:Math.random()*6.28,
            attrs:['light','biological'],          // SC2: Zergling is Light
            reward:{score:10+wave*2,minerals:6+wave*2,gas:Math.floor(wave/2)}};
  }

  function _proceduralRoach() {
    const g=new THREE.Group();
    [['ro-b1',[1.1,.6,1.3],0x3a2200,{y:.4}],
     ['ro-b2',[1.,.35,1.1],0x5a3300,{y:.78}],
     ['ro-b3',[.7,.4,.55],0x4a2800,{x:0,y:.55,z:.72}],
    ].forEach(([key,dims,col,pos])=>{
      const m=new THREE.Mesh(sharedGeo(key,()=>new THREE.BoxGeometry(...dims)),lamMat(col));
      Object.assign(m.position,pos); m.castShadow=true; g.add(m);
    });
    [-0.18,0.18].forEach(ex=>{
      const eye=new THREE.Mesh(sharedGeo('ro-eye',()=>new THREE.SphereGeometry(.09,5,4)),basMat(0xff6600));
      eye.position.set(ex,.68,.98); g.add(eye);
    });
    [[-0.4,-0.3],[0.4,-0.3],[-0.4,.3],[0.4,.3],[-0.3,0],[0.3,0]].forEach(([lx,lz])=>{
      const leg=new THREE.Mesh(sharedGeo('ro-leg',()=>new THREE.BoxGeometry(.14,.22,.14)),lamMat(0x2a1800));
      leg.position.set(lx,.18,lz); g.add(leg);
    });
    return g;
  }
  function makeRoach(x,z){
    const g = new THREE.Object3D();   // transform holder — drawn by its instance pool
    g.position.set(x,0,z);
    // SC2 skin of this wave tier (falls back to the base skin, then procedural)
    const skin = [wave>=13&&'roach_ex3', wave>=9&&'roach_ex1a', 'roach'].find(k => k && ModelLoader.isReady(k));
    const hp=200+wave*70;
    return {mesh:g,...enemyLook(skin, 'roach', _proceduralRoach),atkT:0,mouth:roachMouth(skin),
            type:'r',hp,maxHp:hp,dead:false,speed:0.008+wave*0.002,dmg:18+wave*5,leg:Math.random()*6.28,
            attrs:['armored','biological'],        // SC2: Roach is Armored
            reward:{score:30+wave*5,minerals:18+wave*4,gas:3+wave}};
  }
  // Advance an enemy's walk cycle by `dist` world units (one loop per stride,
  // sped up by ANIM_SPEED) and draw it from that frame's instance pool.
  function walkStep(e, dist) {
    e.step = (e.step + dist / e.stride * ANIM_SPEED) % 1;
    e.pool = e.walk[Math.floor(e.step * e.walk.length)];
  }

  // Distance from the bunker's centre at which an enemy stops and attacks:
  // Zerglings bite the hull, Roaches spit acid from SC2 range.
  function attackReach(e) { return e.type === 'r' ? ROACH_ACID.range : 2.0; }

  // ── Roach acid ───────────────────────────────────────────────────────────
  // In range, a Roach faces the bunker and plays its SC2 Attack animation; at
  // the lunge a glob of acid leaves its mouth and arcs onto the hull facing it.
  // Damage lands on impact (same damage per second as the old bite). Game time:
  // globs freeze on pause and are dropped by Restart/Load.
  let acids = [];
  const ACID_CAP = 256;
  const _acidIM = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(.11, 1), new THREE.MeshBasicMaterial({ color: 0x9cff3a }), ACID_CAP);
  _acidIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _acidIM.frustumCulled = false; _acidIM.count = 0;
  scene.add(_acidIM);
  const _acidM4 = new THREE.Matrix4(), _acidScale = new THREE.Vector3(), _acidQ = new THREE.Quaternion();
  const _PROC_MOUTH = new THREE.Vector3(0, .6, 1.0);   // the procedural Roach's face
  const _mouthCache = {};
  // Ref_Head at the spit moment, in a Roach's local space (the model's normalisation applied)
  function roachMouth(skin) {
    if (!skin) return _PROC_MOUTH;
    if (!_mouthCache[skin]) {
      const t = ModelLoader.clone(skin);
      t.updateMatrixWorld(true);
      _mouthCache[skin] = new THREE.Vector3(...ROACH_ACID.mouth).applyMatrix4(t.getObjectByProperty('isMesh', true).matrixWorld);
    }
    return _mouthCache[skin];
  }
  function roachAttack(e, dt, ex, ez) {
    e.mesh.rotation.y = Math.atan2(-ex, -ez);
    e.mesh.rotation.z = 0; e.mesh.position.y = 0;
    const A = ROACH_ACID, t0 = e.atkT, spit = A.spit / ANIM_SPEED;
    e.atkT += dt;
    if (t0 < spit && e.atkT >= spit) spitAcid(e);
    if (e.atkT >= A.cooldown) e.atkT -= A.cooldown;
    // the 1 s animation (played ANIM_SPEED× faster), then hold its last frame until the next spit
    if (e.attack) e.pool = e.attack[Math.min(e.attack.length - 1, Math.floor(e.atkT * ANIM_SPEED / A.anim * e.attack.length))];
    else if (!e.model) e.mesh.position.y = Math.abs(Math.sin(e.leg)) * .07;
  }
  function spitAcid(e) {
    e.mesh.updateMatrix();
    const p = e.mouth.clone().applyMatrix4(e.mesh.matrix);
    const ex = e.mesh.position.x, ez = e.mesh.position.z, d = Math.hypot(ex, ez) || 1;
    const tx = ex / d * 1.35, tz = ez / d * 1.35, ty = .5 + Math.random() * .4;   // the hull facing the Roach
    const T = ROACH_ACID.flight, g = ROACH_ACID.gravity;
    acids.push({ p, t: 0, dmg: e.dmg * ROACH_ACID.cooldown,
                 v: new THREE.Vector3((tx - p.x) / T, (ty - p.y) / T + .5 * g * T, (tz - p.z) / T) });
    for (let i = 0; i < 4; i++) emitParticle(_glow, p.x, p.y, p.z, (Math.random() - .5) * 2, Math.random() * 1.5, (Math.random() - .5) * 2, .25, .22, .05, .9, 0xc8ff50, 0x3a9a12, 4, 1, 0);
    SFX.play('spit');
  }
  function updateAcids(dt) {
    const g = ROACH_ACID.gravity, arm = 1 / (1 + armorLvl * .35);
    acids = acids.filter(a => {
      a.t += dt; a.v.y -= g * dt; a.p.addScaledVector(a.v, dt);
      if (Math.random() < .75)                                   // dripping trail
        emitParticle(_glow, a.p.x, a.p.y, a.p.z, (Math.random() - .5) * .6, (Math.random() - .5) * .6, (Math.random() - .5) * .6, .3, .26, .05, .85, 0xb8ff40, 0x2c8a10, 2, 0, 0);
      if (a.t < ROACH_ACID.flight) return true;
      bunkerHp = Math.max(0, bunkerHp - a.dmg * arm);
      _waveHurt = true;
      for (let i = 0; i < 9; i++)                                // splash + a puff of corrosive smoke
        emitParticle(_glow, a.p.x, a.p.y, a.p.z, (Math.random() - .5) * 5, Math.random() * 4 + 1, (Math.random() - .5) * 5, .45 + Math.random() * .25, .24, .06, 1, 0xc8ff50, 0x3a9a12, 18, .8, 0);
      emitParticle(_smoke, a.p.x, a.p.y, a.p.z, 0, .8, 0, 1.0, .5, 1.3, .45, 0x6a8a3a, 0x3a4a2a, -.2, .5, 1);
      SFX.play('acid');
      if (_dmgFlashCD <= 0) { flash('dmg-flash'); _dmgFlashCD = .6; }
      return false;
    });
    syncAcids();
  }
  function syncAcids() {
    let n = 0;
    for (const a of acids) {
      if (n >= ACID_CAP) break;
      const w = 1 + Math.sin(a.t * 40 + n) * .15;              // wobbling glob
      _acidM4.compose(a.p, _acidQ, _acidScale.set(w, 2 - w, w));
      _acidM4.toArray(_acidIM.instanceMatrix.array, n++ * 16);
    }
    _acidIM.count = n; _acidIM.instanceMatrix.needsUpdate = true;
  }

  // ── Instanced bullets ────────────────────────────────────────────────────
  // Every round in flight is one instance of a single tracer mesh (1 draw call
  // total; each bullet used to be its own mesh + draw call). A bullet keeps a
  // plain position vector; syncBullets() writes the instance matrices.
  const BULLET_CAP = 512;
  const _bulletIM = new THREE.InstancedMesh(
    new THREE.BoxGeometry(.07, .07, .5),          // tracer streak, long axis = flight direction
    new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }), BULLET_CAP);   // a tracer burns: it shows out in the dark
  _bulletIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _bulletIM.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(BULLET_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
  _bulletIM.frustumCulled = false; // instances spread far from the mesh origin
  _bulletIM.count = 0;
  scene.add(_bulletIM);
  const _tmpCol = new THREE.Color(), _white = new THREE.Color(0xffffff);
  // Soft round glow (white, its alpha falling to 0 at the rim; quads stretch it into
  // streaks): the tracer halos and the radar ring's profile across its band
  const _glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    for (let i = 0; i <= 8; i++) { const k = 1 - i / 8; gr.addColorStop(i / 8, `rgba(255,255,255,${(k * k).toFixed(3)})`); }
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const _glowMat = () => new THREE.MeshBasicMaterial({ map: _glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  // Tracer halos: a flat soft quad along each round (a little by day, strong at night),
  // and at night a faint pool of light on the ground beneath it
  const _haloGeo = new THREE.PlaneGeometry(.5, 1.6).rotateX(-Math.PI / 2);   // long axis = flight direction
  function _glowIM(renderOrder) {
    const im = new THREE.InstancedMesh(_haloGeo, _glowMat(), BULLET_CAP);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(BULLET_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false; im.count = 0; im.renderOrder = renderOrder;
    scene.add(im);
    return im;
  }
  const _haloIM = _glowIM(2), _poolIM = _glowIM(1);
  // R = Ry(yaw)·Rx(pitch) + translation, column-major (local +Z → flight direction);
  // L stretches the round along its flight axis
  function _writeBulletMatrix(m, o, b, L) {
    const sy = b.sin, cy = b.cos, sp = b.sinP, cp = b.cosP, p = b.mesh.position;
    m[o] = cy;        m[o+1] = 0;     m[o+2] = -sy;      m[o+3] = 0;
    m[o+4] = sy*sp;   m[o+5] = cp;    m[o+6] = cy*sp;    m[o+7] = 0;
    m[o+8] = sy*cp*L; m[o+9] = -sp*L; m[o+10] = cy*cp*L; m[o+11] = 0;
    m[o+12] = p.x;    m[o+13] = p.y;  m[o+14] = p.z;     m[o+15] = 1;
  }
  // Marauder rounds (punisher grenades) are drawn as the Viking's missiles are (syncMissiles)
  function syncBullets() {
    const m = _bulletIM.instanceMatrix.array, c = _bulletIM.instanceColor.array;
    const H = _haloIM.instanceMatrix.array, HC = _haloIM.instanceColor.array, P = _poolIM.instanceMatrix.array, PC = _poolIM.instanceColor.array;
    const night = _dnFactor;
    let n = 0, nh = 0;
    for (const b of bullets) {
      if (!b.alive || b.unitType === 'marauder') continue;
      if (nh < BULLET_CAP) {   // halo along the round; pool flat on the ground under it
        const o = nh * 16, p = b.mesh.position;
        _writeBulletMatrix(H, o, b, 1);
        const fl = Math.hypot(H[o + 8], H[o + 10]) || 1, ux = H[o + 8] / fl, uz = H[o + 10] / fl;
        P[o] = -uz * 2.4; P[o+1] = 0; P[o+2] = ux * 2.4; P[o+3] = 0;
        P[o+4] = 0;       P[o+5] = 1; P[o+6] = 0;        P[o+7] = 0;
        P[o+8] = ux * 1.6; P[o+9] = 0; P[o+10] = uz * 1.6; P[o+11] = 0;
        P[o+12] = p.x;    P[o+13] = .03; P[o+14] = p.z;  P[o+15] = 1;
        _tmpCol.setHex(b.color); _tmpCol.toArray(HC, nh * 3); _tmpCol.toArray(PC, nh * 3);
        nh++;
      }
      if (n >= BULLET_CAP) continue;
      _writeBulletMatrix(m, n * 16, b, b.len || 1);
      _tmpCol.setHex(b.color).lerp(_white, .35 * night); _tmpCol.toArray(c, n * 3);   // white-hot at night
      n++;
    }
    _bulletIM.count = n;
    _bulletIM.instanceMatrix.needsUpdate = true;
    _bulletIM.instanceColor.needsUpdate = true;
    _haloIM.material.opacity = .25 + .65 * night;
    _poolIM.material.opacity = .3 * night;
    _haloIM.count = nh; _poolIM.count = night > .01 ? nh : 0;
    for (const im of [_haloIM, _poolIM]) { im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; }
  }

  // ── Firing ports & muzzle flashes ───────────────────────────────────────
  // Units fire through the embrasure band of the bunker wall facing their
  // target. A port is where a horizontal ray at that height, cast from outside
  // toward the bunker's axis, meets the visible hull (cached per 5° bearing;
  // cleared when the hull changes shape, e.g. when the Neosteel frame appears).
  const PORT_Y = 0.62;                       // embrasure height on the SC2 bunker model
  const _portCache = new Map(), _portRC = new THREE.Raycaster(), _pv1 = new THREE.Vector3(), _pv2 = new THREE.Vector3();
  function _shownInScene(o) { for (; o; o = o.parent) if (!o.visible) return false; return true; }
  function bunkerPort(bearing) {             // bearing = atan2(z, x) of the firing direction
    const k = Math.round(bearing / (Math.PI / 36));
    let p = _portCache.get(k);
    if (!p) {
      const a = k * Math.PI / 36, cx = Math.cos(a), cz = Math.sin(a);
      p = new THREE.Vector3(cx * 1.45, PORT_Y, cz * 1.45);    // fallback: procedural bunker / no hit
      if (bunkerGroup) {
        bunkerGroup.updateMatrixWorld(true);
        _portRC.set(_pv1.set(cx * 5, PORT_Y, cz * 5), _pv2.set(-cx, 0, -cz));
        const hit = _portRC.intersectObject(bunkerGroup, true).find(h => _shownInScene(h.object));
        if (hit) p.set(hit.point.x + cx * 0.06, PORT_Y, hit.point.z + cz * 0.06); // just outside the wall
      }
      _portCache.set(k, p);
    }
    return p;
  }
  // Muzzle flash at (x, y, z) firing along the unit vector (dx, dz): hot core,
  // a short flame tongue pointing at the target, sparks sprayed forward, a
  // wisp of smoke, and a brief light flash on the hull.
  function muzzleFlash(x, y, z, dx, dz, col, big) {
    const k = big ? 1.35 : 1, R = Math.random;
    emitParticle(_glow, x, y, z, dx * 1.5, .2, dz * 1.5, .05, .55 * k, .25 * k, 1, 0xffffff, 0xffe08a, 0, 0, 0);          // core
    for (let i = 1; i <= 3; i++)                                                                                       // flame tongue
      emitParticle(_glow, x + dx * .12 * i * k, y, z + dz * .12 * i * k, dx * 4, .1, dz * 4,
        .045 + i * .005, (.42 - i * .08) * k, .05, .9, 0xfff0c0, col, 0, 6, 0);
    for (let i = 0; i < 5; i++) {                                                                                      // sparks
      const a = (R() - .5) * .9, c = Math.cos(a), sn = Math.sin(a), sp = 5 + R() * 6;
      emitParticle(_glow, x, y, z, (dx * c - dz * sn) * sp, R() * 2.5, (dz * c + dx * sn) * sp,
        .15 + R() * .15, .09, .03, 1, 0xffe9a0, 0xff7a20, 9, 1.5, 0);
    }
    emitParticle(_smoke, x + dx * .2, y + .05, z + dz * .2, dx * .6, .5, dz * .6,                                   // smoke wisp
      .5 + R() * .3, .18 * k, .55 * k, .22, 0x6a6a6a, 0x9a9a9a, -.3, 1.2, 1);
    // the gun's light on the ground: low and a little out in front of the port (the Shrike's off its roof: higher, further
    // out), each shot a little stronger or weaker and off to one side so sustained fire flickers; a volley's shots mix
    if (_gunLight) {
      const roof = y > 1.2, out = (roof ? 1.1 : .7) + (R() - .5) * .2, side = (R() - .5) * .3, w = (big ? 3.4 : 2.6) * (.7 + .6 * R());
      const gx = x + dx * out - dz * side, gy = roof ? 1.3 : .75, gz = z + dz * out + dx * side, p = _gunLight.position;
      if (_gunI > .05) p.set((p.x * _gunI + gx * w) / (_gunI + w), (p.y * _gunI + gy * w) / (_gunI + w), (p.z * _gunI + gz * w) / (_gunI + w)); else p.set(gx, gy, gz);
      _gunI = Math.min(4.5, Math.max(_gunI, w) + .15 * Math.min(_gunI, w));
    }
    if (_muzzleLight) { _muzzleLight.position.set(x + dx * .3, y + .1, z + dz * .3); _muzzleLight.intensity = Math.max(_muzzleLight.intensity, big ? 3.2 : 2.2); }
  }

  // ── GPU particle system ──────────────────────────────────────────────────
  // Sparks, debris, flames, embers and smoke all live in two THREE.Points
  // buffers — additive glow and normal-blended smoke — so they cost 2 draw
  // calls in total (each particle used to be its own Mesh and draw call).
  // Particles are soft round sprites with per-particle size/colour/alpha.
  const _partScale = { value: 400 }; // px per world unit at depth 1 (set in resize)
  const PARTICLE_VS = `
    attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
    uniform float uScale;
    varying float vAlpha; varying vec3 vColor; varying vec2 vFogXZ;
    void main() {
      vAlpha = aAlpha; vColor = aColor;
      vFogXZ = ( modelMatrix * vec4( position, 1.0 ) ).xz;   // radial, like the scene fog
      vec4 mv = modelViewMatrix * vec4( position, 1.0 );
      gl_PointSize = aSize * uScale / -mv.z;
      gl_Position = projectionMatrix * mv;
    }`;
  const PARTICLE_FS = `
    varying float vAlpha; varying vec3 vColor; varying vec2 vFogXZ;
    #ifdef USE_FOG
      uniform float fogNear; uniform float fogFar;
      uniform vec4 glowPos[ 8 ]; uniform vec4 glowCol[ 8 ]; uniform int glowCount;   // small lights (radial-fog.js)
    #endif
    void main() {
      float d = length( gl_PointCoord - 0.5 ) * 2.0;
      float a = vAlpha * ( 1.0 - smoothstep( 0.15, 1.0, d ) ); // soft round sprite
      #ifdef USE_FOG
        float lift = 0.0;                                     // fade out in the night fog, except near a small light
        for ( int i = 0; i < 8; i ++ ) {
          if ( i >= glowCount ) break;
          float gr = glowPos[ i ].w;
          lift = max( lift, glowCol[ i ].a * ( 1.0 - smoothstep( 0.35 * gr, gr, length( vFogXZ - glowPos[ i ].xz ) ) ) );
        }
        a *= 1.0 - smoothstep( fogNear, fogFar, length( vFogXZ ) ) * ( 1.0 - lift );
      #endif
      if ( a < 0.004 ) discard;
      gl_FragColor = vec4( vColor, a );
    }`;
  function makeParticleSystem(cap, blending) {
    const sys = {
      cap, n: 0,
      pos: new Float32Array(cap * 3), col: new Float32Array(cap * 3), size: new Float32Array(cap), alpha: new Float32Array(cap),
      vel: new Float32Array(cap * 3), life: new Float32Array(cap), maxLife: new Float32Array(cap),
      grav: new Float32Array(cap), drag: new Float32Array(cap), s0: new Float32Array(cap), s1: new Float32Array(cap),
      a0: new Float32Array(cap), c0: new Float32Array(cap * 3), c1: new Float32Array(cap * 3), fade: new Uint8Array(cap),
    };
    const geo = new THREE.BufferGeometry();
    const attr = (arr, k) => new THREE.BufferAttribute(arr, k).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr(sys.pos, 3));
    geo.setAttribute('aColor', attr(sys.col, 3));
    geo.setAttribute('aSize', attr(sys.size, 1));
    geo.setAttribute('aAlpha', attr(sys.alpha, 1));
    geo.setDrawRange(0, 0);
    // fog uniforms are refreshed by the renderer (fog:true); uScale stays the shared object resize() updates
    const mat = new THREE.ShaderMaterial({ uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog), { uScale: _partScale }),
      vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS, transparent: true, depthWrite: false, blending, fog: true });
    sys.points = new THREE.Points(geo, mat);
    sys.points.frustumCulled = false;
    sys.points.renderOrder = blending === THREE.AdditiveBlending ? 3 : 2; // glow over smoke
    scene.add(sys.points);
    return sys;
  }
  const _glow  = makeParticleSystem(3000, THREE.AdditiveBlending); // sparks, debris, flames, embers
  const _smoke = makeParticleSystem(800,  THREE.NormalBlending);   // smoke
  // fade: 0 = linear fade-out, 1 = fade in then out (smoke)
  function emitParticle(sys, x, y, z, vx, vy, vz, life, s0, s1, a0, c0, c1, grav, drag, fade) {
    if (sys.n >= sys.cap) return;
    const i = sys.n++, i3 = i * 3;
    sys.pos[i3] = x; sys.pos[i3+1] = y; sys.pos[i3+2] = z;
    sys.vel[i3] = vx; sys.vel[i3+1] = vy; sys.vel[i3+2] = vz;
    sys.life[i] = sys.maxLife[i] = life;
    sys.s0[i] = s0; sys.s1[i] = s1; sys.a0[i] = a0; sys.grav[i] = grav; sys.drag[i] = drag; sys.fade[i] = fade;
    sys.c0[i3] = (c0 >> 16 & 255) / 255; sys.c0[i3+1] = (c0 >> 8 & 255) / 255; sys.c0[i3+2] = (c0 & 255) / 255;
    sys.c1[i3] = (c1 >> 16 & 255) / 255; sys.c1[i3+1] = (c1 >> 8 & 255) / 255; sys.c1[i3+2] = (c1 & 255) / 255;
  }
  function updateParticles(sys, dt) {
    let i = 0;
    while (i < sys.n) {
      sys.life[i] -= dt;
      if (sys.life[i] <= 0) { _copyParticle(sys, sys.n - 1, i); sys.n--; continue; } // swap-remove keeps the buffer packed
      const i3 = i * 3, t = 1 - sys.life[i] / sys.maxLife[i], k = Math.max(0, 1 - sys.drag[i] * dt);
      sys.vel[i3] *= k; sys.vel[i3+2] *= k; sys.vel[i3+1] = sys.vel[i3+1] * k - sys.grav[i] * dt;
      sys.pos[i3] += sys.vel[i3] * dt; sys.pos[i3+1] += sys.vel[i3+1] * dt; sys.pos[i3+2] += sys.vel[i3+2] * dt;
      sys.size[i] = sys.s0[i] + (sys.s1[i] - sys.s0[i]) * t;
      sys.alpha[i] = sys.a0[i] * (sys.fade[i] ? Math.sin(Math.PI * Math.min(1, t * 1.15)) : 1 - t);
      for (let c = 0; c < 3; c++) sys.col[i3+c] = sys.c0[i3+c] + (sys.c1[i3+c] - sys.c0[i3+c]) * t;
      i++;
    }
    const g = sys.points.geometry;
    g.setDrawRange(0, sys.n);
    for (const k of ['position', 'aColor', 'aSize', 'aAlpha']) g.attributes[k].needsUpdate = true;
  }
  function _copyParticle(sys, from, to) {
    if (from === to) return;
    const f3 = from * 3, t3 = to * 3;
    for (const a of [sys.pos, sys.col, sys.vel, sys.c0, sys.c1]) { a[t3] = a[f3]; a[t3+1] = a[f3+1]; a[t3+2] = a[f3+2]; }
    for (const a of [sys.size, sys.alpha, sys.life, sys.maxLife, sys.grav, sys.drag, sys.s0, sys.s1, sys.a0, sys.fade]) a[to] = a[from];
  }
  function clearParticles() { for (const s of [_glow, _smoke]) { s.n = 0; s.points.geometry.setDrawRange(0, 0); } }

  // Burst of glowing sparks/debris (same feel as the old sphere particles:
  // fast outward + upward spray, gravity, ~0.55 s life).
  function spawnParts(pos,col,n=7){
    for(let i=0;i<n;i++){
      emitParticle(_glow, pos.x, pos.y, pos.z,
        (Math.random()-.5)*13, Math.random()*12+3.6, (Math.random()-.5)*13,
        .4+Math.random()*.3, .2, .08, 1, col, col, 54, 0.5, 0);
    }
  }
  function makeCrate(x,z){
    const m=new THREE.Mesh(sharedGeo('crate',()=>new THREE.BoxGeometry(.65,.65,.65)),lamMat(0xaa8800));
    m.position.set(x,.32,z); m.rotation.y=Math.random()*Math.PI; scene.add(m);
    crates.push({mesh:m,x,z});
  }
  const _beamGeo=new THREE.CylinderGeometry(.25,.6,24,8);
  function makeBeam(x,z,col){
    const b=new THREE.Mesh(_beamGeo,new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.8}));
    b.position.set(x,12,z); scene.add(b);
    beams.push({mesh:b,life:.5});
  }
  // Remove a beam and free its GPU resources (shared geometry is kept)
  function _removeBeam(b){
    scene.remove(b.mesh);
    if(b.mesh.geometry!==_beamGeo && b.mesh.geometry!==_ringGeo) b.mesh.geometry.dispose();
    b.mesh.material.dispose();
  }
  // Unit ring used (scaled) by nuke shockwave/warning — replaces the old
  // "dispose + rebuild RingGeometry every frame" pattern.
  const _ringGeo=new THREE.RingGeometry(0.95,1,32);

  // ── Viking airstrike ─────────────────────────────────────────────────────
  let vikingMesh = null;
  let vikingActive = false;

  function _proceduralVikingMesh() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.25, 1.6), new THREE.MeshLambertMaterial({color: 0x8899aa}));
    g.add(body);
    const wingL = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.1, 0.7), new THREE.MeshLambertMaterial({color: 0x7788aa}));
    wingL.position.set(0, 0, -0.2); g.add(wingL);
    const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), new THREE.MeshLambertMaterial({color: 0x334455}));
    cockpit.position.set(0, 0.18, 0.55); g.add(cockpit);
    [-0.9, 0.9].forEach(ex => {
      const eng = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 0.5, 7), new THREE.MeshLambertMaterial({color: 0x556677}));
      eng.rotation.x = Math.PI / 2; eng.position.set(ex, -0.05, -0.4); g.add(eng);
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 4), new THREE.MeshBasicMaterial({color: 0x4488ff}));
      glow.position.set(ex, -0.05, -0.66); g.add(glow);
    });
    const finV = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.4, 0.45), new THREE.MeshLambertMaterial({color: 0x778899}));
    finV.position.set(0, 0.2, -0.7); g.add(finV);
    return g;
  }
  function makeVikingMesh() {
    return ModelLoader.clone('viking', _proceduralVikingMesh);
  }

  // ── Viking missiles ──────────────────────────────────────────────────────
  // One air-to-ground missile per target, from the muzzle of one of the Viking's
  // two launcher tubes in turn: it runs ahead, then dives on its target along a
  // quadratic curve (p0 → p1 → target), homing on the lead enemy while it lives,
  // with an exhaust flame, a light streak and a smoke trail; strikes as the bombs did.
  const VM_FLIGHT = 0.6, VM_RUN = 4;                 // s from the tube to the target; run ahead before the dive
  const VM_LEN = 0.13, VM_TAIL = 0.5 * VM_LEN;       // its length; centre → nozzle
  const VM_STREAK = 0.25;                            // the light streak covers the last this-many seconds of the path
  // a Marauder's grenade is drawn as this missile, a little larger, with its flame and a shorter streak
  // (it is faster); its blast on the ground lasts MG_BLAST_DUR s
  const MG_LEN = 0.16, MG_STREAK = 0.12, MG_BLAST_DUR = 0.55;
  // A grenade in flight is a small weak light (reach MG_LIGHT_R) that lifts the night around it, so the
  // Zerg it passes show in the dark; its burst lights the blast for MG_BURST_LIGHT s, fading
  const MG_LIGHT_R = 2.4, MG_LIGHT_I = 0.9, MG_BURST_LIGHT = 0.35;
  // the SC2 model's launchers: the two long tubes either side of the nose, muzzles at
  // (±0.2, 0.09, 0.91) in its normalised space (+z = nose); the procedural stand-in uses the same points
  const VM_MUZZLE = [0.2, 0.09, 0.91];
  let vMissiles = [], _vmSide = 1;
  // Unit-length missile on +z (nozzle at z = -0.5): body, nose cone, four tail fins, merged
  function _mergeGeos(geos) {
    const parts = geos.map(g => g.index ? g.toNonIndexed() : g);
    const n = parts.reduce((s, g) => s + g.attributes.position.count, 0), pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
    let o = 0;
    for (const g of parts) { pos.set(g.attributes.position.array, o); nrm.set(g.attributes.normal.array, o); o += g.attributes.position.array.length; }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    return out;
  }
  const _vmGeo = (() => {
    const zAxis = new THREE.Matrix4().makeRotationX(Math.PI / 2);   // cylinder / cone axis y → +z
    const body = new THREE.CylinderGeometry(.09, .09, .72, 10).applyMatrix4(zAxis).translate(0, 0, -.14);
    const nose = new THREE.ConeGeometry(.09, .28, 10).applyMatrix4(zAxis).translate(0, 0, .36);
    const fins = [0, 1, 2, 3].map(k => {
      const a = k * Math.PI / 2;
      return new THREE.BoxGeometry(.02, .14, .2).rotateZ(a - Math.PI / 2).translate(Math.cos(a) * .15, Math.sin(a) * .15, -.38);
    });
    return _mergeGeos([body, nose, ...fins]);
  })();
  const VM_CAP = 96, STREAK_CAP = 96 * 24;   // Viking missiles and Marauder grenades
  function _vmIM(geo, mat, cap, renderOrder) {
    const im = new THREE.InstancedMesh(geo, mat, cap);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false; im.count = 0; im.renderOrder = renderOrder;
    scene.add(im);
    return im;
  }
  const _vmFlameMat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const _vmBodyIM = _vmIM(_vmGeo, new THREE.MeshStandardMaterial({ color: 0xc4c9d0, metalness: .5, roughness: .4 }), VM_CAP, 0);
  _vmBodyIM.castShadow = true;
  const _vmFlameGeo = new THREE.CylinderGeometry(0.25, 1, 1, 10);   // unit height on y, wide end (r 1) at y = -0.5
  const _vmFlameGlowIM = _vmIM(_vmFlameGeo, _vmFlameMat(0xff6a1a, .55), VM_CAP, 2);
  const _vmFlameCoreIM = _vmIM(_vmFlameGeo, _vmFlameMat(0xfff2d0, .95), VM_CAP, 3);
  const _streakGeo = new THREE.CylinderGeometry(1, 1, 1, 6);
  const _streakGlowIM = _vmIM(_streakGeo, _vmFlameMat(0xff8a3a, .55), STREAK_CAP, 2);
  const _streakCoreIM = _vmIM(_streakGeo, _vmFlameMat(0xfff0c0, .95), STREAK_CAP, 3);
  // a concussive shell's flame and streak burn icy blue (as StarCraft II draws it)
  const _mgFlameGlowIM = _vmIM(_vmFlameGeo, _vmFlameMat(0x2f8cff, .55), VM_CAP, 2);
  const _mgFlameCoreIM = _vmIM(_vmFlameGeo, _vmFlameMat(0xdff2ff, .95), VM_CAP, 3);
  const _mgStreakGlowIM = _vmIM(_streakGeo, _vmFlameMat(0x2f8cff, .55), STREAK_CAP, 2);
  const _mgStreakCoreIM = _vmIM(_streakGeo, _vmFlameMat(0xdff2ff, .95), STREAK_CAP, 3);
  for (const im of [_streakGlowIM, _streakCoreIM, _mgStreakGlowIM, _mgStreakCoreIM])
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(STREAK_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);

  function fireVikingMissile(tgt) {
    if (!vikingMesh) return;
    _vmSide = -_vmSide;
    const p0 = new THREE.Vector3(VM_MUZZLE[0] * _vmSide, VM_MUZZLE[1], VM_MUZZLE[2]).applyEuler(vikingMesh.rotation).add(vikingMesh.position);
    vMissiles.push({ p0, p1: p0.clone().add(new THREE.Vector3(VM_RUN, -0.5, 0)), p: p0.clone(), dir: new THREE.Vector3(1, 0, 0),
      tx: tgt.x, tz: tgt.z, e: tgt.e, t: 0, trail: [] });
    for (let i = 0; i < 6; i++)   // ignition
      emitParticle(_glow, p0.x, p0.y, p0.z, -2 - Math.random() * 3, (Math.random() - .5) * 1.5, (Math.random() - .5) * 1.5, .18, .35, .1, .95, 0xffd080, 0xff5010, 0, 2, 0);
    SFX.play('rocket');
  }
  const _vmP2 = new THREE.Vector3(), _vmD = new THREE.Vector3(), _vmTail = new THREE.Vector3();
  function updateVikingMissiles(dt) {
    for (let i = 0; i < vMissiles.length;) {
      const m = vMissiles[i];
      if (m.e && !m.e.dead) { m.tx = m.e.mesh.position.x; m.tz = m.e.mesh.position.z; }
      const prevTail = m.p.clone().addScaledVector(m.dir, -VM_TAIL);
      m.t = Math.min(1, m.t + dt / VM_FLIGHT);
      const u = m.t * (0.6 + 0.4 * m.t), a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u;   // speeds up through the dive
      _vmP2.set(m.tx, 0.15, m.tz);
      m.p.set(a * m.p0.x + b * m.p1.x + c * _vmP2.x, a * m.p0.y + b * m.p1.y + c * _vmP2.y, a * m.p0.z + b * m.p1.z + c * _vmP2.z);
      _vmD.subVectors(m.p1, m.p0).multiplyScalar(1 - u).addScaledVector(_vmP2.clone().sub(m.p1), u);
      if (_vmD.lengthSq() > 1e-8) m.dir.copy(_vmD).normalize();
      // smoke trail: a puff every ~0.12 along this frame's path, and a few embers
      const tail = _vmTail.copy(m.p).addScaledVector(m.dir, -VM_TAIL);
      m.trail.push([tail.x, tail.y, tail.z, _gameT]);   // the light streak
      while (m.trail.length > 2 && _gameT - m.trail[0][3] > VM_STREAK) m.trail.shift();
      const n = Math.max(1, Math.min(16, Math.ceil(tail.distanceTo(prevTail) / 0.12)));
      for (let k = 1; k <= n; k++) {
        const f = k / n, R = Math.random;
        emitParticle(_smoke, prevTail.x + (tail.x - prevTail.x) * f, prevTail.y + (tail.y - prevTail.y) * f, prevTail.z + (tail.z - prevTail.z) * f,
          (R() - .5) * .2, .2, (R() - .5) * .2, .8, .07, .4, .4, 0xb0aaa0, 0x605c56, -.1, .8, 1);
      }
      if (Math.random() < .5)
        emitParticle(_glow, tail.x, tail.y, tail.z, -m.dir.x * 2 + Math.random() - .5, -m.dir.y * 2 + Math.random() - .5, -m.dir.z * 2 + Math.random() - .5, .2, .05, .015, .9, 0xffd080, 0xc02000, 2, 1, 0);
      if (m.t < 1) { i++; continue; }
      vMissiles.splice(i, 1);
      strikeAt(m.tx, m.tz, 0xff8800, 4.5);
    }
  }
  const _vmM = new THREE.Matrix4(), _vmX = new THREE.Vector3(), _vmY = new THREE.Vector3(), _vmZ = new THREE.Vector3(), _vmUp = new THREE.Vector3(0, 1, 0);
  const _mgDir = new THREE.Vector3();
  // Missiles (Viking and Marauder), on their own axes (z along the flight), with the rocket's exhaust
  // flame from the nozzle and a light streak along the recent path; all scale with the missile's length.
  // Orange, or icy blue for a concussive shell
  const _fire = [
    { fg: _vmFlameGlowIM, fc: _vmFlameCoreIM, sg: _streakGlowIM, sc: _streakCoreIM, nf: 0, ns: 0 },
    { fg: _mgFlameGlowIM, fc: _mgFlameCoreIM, sg: _mgStreakGlowIM, sc: _mgStreakCoreIM, nf: 0, ns: 0 },
  ];
  function syncMissiles() {
    let n = 0;
    for (const F of _fire) F.nf = F.ns = 0;
    const put = (p, dir, len, trail, streakDur, F) => {
      if (n >= VM_CAP) return;
      const sk = len / VM_LEN;
      const side = Math.abs(dir.y) < .99 ? _vmX.crossVectors(_vmUp, dir).normalize() : _vmX.set(1, 0, 0);
      const up = _vmY.crossVectors(dir, side);
      _vmM.makeBasis(_vmZ.copy(side).multiplyScalar(len), up.clone().multiplyScalar(len), dir.clone().multiplyScalar(len)).setPosition(p);
      _vmBodyIM.setMatrixAt(n, _vmM);
      const flick = 0.85 + 0.15 * Math.sin(_gameT * 70 + n * 1.7);
      const nozzle = p.clone().addScaledVector(dir, -0.5 * len);
      for (const [im, fl, w] of [[F.fg, .45 * sk * flick, .05 * sk], [F.fc, .25 * sk * flick, .02 * sk]]) {
        _vmM.makeBasis(side.clone().multiplyScalar(w), dir.clone().multiplyScalar(-fl), up.clone().multiplyScalar(w))
          .setPosition(nozzle.clone().addScaledVector(dir, -fl / 2));
        im.setMatrixAt(F.nf, _vmM);
      }
      F.nf++;
      // the light streak: thin cylinders, dimming and narrowing with age
      for (let k = 0; k + 1 < trail.length && F.ns < STREAK_CAP; k++) {
        const A = trail[k], B = trail[k + 1];
        const d = new THREE.Vector3(B[0] - A[0], B[1] - A[1], B[2] - A[2]), L = d.length();
        if (L < 1e-4) continue;
        const kk = Math.max(0, Math.min(1, 1 - (_gameT - B[3]) / streakDur));
        const s = Math.abs(d.y) < .99 * L ? new THREE.Vector3().crossVectors(d, _vmUp).normalize() : new THREE.Vector3(1, 0, 0);
        const u = new THREE.Vector3().crossVectors(s, d).normalize();
        const mid = new THREE.Vector3((A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2);
        for (const [im, w] of [[F.sg, .04 * sk * (.4 + .6 * kk)], [F.sc, .014 * sk]]) {
          _vmM.makeBasis(s.clone().multiplyScalar(w), d, u.clone().multiplyScalar(w)).setPosition(mid);
          im.setMatrixAt(F.ns, _vmM);
          _tmpCol.setRGB(kk, kk, kk); im.setColorAt(F.ns, _tmpCol);
        }
        F.ns++;
      }
      n++;
    };
    for (const v of vMissiles) put(v.p, v.dir, VM_LEN, v.trail, VM_STREAK, _fire[0]);
    for (const b of bullets)
      if (b.alive && b.unitType === 'marauder') put(b.mesh.position, _mgDir.set(b.vx, b.vy, b.vz).normalize(), MG_LEN, b.trail, MG_STREAK, _fire[concussiveUnlocked ? 1 : 0]);
    _vmBodyIM.count = n; _vmBodyIM.instanceMatrix.needsUpdate = true;
    for (const F of _fire) {
      for (const im of [F.fg, F.fc]) { im.count = F.nf; im.instanceMatrix.needsUpdate = true; }
      for (const im of [F.sg, F.sc]) { im.count = F.ns; im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; }
    }
  }

  // ── Marauder grenade blasts ───────────────────────────────────────────────
  // A punisher grenade bursts at `at`: the enemy it struck (if any) already took the round's damage;
  // everyone else within the blast radius takes MG_SPLASH of it (double vs Armored, as the round),
  // and all of them, struck one too, are slowed (harder with Concussive Shells). Drawn: a ball of
  // light with a few sparks, over a soft glow on the ground (syncBlasts)
  let mBlasts = [];
  const MG_HEART = [0xfff0c0, 0xe8f6ff], MG_GLOW = [0xffa040, 0x5cb0ff], MG_DEEP = [0xc03000, 0x1a50e0];   // warm, concussive blue
  function marauderBlast(at, struck, dmg0, enemies) {
    const def = UNIT_DEF.marauder, R = MG_RADIUS[concussiveLvl], sl = concussiveUnlocked ? 1 : 0, killed = [];
    for (const o of enemies) {
      if (o.dead) continue;
      const q = o.mesh.position, dx = q.x - at.x, dz = q.z - at.z;
      if (o !== struck && dx * dx + dz * dz > R * R) continue;
      slowedEnemies.set(o.mesh.uuid, { until: _gameT + MG_SLOW_DUR[sl], factor: MG_SLOW[sl] });
      if (o === struck) continue;
      const bonus = def.bonusVs.some(t => (o.attrs || []).includes(t)) ? def.bonusMult : 1;
      o.hp -= dmg0 * def.dmgMult * bonus * MG_SPLASH;
      o.flash = 0.08;
      if (o.hp <= 0) killed.push(o);
    }
    if (mBlasts.length >= BLAST_CAP) mBlasts.shift();
    mBlasts.push({ x: at.x, z: at.z, r: R, t: 0, blue: sl === 1 });
    // the burst: a small ball of light, white-hot at the heart in a wider soft glow, shrinking as it
    // fades, and a few sparks — icy blue for a concussive shell (as StarCraft II draws it), else warm
    emitParticle(_glow, at.x, .4, at.z, 0, .3, 0, .26, .85, .3, 1, MG_HEART[sl], MG_GLOW[sl], 0, 0, 0);
    emitParticle(_glow, at.x, .4, at.z, 0, .2, 0, .34, 1.7, .7, .45, MG_GLOW[sl], MG_DEEP[sl], 0, 0, 0);
    const rnd = Math.random;
    for (let i = 0; i < 6; i++) {
      const a = rnd() * Math.PI * 2, v = 1.4 + rnd() * 1.4;
      emitParticle(_glow, at.x, .4, at.z, Math.cos(a) * v, .8 + rnd() * .8, Math.sin(a) * v, .2 + rnd() * .12, .12, .04, .9, MG_HEART[sl], MG_GLOW[sl], 3, 2, 0);
    }
    SFX.play('mblast');
    for (const o of killed) killEnemy(o, true);
    achMultiKill('grenade', killed.length + (struck && !struck.dead && struck.hp <= 0 ? 1 : 0));   // + the one it hit
  }
  // Its light on the ground: a soft glow over the blast radius with no edge, swelling out in the
  // first moment and dying away
  const BLAST_CAP = 48;
  const _blastWashTex = (() => {   // an even soft disk that dies away to nothing, no rim
    const N = 64, c = document.createElement('canvas'); c.width = c.height = N;
    const g = c.getContext('2d'), img = g.createImageData(N, N);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const x = (i + .5) / N * 2 - 1, y = (j + .5) / N * 2 - 1, r = Math.hypot(x, y), o = (j * N + i) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
        img.data[o + 3] = Math.round(255 * (1 - THREE.MathUtils.smoothstep(r, .25, 1)));
      }
    g.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(c);
  })();
  const _blastWashIM = (() => {
    const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), Object.assign(_glowMat(), { map: _blastWashTex }), BLAST_CAP);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(BLAST_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false; im.count = 0; im.renderOrder = 1;
    scene.add(im);
    return im;
  })();
  function syncBlasts(dt) {   // game time: frozen while paused
    for (const bl of mBlasts) bl.t += dt;
    mBlasts = mBlasts.filter(bl => bl.t < MG_BLAST_DUR);
    mBlasts.forEach((bl, i) => {
      const k = bl.t / MG_BLAST_DUR, r = bl.r * (.5 + .5 * THREE.MathUtils.smoothstep(k, 0, .2)), fade = (1 - k) * (1 - k);
      _vmM.makeScale(2.3 * r, 1, 2.3 * r).setPosition(bl.x, .04, bl.z);
      _blastWashIM.setMatrixAt(i, _vmM);
      _blastWashIM.setColorAt(i, _tmpCol.setHex(bl.blue ? 0x2f7cff : 0xff7a2a).multiplyScalar(.5 * fade));
    });
    _blastWashIM.count = mBlasts.length;
    _blastWashIM.instanceMatrix.needsUpdate = true; _blastWashIM.instanceColor.needsUpdate = true;
  }
  // This frame's small lights (GLOW_LIGHTS, radial-fog.js): the bursts of the last MG_BURST_LIGHT s
  // first (brighter, wider: the blast), then grenades in flight; weak by day, at full strength at night
  function syncGlows() {
    const P = GLOW_LIGHTS.glowPos.value, C = GLOW_LIGHTS.glowCol.value, k = .35 + .65 * _dnFactor;
    let n = 0;
    const add = (x, y, z, hex, i, r, reveal) => {
      if (n >= 8) return;
      _tmpCol.setHex(hex).multiplyScalar(i * k);
      P.set([x, y, z, r], n * 4); C.set([_tmpCol.r, _tmpCol.g, _tmpCol.b, reveal], n * 4);
      n++;
    };
    for (let i = mBlasts.length - 1; i >= 0; i--) {   // newest first
      const bl = mBlasts[i], f = 1 - bl.t / MG_BURST_LIGHT;
      if (f > 0) add(bl.x, .5, bl.z, bl.blue ? 0x4a9cff : 0xff8a3a, 2.2 * f * f, bl.r + 1, f);
    }
    const col = concussiveUnlocked ? 0x4a9cff : 0xff8a3a;
    for (const b of bullets)
      if (b.alive && b.unitType === 'marauder') { const p = b.mesh.position; add(p.x, p.y, p.z, col, MG_LIGHT_I, MG_LIGHT_R, .9); }
    GLOW_LIGHTS.glowCount.value = n;
  }
  // how much the night hides a Zerg there (0 in full light, 1 black): the radial fog as the shader
  // draws it (radial-fog.js), less what a small light lifts
  function _nightDark(x, z) {
    const P = GLOW_LIGHTS.glowPos.value, C = GLOW_LIGHTS.glowCol.value;
    let lift = 0;
    for (let i = 0; i < GLOW_LIGHTS.glowCount.value; i++) {
      const r = P[i * 4 + 3];
      lift = Math.max(lift, C[i * 4 + 3] * (1 - _sstep(.35 * r, r, Math.hypot(x - P[i * 4], z - P[i * 4 + 2]))));
    }
    return _sstep(scene.fog.near, scene.fog.far, Math.hypot(x, z)) * (1 - lift);
  }
  // near enough a small light to show in the dark
  function _glowLit(x, z) {
    const P = GLOW_LIGHTS.glowPos.value, C = GLOW_LIGHTS.glowCol.value;
    for (let i = 0; i < GLOW_LIGHTS.glowCount.value; i++)
      if (C[i * 4 + 3] > .3 && Math.hypot(x - P[i * 4], z - P[i * 4 + 2]) < .8 * P[i * 4 + 3]) return true;
    return false;
  }

  // targets: [{x, z, e}] — e = lead enemy of the cluster (may be undefined)
  function launchViking(targets, cratePos) {
    if (vikingActive) return;
    vikingActive = true;

    vikingMesh = makeVikingMesh();
    // Start far left at mid-Z, high altitude, facing the direction of travel (+X)
    vikingMesh.position.set(-22, 5, 0);
    vikingMesh.rotation.y = Math.PI / 2;
    scene.add(vikingMesh);

    // Viking travels x=-22 → +22 at 14 units/s (~3.1 s). Each missile leaves
    // VM_FLIGHT s before the Viking would pass over its target, so it lands about
    // then, homing on the lead enemy's CURRENT position (enemies keep moving).
    const SPEED = 14, TOTAL_X = 44, START_X = -22;
    targets.forEach(tgt => {
      after(Math.max(0.2, (tgt.x - START_X) / SPEED - VM_FLIGHT), () => fireVikingMissile(tgt));
    });

    // Drop crate near the bunker as the Viking exits (~2.7 s in). The crate is
    // promised from launch on: a wave cleared by these missiles waits for it (resupply)
    awaitCrate(() => setStatus('Ammo restocked! Good hunting, Commander.'));
    after((22 - START_X) / SPEED * 0.85, () => {
      setStatus('Crate deployed! Marine incoming...');
      deliverCrate(cratePos[0], cratePos[1]);
    });

    // Cleanup after the Viking leaves the screen
    after(TOTAL_X / SPEED + 0.4, removeViking);

    // At night the Viking also drops a parachute flare (as in Beach Head). Checked again
    // when it fires: Y switches the cycle off without pausing.
    if (dnEnabled && _dnFactor > 0.5) after(0.6, () => { if (dnEnabled && _dnFactor > 0.5) startFlare(); });
  }

  function removeViking() {
    if (vikingMesh) { scene.remove(vikingMesh); vikingMesh = null; }
    vikingActive = false;
  }

  function updateViking(dt) {
    if (!vikingActive || !vikingMesh) return;
    // Fly left → right
    vikingMesh.position.x += 14 * dt;
    // Slight bob
    vikingMesh.position.y = 5 + Math.sin(_gameT * 4) * 0.15;
    // Tilt slightly in direction of travel
    vikingMesh.rotation.z = -0.05;
  }

  // ── Viking flare ─────────────────────────────────────────────────────────
  // A night airstrike drops a parachute flare that burns FLARE_DUR s of game
  // time. While it burns the lights and fog follow an effective night factor
  // lifted toward FLARE_F (_dnEffFactor; fog far ≈ 21.6 at full flare, so the
  // whole spawn ring shows). It hangs 2.5 units beyond the bunker as the camera
  // saw it on ignition and sinks from 11 to 6.5.
  const FLARE_DUR = 7.5, FLARE_F = 0.62;
  let _flareT = -1;              // seconds burned (game time); -1 = no flare
  let _flareDir = [0, -1];       // ground direction camera → bunker at ignition
  let _flareMesh = null, _flareCore = null, _flareGlow = null;
  const _flareCoreGeo = new THREE.SphereGeometry(0.22, 12, 8), _flareGlowGeo = new THREE.SphereGeometry(0.8, 16, 12);
  function startFlare() {
    if (!_flareMesh) {
      const mat = (color) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
      _flareCore = new THREE.Mesh(_flareCoreGeo, mat(0xfff6d8));
      _flareGlow = new THREE.Mesh(_flareGlowGeo, mat(0xffd9a0));
      _flareMesh = new THREE.Group(); _flareMesh.add(_flareGlow, _flareCore);
      scene.add(_flareMesh);
    }
    const cx = camera.position.x, cz = camera.position.z, l = Math.hypot(cx, cz) || 1;
    _flareDir = [-cx / l, -cz / l];
    _flareT = 0;                 // a flare started while one burns restarts the timer
    _flareMesh.visible = false;
    setStatus('Viking flare — the battlefield is lit!');
  }
  // Flare strength 0-1: fades in over 0.4 s, out over the last 1.5 s
  function _flareK() {
    if (_flareT < 0) return 0;
    return Math.min(1, _flareT / 0.4) * Math.max(0, Math.min(1, (FLARE_DUR - _flareT) / 1.5));
  }
  function updateFlare(dt) {     // live frames only (game time)
    if (_flareT < 0) return;
    _flareT += dt;
    if (_flareT >= FLARE_DUR) _flareT = -1;
    const k = _flareK();
    _flareMesh.visible = k > 0;
    if (k <= 0) return;
    const [dx, dz] = _flareDir, sway = 0.35 * Math.sin(_flareT * 1.3);
    _flareMesh.position.set(dx * 2.5 - dz * sway, 11 - 4.5 * _flareT / FLARE_DUR, dz * 2.5 + dx * sway);
    _flareCore.material.opacity = 0.95 * k;
    _flareGlow.material.opacity = 0.35 * k;
  }
  // Restart / Load / main menu: no flare, lights back at the true night factor
  function clearFlare() {
    _flareT = -1;
    if (_flareMesh) { scene.remove(_flareMesh); _flareCore.material.dispose(); _flareGlow.material.dispose(); _flareMesh = _flareCore = _flareGlow = null; }
    if (_dnLitF !== _dnFactor) { _dnLitF = _dnFactor; _applyDNLights(_dnFactor); }
  }

    // ── Marine movement ──────────────────────────────────────────────────────
  function syncMarines(){
    const count=roster.length;
    while(marines.length<count){
      const idx=marines.length;
      const [ox,oz]=MARINE_SLOTS[idx]??[.3+idx*.4,0];
      marines.push(makeMarine(ox,oz,idx,roster[idx]));
    }
    while(marines.length>count){
      // Remove an idle marine first. A marine out on a crate run carries the
      // resupply callback (ammo refill + next-wave countdown); dropping it
      // used to stall the game forever, so if it must go, finish its job.
      let i=-1;
      for(let k=marines.length-1;k>=0;k--) if(marines[k].state==='bunker'){i=k;break;}
      const m=marines.splice(i>=0?i:marines.length-1,1)[0];
      scene.remove(m.mesh);
      if(m.state!=='bunker'){
        if(m.target) collectCrateAt(m.target.x,m.target.z);
        m.queue.forEach(q=>collectCrateAt(q.x,q.z)); m.queue=[];
        const cb=m.cb; m.cb=null; cb?.();
      }
    }
    // marines[i] stands for roster[i]: a dismissal can shift the types
    marines.forEach((m,i)=>{ if(m.state==='bunker') setUnitModel(m,roster[i],i); });
  }
  function slotsUsed(){return roster.reduce((s,u)=>s+UNIT_DEF[u].slots,0);}
  function slotsLeft(){return 6-slotsUsed();}
  function collectCrateAt(x,z){
    crates=crates.filter(c=>{
      if(Math.abs(c.x-x)<1.2&&Math.abs(c.z-z)<1.2){scene.remove(c.mesh);return false;}
      return true;
    });
  }
  // ── Resupply: one crate per wave ──────────────────────────────────────────
  // The Viking's crate (airstrike) and the end-of-wave crate both refill the
  // magazine. The end-of-wave resupply rides on a Viking crate still on its way
  // (about to drop, on the ground or being carried in) and skips its own crate
  // when one already came in this wave: a Marine picks up one crate, not two.
  let _crateCbs=null;          // callbacks waiting for the crate on its way (null = none)
  let waveCrates=0;            // crates carried in this wave (startWave resets it)
  function awaitCrate(cb){ (_crateCbs||(_crateCbs=[])).push(cb); }
  function deliverCrate(x,z){ makeCrate(x,z); sendMarine(x,z,_crateIn); }
  function _crateIn(){
    const cbs=_crateCbs||[]; _crateCbs=null; waveCrates++;
    ammo=maxAmmo; updateHUD(); SFX.play('crate');
    cbs.forEach(f=>f());
  }
  function sendMarine(tx,tz,cb){
    // Only one unit leaves the bunker: a crate dropped while one is already out
    // joins its trip, both resupplies apply on its return (a safety net — the
    // resupply above keeps to one crate at a time)
    const out=marines.find(m=>m.state==='running');
    if(out){
      out.queue.push({x:tx,z:tz});
      const prev=out.cb; out.cb=()=>{prev?.();cb?.();};
      if(out.target.phase==='return') out.target={...out.queue.shift(),phase:'goto'};
      return;
    }
    // The elected runner fetches the crate when it is free, else a free Marine, else any idle unit
    const free=i=>marines[i]?.state==='bunker';
    let i=runnerIdx>=0&&runnerIdx<roster.length&&free(runnerIdx)?runnerIdx:roster.findIndex((u,k)=>u==='marine'&&free(k));
    if(i<0) i=marines.findIndex((m,k)=>free(k));
    // Nobody free to fetch it — resupply instantly and don't leave the crate behind
    if(i<0){collectCrateAt(tx,tz);cb?.();return;}
    const idle=marines[i];
    setUnitModel(idle,roster[i],i);
    idle.state='running'; idle.mesh.visible=true; idle.target={x:tx,z:tz,phase:'goto'}; idle.queue=[]; idle.cb=cb;
  }
  function updateMarines(dt){
    marines.forEach(m=>{
      if(m.state==='bunker')return;
      const mp=m.mesh.position; m.leg+=dt*9;
      if(m.walk){                                    // SC2 walk cycle at the running pace
        m.step=(m.step+2.8*dt/m.stride*ANIM_SPEED)%1;
        m.walkMesh.geometry=m.walk[Math.floor(m.step*m.walk.length)];
      } else mp.y=Math.abs(Math.sin(m.leg))*.1;      // procedural marine hops
      const tgt=m.target;
      if(tgt.phase==='goto'){
        const dx=tgt.x-mp.x,dz=tgt.z-mp.z,d=Math.sqrt(dx*dx+dz*dz);
        if(d<.5){
          collectCrateAt(tgt.x,tgt.z);
          if(m.queue.length) m.target={...m.queue.shift(),phase:'goto'};   // next crate on this trip
          else tgt.phase='return';
        } else {mp.x+=dx/d*2.8*dt;mp.z+=dz/d*2.8*dt;m.mesh.rotation.y=Math.atan2(dx,dz);}
      } else {
        const dx=m.homeX-mp.x,dz=m.homeZ-mp.z,d=Math.sqrt(dx*dx+dz*dz);
        if(d<.5){mp.set(m.homeX,0,m.homeZ);m.state='bunker';m.mesh.visible=false;mp.y=0;if(m.cb){m.cb();m.cb=null;}}
        else{mp.x+=dx/d*2.8*dt;mp.z+=dz/d*2.8*dt;m.mesh.rotation.y=Math.atan2(dx,dz);}
      }
    });
  }

  // ── Crate runner's chest lamps ───────────────────────────────────────────
  // At night a unit out of the bunker wears a twin white LED pod on its chest
  // armour (as the Marines' flashlights in StarCraft II): two small soft hot spots
  // in one soft glow, and a soft pool of light on the ground ahead of it with no
  // edge anywhere — plus a real spot light. (A fan with a tip and straight sides,
  // two of them overlapping, and lamp spheres with hard rims read as sharp rays.)
  const LAMP_FRONT = 0.22, LAMP_SPACING = 0.07, LAMP_CAP = 8;   // ahead of its centre · apart from the middle (LAMP_CHEST: setUnitModel)
  // the pool: across, a Gaussian that widens with distance (0.25 → 0.85 of the half-width);
  // along, it swells in over the first quarter and dies away toward the far end
  const _beamTex = (() => {   // x across, v along (v = 0 at the lamp: the canvas bottom, as flipY puts it)
    const W = 64, H = 128, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'), img = g.createImageData(W, H);
    const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const x = (i + .5) / W * 2 - 1, v = 1 - (j + .5) / H, w = 0.25 + 0.6 * v, o = (j * W + i) * 4;
      const along = sstep(0, 0.25, v) * (1 - v) * (1 - v), across = Math.exp(-3 * (x / w) * (x / w));
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 255; img.data[o + 3] = Math.round(255 * along * across);
    }
    g.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(c);
  })();
  const _beamGeo2 = (() => {   // a quad in the xz plane, 1 wide on x, z from 0 (the lamp's end) to 1
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-.5,0,0, .5,0,1, .5,0,0, -.5,0,0, -.5,0,1, .5,0,1], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0,0, 1,1, 1,0, 0,0, 0,1, 1,1], 2));
    return g;
  })();
  // The bunker blocks the lamp, its light and its pool (the desktop's spotSeen): it stands as a vertical cylinder fitted
  // to its walls (centre xz, radius, top: fitBunkerOccluder), and the lamp does not reach a point whose segment to it
  // passes through the cylinder below its top. The rim is soft (a lamp is not a point; a hard edge would crawl) and
  // straddles the wall as on the desktop (the hull reaches past the fitted radius along its long side), but it spares the
  // ground at the wall's foot whose segment heads away from the axis: it fades in over the segment's first 0.05 of dip
  // toward it (no seam where the segment turns tangent). On or inside the cylinder (the hull, the ground at its foot) the
  // half facing the lamp is lit (N·L decides) and the far half is not. A lamp well inside it lights nothing outside.
  const _lampOcc = { value: new THREE.Vector4(0, 0, 1.5, 1.6) };   // until the model is in
  GLOW_LIGHTS.lampOcc = _lampOcc;   // every material gets it with the small lights' uniforms (radial-fog.js)
  const _SPOT_SEEN = `uniform vec4 lampOcc;
float spotSeenW( vec3 p, vec3 l ) {   // world space
  float R = lampOcc.z;
  vec2 a = p.xz - lampOcc.xy, d = l.xz - p.xz;
  float t = clamp( - dot( a, d ) / max( dot( d, d ), 1e-6 ), 0.0, 1.0 );   // the segment's closest approach to the axis
  if ( mix( p.y, l.y, t ) > lampOcc.w ) return 1.0;                        // it passes over the top
  if ( dot( a, a ) < R * R ) return smoothstep( -0.25, 0.15, dot( a, d ) * inversesqrt( max( dot( d, d ), 1e-6 ) ) );
  float c = length( a + d * t );
  return mix( 1.0, smoothstep( R - 0.25, R + 0.15, c ), smoothstep( 0.0, 0.05, length( a ) - c ) );
}
`;
  // The lights' loops run in view space: spotSeen() takes the point and the lamp back to world space. Spot light 0 is
  // the lamp (the scene's only one). Phong and Standard light per pixel, Lambert (rocks, stand-ins) per vertex.
  // Patched once, before any material compiles.
  THREE.ShaderChunk.lights_pars_begin += `
#if NUM_SPOT_LIGHTS > 0
${_SPOT_SEEN}float spotSeen( vec3 p, vec3 l ) { mat3 r = mat3( viewMatrix ); vec3 o = viewMatrix[ 3 ].xyz; return spotSeenW( ( p - o ) * r, ( l - o ) * r ); }
#endif`;
  [['lights_fragment_begin', 'getSpotDirectLightIrradiance( spotLight, geometry, directLight );', 'spotLight'],
   ['lights_lambert_vertex', 'getSpotDirectLightIrradiance( spotLights[ i ], geometry, directLight );', 'spotLights[ i ]']].forEach(([k, call, sl]) => {
    if (!THREE.ShaderChunk[k].includes(call)) console.warn(`Lamp: three.js ${k} has changed, the bunker does not block the lamp`);
    THREE.ShaderChunk[k] = THREE.ShaderChunk[k].replace(call, `${call}
		#if UNROLLED_LOOP_INDEX == 0
		directLight.color *= spotSeen( geometry.position, ${sl}.position );
		#endif`);
  });
  // The cylinder (the desktop's fitBunkerOccluder): the walls' mean half-width below 60% of the height (the roof's
  // overhang left out) and the hull's top. The Neosteel frame counts once it shows; the turret blocks nothing.
  function fitBunkerOccluder() {
    const v = new THREE.Vector3(), pts = [];
    bunkerModelRoot.updateMatrixWorld(true);
    bunkerModelRoot.traverseVisible(ch => {
      if (!ch.isMesh || !ch.geometry?.attributes.position) return;
      const p = ch.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(ch.matrixWorld); pts.push(v.x, v.y, v.z); }
    });
    let top = 0, hx = 0, hz = 0;
    for (let i = 1; i < pts.length; i += 3) top = Math.max(top, pts[i]);
    for (let i = 0; i < pts.length; i += 3) if (pts[i + 1] < 0.6 * top) { hx = Math.max(hx, Math.abs(pts[i])); hz = Math.max(hz, Math.abs(pts[i + 2])); }
    if (top > 0 && hx > 0 && hz > 0) _lampOcc.value.set(0, 0, 0.5 * (hx + hz), top);
  }
  const _lampBeamIM = new THREE.InstancedMesh(_beamGeo2, new THREE.MeshBasicMaterial({ color: 0xf2f6ff, map: _beamTex, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }), LAMP_CAP);   // white LEDs
  // the bunker's shadow cuts the pool as it cuts the light: each pool's lamp stands over its near end, at the height of
  // the instance's y scale (the quad is flat)
  _lampBeamIM.material.onBeforeCompile = sh => {
    sh.vertexShader = 'varying vec3 vPoolW, vPoolL;\n' + sh.vertexShader.replace('#include <fog_vertex>', `#include <fog_vertex>
      vPoolW = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
      vPoolL = ( modelMatrix * instanceMatrix * vec4( 0.0, 1.0, 0.0, 1.0 ) ).xyz;`);
    sh.fragmentShader = 'varying vec3 vPoolW, vPoolL;\n' + _SPOT_SEEN + sh.fragmentShader.replace('#include <dithering_fragment>',
      '#include <dithering_fragment>\n  gl_FragColor.a *= spotSeenW( vPoolW, vPoolL );');
  };
  _lampBeamIM.material.customProgramCacheKey = () => 'lampPool';
  _lampBeamIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _lampBeamIM.frustumCulled = false; _lampBeamIM.count = 0; _lampBeamIM.renderOrder = 1;
  scene.add(_lampBeamIM);
  const _lampFx = makeParticleSystem(32, THREE.AdditiveBlending);   // the lamps themselves: soft sprites, rebuilt every frame
  const _lampM = new THREE.Matrix4(), _lampQ = new THREE.Quaternion(), _lampP = new THREE.Vector3(), _lampS = new THREE.Vector3(), _lampUp = new THREE.Vector3(0, 1, 0);
  const _lampWhite = new THREE.Color(0xffffff), _lampGlowCol = new THREE.Color(0xe8f0ff);
  // The pod's light, a real one (one runner at a time): a spot light (40° cone, full within 7° — a wide soft rim — fading
  // fast with distance, aimed LAMP_TILT below level: flatter, its near rim spreads far over the ground) that lights the
  // hull, the Zerg and the rocks it faces. In the scene from the start, at 0 when unused (adding a light later recompiles
  // every material).
  const LAMP_TILT = 0.21;
  const _lampLight = new THREE.SpotLight(0xf2f6ff, 0, 8, 0.7, 1 - 0.12 / 0.7, 2);   // penumbra: inner 0.12 rad
  scene.add(_lampLight, _lampLight.target);
  function syncUnitLamps() {
    let n = 0;
    _lampLight.intensity = 0;
    _lampFx.n = 0;
    if (_dnFactor > 0.02) for (const m of marines) {
      if (!m.mesh.visible || n >= LAMP_CAP) continue;
      const rot = m.mesh.rotation.y, p = m.mesh.position, h = m.lampH ?? 0.8;
      if (_lampLight.intensity === 0) {
        _lampLight.position.set(0, h, LAMP_FRONT).applyAxisAngle(_lampUp, rot).add(p);
        _lampLight.target.position.set(Math.sin(rot) * Math.cos(LAMP_TILT), -Math.sin(LAMP_TILT), Math.cos(rot) * Math.cos(LAMP_TILT)).add(_lampLight.position);
        _lampLight.target.updateMatrixWorld();
        _lampLight.intensity = 3.5 * _dnFactor;
      }
      for (const side of [-1, 1]) {   // the two LEDs
        _lampP.set(side * LAMP_SPACING, h, LAMP_FRONT).applyAxisAngle(_lampUp, rot).add(p);
        _putSprite(_lampFx, _lampP.x, _lampP.y, _lampP.z, 0.12, _lampWhite, _dnFactor);
      }
      _lampP.set(0, h, LAMP_FRONT).applyAxisAngle(_lampUp, rot).add(p);
      _putSprite(_lampFx, _lampP.x, _lampP.y, _lampP.z, 0.6, _lampGlowCol, 0.35 * _dnFactor);
      // one pool of light on the ground for the pod (its y scale: the lamp's height, for the bunker's shadow)
      _lampP.set(0, 0, LAMP_FRONT).applyAxisAngle(_lampUp, rot).add(p).setY(.025);
      _lampBeamIM.setMatrixAt(n, _lampM.compose(_lampP, _lampQ.setFromAxisAngle(_lampUp, rot), _lampS.set(3.6, h, 5.0)));
      n++;
    }
    _lampBeamIM.material.opacity = 0.55 * _dnFactor;   // over the ground the spot light lights too
    _lampBeamIM.count = n; _lampBeamIM.instanceMatrix.needsUpdate = true;
    const geo = _lampFx.points.geometry;
    geo.setDrawRange(0, _lampFx.n);
    for (const k of ['position', 'aColor', 'aSize', 'aAlpha']) geo.attributes[k].needsUpdate = true;
  }

  // ── Strikes ──────────────────────────────────────────────────────────────
  function allEnemies(){return[...zerglings,...roaches];}
  function strikeAt(tx,tz,col,r){
    makeBeam(tx,tz,col);
    SFX.play('boom');
    spawnParts(new THREE.Vector3(tx,.5,tz),col,22);
    let n=0;
    allEnemies().forEach(e=>{if(e.dead)return;const dx=e.mesh.position.x-tx,dz=e.mesh.position.z-tz;if(Math.sqrt(dx*dx+dz*dz)<r){killEnemy(e,true);n++;}});
    if(n) achMultiKill('strike', _airRunKills+=n);   // the airstrike's missiles so far
  }
  function randPos(){const r=8+Math.random()*4,a=Math.random()*Math.PI*2;return[Math.cos(a)*r,Math.sin(a)*r];}

  function doAirstrike(){
    if(isPaused()) return;
    if(airCD>0||wavePhase!=='combat'||ammo>0){
      setStatus(ammo>0?'Use when ammo is empty!':'Not ready yet!');return;
    }
    if(vikingActive){setStatus('Viking already inbound!');return;}
    airCD=strikeCooldown(); waveAirs++;
    _run.usedSupport=true; _airRunKills=0;   // its missiles' kills add up (AIR SUPERIORITY)

    const alive=allEnemies().filter(e=>!e.dead);

    // Build the missile target list — one per enemy cluster (group nearby enemies together)
    const targets=[];
    const assigned=new Set();
    alive.forEach(e=>{
      if(assigned.has(e))return;
      const ex=e.mesh.position.x, ez=e.mesh.position.z;
      // Group all enemies within radius 3 into this target
      alive.forEach(o=>{
        const dx=o.mesh.position.x-ex, dz=o.mesh.position.z-ez;
        if(Math.sqrt(dx*dx+dz*dz)<3) assigned.add(o);
      });
      targets.push({x:ex, z:ez, e});
    });
    targets.sort((a, b) => a.x - b.x); // flight order, left → right

    // Crate drops close to bunker (safe pick-up spot)
    const crateAngle=Math.random()*Math.PI*2;
    const cratePos=[Math.cos(crateAngle)*3.5, Math.sin(crateAngle)*3.5];

    if(alive.length>0){
      setStatus('Viking incoming — '+alive.length+' target'+(alive.length>1?'s':'')+' acquired!');
      launchViking(targets, cratePos);
    } else {
      // No enemies — still send Viking for the resupply crate
      setStatus('Viking inbound — resupply run!');
      launchViking([], cratePos);
    }
  }

  // ── Nuke timeline (the desktop's nk::, nuke_fx.h) ──────────────────────────
  // Closed-form curves of a blast t s old (game time), so every part and every frame reads the
  // same blast: the shock front (its ring, the cracks it opens, when it throws a victim, when its
  // boom reaches the bunker), the base surge, the fireball and the mushroom's cap. StarCraft II's
  // own keys (NB) time the rest, read at seqMs(t).
  const nk = (() => {
    const S_MAX = 30, S_TAU = .9;   // the front: 33 u/s at the blast, 15 u/s as it passes the kill radius (16 at 0.69 s)
    const frontR = t => t <= 0 ? 0 : S_MAX * (1 - Math.exp(-t / S_TAU));
    // the fireball: a white-hot hemisphere (r 2.6 at 0.1 s) that lifts off, cools and flattens
    const fireR = t => 3.3 * Math.sqrt(1 - Math.exp(-t / .16)) + .12 * t;
    const fireY = t => .42 * fireR(t) + 4.6 * (1 - Math.exp(-Math.max(0, t - .3) / 1.2));
    return {
      frontR,
      frontT: r => -S_TAU * Math.log(1 - Math.min(r, S_MAX - .01) / S_MAX),
      // the base surge: rolls out just behind the front, past the kill radius at ~1.3 s, stalls near 22
      surgeR: t => Math.max(0, Math.min(frontR(t) - .6, 1.5 + 21 * (1 - Math.exp(-t / 1.2)))),
      surgeH: t => (.5 + 3.1 * (1 - Math.exp(-t / .7))) * (1 - .5 * _sstep(2, 6, t)),
      fireR,
      heat: t => Math.exp(-t / 2.4),
      // the mushroom's cap (its sprites and the fire tori): height, ring radius, tube
      capH: t => fireY(t) + .25 * Math.max(0, t - 2),
      capR: t => .8 * fireR(t) * (1 + .22 * _sstep(.6, 2.6, t)) + .1 * t,
      capTube: t => .42 * fireR(t),
      // SC2's nuke (Nuke.m3, its Death sequence) keys its parts in ms: a blast t s old reads them at
      // seqMs(t), so its flash star opens as ours goes off and its detonation frame follows 0.24 s later
      seqMs: t => t * 1000 + 130,
      // the flash: up in 25 ms, mostly gone by 0.3 s; then the eyes are dazzled (the desktop's exposure x0.8 at
      // 0.45-0.9 s, back to 1 by 3 s): how much the field dims
      flashK: t => t < 0 ? 0 : t < .025 ? t / .025 : Math.exp(-(t - .025) / .09),
      dazzle: t => .2 * _sstep(.15, .45, t) * (1 - _sstep(.9, 3, t)),
      FRONT_END: 2,    // the front ring has faded out past the screen
      FIRE_OUT0: 3.6, FIRE_OUT1: 5.4,   // the fire burns out (SC2's cap by 4.7 s, its top by 5.5 s)
      SURGE_END: 6.5,  // the surge has settled; the cloud's last smoke with it
      HAZE_END: 12.3,  // the air over the crater has stopped shimmering
      SCAR_END: 16,    // the scar has faded
    };
  })();

  // ── Nuke: 1 warhead, massive radius, laser designator then detonation ──────
  // SC2 lore: Terran nuclear missile. Bunker survives (hardened structure).
  // Enemies within blast radius are wiped. ~2s warning laser before impact.
  let _nukeInFlight = false;

  // force = cheat launch: skips the wave unlock, cooldown and in-flight checks
  let _nukeTargetTex = null;   // SC2 nuke reticle for the target marker, loaded at boot
  ModelLoader.texture(DECALS.nukeTarget).then(t => { _nukeTargetTex = t; warmNukeShaders(); })
    .catch(() => console.warn('Nuke target texture failed to load — using a plain ring.'));
  function doNuke(force){
    if(!force){
      if(isPaused()) return; // command card stays clickable under the roster dim
      if(nukeCD>0||wave<CFG.nuke_wave){
        setStatus(wave<CFG.nuke_wave?`Nuke unlocks wave ${CFG.nuke_wave}!`:'Nuke on cooldown!');
        return;
      }
      if(_nukeInFlight){ setStatus('Nuclear launch already in progress!'); return; }
      nukeCD=nukeCooldown();
      _run.usedSupport=true;
    }
    waveNukes++;
    _nukeInFlight = true;

    // ── Phase 1: Ghost designates target (0.0s) ─────────────────────────
    // Target = centroid of all living enemies, clamped away from bunker
    const alive = allEnemies().filter(e=>!e.dead);
    let tx=0, tz=0;
    if(alive.length){
      tx = alive.reduce((s,e)=>s+e.mesh.position.x,0)/alive.length;
      tz = alive.reduce((s,e)=>s+e.mesh.position.z,0)/alive.length;
      // Push centroid outward a bit if too close to bunker
      const d=Math.sqrt(tx*tx+tz*tz);
      if(d<3){ tx*=3/Math.max(d,0.1); tz*=3/Math.max(d,0.1); }
    } else {
      // No enemies — aim at a random field position
      const a=Math.random()*Math.PI*2; tx=Math.cos(a)*8; tz=Math.sin(a)*8;
    }

    setStatus('NUCLEAR LAUNCH DETECTED — 2 seconds to impact!');
    SFX.play('nukeWarn');
    prepNukeHaze();   // (the heat haze's targets, ready before the blast)

    // The dive path leans NUKE_SLANT toward the far side of the target as the camera
    // sees it, so the warhead and its streak come in from the top of the screen. (A
    // vertical one, seen from the steep overview camera, pointed sideways or at the
    // camera for targets in the lower half of the screen.)
    const NUKE_SKY_Y = 30, NUKE_FALL_AT = 0.4, NUKE_SLANT = 0.55, NUKE_TRAIL_FADE = 0.5;   // leaves the sky at 0.4 s (above the camera, y 22)
    const away = new THREE.Vector2(-camera.position.x, -camera.position.z).normalize();
    const up = new THREE.Vector3(away.x * NUKE_SLANT, 1, away.y * NUKE_SLANT).normalize();
    const tilt = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    const along = h => new THREE.Vector3(tx, 0, tz).addScaledVector(up, h / up.y);   // the path's point at height h

    // ── Phase 2: Laser designator beam (thin red line, 2s) ──────────────
    const laserGeo = new THREE.CylinderGeometry(0.04, 0.04, 28, 5);
    const laserMat = new THREE.MeshBasicMaterial({color:0xff0000, transparent:true, opacity:0.85, fog:false});   // the designator and its marks show in the dark
    const laser = new THREE.Mesh(laserGeo, laserMat);
    laser.position.copy(along(14 * up.y));          // 28 long: target → sky, down the dive path
    laser.quaternion.copy(tilt);
    scene.add(laser);

    // Blinking target marker on the ground: the SC2 nuke reticle (red on black,
    // drawn additively), or a plain red ring until that texture has loaded
    const dotGeo = _nukeTargetTex ? new THREE.PlaneGeometry(2.6, 2.6) : new THREE.RingGeometry(0.3, 0.6, 16);
    const dotMat = _nukeTargetTex
      ? new THREE.MeshBasicMaterial({map:_nukeTargetTex, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, fog:false})
      : new THREE.MeshBasicMaterial({color:0xff0000, side:THREE.DoubleSide, transparent:true, fog:false});
    const dot = new THREE.Mesh(dotGeo, dotMat);
    dot.rotation.x = -Math.PI/2;
    dot.position.set(tx, 0.05, tz);
    scene.add(dot);

    // The warhead itself streaks down the laser from the sky, nose first (SC2 model, if loaded)
    const missile = ModelLoader.clone('nukeMissile');
    const missileHalf = missile ? missile.position.y : 0;  // the template floats by half its height
    const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);   // modelled nose up
    const spinQ = new THREE.Quaternion(), Y_AXIS = new THREE.Vector3(0, 1, 0);
    let spin = 0;
    if (missile) {
      missile.visible = false;                    // until the dive (a close-up camera looks up)
      scene.add(missile);
    }
    // Its trail, as in StarCraft: one straight streak from the tail up out of view,
    // a white-hot core in an orange glow (both taper toward the sky), and a flare at
    // the tail. (Sparks sprayed from the tail every frame read as fireworks.)
    const trailGeo = new THREE.CylinderGeometry(0.25, 1, 1, 10);   // unit height, narrowing to the top
    const glowMat = (color, opacity) => new THREE.MeshBasicMaterial({color, transparent:true, opacity, blending:THREE.AdditiveBlending, depthWrite:false, fog:false});
    const trailGlow = new THREE.Mesh(trailGeo, glowMat(0xff6a1a, 0.45));
    const trailCore = new THREE.Mesh(trailGeo, glowMat(0xfff2d0, 0.95));
    const flareGeo = new THREE.SphereGeometry(1, 12, 8);
    const flare = new THREE.Mesh(flareGeo, glowMat(0xffd28a, 0.9));
    [trailGlow, trailCore, flare].forEach((m, i) => { m.renderOrder = 4 + i; m.visible = false; scene.add(m); });
    function setTrail(bottom) {                   // the streak from height `bottom` up the path into the sky
      const top = NUKE_SKY_Y + 8, len = (top - bottom) / up.y;
      [[trailGlow, 0.24], [trailCore, 0.07]].forEach(([m, r]) => {
        m.position.copy(along((top + bottom) / 2)); m.quaternion.copy(tilt); m.scale.set(r, len, r);
      });
    }

    // Expanding warning ring — unit ring, animated via scale (no geometry churn)
    const warnMat = new THREE.MeshBasicMaterial({color:0xff2200, side:THREE.DoubleSide, transparent:true, opacity:0.6, fog:false});
    const warnRing = new THREE.Mesh(_ringGeo, warnMat);
    warnRing.scale.setScalar(0.1);
    warnRing.rotation.x = -Math.PI/2;
    warnRing.position.set(tx, 0.06, tz);
    scene.add(warnRing);
    // At night the warning ring glows softly: a soft band along it, as strong as the night is dark
    const warnGlow = new THREE.Mesh(_glowRingGeo, Object.assign(_glowMat(), { color: new THREE.Color(0xff3018), opacity: 0 }));
    warnGlow.scale.setScalar(0.1);
    warnGlow.position.set(tx, 0.07, tz);
    warnGlow.renderOrder = 1;
    scene.add(warnGlow);

    // Animate warning ring expanding and dot blinking (game time — freezes on pause)
    let warnT = 0, detonated = false;
    const WARN_DUR = 2.0; // seconds
    const NUKE_RADIUS = 16; // kills everything within this range
    const NUKE_VAPOR_R = 3.5; // this close to ground zero they vanish in the fireball; the rest are flung
    // (one ticker to the end of the trail's fade: a ticker added from inside a ticker would be dropped)
    addTicker(dt => {
      warnT += dt;
      if (!detonated) {
        const prog = Math.min(1, warnT / WARN_DUR);
        // Ring expands to show blast radius
        warnRing.scale.setScalar(Math.max(0.1, prog * NUKE_RADIUS));
        warnRing.material.opacity = 0.4 + Math.sin(warnT*12)*0.3; // pulse
        warnGlow.scale.setScalar(Math.max(0.1, prog * NUKE_RADIUS));
        warnGlow.material.opacity = 0.9 * _dnFactor * (0.6 + 0.4 * Math.sin(warnT * 12));
        // Dot blinks faster as impact nears
        dot.material.opacity = Math.sin(warnT*(6+prog*14)) > 0 ? 0.9 : 0.1;
        laser.material.opacity = 0.5 + Math.sin(warnT*8)*0.35;
        // accelerating dive from the sky, lands at detonation
        const fall = Math.max(0, Math.min(1, (warnT - NUKE_FALL_AT) / (WARN_DUR - NUKE_FALL_AT)));
        const y = missileHalf + NUKE_SKY_Y * (1 - Math.pow(fall, 1.6)), tail = y + missileHalf * up.y;   // nose first: the tail is up the path
        spin += dt * 4;
        if (missile) {
          missile.visible = fall > 0;
          missile.position.copy(along(y));
          missile.quaternion.copy(tilt).multiply(flip).multiply(spinQ.setFromAxisAngle(Y_AXIS, spin));
        }
        trailGlow.visible = trailCore.visible = flare.visible = fall > 0;
        setTrail(tail);
        flare.position.copy(along(tail));
        flare.scale.setScalar(0.28 + 0.06 * Math.sin(warnT * 40));
        if (warnT < WARN_DUR) return true;
        // ── impact: the designator and the warhead go, the streak ends in the blast and fades
        detonated = true;
        [laser, dot, warnRing, warnGlow, flare].forEach(m => { m.visible = false; });
        if (missile) missile.visible = false;
        setTrail(0);
        _nukeInFlight = false;
        detonate();
      }
      const k = Math.max(0, 1 - (warnT - WARN_DUR) / NUKE_TRAIL_FADE);
      trailGlow.material.opacity = 0.45 * k;
      trailCore.material.opacity = 0.95 * k;
      return k > 0;
    }, () => {
      // Remove designator visuals (warnRing uses shared _ringGeo — don't dispose it).
      // Also runs when Restart/Load drops the launch mid-countdown.
      scene.remove(laser); scene.remove(dot); scene.remove(warnRing); scene.remove(warnGlow);
      if (missile) scene.remove(missile);         // shares the template's geometry — no dispose
      [trailGlow, trailCore, flare].forEach(m => { scene.remove(m); m.material.dispose(); });
      laser.geometry.dispose(); dot.geometry.dispose(); trailGeo.dispose(); flareGeo.dispose();
      laser.material.dispose(); dot.material.dispose(); warnRing.material.dispose(); warnGlow.material.dispose();
      _nukeInFlight = false;
    });

    // ── Phase 3: DETONATION (2.0s) ──────────────────────────────────────
    function detonate() {
      SFX.play('nukeBoom');
      // The shock front reaches the bunker: a crack and a deep thud, then a long rumble
      after(nk.frontT(Math.hypot(tx, tz)), () => { SFX.play('nukeShock'); after(0.3, () => SFX.play('nukeRumble')); });
      // The blast, on nk:: and timed from SC2's (the flash, the shock front under its dome, the fireball
      // rolling into the mushroom cloud, the base surge, the burn ring, the flash star, the glow cards,
      // the heat haze), the scar it leaves, and its light (at night it lights the field)
      const seed = Math.random() * 50;
      nukeBlasts.push({x: tx, z: tz, t: 0, parts: _nbMake(tx, tz, seed)});
      addNukeScar(tx, tz, seed);
      _nukeLightT = 0;
      _nukeLight.position.set(tx, 2.3, tz);

      // (no sparks or debris flung across the field: hard to read; the blast carries it)

      // Kill ALL enemies in radius — bunker excluded (hardened); burnt: no blood. Vaporised near
      // ground zero; the rest catch fire in the flash and run on until the front flings them out
      let killed = 0;
      _killBatch = true;
      allEnemies().forEach(e => {
        if(e.dead) return;
        const dx=e.mesh.position.x-tx, dz=e.mesh.position.z-tz, d=Math.sqrt(dx*dx+dz*dz);
        if(d > NUKE_RADIUS) return;
        killed++;
        if(d < NUKE_VAPOR_R){ e.mesh.visible = false; killEnemy(e, true, false); return; }   // nothing left
        e.mesh.visible = true;   // (out in the night's dark too: the flash shows them, then the blast lights the field)
        const k = 1 - d / 24, j = .8 + .4 * Math.random(), h = (3 + 10 * k) * j;
        killEnemy(e, true, false, { zero: [tx, tz], delay: nk.frontT(d), vel: [dx / d * h, 3 + 5 * k * Math.random(), dz / d * h],
          spin: (Math.random() < .5 ? -1 : 1) * (6 + 6 * Math.random()) });
      });
      _killBatch = false; updateHUD();
      achMultiKill('nuke', killed);

      setStatus(`Nuclear detonation — ${killed} unit${killed!==1?'s':''} annihilated. Bunker intact.`);
    }
  }
  // A soft glowing band along a unit circle (the nuke's warning ring at night), scaled with it
  const _glowRingGeo = (() => {
    const pos = [], uv = [], S = 96;
    for (let i = 0; i < S; i++) {
      const a0 = i / S * Math.PI * 2, a1 = (i + 1) / S * Math.PI * 2;
      const v = (a, r, t) => { pos.push(Math.cos(a) * r, 0, Math.sin(a) * r); uv.push(0.5, t); };
      v(a0, .95, 0); v(a0, 1.05, 1); v(a1, 1.05, 1); v(a0, .95, 0); v(a1, 1.05, 1); v(a1, .95, 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    return g;
  })();

  // ── Nuke fireball light ──────────────────────────────────────────────────
  // SC2's (NB.light): dark until the detonation frame, full in ~0.3 s, held to ~2 s, gone by
  // 4 s: a warm white point light at the blast, and at night the dark lifts toward
  // NUKE_LIGHT_F (fog far ≈ 40: past the spawn ring) — _dnEffFactor.
  const NUKE_LIGHT_DUR = 4, NUKE_LIGHT_F = 0.32, NUKE_FLASH_LIGHT = 10;
  let _nukeLightT = -1;          // seconds since the blast (game time); -1 = none
  function _nukeLightK() { return _nukeLightT < 0 ? 0 : _nbKey(NB.light, nk.seqMs(_nukeLightT)); }
  function updateNukeLight(dt) {   // live frames only, before updateDayNight (the lights follow it)
    if (_nukeLightT >= 0 && (_nukeLightT += dt) >= NUKE_LIGHT_DUR) _nukeLightT = -1;
    if (_nukeLight) _nukeLight.intensity = _nukeLightK() * (1 + 3 * _dnFactor) + NUKE_FLASH_LIGHT * nk.flashK(_nukeLightT);   // (and it surges in the flash)
  }

  // ── Nuke blast ───────────────────────────────────────────────────────────
  // StarCraft II's, rebuilt on nk:: and timed from SC2's own nuke (Nuke.m3, its Death sequence):
  // the shock front under its dome, the burn ring, the fire tori and the scar (its own: nukeScars)
  // are drawn by their shaders; the fireball, the mushroom cloud, the base surge and the glow
  // cards are soft sprites (_nbCloud). Each SC2 part follows SC2's key tracks (ms -> value);
  // a blast at t s reads them at nk.seqMs(t) ms, so the flash star is already opening
  // at the detonation frame. Sizes are SC2's units (ours match: the bunker is 3 wide). The
  // textures are drawn here (no art for them).
  const NB_END = 13000;
  let nukeBlasts = [];   // {x, z, t: s since the blast, parts}
  const NB = {
    flashSide:  [[0, 1.15], [200, 2.2], [300, 6.6], [400, 12.3], [500, 16.7], [566, 17.8]],
    flashLight: [[133, 1], [366, .8], [566, 0]],
    // the glow cards (_nbGlowCards): the flare of the flash, a white haze, a yellow core, a burst cut short at 1 s
    flareSide:  [[0, 2.9], [113, 10.5], [433, 3.9]],
    flareLight: [[181, 1], [433, 0]],
    hazeSide:   [[333, 1.4], [433, 3.1], [700, 16.9], [933, 24.8], [1166, 24.4], [2000, 17.4], [3166, 3]],
    hazeLight:  [[333, 0], [633, 1], [5033, 0]],
    coreSide:   [[0, 1], [500, 4.1], [766, 14.4], [1066, 17.4], [1800, 13.9], [2400, 8.7], [3100, 2.6]],
    burstSide:  [[333, .7], [433, 1.4], [766, 9.5], [933, 11.5]],
    glowCool:   [[633, 1], [5033, 0]],
    light:      [[333, 0], [400, .1], [466, .35], [533, .65], [600, .9], [666, 1], [1966, 1], [2200, .96], [2466, .84], [2633, .75],
                 [2900, .57], [3266, .32], [3466, .19], [3633, .11], [3766, .05], [3900, .02], [4000, 0]],
    burnR:      [[633, 3.8], [1700, 9.3], [3000, 16]],         // the burn ring (radius: SC2's half-width x 1.83, our blast's footprint)
    burnLight:  [[633, 0], [933, 1], [1700, 2], [3000, 0]],
    toriLight:  [[1100, 0], [1433, 3], [3566, 1.6], [4700, 0]],
    // the heat haze (strength: 10 bends ~10 px at 1080p; D: SC2's diameter): the shock bubble, the ripple over the
    // ground behind it, the shimmer round the cap; over the crater, keyed by the blast's own age (ms, not seqMs)
    hazeBubbleD: [[130, 1], [500, 7.6], [900, 15.6], [1300, 21.8], [1600, 23.6]],
    hazeBubble:  [[130, 0], [233, 10], [733, 9], [1233, 5], [1300, 6], [1600, 0]],
    hazeRippleD: [[666, 2.3], [1700, 17.1], [1966, 18.9]],
    hazeRipple:  [[300, 0], [700, 10], [1466, 6], [1966, 0]],
    hazeCap:     [[666, 0], [1366, 7], [4233, 7], [5166, 0]],
    hazeCrater:  [[1900, 0], [1970, 3], [2440, 5], [9740, 6], [12300, 0]],
    hazeCraterR: [[1900, 2.3], [2640, 8.9], [5400, 5.1]],
    hazeCraterH: [[1900, 1.2], [2640, 3.4], [5400, 1.6]],
  };
  function _nbKey(tr, ms) {   // piecewise linear, held at both ends
    if (ms <= tr[0][0]) return tr[0][1];
    for (let i = 1; i < tr.length; i++)
      if (ms <= tr[i][0]) { const [a, va] = tr[i - 1], [b, vb] = tr[i]; return va + (vb - va) * (ms - a) / (b - a); }
    return tr[tr.length - 1][1];
  }
  const _puffHash = (i, salt) => { const s = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453; return s - Math.floor(s); };
  const _sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  // textures: the cloud's puffs, the flash star
  // The puffs: a 2x2 atlas of cauliflower billows, 128² each: round billows packed on a low dome, smaller
  // florets bulging out of them, each a dome (lit by its normal); their silhouette crisp and a little
  // ragged. R density, GB the normal (x, y; 0.5 = flat), A the hollows (as the cloud cools, its fire glows
  // on there, sinking deeper)
  const _nbPuffTex = (() => {
    const N = 128, W = 2 * N, px = new Uint8Array(W * W * 4), hgt = new Float32Array(N * N);
    const hash = (x, y, s) => {
      let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2246822519)) >>> 0;
      n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
      return ((n ^ (n >>> 16)) & 0xffff) / 65535;
    };
    const noise = (x, y, s) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      let fx = x - ix, fy = y - iy; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
      const a = hash(ix, iy, s) + (hash(ix + 1, iy, s) - hash(ix, iy, s)) * fx, b = hash(ix, iy + 1, s) + (hash(ix + 1, iy + 1, s) - hash(ix, iy + 1, s)) * fx;
      return a + (b - a) * fy;
    };
    const fbm = (x, y, s, oct) => { let v = 0; for (let o = 0, a = .5; o < oct; o++, a *= .5) { v += a * noise(x, y, s + o * 17); x = x * 2.03 + 5.1; y = y * 2.03 + 1.3; } return v; };
    for (let cell = 0; cell < 4; cell++) {
      const ox = (cell % 2) * N, oy = (cell >> 1) * N, H = (k, s) => hash(k, cell, s);
      // the billows {x, y, r, z: lift, w: how much their seams glow}: each overlapping one, swallowed by none
      const B = [{ x: 0, y: 0, r: .34, z: .3, w: 1 }];
      for (let k = 0; B.length < 20 && k < 2000; k++) {
        const a = H(k, 1) * 6.2832, d = .62 * Math.sqrt(H(k, 2)), r = .14 + .16 * H(k, 3) * (1 - .5 * d), x = Math.cos(a) * d, y = Math.sin(a) * d;
        const gap = Math.min(...B.map(b => Math.hypot(x - b.x, y - b.y) / (r + b.r)));
        if (d + r <= .87 && gap >= .5 && gap <= .85) B.push({ x, y, r, z: .3 * (1 - d * d / .7), w: 1 });
      }
      const top = (x, y) => { let h = -1; for (const b of B) { const q = 1 - ((x - b.x) ** 2 + (y - b.y) ** 2) / (b.r * b.r); if (q > 0) h = Math.max(h, b.z + .9 * b.r * q); } return h; };
      for (let k = 0, m = 0; m < 24 && k < 600; k++) {   // the florets
        const x = 1.6 * (H(k, 20) - .5), y = 1.6 * (H(k, 21) - .5), hp = top(x, y), r = .055 + .06 * H(k, 22);
        if (hp >= .16) { B.push({ x, y, r, z: hp - .5 * r, w: .15 }); m++; }
      }
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const x = (i + .5) / N * 2 - 1, y = (j + .5) / N * 2 - 1, o = ((oy + j) * W + ox + i) * 4;
        let sd = -9, h1 = 0, h2 = 0, w1 = 0, w2 = 0, hm = 0, qm = 0;   // the distance in from the silhouette; the two highest billows here; qm: how near the crown of the top billow (not a floret)
        for (const b of B) {
          const q = (x - b.x) ** 2 + (y - b.y) ** 2;
          sd = Math.max(sd, b.r - Math.sqrt(q));
          if (q >= b.r * b.r) continue;
          const c = 1 - q / (b.r * b.r), h = b.z + .9 * b.r * c;   // (domed, not a ball: no hard ring round each billow)
          if (h > h1) { h2 = h1; w2 = w1; h1 = h; w1 = b.w; } else if (h > h2) { h2 = h; w2 = b.w; }
          if (b.w > .5 && h > hm) { hm = h; qm = c; }
        }
        const f1 = fbm(x * 6 + cell * 3.7, y * 6, 11 + cell, 3), f2 = fbm(x * 11 + cell, y * 11, 50 + cell, 2);
        const e = sd + .07 * (f2 - .5) + .03 * (f1 - .5);   // the rim, a little ragged
        // the hollows: down each billow's flank to the seams, in broad blotches (lines read as cracked rock, rings round each billow as bubbles)
        const seam = h2 > 0 ? (1 - _sstep(0, .1, h1 - h2)) * Math.min(w1, w2) : 0, f3 = fbm(x * 3.3 + cell * 1.7, y * 3.3, 90 + cell, 2);
        hgt[j * N + i] = h1 + .09 * f1;
        px[o] = Math.round(255 * Math.max(_sstep(0, .055, e), 1 - _sstep(.4, .62, Math.hypot(x, y))));   // (no holes inside it)
        px[o + 3] = Math.round(255 * Math.max(0, Math.min(1, .35 * (1 - qm) ** 1.3 + .8 * (f3 - .4) + .12 * (f2 - .5) + .15 * seam)));
      }
      const Hh = (a, b) => hgt[Math.max(0, Math.min(N - 1, b)) * N + Math.max(0, Math.min(N - 1, a))];
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {   // (slopes in the cell's own units)
        const nx = (Hh(i - 1, j) - Hh(i + 1, j)) * N / 4, ny = (Hh(i, j - 1) - Hh(i, j + 1)) * N / 4, l = Math.hypot(nx, ny, 1), o = ((oy + j) * W + ox + i) * 4;
        px[o + 1] = Math.round(255 * (nx / l * .5 + .5));
        px[o + 2] = Math.round(255 * (ny / l * .5 + .5));
      }
    }
    const t = new THREE.DataTexture(px, W, W, THREE.RGBAFormat);
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
    return t;
  })();
  function _nbCanvasTex(w, h, paint) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    paint(c.getContext('2d'), w, h);
    return new THREE.CanvasTexture(c);
  }
  // flash star: a white-hot core and twelve thin rays
  const _nbStarTex = _nbCanvasTex(128, 128, (g) => {
    g.globalCompositeOperation = 'lighter';
    const core = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    core.addColorStop(0, 'rgba(255,255,255,1)'); core.addColorStop(.12, 'rgba(255,248,220,.85)');
    core.addColorStop(.35, 'rgba(255,220,150,.25)'); core.addColorStop(1, 'rgba(255,200,120,0)');
    g.fillStyle = core; g.fillRect(0, 0, 128, 128);
    for (let k = 0; k < 12; k++) {
      const a = k * Math.PI / 6 + (_puffHash(k, 3) - .5) * .25, len = 50 + 13 * _puffHash(k, 4), wd = .035 + .03 * _puffHash(k, 5);
      const ray = g.createLinearGradient(64, 64, 64 + Math.cos(a) * len, 64 + Math.sin(a) * len);
      ray.addColorStop(0, 'rgba(255,255,255,.9)'); ray.addColorStop(1, 'rgba(255,230,180,0)');
      g.fillStyle = ray;
      g.beginPath(); g.moveTo(64 + Math.cos(a - wd) * 4, 64 + Math.sin(a - wd) * 4);
      g.lineTo(64 + Math.cos(a) * len, 64 + Math.sin(a) * len); g.lineTo(64 + Math.cos(a + wd) * 4, 64 + Math.sin(a + wd) * 4); g.fill();
    }
  });
  // shapes: flat quad (and one facing down: the ripple's haze, seen from behind), open hemisphere, ball (the cap's
  // haze), the fire tori's ring (1 round, its tube 0.5, lying flat)
  const _nbQuad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), _nbQuadDown = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2);
  const _nbDomeGeo = new THREE.SphereGeometry(.5, 64, 16, 0, Math.PI * 2, 0, Math.PI / 2);   // (16 across: its silhouette, 16 wide, would show facets)
  const _nbBallGeo = new THREE.SphereGeometry(.5, 32, 16);
  const _nbTorusGeo = new THREE.TorusGeometry(1, .5, 16, 48).rotateX(-Math.PI / 2);
  // A glow that also hides some of what lies behind it (premultiplied, cover NB_COVER): added
  // light alone tints the bright grass lime; this whitens and warms it
  const NB_COVER = .55;
  function _nbCoverGlow(mat) {
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    mat.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>',
      '#include <dithering_fragment>\n  gl_FragColor = vec4(gl_FragColor.rgb * gl_FragColor.a, gl_FragColor.a * ' + NB_COVER.toFixed(2) + ');'); };
    mat.customProgramCacheKey = () => 'nbCoverGlow';
    return mat;
  }
  // ── Nuke shaders (the desktop's nuke_fx.cpp) ─────────────────────────────
  // The shock front, its dome, the burn ring and the scar, drawn procedurally: value noise from
  // integer hashes (no texture; sampled round a circle it is periodic), fbm over it, the fire ramp.
  // Premultiplied like _nbCoverGlow: they whiten and warm the grass instead of tinting it lime.
  const NK_NOISE = `
    float h12(vec2 p) { vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    float h13(vec3 p) { p = fract(p * .1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
    vec2 h22(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
    float n2(vec2 x) {
      vec2 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
      return mix(mix(h12(i), h12(i + vec2(1., 0.)), f.x), mix(h12(i + vec2(0., 1.)), h12(i + vec2(1., 1.)), f.x), f.y);
    }
    float n3(vec3 x) {
      vec3 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
      return mix(mix(mix(h13(i), h13(i + vec3(1., 0., 0.)), f.x), mix(h13(i + vec3(0., 1., 0.)), h13(i + vec3(1., 1., 0.)), f.x), f.y),
                 mix(mix(h13(i + vec3(0., 0., 1.)), h13(i + vec3(1., 0., 1.)), f.x), mix(h13(i + vec3(0., 1., 1.)), h13(i + vec3(1., 1., 1.)), f.x), f.y), f.z);
    }
    float fbm2(vec2 p, int o) { float s = 0., a = .5; for (int i = 0; i < 4; i++) { if (i >= o) break; s += a * n2(p); p = p * 2.03 + vec2(5.1, 1.3); a *= .5; } return s; }
    vec3 fireCol(float T) {   // fire by temperature: soot, deep red, orange, yellow, white-hot
      T = clamp(T, 0., 1.15);
      float k = min(T, 1.) * 4.;
      vec3 c = k < 1. ? mix(vec3(.18, .14, .12), vec3(.54, .16, .05), k) : k < 2. ? mix(vec3(.54, .16, .05), vec3(.94, .42, .09), k - 1.)
             : k < 3. ? mix(vec3(.94, .42, .09), vec3(1., .71, .23), k - 2.) : mix(vec3(1., .71, .23), vec3(1., .94, .75), k - 3.);
      return c * (1. + .25 * T);
    }
    varying vec3 vW; varying vec3 vN;
  `;
  const NK_VS = `varying vec3 vW; varying vec3 vN;
    void main() { vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vN = mat3(modelMatrix) * normal; gl_Position = projectionMatrix * viewMatrix * w; }`;
  // the shock front: a bright ragged ring (a Mach stem) racing over the ground, a luminous zone trailing it
  const NK_FRONT_FS = `
    uniform vec2 uC; uniform float uR, uW, uI, uTime, uSeed;
    void main() {
      vec2 dv = vW.xz - uC; float r = length(dv);
      float x0 = (r - uR) / uW;
      if (x0 > 3. || x0 < -8.) discard;   // (the rag moves the ring by under 0.6 band widths)
      vec2 dir = dv / max(r, 1e-4);
      float R = uR * (1. + .03 * (n2(dir * 3. + vec2(uSeed, uTime * 2.)) - .5) + .012 * (n2(dir * 11. + uSeed) - .5));
      float x = (r - R) / uW;
      float clump = .6 + .4 * n2(dir * 9. + vec2(uTime * 1.3, uSeed));
      float trail = .3 * smoothstep(-7., -.5, x) * step(x, 0.) * smoothstep(.5, .8, r / max(uR, 1e-3)) * (.5 + .5 * n2(dir * 14. + vec2(r * .8)));
      float k = uI * (exp(-x * x * 3.) * clump + trail);
      gl_FragColor = vec4(vec3(1., .86, .62) * k, clamp(.5 * k, 0., .85));
    }`;
  // the shock dome: a hemisphere of compressed air over the front, seen at its rim (fading out right at
  // the silhouette: the rim alone ends in a hard line, a wall of light seen from the close-up)
  const NK_DOME_FS = `
    uniform float uA, uTime;
    void main() {
      vec3 N = normalize(vN), V = normalize(cameraPosition - vW);
      float c = abs(dot(N, V));
      float a = uA * (2.6 * pow(1. - c, 3.) + .04) * smoothstep(0., .35, c) * (.7 + .3 * n3(vW * .7 + vec3(uTime * 3.)));
      gl_FragColor = vec4(vec3(1., .95, .88) * a, a * ${NB_COVER.toFixed(2)});
    }`;
  // SC2's burn ring: a band of burning ground spreading at a steady pace, torn along the ring and across
  // it. Drawn straight to the screen the fire covers the bright grass and stays under 1 (added, or past
  // 1, it turns yellow-white there, lime at its edges)
  const NK_BURN_FS = `
    uniform vec2 uC; uniform float uR, uW, uK, uTime, uSeed;
    void main() {
      vec2 dv = vW.xz - uC; float r = length(dv);
      float x = (r - uR) / uW;
      if (abs(x) > 3.) discard;
      vec2 dir = dv / max(r, 1e-4);
      float tear = fbm2(dir * 5. + vec2(uSeed, r * .35 - uTime * .4), 3);
      float band = exp(-x * x * 2.2) * smoothstep(.25, .6, tear) + .3 * exp(-x * x * 7.) * tear;
      float k = 1. - exp(-2. * uK * band);
      gl_FragColor = vec4(fireCol(.45 + .25 * n2(dir * 13. + vec2(r * 1.3, uTime * 2.))) * k, k);
    }`;
  // The scar: a small scorched pit of churned earth. Short cracks run out of it (each forking once)
  // and its floor is shattered; they open behind the shock front and glow a deep red-orange through
  // the soil, dimming over ~8 s, then the pit fades. The earth darkens the grass (fogged like the
  // ground, dimmed with the night: uLit), the cracks glow
  const NK_SCAR_FS = `
    uniform vec2 uC; uniform float uAge, uSeed, uFront, uK, uLit;
    #ifdef USE_FOG
      uniform vec3 fogColor; uniform float fogNear, fogFar;
    #endif
    const float TAU = 6.2831853;
    float adiff(float a, float b) { return mod(a - b + 3.14159265, TAU) - 3.14159265; }
    float ln1(float x) { float i = floor(x); return mix(h12(vec2(i, uSeed)), h12(vec2(i + 1., uSeed)), fract(x)); }   // linear: a polyline
    // a crack's lateral wander (world units) at radius r: straight runs with sharp kinks, and a fine jag
    float wander(float r, float i) { return (ln1(r * 2.4 + i * 7.31) - .5) * .4 + (ln1(r * 7.5 + i * 3.17 + 40.) - .5) * .11; }
    // a line of half-width h, x off its centre: no thinner than a pixel px (thinner, it breaks into dots), dimmed as it widens
    float line(float x, float h, float px) { float w = max(h, px); return (1. - smoothstep(w * .35, w + .5 * px, x)) * h / w; }
    void main() {
      vec2 d = vW.xz - uC; float r = length(d), px = fwidth(r);   // (a pixel, in world units)
      if (r > 4.) discard;
      float ang = atan(d.y, d.x);
      float mott = fbm2(vW.xz * .8 + uSeed, 3);
      float pit = 1. - smoothstep(.5, 1.2 + .4 * mott, r);    // the churned centre
      float soil = 1. - smoothstep(1.6, 2.4 + .8 * mott, r);   // scorched earth
      float tint = 1. - smoothstep(2.3, 3.8, r);               // a faint singe on the grass
      float crack = 0.;
      for (int i = 0; i < 10; i++) {
        float fi = float(i);
        float len = 1.3 + 1.2 * h12(vec2(fi + 31., uSeed));
        if (r > len + .2) continue;
        float phi = (fi + .7 * h12(vec2(fi, uSeed))) * TAU / 10.;
        float da = adiff(ang, phi) * r;   // arc distance from the crack's base line
        if (abs(da) > 1.4) continue;
        float w = wander(r, fi);
        float taper = 1. - smoothstep(.2, len, r);
        float wid = .025 + .045 * taper;
        crack = max(crack, line(abs(da - w), wid, px) * smoothstep(.2, .45, r) * sqrt(taper));
        float rb = .6 + .4 * len * h12(vec2(fi + 7., uSeed));   // the fork leaves at rb, bending off ~25 deg
        if (r > rb) {
          float side = h12(vec2(fi + 13., uSeed)) < .5 ? -1. : 1.;
          float tb = 1. - smoothstep(rb, rb + len * (.35 + .25 * h12(vec2(fi + 17., uSeed))), r);
          float xb = abs(da - w - side * (r - rb) * .5 - (ln1(r * 6. + fi * 5.1 + 90.) - .5) * .12);
          float wb = .018 + .035 * tb;
          crack = max(crack, line(xb, wb, px) * tb);
        }
      }
      if (r < 1.8) {   // the shattered floor: Voronoi cell edges
        vec2 x = vW.xz * 3.2 + uSeed * 3.; vec2 g = floor(x), f = fract(x); float F1 = 8., F2 = 8.;
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
          vec2 o = vec2(float(i), float(j)); vec2 dd = o + h22(g + o) - f; float q = dot(dd, dd);
          if (q < F1) { F2 = F1; F1 = q; } else if (q < F2) F2 = q;
        }
        crack = max(crack, line((sqrt(F2) - sqrt(F1)) / 3.2, .028, px) * (1. - smoothstep(.8, 1.7, r)));
      }
      crack *= 1. - smoothstep(uFront * .9 - .3, uFront * .9, r);   // opened by the front
      // a deep red-orange glow, brightest in the pit, flickering a little, dimming over ~8 s
      float E = .85 * exp(-uAge / 3.) + .15 * exp(-uAge / 8.);
      float T = E * (1. - .12 * r) * (.75 + .5 * n2(vW.xz * 3. + uAge * .6));
      vec3 hot = mix(vec3(.54, .1, .03), vec3(1., .23, .06), clamp(T, 0., 1.)), earth = vec3(.3, .19, .11);   // dull red .. glowing red
      float under = mix(.35, 1., smoothstep(1., 3., uAge));   // dim while the fireball sits on it (no veins through the fire)
      vec3 glow = mix(earth * .5, hot, .65) * crack * smoothstep(0., .25, T) * under;   // red through the soil
      glow += hot * .22 * pit * E * under * (.5 + .5 * mott);   // the pit floor smoulders
      float a = clamp(uK * (pit * .35 + soil * (.45 + .25 * mott) + tint * .12 + crack * .35), 0., .9);
      vec3 ch = mix(vec3(.16, .11, .07), vec3(.07, .05, .035), max(pit, crack)) * uLit;   // churned brown earth, darker in the pit and cracks
      #ifdef USE_FOG
        ch = mix(ch, fogColor, smoothstep(fogNear, fogFar, length(vW.xz)));
      #endif
      gl_FragColor = vec4(ch * a + glow * uK, a);
    }`;
  // The fire tori (SC2's cap: three nested fat rings of fire): fire that rolls round the tube, faint,
  // bright face-on and gone well before the silhouette (the sprites over it keep the cloud soft; past
  // them, faded as slowly as the desktop's, the rim read as a lime ring on the grass), blended over (full
  // cover). vO: the vertex on the unit ring (tube 0.5); the normal and view in view space (scaled unevenly)
  const NK_TORUS_VS = `varying vec3 vO; varying vec3 vN; varying vec3 vV;
    void main() { vec4 mv = modelViewMatrix * vec4(position, 1.); vO = position; vN = normalMatrix * normal; vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`;
  const NK_TORUS_FS = `
    uniform float uB, uTime, uSeed;
    varying vec3 vO; varying vec3 vV;
    void main() {
      float phi = atan(vO.z, vO.x);
      vec2 cs = vec2(length(vO.xz) - 1., vO.y);
      float th = atan(cs.y, cs.x) + uTime * 2.9;   // rolling round the tube
      vec3 q = vec3(cos(phi) * (3. + cos(th)), sin(phi) * (3. + cos(th)), sin(th)) * 1.3 + uSeed;   // seamless both ways
      float T = .62 * n3(q) + .38 * n3(q * 2.3 + 7.);
      float a = clamp(.22 * uB * smoothstep(.25, .8, T) * pow(abs(dot(normalize(vN), normalize(vV))), 1.5), 0., 1.);
      gl_FragColor = vec4(fireCol(.45 + .5 * T) * a, a);
    }`;
  // The condensation (Wilson) ring: a pale skirt of cloud flashing out round the cap's foot as the shock
  // passes through damp air, wispy, sharpest at its outer edge. The mesh's outer edge is at uR
  const NK_WILSON_FS = `
    uniform vec2 uC; uniform vec3 uCol; uniform float uR, uA, uTime, uSeed;
    void main() {
      vec2 dv = vW.xz - uC; float r = length(dv), x = r / uR;
      vec2 dir = dv / max(r, 1e-4);
      float wisp = fbm2(dir * 4. + vec2(uSeed + x * 9., x * 9. - uTime * .3), 2);   // (as fast across the band as along it: no radial streaks)
      float k = uA * smoothstep(.995, .945, x + .05 * (wisp - .5)) * smoothstep(.8, .95, x) * smoothstep(.25, .7, wisp);
      k *= smoothstep(3., 9., distance(cameraPosition, vW));   // (gone as the close-up lens comes into it: a white smear)
      gl_FragColor = vec4(uCol * k, k * .8);
    }`;
  const _nbWilsonGeo = new THREE.RingGeometry(.8, 1, 160).rotateX(-Math.PI / 2);
  // The heat haze: signed uv offsets the scene is bent by (renderFrame's composite, or renderScene), from its own noise, rising, strongest
  // face-on (SC2's inverted fresnel), fading out toward the ground; or a ripple band on the ground (uRing.y > 0).
  // RGBA: +x, -x, +y, -y over HZ_RANGE (added: no float target needed)
  const HZ_RANGE = .05;
  const NK_HAZE_FS = `
    uniform vec2 uC, uRing; uniform float uS, uTile, uRise, uAspectInv;
    void main() {
      if (vW.y < -.05) discard;
      vec3 N = normalize(vN), V = normalize(cameraPosition - vW);
      float f = pow(abs(dot(N, V)), .6) * smoothstep(-.05, 1., vW.y);
      if (uRing.y > 0.) { float x = (length(vW.xz - uC) - uRing.x) / uRing.y; f = exp(-x * x * 2.); }
      vec3 q = vW * uTile - vec3(0., uRise, 0.);
      vec2 o = vec2(n3(q), n3(q + vec3(17.3, 4.1, 9.7))) - .5 + .5 * (vec2(n3(q * 2.3 + 3.), n3(q * 2.3 + 11.)) - .5);
      o *= vec2(uAspectInv, 1.) * uS * f * ${(.0019 / HZ_RANGE).toFixed(4)};   // S 10: about 10 px at 1080p, alike both ways
      gl_FragColor = vec4(max(o, 0.), max(-o, 0.)).xzyw;
    }`;
  // The cloud's sprites (the desktop's PART_VS / PART_FS): quads facing the camera, drawn instanced and
  // rebuilt every frame. iPos: xyz, the world diameter; iCol: rgb, alpha; iCell: the puff atlas's cell (< 0:
  // a plain soft disc, coloured iCol), its turn, its fire's temperature and how far that fire has sunk into
  // the hollows (0: it burns all over); iShape: xy, the quad squashed along this screen direction by its
  // length (a billow rolling over the cap's rim, seen edge-on), z: how blurred (mip levels: dust, smoke in
  // shadow, glowing gas). They fade out as the lens comes within about their size, where they meet the
  // ground and in the night fog (except near a small light), and the cloud thins where it hangs between the
  // camera and the bunker (uThin: the bunker on screen, the aspect; w 0: not this system)
  const NK_PUFF_VS = `
    attribute vec4 iPos; attribute vec4 iCol; attribute vec4 iCell; attribute vec3 iShape;
    uniform vec4 uThin;
    varying vec2 vUv; varying vec4 vCol; varying vec4 vCell; varying vec2 vFogXZ; varying float vWy, vBlur;
    void main() {
      vec4 mv = viewMatrix * vec4(iPos.xyz, 1.), c = projectionMatrix * mv;
      float a = iCol.a * smoothstep(1. + .5 * iPos.w, 2. + 1.6 * iPos.w, -mv.z);
      if (uThin.w > 0. && iPos.y >= 2. && c.w > 0.) a *= .35 + .65 * smoothstep(.12, .4, length((c.xy / c.w - uThin.xy) * vec2(uThin.z, 1.)));
      float sq = length(iShape.xy);
      vec2 q = position.xy, ax = iShape.xy / max(sq, 1e-4);
      q -= ax * dot(q, ax) * sq;
      mv.xy += q * iPos.w;
      vWy = iPos.y + iPos.w * (q.x * viewMatrix[1][0] + q.y * viewMatrix[1][1]);   // this corner's height in the world
      vUv = position.xy; vCol = vec4(iCol.rgb, a); vCell = iCell; vFogXZ = iPos.xz; vBlur = iShape.z;
      gl_Position = projectionMatrix * mv;
    }`;
  const NK_PUFF_FS = `
    uniform sampler2D uPuff; uniform vec3 uLightV; uniform float uCover;   // the sun in view space; < 0: blended over, else premultiplied light that hides this much of what is behind
    varying vec2 vUv; varying vec4 vCol; varying vec4 vCell; varying vec2 vFogXZ; varying float vWy, vBlur;
    #ifdef USE_FOG
      uniform float fogNear; uniform float fogFar;
      uniform vec4 glowPos[ 8 ]; uniform vec4 glowCol[ 8 ]; uniform int glowCount;   // small lights (radial-fog.js)
    #endif
    vec3 fire(float T) {   // by temperature: warm ash, deep red, orange, yellow, pale yellow (white would read as a hole)
      float k = clamp(T, 0., 1.) * 4.;   // (the coolest was near-black soot: the dying fire left a black crust of cracks)
      return k < 1. ? mix(vec3(.5, .38, .3), vec3(.62, .2, .06), k) : k < 2. ? mix(vec3(.54, .14, .04), vec3(.95, .4, .08), k - 1.)
           : k < 3. ? mix(vec3(.95, .4, .08), vec3(1., .7, .22), k - 2.) : mix(vec3(1., .7, .22), vec3(1., .88, .56), k - 3.);
    }
    void main() {
      float d = length(vUv) * 2., cell = max(floor(vCell.x + .5), 0.), s = sin(vCell.y), co = cos(vCell.y);
      vec2 uv = (vec2(mod(cell, 2.), floor(cell / 2.)) + mat2(co, s, -s, co) * vUv + .5) * .5;
      vec4 t = texture2D(uPuff, uv, vBlur), tb = texture2D(uPuff, uv, vBlur + 1.5);   // tb: blurred (both sampled for the discs too: no derivatives in a branch)
      vec3 col = vCol.rgb;
      float a;
      if (vCell.x >= 0.) {   // a billow: a turned atlas cell, its smoke lit by the sun and dark in the hollows, its fire by temperature
        float T = vCell.z, w = vCell.w;
        a = vCol.a * mix(tb.r, t.r, w) * step(d, 1.);   // burning, its edge soft (glowing gas: crisp, the young fireball read as popcorn); its soot crisp
        vec2 n = mat2(co, -s, s, co) * (t.gb * 2. - 1.);   // the cell's normal, turned back to the screen
        vec3 N = vec3(n, sqrt(max(0., 1. - dot(n, n))));
        float k = 1. - .2 * min(vBlur, 2.), dif = max(dot(N, uLightV), 0.);
        col = col * mix(.9 + .15 * dif, .7 + .45 * dif, k) * (1. - .25 * k * t.a) + fire(T) * .3 * T;   // (and the fire's own glow on its smoke; the hollows only a little darker)
        // burning all over, the billows are hottest at their crowns; cooling, the fire sinks into the hollows between
        // them (thr: how deep) in soft patches (crisp, they read as a network of cracks in lava), deepening to red (not
        // on the billow's thin rim: over the grass it would turn olive)
        float ha = mix(t.a, tb.a, w), Tp = T * mix(.75 + .25 * N.z - .3 * tb.a, .7 + .55 * ha, w), thr = 1.3 - 2. * T;   // (hot: orange down its flanks, or the fireball reads as pale cotton)
        col = mix(col, fire(Tp), smoothstep(thr - .2, thr + .15, ha) * mix(1., smoothstep(.5, .9, t.r), w));
      } else a = vCol.a * (1. - smoothstep(.15, 1., d));
      a *= smoothstep(-.05, .6, vWy);
      #ifdef USE_FOG
        float lift = 0.0;
        for ( int i = 0; i < 8; i ++ ) {
          if ( i >= glowCount ) break;
          float gr = glowPos[ i ].w;
          lift = max( lift, glowCol[ i ].a * ( 1.0 - smoothstep( 0.35 * gr, gr, length( vFogXZ - glowPos[ i ].xz ) ) ) );
        }
        a *= 1.0 - smoothstep( fogNear, fogFar, length( vFogXZ ) ) * ( 1.0 - lift );
      #endif
      if (a < .004) discard;
      gl_FragColor = uCover < 0. ? vec4(col, a) : vec4(col * a, a * uCover);
    }`;
  const _nkU = (o) => { const u = {}; for (const k in o) u[k] = { value: o[k] }; return u; };   // {name: value} -> uniforms
  function _nkMat(fs, uniforms, o) {
    return new THREE.ShaderMaterial(Object.assign({ uniforms, vertexShader: NK_VS, fragmentShader: NK_NOISE + fs,
      transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor }, o));
  }
  const _nkRingGeo = new THREE.RingGeometry(.5, 1.12, 192).rotateX(-Math.PI / 2);   // the front's band (scaled out past its glow)

  function _putSprite(sys, x, y, z, size, col, alpha) {   // one sprite into a rebuilt-every-frame system
    if (sys.n >= sys.cap || alpha < .005) return;
    const i = sys.n++, i3 = i * 3;
    sys.pos[i3] = x; sys.pos[i3 + 1] = y; sys.pos[i3 + 2] = z;
    sys.col[i3] = col.r; sys.col[i3 + 1] = col.g; sys.col[i3 + 2] = col.b;
    sys.size[i] = size; sys.alpha[i] = alpha;
  }
  // The sprite systems (NK_PUFF_*), rebuilt every frame (the cloud keeps no per-puff state): the
  // smoke and the fire's body blended over, back to front (_nbPuffs); the hot glows added over them,
  // premultiplied, hiding most of what is behind them (_nbFire: drawn straight to the screen, added
  // light clips to flat white over the fire and tints the grass lime round it); the glow cards, big and
  // pale, blended over under the cloud (_nbGlow). Hidden while empty
  const _nbLightV = { value: new THREE.Vector3() }, _nbThin = { value: new THREE.Vector4() };
  function _nbSys(cap, order, cover, sorted) {
    const geo = new THREE.InstancedBufferGeometry(), at = (k) => new THREE.InstancedBufferAttribute(new Float32Array(cap * k), k).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-.5, -.5, 0, .5, -.5, 0, .5, .5, 0, -.5, .5, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('iPos', at(4)); geo.setAttribute('iCol', at(4)); geo.setAttribute('iCell', at(4)); geo.setAttribute('iShape', at(3));
    geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({ uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      { uPuff: { value: _nbPuffTex }, uLightV: _nbLightV, uCover: { value: cover }, uThin: _nbThin }),
      vertexShader: NK_PUFF_VS, fragmentShader: NK_PUFF_FS, transparent: true, depthWrite: false, fog: true });   // (fog: the renderer keeps its uniforms)
    if (cover >= 0) Object.assign(mat, { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; mesh.renderOrder = order; mesh.visible = false;
    scene.add(mesh);
    const A = geo.attributes, s = { cap, n: 0, mesh, P: A.iPos.array, C: A.iCol.array, L: A.iCell.array, Q: A.iShape.array };
    if (sorted) Object.assign(s, { out: [s.P, s.C, s.L, s.Q], P: new Float32Array(cap * 4), C: new Float32Array(cap * 4), L: new Float32Array(cap * 4), Q: new Float32Array(cap * 3), key: new Float32Array(cap), idx: [] });
    return s;
  }
  const _nbPuffs = _nbSys(1000, 2, -1, true), _nbGlow = _nbSys(16, 1.6, 1), _nbFire = _nbSys(1000, 3, .85);   // (the glow cards under the cloud: over it, they wash out its billows)
  _nbGlow.mesh.material.uniforms.uThin = { value: new THREE.Vector4() };   // (light, not cloud: it does not thin)
  // cell: the puff atlas's (-1: a plain soft disc); near: sorted as this much nearer; T, w: its fire; sx, sy, blur: iShape (NK_PUFF_*)
  function _nbPut(s, x, y, z, size, c, a, cell = -1, turn = 0, near = 0, T = 0, w = 0, sx = 0, sy = 0, blur = 0) {
    if (s.n >= s.cap || a < .004) return;
    const i = s.n++, i4 = i * 4;
    s.P[i4] = x; s.P[i4 + 1] = y; s.P[i4 + 2] = z; s.P[i4 + 3] = size;
    s.C[i4] = c.r; s.C[i4 + 1] = c.g; s.C[i4 + 2] = c.b; s.C[i4 + 3] = a;
    s.L[i4] = cell; s.L[i4 + 1] = turn; s.L[i4 + 2] = T; s.L[i4 + 3] = w;
    s.Q[i * 3] = sx; s.Q[i * 3 + 1] = sy; s.Q[i * 3 + 2] = blur;
    if (s.key) s.key[i] = near;
  }
  function _nbUpload(s, v) {   // v: the view matrix (a sorted system goes back to front)
    const n = s.n, A = s.mesh.geometry.attributes;
    if (s.key) {
      const [P, C, L, Q] = s.out, idx = s.idx;
      idx.length = n;
      for (let i = 0; i < n; i++) { idx[i] = i; s.key[i] += v[2] * s.P[i * 4] + v[6] * s.P[i * 4 + 1] + v[10] * s.P[i * 4 + 2]; }
      idx.sort((a, b) => s.key[a] - s.key[b]);
      for (let j = 0; j < n; j++) {
        const i = idx[j];
        for (let c = 0; c < 4; c++) { P[j * 4 + c] = s.P[i * 4 + c]; C[j * 4 + c] = s.C[i * 4 + c]; L[j * 4 + c] = s.L[i * 4 + c]; }
        for (let c = 0; c < 3; c++) Q[j * 3 + c] = s.Q[i * 3 + c];
      }
    }
    s.mesh.geometry.instanceCount = n;
    if ((s.mesh.visible = n > 0)) for (const a of [A.iPos, A.iCol, A.iCell, A.iShape]) { a.updateRange.count = n * a.itemSize; a.needsUpdate = true; }
  }

  // Fire by temperature (the plain glows; the billows burn in NK_PUFF_FS): dull ember, deep red, orange, yellow,
  // white-hot. The coolest is an ember's glow, not soot: drawn over the scene, soot here left a dark disc
  const _NB_FIRE = [0x6a3018, 0x8a2a0c, 0xf06a18, 0xffb43a, 0xfff0c0].map(c => new THREE.Color(c));
  function _nbFireRamp(T, out) { T = Math.max(0, Math.min(1, T)) * 4; const i = Math.min(3, Math.floor(T)); return out.copy(_NB_FIRE[i]).lerp(_NB_FIRE[i + 1], T - i); }
  // The cloud's smoke: warm ash lit by its fire, as SC2's nuke (never black: charcoal-brown read as a burnt-out
  // black cloud); the stem's foot a little browner. The dust is the field's earth, pale
  const _nbC = new THREE.Color(), _nbC2 = new THREE.Color(), _nbSoot0 = new THREE.Color(0x9a8270), _nbSoot1 = new THREE.Color(0xb4a08a), _nbStemSmoke = new THREE.Color(0xa08a76);
  const _nbDust0 = new THREE.Color(0x9a8266), _nbDust1 = new THREE.Color(0xc2a888);
  const _nbEmb0 = new THREE.Color(0xf0941d), _nbEmb1 = new THREE.Color(0xd11d1d), _nbSuck0 = new THREE.Color(0xffc46a), _nbSuck1 = new THREE.Color(0xff4a10);
  const _nbCell = (i, salt) => Math.floor(_puffHash(i, salt + 1) * 3.999);   // a puff's atlas cell and its turn: fixed per puff
  const _nbTurn = (i, salt, turn) => _puffHash(i, salt) * 6.2831853 + turn;
  const _nbSunW = new THREE.Vector3(), _nbEye = new THREE.Vector3(), _nbN = new THREE.Vector3();
  // The blast's fire and smoke at its age (the desktop's mushroomSprites, taken further). The mushroom's
  // cap is a vortex ring of cauliflower billows: each puff rides round the ring's tube (up the inside, out
  // over the top, down over the rim and back in underneath), slow and heavy, turning a little as it goes,
  // so from above the cap's surface flows out from its heart and curls under at the rim. The young
  // fireball is the same ring, a fat tube with no hole, so its puffs roll straight on into the mushroom as
  // it rises and flattens (nk::). A puff cools as it rolls (hottest coming up the inside, coolest at the
  // rim and underneath): from above, a hot heart, the rolling ring and a darker sooty skirt. It burns
  // white-yellow and orange all over at first; from ~1 s soot takes the billows' crowns and the fire glows
  // on in the hollows between them, sinking into the heart and deepening to red. As in SC2 it is all gone
  // by 5.4 s: no grey cloud lingers, the soot dims out with the fire. Over the ring a dome of hot billows
  // wells up from the heart and spreads into it; under it the stem draws fire up from the ground (grey-brown
  // smoke at its foot). The smoke is lit by the sun and by the scene (lit: dark at night), darker underneath
  // and inside the ring; a billow on the far side of the tube fades out, and one turning over the rim is
  // squashed, seen edge-on. Then the base surge. On GFX LOW the cap, the dome and the stem have half the
  // puffs (the cap's a little larger), the surge's dust a third (a little denser)
  function _nbCloud(b, lit) {
    const t = b.t, low = gfxQuality !== 'HIGH', step = low ? 2 : 1;
    if (t >= nk.SURGE_END) return;   // (the blast lives on for its embers)
    const PI2 = Math.PI * 2, v = camera.matrixWorldInverse.elements, eye = camera.position;
    const g = 1 - Math.exp(-t / .9), fr = nk.fireR(t), gF = _sstep(.6, 2.6, t), m = _sstep(.25, 2.2, t);   // m: the ball has become the ring
    const R = .15 * fr + (nk.capR(t) - .15 * fr) * m, r = .85 * fr + (1.1 * nk.capTube(t) - .85 * fr) * m;   // the ring's radius, its tube
    const sy = 1 - .38 * gF + (.38 * gF - .22) * m, H = nk.capH(t);   // the tube's height / width (the ball flattening as it rises)
    const roll = 1.05 * (t - .5 * (1 - Math.exp(-t / .5)));   // how far it has rolled round the tube: ~1 rad/s once it is going
    const burn = 1 - _sstep(nk.FIRE_OUT0, nk.FIRE_OUT1, t), Tg = 1.12 * Math.exp(-t / 6) * burn;   // the cloud's temperature
    const spread = .15 + .6 * _sstep(.4, 2.6, t);   // how much cooler its rim burns than its heart
    const puff = Math.max(1.05 + 1.65 * g, .7 * fr * (1 - m)) * (low ? 1.3 : 1), fadeIn = Math.min(1, t / .08);   // (the ball's billows big: it reads solid)
    _nbSunW.copy(_sunLight.position).normalize();
    // one billow at (x, y, z) from ground zero, its normal _nbN (world), shade: its smoke's own shadow (alb lit
    // by the sun through it). From 2.8 s a billow whose fire is dying (life: how hot its part of the cloud
    // burns) breaks up and dims out, the rim first, the heart last: the soot goes with the fire. On the ring
    // (ring): fades out on the far side of the tube, squashed at the rim. Burning all over, it is blurred a
    // little: glowing gas has no crisp edge, the soot does
    const put = (k, salt, x, y, z, size, a, T, life, shade, alb, ring, blur = 0) => {
      const n = _nbN, f = ring ? n.dot(_nbEye.set(eye.x - b.x - x, eye.y - y, eye.z - b.z - z).normalize()) : 1, h = .06 * _puffHash(k, salt + 5);
      const go = 1 - _sstep(2.8, 3.8, t) * (1 - _sstep(.3 + h, .55 + h, life));   // (shrinking as it goes: thinned, it turned olive over the grass)
      a *= (ring ? _sstep(-.4, 0, f) : 1) * Math.min(1, 1.6 * go) * fadeIn;   // (the far side hidden: not drawn)
      size *= .5 + .5 * go;
      if (a < .004) return;
      const vx = v[0] * n.x + v[4] * n.y + v[8] * n.z, vy = v[1] * n.x + v[5] * n.y + v[9] * n.z, sq = ring ? .5 * (1 - Math.abs(f)) / Math.max(Math.hypot(vx, vy), 1e-4) : 0;
      // lit by the sun, and by the fireball and the sky on its shadowed sides (.4 there with its own shadow
      // on top took the rim and the underside to near black)
      _nbC.copy(alb).multiplyScalar(lit * (.68 + .45 * Math.max(0, n.dot(_nbSunW))) * (.7 + .3 * shade));
      _nbPut(_nbPuffs, b.x + x, Math.max(y, .35 * size), b.z + z, size, _nbC, a, _nbCell(k, salt), _nbTurn(k, salt, t * (_puffHash(k, salt + 2) - .5) * .8),
        0, T, _sstep(.8, .4, T), vx * sq, vy * sq, blur + 1.2 * _sstep(.6, 1, T));
    };
    for (let k = 0, NT = 120; k < NT; k += step) {   // the ring (golden-angle offsets spread the puffs over its tube)
      const h1 = _puffHash(k, 10), h2 = _puffHash(k, 11), a = PI2 * (k + .4 * h1) / NT, ph = k * 2.39996 - roll + .3 * h2;
      const s = Math.sin(ph), c = Math.cos(ph), rr = R + r * c, ca = Math.cos(a), sa = Math.sin(a);
      const u = (((Math.PI - ph) / PI2) % 1 + 1) % 1;   // along the roll: 0 coming up the inside, .25 over the top, .5 the rim, .75 underneath
      const hot = 1 - _sstep(0, .5, u) + _sstep(.75, 1, u);
      _nbN.set(ca * c, s / sy, sa * c).normalize();   // (the tube is squashed: sy)
      put(k, 12, ca * rr, H + r * sy * s, sa * rr, puff * (.82 + .15 * (1 + s)) * (.85 + .3 * h1), .92, Tg * (1 - spread * (1 - hot)) * (.9 + .2 * h2), Tg * (.55 + .45 * hot),
        (.55 + .225 * (1 + s)) * (.8 + .1 * (1 + c)), _nbC2.copy(_nbSoot0).lerp(_nbSoot1, h1), true, 1.5 * _sstep(-.2, -.8, s));   // (underneath, in its own shadow: blurred)
    }
    for (let k = 0; k < 26; k += step) {   // the dome: hot billows welling up from the heart, spreading out over the top into the ring
      const h1 = _puffHash(k, 20), h2 = _puffHash(k, 21), u = (h1 + t * .16) % 1, ang = PI2 * h2 + .3 * t * (h1 - .5), q = .95 * R * Math.sqrt(u);
      _nbN.set(Math.cos(ang) * .5 * u, 1, Math.sin(ang) * .5 * u).normalize();
      put(k, 22, Math.cos(ang) * q, H + r * sy * (1.05 - .35 * u), Math.sin(ang) * q, puff * (1.25 - .3 * u + .25 * _puffHash(k, 23)), .92 * _sstep(0, .06, u) * (1 - _sstep(.7, 1, u)),
        Tg * (1 - .25 * u), Tg * (1 - .25 * u), 1, _nbC2.copy(_nbSoot0).lerp(_nbSoot1, h2), true);
    }
    const stemIn = _sstep(.4, 1.4, t), stemTop = Math.max(.5, H - .5 * r * sy);
    for (let k = 0; k < 18 && stemIn > 0; k += step) {   // the stem: fire drawn up from the ground into the cap, smoke at its foot
      const u = (_puffHash(k, 30) + t * .3) % 1, ang = PI2 * _puffHash(k, 31) + t * .6, q = (.2 + .6 * (1 - u) ** 2) * _puffHash(k, 32) * (.6 + .4 * m);
      _nbN.set(Math.cos(ang), .3, Math.sin(ang)).normalize();
      put(k, 33, Math.cos(ang) * q, .2 + u * (stemTop - .2), Math.sin(ang) * q, (1 + 1.1 * (1 - u)) * (.6 + .4 * g) * (low ? 1.3 : 1), .7 * stemIn * _sstep(0, .15, u) * (1 - _sstep(.85, 1, u)),
        Tg * (.55 + .45 * u), Tg * (.55 + .45 * u), .8, _nbC2.copy(_nbStemSmoke).lerp(_nbSoot1, u), false);
    }
    // the cap's heart: a knot of flame glowing through the smoke, white-hot while young, then widening into
    // a soft ember glow as it cools (and a faint glow up the stem while it is hot, seen from the side; from
    // above it would read as a stick)
    const heat = Math.exp(-t / 3.6), hk = fadeIn * (1 - _sstep(3.5, 5, t)) * _sstep(.08, .3, heat), widen = 1.6 - .6 * heat;
    for (let i = 0; i < 7 && hk > 0; i++) {
      const a = PI2 * _puffHash(i, 60), q = .25 * R * Math.sqrt(_puffHash(i, 61));
      _nbPut(_nbFire, b.x + Math.cos(a) * q, H + r * sy * (.3 + .5 * _puffHash(i, 62)), b.z + Math.sin(a) * q, (R + .5 * r) * (.6 + .3 * _puffHash(i, 63)) * widen,
        _nbFireRamp(Math.min(1, heat * (1.6 + .4 * _puffHash(i, 64))), _nbC), .12 * hk * (.6 + .4 * heat));
    }
    const stemK = .15 * hk * stemIn * _sstep(.3, .5, heat);
    for (let i = 0; i < 6 && stemK > 0; i++) {
      const f = (i + .5) / 6;
      _nbPut(_nbFire, b.x, .4 + f * (stemTop - .4), b.z, 1.1 + .5 * (1 - f), _nbFireRamp(Math.min(1, heat * (1.6 - .3 * f)), _nbC), stemK);
    }
    // the base surge: a ring of dust rolling out past the kill radius with a burning leading edge
    // (shock-heated dust), the most of it at its front, breaking up and settling as it slows. The
    // bunker stays readable through it (keep)
    const Rd = nk.surgeR(t), Hd = nk.surgeH(t), grow = 1 + .5 * _sstep(1.5, nk.SURGE_END, t);
    const sa = _sstep(.03, .2, t) * (1 - _sstep(2, 4.5, t));
    const rim = Math.exp(-t / 2.2), rimHeat = Math.exp(-t / 1.8), rimIn = _sstep(.03, .15, t);
    const keep = (x, z) => .3 + .7 * _sstep(1.5, 4, Math.hypot(x, z));
    for (let k = 0, NW = 130; k < NW && sa > 0; k += low ? 3 : 1) {
      const h1 = _puffHash(k, 30), h2 = _puffHash(k, 31), h3 = _puffHash(k, 32), h4 = _puffHash(k, 33);
      const a = PI2 * (k + .5 * h1) / NW, q = Rd - (.2 + .25 * Rd) * h2 * h2, x = b.x + Math.cos(a) * q, z = b.z + Math.sin(a) * q;
      _nbC.copy(_nbDust0).lerp(_nbDust1, h3).multiplyScalar(.85 * lit);   // dust: lit by the scene (earthy: on the bright grass grey read as shrubs, pale as smoke)
      _nbPut(_nbPuffs, x, .5 + .55 * Hd * (.3 + .7 * h3) * (1 - .5 * h2), z, (1.6 + .13 * Rd) * (.75 + .5 * h4) * grow, _nbC, .55 * (low ? 1.55 : 1) * sa * keep(x, z), _nbCell(k, 34), _nbTurn(k, 34, t * (h1 - .5) * .8), 0, 0, 0, 0, 0, 3);   // (blurred: soft dust)
    }
    // the burning edge: flames licking along the front, close enough to merge (blended over: added, the
    // yellow would tint the grass lime), sorted a little nearer: the dust rolling behind them does not hide them
    for (let k = 0, NF = 96; k < NF && rim * rimIn > .02; k++) {
      const h1 = _puffHash(k, 50), h3 = _puffHash(k, 52), h4 = _puffHash(k, 53);
      const a = PI2 * (k + .6 * h1) / NF, q = Rd + .2 + .3 * h4, x = b.x + Math.cos(a) * q, z = b.z + Math.sin(a) * q;
      _nbPut(_nbPuffs, x, .45 + .3 * Hd * h3, z, (1.1 + .1 * Rd) * (.8 + .4 * h3), _nbC.copy(_nbDust0).multiplyScalar(lit),
        Math.min(1, 1.1 * Math.min(1, 1.3 * rim) * rimIn * (.5 + .5 * h1)) * keep(x, z), _nbCell(k, 54), _nbTurn(k, 54, t * (h1 - .5) * 2), 2, .35 + .6 * rimHeat * (.6 + .4 * h4), 0, 0, 0, 1);
    }
  }
  // SC2's glow cards: the soft ball of light round the fire for its first 3 s (a white haze, a yellow
  // core, a burst cut short at 1 s), and the flare of the flash. SC2's cards lie flat; from above they
  // read as these soft discs. Drawn straight to the screen (no bloom), their light is dimmed (k)
  function _nbGlowCards(b, ms) {
    if (ms >= 3233) return;
    const K = (tr) => _nbKey(tr, ms), k = .45, cool = K(NB.glowCool);
    const card = (y, size, r, g, bl, a) => { if (size > 0) _nbPut(_nbGlow, b.x, y, b.z, size, _nbC.setRGB(r * k, g * k, bl * k), a); };
    if (ms < 433) card(.9, K(NB.flareSide), 4, 3.88, 3.6, K(NB.flareLight));   // flare
    if (ms >= 333) card(2.6, K(NB.hazeSide), 1.5, 1.425, 1.32, .6 * K(NB.hazeLight));   // haze
    if (ms >= 300) card(2.8, K(NB.coreSide), 2.5, 1.95, .875, .7 * cool);   // core
    if (ms >= 333 && ms < 966) card(3.3, K(NB.burstSide), 3, 2.55, 1.5, .7 * cool);   // burst
  }
  // SC2's fire inrush and embers, at SC2's rates (per s, ms keys): the birth times (ms) of the ones a blast throws
  const _nbBirths = (tr) => { const out = []; for (let ms = tr[0][0], n = 0; ms < tr[tr.length - 1][0]; ms += 5) for (n += _nbKey(tr, ms) * .005; n >= 1; n--) out.push(ms); return out; };
  const NB_INRUSH = _nbBirths([[1533, 0], [1540, 200], [3100, 200], [3110, 0]]), NB_EMBERS = _nbBirths([[866, 0], [1266, 44], [2866, 44], [9100, 0]]);
  // The inrush: streaks pulled in from a ring round ground zero toward a point over it, slowing as they go (drag
  // 4), each three sprites along its path (a streak, stretched by its speed). The embers: small sparks rising
  // slowly off the crater, a disc 2.8 across, orange cooling to red; the later ones live longer
  function _nbSparks(b, ms) {
    for (let k = 0; k < NB_INRUSH.length; k++) {
      const age = (ms - NB_INRUSH[k]) / 1000, life = .45 + .2 * _puffHash(k, 80), f = age / life;
      if (f < 0 || f >= 1) continue;
      const a = Math.PI * 2 * _puffHash(k, 81), r = 1.6 + 3.6 * _puffHash(k, 82), y = .3 + .9 * _puffHash(k, 83);
      const dx = -Math.cos(a) * r, dy = 1 - y, dz = -Math.sin(a) * r, v = (5 + 2 * _puffHash(k, 84)) / Math.hypot(dx, dy, dz), go = (1 - Math.exp(-4 * age)) / 4;
      _nbC.copy(_nbSuck0).lerp(_nbSuck1, f);
      for (let j = 0; j < 3; j++) {
        const m = (go - .03 * j) * v;
        _nbPut(_nbFire, b.x + Math.cos(a) * r + dx * m, y + dy * m, b.z + Math.sin(a) * r + dz * m, .22 - .05 * j + (.05 - .22 + .05 * j) * f, _nbC, (.5 - .12 * j) * (1 - f));
      }
    }
    for (let k = 0; k < NB_EMBERS.length; k++) {
      const late = _sstep(866, 9100, NB_EMBERS[k]), life = 2.5 + 2 * late + 2.6 * _puffHash(k, 90), age = (ms - NB_EMBERS[k]) / 1000, f = age / life;
      if (f < 0 || f >= 1) continue;
      const a = Math.PI * 2 * _puffHash(k, 91), r = 2.8 * Math.sqrt(_puffHash(k, 92));
      _nbPut(_nbFire, b.x + Math.cos(a) * r, .2 + (.7 + 2 * _puffHash(k, 93)) * age, b.z + Math.sin(a) * r, .12 - .08 * f, _nbC.copy(_nbEmb0).lerp(_nbEmb1, f), 1 - f);
    }
    // sparks flung off the cap's rolling rim (1-4.4 s), spiralling up and out round it as they cool
    for (let k = 0, NS = gfxQuality === 'HIGH' ? 64 : 32, t = b.t; k < NS; k++) {
      const born = 1 + 3.4 * _puffHash(k, 120), age = t - born, f = age / (1.1 + .9 * _puffHash(k, 121));
      if (f < 0 || f >= 1) continue;
      const a = Math.PI * 2 * _puffHash(k, 122) + (.3 + .3 * _puffHash(k, 123)) * age, loop = .3 * (1 - f);
      const q = nk.capR(born) + .95 * nk.capTube(born) + (1.2 + 1.6 * _puffHash(k, 124)) * (1 - Math.exp(-age / .5)) + loop * Math.cos(6 * age);
      const y = nk.capH(born) + .2 * nk.capTube(born) + (.6 + 1.2 * _puffHash(k, 125)) * age + loop * Math.sin(6 * age);
      _nbPut(_nbFire, b.x + Math.cos(a) * q, y, b.z + Math.sin(a) * q, .16 - .08 * f, _nbC.copy(_nbEmb0).lerp(_nbEmb1, f), (1 - f) * (.75 + .25 * Math.sin(age * 23 + k)));
    }
  }

  function _nbMake(x, z, seed) {
    const add = (geo, mat, order, y = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.renderOrder = order; m.visible = false; scene.add(m); return m; };
    const glow = (o) => _nbCoverGlow(new THREE.MeshBasicMaterial(Object.assign({ transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide }, o)));
    return {
      burn:   add(_nbQuad, _nkMat(NK_BURN_FS, _nkU({ uC: new THREE.Vector2(x, z), uR: 0, uW: 1, uK: 0, uTime: 0, uSeed: seed })), 1, .06),   // with the ground decals
      wash:   add(_nbQuad, glow({ map: _blastWashTex, color: 0xff8c38 }), 1, .045),
      front:  add(_nkRingGeo, _nkMat(NK_FRONT_FS, _nkU({ uC: new THREE.Vector2(x, z), uR: 0, uW: 1, uI: 0, uTime: 0, uSeed: seed })), 1, .12),
      tori:   [0, 1, 2].map(i => add(_nbTorusGeo, _nkMat(NK_TORUS_FS, _nkU({ uB: 0, uTime: 0, uSeed: seed + 3.1 * i }), { vertexShader: NK_TORUS_VS }), 1)),   // (under the cloud)
      dome:   add(_nbDomeGeo, _nkMat(NK_DOME_FS, _nkU({ uA: 0, uTime: 0 })), 4),
      star:   add(_nbQuad, glow({ map: _nbStarTex }), 4, .8),
      shadow: add(_nbQuad, new THREE.MeshBasicMaterial({ map: _blastWashTex, color: 0, transparent: true, depthWrite: false, fog: false }), 1, .05),
      wilson: add(_nbWilsonGeo, _nkMat(NK_WILSON_FS, _nkU({ uC: new THREE.Vector2(x, z), uCol: new THREE.Color(), uR: 1, uA: 0, uTime: 0, uSeed: seed })), 1.5),   // (under the cap's sprites)
      // the heat haze (renderScene bends the scene by it): the shock bubble, the ripple over the ground, the cap's shimmer, the crater's
      haze:   [_nbDomeGeo, _nbQuadDown, _nbBallGeo, _nbDomeGeo].map((geo, i) => {
        const m = new THREE.Mesh(geo, _nkMat(NK_HAZE_FS, Object.assign(_nkU({ uC: new THREE.Vector2(x, z), uRing: new THREE.Vector2(), uS: 0, uTile: 1, uRise: 0 }), _hz.U),
          { depthTest: false, side: THREE.DoubleSide, blendDst: THREE.OneFactor }));
        m.position.set(x, i === 1 ? .05 : 0, z); m.visible = false; _hz.scene.add(m); return m;
      }),
    };
  }
  function _nbDispose(b) {
    const P = b.parts;
    for (const m of [P.burn, P.wash, P.front, ...P.tori, P.dome, P.star, P.shadow, P.wilson]) { scene.remove(m); m.material.dispose(); }
    for (const m of P.haze) { _hz.scene.remove(m); m.material.dispose(); }
    b.parts = null;
  }
  function _nbPose(b, ms) {
    const P = b.parts, K = (tr) => _nbKey(tr, ms), on = (m, from, to) => (m.visible = ms >= from && ms < to);
    const flat = (m, d, k = 1) => m.scale.set(d, k, d);
    if (on(P.star, 133, 566)) { flat(P.star, K(NB.flashSide)); P.star.material.opacity = K(NB.flashLight); }
    // nk::: the shock front racing over the ground (a soft band of light, not a drawn line) under its dome (gone by 0.8 s)
    const t = b.t, R0 = nk.frontR(t);
    if ((P.front.visible = t < nk.FRONT_END)) {
      const w = .45 + .04 * R0, U = P.front.material.uniforms;
      flat(P.front, Math.max(.05, R0 + 2 * w) / 1.12);   // the band's mesh (r 0.5-1.12) out past its glow
      U.uR.value = R0; U.uW.value = w; U.uTime.value = t;
      U.uI.value = Math.min(1.2, (6 * Math.exp(-t / .3) + .9) * (1 - _sstep(1.2, nk.FRONT_END, t)));
    }
    if ((P.dome.visible = t < .8 && gfxQuality === 'HIGH')) {   // (not on LOW: a faint rim, but the whole screen drawn over)
      const U = P.dome.material.uniforms;
      P.dome.scale.setScalar(2 * Math.max(.05, R0));
      U.uA.value = Math.min(.8, 2.2 * _sstep(0, .04, t) * (1 - _sstep(.2, .8, t))); U.uTime.value = t;
    }
    // SC2's burn ring: burning ground spreading at a steady pace well behind the front, brightest at 1.7 s
    if (on(P.burn, 633, 3000)) {
      const r = K(NB.burnR), w = .9 + .06 * r, U = P.burn.material.uniforms;
      flat(P.burn, 2 * (r + 3 * w));
      U.uR.value = r; U.uW.value = w; U.uK.value = K(NB.burnLight); U.uTime.value = t;
    }
    // the fireball's glow on the ground under it (short: its light lights the field), less in the close-up (it looks across it)
    const wk = nk.heat(t) * (1 - _sstep(1.5, 3.5, t));
    if ((P.wash.visible = wk > .01)) { flat(P.wash, 5.6 * nk.fireR(t)); P.wash.material.opacity = wk * (1 - .5 * _zoom); }
    // the fire tori: SC2's cap is three nested fat rings of rolling fire (the main ring, a smaller one over it,
    // a narrow tall core) on the cap's curves, a faint layer under the sprites
    const h = nk.capH(t), cr = nk.capR(t), tb = nk.capTube(t), B = K(NB.toriLight);
    const tori = [[h, cr, 2 * tb], [h + 1.2, .7 * cr, 1.4 * tb], [h - .4 * tb, .35 * cr, 3.2 * tb]];
    P.tori.forEach((m, i) => {
      if (!on(m, 1100, 4700) || !(m.visible = gfxQuality === 'HIGH')) return;   // (not on LOW: faint under the sprites)
      const [y, r, s] = tori[i], U = m.material.uniforms;
      m.position.y = y; m.scale.set(r, s, r);
      U.uB.value = B * (i === 2 ? .7 : 1) * (1 - _sstep(3.2, 4.2, t)); U.uTime.value = t;   // (gone with the cloud's billows)
    });
    // the heat haze: the shock bubble swelling out to the kill radius (gone by 1.5 s), a ripple running over the
    // ground behind it (to 1.8 s), the shimmer round the cap (0.7-5 s) and over the crater (to 12.3 s, fading
    // with the scar); SC2's keys, its sizes x 1.83 on the ground, x 1.1 for the cap. The shapes are 1 across
    const [hb, hr, hc, hk] = P.haze, ta = t * 1000;
    const haze = (m, S, tile, rise) => { const U = m.material.uniforms; U.uS.value = S; U.uTile.value = tile; U.uRise.value = rise; return (m.visible = S > .01); };
    if (haze(hb, K(NB.hazeBubble), .35, 1.5 * t)) { const d = 1.83 * K(NB.hazeBubbleD); hb.scale.set(d, .9 * d, d); }
    if (haze(hr, K(NB.hazeRipple), .5, 0)) { const r = .915 * K(NB.hazeRippleD), w = .8 + .06 * r; flat(hr, 2 * (r + 2.5 * w)); hr.material.uniforms.uRing.value.set(r, w); }
    if (haze(hc, K(NB.hazeCap), .6, 2.2 * t)) { hc.scale.setScalar(2 * (3.96 + .3 * cr)); hc.position.y = h; }
    if (haze(hk, _nbKey(NB.hazeCrater, ta) * (1 - _sstep(nk.SCAR_END - 5, nk.SCAR_END, t)), .9, .45 * t)) {
      const r = 2 * _nbKey(NB.hazeCraterR, ta); hk.scale.set(r, 2 * _nbKey(NB.hazeCraterH, ta), r);
    }
    // the cap's soft shadow on the ground, cast away from the sun: it tells its height from above (once the
    // fire no longer outshines the sun; none at night). Cast as by a lower sun: from the high one it would
    // hide under the cap, seen from the overview
    const sk = _sstep(1, 2.2, t) * (1 - _sstep(3.3, 4.6, t)) * (1 - _dnLitF);
    if ((P.shadow.visible = sk > .01)) {
      const S = _sunLight.position, k = 1.6 * h / S.y;
      P.shadow.position.set(b.x - k * S.x, .05, b.z - k * S.z);
      flat(P.shadow, 2.6 * (cr + tb));
      P.shadow.material.opacity = .3 * sk;   // (.65 read as black smoke lying on the ground)
    }
    // the condensation (Wilson) ring flashing out round the cap's foot (0.75-2.65 s), lit by the fire at night
    // (not on LOW: a wide ring of noise drawn over the field)
    const tw = t - .75;
    if ((P.wilson.visible = tw > 0 && tw < 1.9 && gfxQuality === 'HIGH')) {
      const U = P.wilson.material.uniforms, Rw = (cr + tb) * (1.1 + 1.5 * (1 - Math.exp(-tw / .55)));
      P.wilson.position.y = h - .4 * tb;
      flat(P.wilson, Rw);
      U.uR.value = Rw; U.uA.value = _sstep(0, .12, tw) * (1 - _sstep(.5, 1.9, tw)); U.uTime.value = t;
      U.uCol.value.setRGB(.92, .94, .97).lerp(_nbC.setRGB(.8, .5, .32), _dnLitF);
    }
  }
  const _nbV = new THREE.Vector3();
  function syncNukeBlasts(dt) {   // live frames: they age in game time
    for (const b of nukeBlasts) { b.t += dt; if (nk.seqMs(b.t) >= NB_END) _nbDispose(b); }
    nukeBlasts = nukeBlasts.filter(b => b.parts);
    _nbPuffs.n = _nbFire.n = _nbGlow.n = 0;
    const lit = 1 - .75 * _dnLitF;
    for (const b of nukeBlasts) { const ms = nk.seqMs(b.t); _nbPose(b, ms); _nbCloud(b, lit); _nbGlowCards(b, ms); _nbSparks(b, ms); }
    syncNukeScars(dt, lit);
    if (nukeBlasts.length) {   // the sun in view space (it lights the puffs), the bunker on screen (the cloud thins over it)
      _nbLightV.value.copy(_sunLight.position).transformDirection(camera.matrixWorldInverse);
      _nbV.set(0, 1, 0).project(camera); _nbThin.value.set(_nbV.x, _nbV.y, camera.aspect, 1);
    }
    for (const s of [_nbPuffs, _nbGlow, _nbFire]) _nbUpload(s, camera.matrixWorldInverse.elements);
    syncNukeFlash();
    syncNukeHaze();
  }
  function clearNukeBlasts() { nukeBlasts.forEach(_nbDispose); nukeBlasts = []; nukeScars.forEach(_dropScar); nukeScars = []; syncNukeBlasts(0); }
  // The nuke's programs, compiled at load (again as the reticle and the warhead load, and when the
  // graphics quality changes them) off a set of its materials kept hidden for good: the first nuke
  // does not stall a frame, and a material disposed with its launch or its blast does not take its
  // program with it (the next nuke would compile it again). The launch's own (designator, warning
  // ring and its night glow, the warhead's trail) are plain MeshBasicMaterials: unlit, one- or
  // two-sided, the reticle's map, the glow's (_glowMat)
  let _nbKeep = null;
  function warmNukeShaders() {
    const hidden = (mat) => { const m = new THREE.Mesh(_nbQuad, mat); m.visible = false; scene.add(m); return m; };
    if (!_nbKeep) {
      _nbKeep = { parts: _nbMake(0, 0, 0), scar: _nbScarMesh(0, 0, 0),
        launch: [{}, { side: THREE.DoubleSide }].map(o => hidden(new THREE.MeshBasicMaterial(Object.assign({ fog: false }, o)))).concat(hidden(_glowMat())) };
      _nbKeep.scar.visible = false;
      for (const t of [_nbPuffTex, _nbStarTex, _blastWashTex]) renderer.initTexture(t);
    }
    if (_nukeTargetTex && !_nbKeep.dot) _nbKeep.dot = hidden(new THREE.MeshBasicMaterial({ map: _nukeTargetTex, fog: false }));
    if (!_nbKeep.missile && (_nbKeep.missile = ModelLoader.clone('nukeMissile'))) { _nbKeep.missile.visible = false; scene.add(_nbKeep.missile); }
    renderer.compile(scene, camera);
    renderer.compile(_hz.scene, camera);   // (the heat haze's: its shapes, the scene bent by them)
  }

  // ── Nuke scars ───────────────────────────────────────────────────────────
  // The pit a blast leaves (NK_SCAR_FS), its cracks opened by the front: kept apart from the blasts
  // (it outlives them, to nk.SCAR_END), at most NUKE_SCARS
  const NUKE_SCARS = 3;
  let nukeScars = [];   // {age: s since the blast, mesh}, oldest first
  function _nbScarMesh(x, z, seed) {
    const mat = _nkMat(NK_SCAR_FS, Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog), _nkU({ uC: new THREE.Vector2(x, z), uAge: 0, uSeed: seed, uFront: 0, uK: 0, uLit: 1 })),
      { fog: true, polygonOffset: true, polygonOffsetFactor: -2, extensions: { derivatives: true } });   // (fog: the renderer keeps its uniforms; fwidth on WebGL 1)
    const m = new THREE.Mesh(_nbQuad, mat);
    m.position.set(x, .03, z); m.scale.set(8.5, 1, 8.5); m.renderOrder = 0;   // before every other transparent: it lies on the ground
    scene.add(m);
    return m;
  }
  function addNukeScar(x, z, seed) {
    if (nukeScars.length >= NUKE_SCARS) _dropScar(nukeScars.shift());
    nukeScars.push({ age: 0, mesh: _nbScarMesh(x, z, seed) });
  }
  function _dropScar(s) { scene.remove(s.mesh); s.mesh.material.dispose(); }
  function syncNukeScars(dt, lit) {
    for (const s of nukeScars) {
      const U = s.mesh.material.uniforms;
      s.age += dt;
      // it shows as the flash dies (not a dark pit under the flash star), fades by nk.SCAR_END
      U.uAge.value = s.age; U.uFront.value = nk.frontR(s.age); U.uLit.value = lit;
      U.uK.value = _sstep(.1, .45, s.age) * (1 - _sstep(nk.SCAR_END - 5, nk.SCAR_END, s.age));
    }
    while (nukeScars.length && nukeScars[0].age >= nk.SCAR_END) _dropScar(nukeScars.shift());
  }

  // ── Nuke flash and heat haze ─────────────────────────────────────────────
  // The flash: the desktop blows the field out to white through its HDR exposure (x6) under a white bloom
  // over ground zero. Here the field whitens, most round ground zero, under a quad drawn
  // over the scene (the HUD stays clear), then dims a little round the fireball as the eyes are dazzled.
  // The ambient light, the fog and the fireball's light (updateNukeLight) surge with it
  const NK_FLASH_VS = `uniform vec3 uPos; varying vec2 vUv; varying vec2 vC;
    void main() { vec4 c = projectionMatrix * viewMatrix * vec4(uPos, 1.); vC = c.xy / max(c.w, 1e-3) * .5 + .5; vUv = position.xy * .5 + .5; gl_Position = vec4(position.xy, 0., 1.); }`;
  const NK_FLASH_FS = `
    uniform float uK, uDim, uAspect;
    varying vec2 vUv; varying vec2 vC;
    void main() {
      vec2 d = (vUv - vC) * vec2(uAspect, 1.);
      float g = exp(-dot(d, d) / .2025);   // the bloom (0.45 of the screen's height)
      float w = 1. - exp(-2.4 * uK * sqrt(uK) - 3. * uK * g);   // (the field comes back before the bloom: half white, the grass reads lime)
      gl_FragColor = vec4(mix(vec3(1., .98, .96), vec3(1., .93, .82), g) * w, 1. - (1. - w) * (1. - uDim * (1. - g)));
    }`;
  const NUKE_FLASH_AMB = 1.5, NUKE_FLASH_FOG = 1;   // the ambient light's and the fog's surge at its peak (at night the field is its fog)
  const _nbFlash = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms: _nkU({ uPos: new THREE.Vector3(), uK: 0, uDim: 0, uAspect: 1 }),
    vertexShader: NK_FLASH_VS, fragmentShader: NK_FLASH_FS, transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor }));
  _nbFlash.frustumCulled = false; _nbFlash.renderOrder = 99; _nbFlash.visible = false;   // (over every other transparent)
  scene.add(_nbFlash);
  let _nbSurged = false;
  function syncNukeFlash() {   // (syncNukeBlasts) the youngest blast's
    let k = 0, dim = 0, b = null;
    for (const n of nukeBlasts) { k = Math.max(k, nk.flashK(n.t)); dim = nk.dazzle(n.t); b = n; }
    const on = k > .002;
    if ((_nbFlash.visible = on || dim > .002)) {
      const U = _nbFlash.material.uniforms;
      U.uPos.value.set(b.x, Math.max(3, nk.capH(b.t)), b.z); U.uK.value = k; U.uDim.value = dim; U.uAspect.value = camera.aspect;
    }
    // the surge, over the day / night lights (_applyDNLights): set again each frame while it lasts, and once after it
    if (!on && !_nbSurged) return;
    _applyDNLights(_dnLitF);
    if (!(_nbSurged = on)) return;
    _ambientLight.color.multiplyScalar(_ambientLight.intensity).add(_nbC.setRGB(1, .97, .92).multiplyScalar(NUKE_FLASH_AMB * k));
    _ambientLight.intensity = 1;
    scene.fog.color.add(_nbC.setRGB(1, .95, .85).multiplyScalar(NUKE_FLASH_FOG * k));
    scene.background.copy(scene.fog.color);
  }

  // The heat haze (the desktop's distortion pass; the shapes are each blast's, posed in _nbPose): while a blast
  // is younger than nk.HAZE_END, the post path's composite bends the scene by them (renderFrame). Without it, the
  // scene, drawn to the canvas as ever, is copied; the haze shapes draw their
  // offsets (NK_HAZE_FS) into a target half the canvas's size in CSS pixels (a quarter on GFX LOW), then their
  // far sides are drawn again over the canvas, each pixel the copy bent by them (_hzBend). Drawn there they are
  // hidden by what the scene drew in front of them (its depth: the bunker, Zerg in the haze or near the lens are
  // not bent), and the canvas keeps its own antialiasing: the switch in and out changes nothing. (The scene
  // drawn into a target of its own, multisampled to keep its edges and resolving its depth, cost ~5 ms a frame
  // more at 2x.) Its targets are made at the launch and freed when the haze is over
  const _hz = { on: false, made: false, ht: null, copy: null, scene: new THREE.Scene(), U: { uAspectInv: { value: 1 } } };   // U: the shapes' shared uniforms
  const _hzBend = new THREE.ShaderMaterial({ uniforms: { tScene: { value: null }, tHaze: { value: null }, uPx: { value: new THREE.Vector2(1, 1) } },
    vertexShader: NK_VS, fragmentShader: `uniform sampler2D tScene, tHaze; uniform vec2 uPx;
      void main() {
        vec2 uv = gl_FragCoord.xy * uPx; vec4 h = texture2D(tHaze, uv);
        vec2 o = (h.xz - h.yw) * ${HZ_RANGE.toFixed(2)};
        if (dot(o, o) < 1e-9) discard;   // (bends nothing)
        gl_FragColor = vec4(texture2D(tScene, uv + o).rgb, 1.);
      }`, side: THREE.BackSide, depthWrite: false });
  _hz.scene.add(Object.assign(new THREE.Mesh(_nbQuad, _hzBend), { visible: false }));   // (kept: its program compiled at load)
  const _hzOrigin = new THREE.Vector2(), _hzSize = new THREE.Vector2();
  function _hzTargets() {   // made, or sized to the canvas
    const s = renderer.getDrawingBufferSize(_hzSize), q = renderer.getPixelRatio() * (gfxQuality === 'HIGH' ? 2 : 4), w = Math.ceil(s.x / q), h = Math.ceil(s.y / q);
    if (!_hz.ht) _hz.ht = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
    if (_hz.ht.width !== w || _hz.ht.height !== h) _hz.ht.setSize(w, h);
    if (!_hz.copy || _hz.copy.image.width !== s.x || _hz.copy.image.height !== s.y) {
      if (_hz.copy) _hz.copy.dispose();
      _hz.copy = Object.assign(new THREE.DataTexture(null, s.x, s.y, THREE.RGBFormat), { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });   // (the canvas has no alpha)
    }
    const U = _hzBend.uniforms;
    U.tScene.value = _hz.copy; U.tHaze.value = _hz.ht.texture; U.uPx.value.set(1 / s.x, 1 / s.y);
    _hz.made = true;
  }
  function prepNukeHaze() {   // (the launch) its targets, ready before the blast
    _hzTargets();
    renderer.setRenderTarget(_hz.ht); renderer.setRenderTarget(null); renderer.initTexture(_hz.copy);
  }
  function syncNukeHaze() {   // (syncNukeBlasts) its targets freed once it is over, or the launch was called off
    _hz.on = nukeBlasts.some(b => b.t < nk.HAZE_END);
    if (!_hz.on && _hz.made && !_nukeInFlight) { _hz.ht.dispose(); _hz.copy.dispose(); _hz.made = false; }
  }
  function renderScene() {   // (loop()) the scene, bent by the heat haze
    renderer.render(scene, camera);
    if (!_hz.on) return;
    _hzTargets();
    const a = renderer.getClearAlpha(), P = camera.projectionMatrix.elements;
    _hz.U.uAspectInv.value = P[0] / P[5];
    renderer.setRenderTarget(_hz.ht); renderer.setClearAlpha(0); renderer.render(_hz.scene, camera); renderer.setClearAlpha(a);   // the offsets (cleared to none)
    renderer.setRenderTarget(null); renderer.copyFramebufferToTexture(_hzOrigin, _hz.copy);
    _hz.scene.overrideMaterial = _hzBend; renderer.autoClear = false;
    renderer.render(_hz.scene, camera);
    _hz.scene.overrideMaterial = null; renderer.autoClear = true;
  }

  // ── Kill / upgrade ────────────────────────────────────────────────────────
  // Zerg blood: Zergling, Roach — fresh → dried
  const BLOOD = { z: [0x3e9a2e, 0x0a2a0c], r: [0xc8601e, 0x3a1200] };
  // A round hitting a Zerg: a little of its blood spurts out the far side along (dx, dz)
  // and falls. (Sparks in the round's colour, flung up and out, read as fireworks.)
  function bloodFx(e, p, dx, dz) {
    const [c0, c1] = BLOOD[e.type === 'r' ? 'r' : 'z'], R = Math.random;
    for (let i = 0; i < 4; i++)
      emitParticle(_smoke, p.x, p.y, p.z, dx * 2.4 + (R() - .5) * 1.4, .6 + R() * 1.8, dz * 2.4 + (R() - .5) * 1.4, .3 + R() * .25, .09, .05, .9, c0, c1, 14, .6, 0);
  }
  // A Zerg dying: a low splash of its blood that lands on the ground (a burst of
  // glowing sparks flung up read as fireworks — a field of them after a nuke)
  function deathFx(e) {
    const r = e.type === 'r', [c0, c1] = BLOOD[r ? 'r' : 'z'], p = e.mesh.position, R = Math.random;
    for (let i = 0; i < (r ? 10 : 7); i++)
      emitParticle(_smoke, p.x, p.y + .35, p.z, (R() - .5) * 2.6, .8 + R() * 2, (R() - .5) * 2.6, .45 + R() * .35, .11, .06, .9, c0, c1, 16, .8, 0);
  }
  // splash: its blood (not for a nuke: burnt); fling: a nuke's victim {zero, delay, vel, spin} (its
  // shock front throws the body: updateCorpses)
  let _killBatch = false;   // a nuke kills a wave in one frame: the HUD once after them (each refresh forces a layout)
  function killEnemy(e,reward,splash=true,fling=null){
    if(e.dead)return; e.dead=true;
    const slowF=slowedEnemies.get(e.mesh.uuid)?.factor??1;   // (a nuke's victim runs on at the pace it had)
    slowedEnemies.delete(e.mesh.uuid);
    if(splash) deathFx(e);
    scene.remove(e.mesh);
    SFX.play(e.type==='r'?'rdie':'zdie');
    if(e.pool&&e.mesh.visible){                       // death animation (instanced corpse)
      if(corpses.length>=CORPSE_CAP) corpses.shift();
      const c={mesh:e.mesh,pool:e.pool,corpse:true,t:0,spin:Math.random()<.5?-1:1};
      if(fling){                                      // burning, it runs on at the bunker (one at the hull writhes there, in its attack pose)
        Object.assign(c, fling, {flung:true, thrown:false, col:[1,1,1], stopR:attackReach(e), fireAcc:Math.random(), smokeAcc:Math.random()});   // (flames out of step)
        const p=e.mesh.position, d=Math.hypot(p.x,p.z);
        if(d>=c.stopR&&d>.01){ const v=e.speed*slowF*60/d; c.run=[-p.x*v,-p.z*v]; c.walk=e.walk; c.stride=e.stride; c.step=e.step; }
      }
      corpses.push(c);
    }
    if(reward){
      score+=e.reward.score; kills++; waveKills++;
      minerals+=e.reward.minerals; gas+=e.reward.gas;
      if(!_killBatch) updateHUD();
      achKill(kills);
    }
  }

  function updateBunkerVisual() {
    if (!bunkerModelRoot) { updatePortraitBunker(); return; }
    // Bunker stages: Lv0-1 original bunker · Lv2 Neosteel frame (Mesh.002) ·
    // Lv3 (max) frame + Shrike turret. Frame panels: blue at Lv2, gold at Lv3
    // (team-colour mask only — tinting the whole mesh hid the texture).
    const tierCol = hpLvl >= 3 ? SHRIKE_GOLD : BUNKER_TEAM_COL;
    bunkerModelRoot.traverse(ch => {
      if (ch.name === 'Mesh.002') {
        ch.visible = hpLvl >= 2;
        ch.userData.teamColor?.setHex(tierCol);
      }
    });
    if (shrikeRoot) shrikeRoot.visible = hpLvl >= 3;
    _fireSpots = null; // the frame changes the surface the fire sits on
    _portCache.clear(); // ...and where the firing slits are
    fitBunkerOccluder(); // ...and what blocks the crate runner's lamp
    updatePortraitBunker(); // sync hologram portrait
  }

  function buy(type){
    const spent0=minerals+gas;
    const s=({
      dmg:  ()=>{if(dmgLvl>=3)return'Damage MAX!';const[m,g]=CFG.dmg_costs[dmgLvl];if(minerals<m||gas<g)return needText(m,g);minerals-=m;gas-=g;dmgLvl++;return`Damage Lv. ${dmgLvl}`;},
      armor:()=>{if(armorLvl>=3)return'Armor MAX!';const[m,g]=CFG.armor_costs[armorLvl];if(minerals<m||gas<g)return needText(m,g);minerals-=m;gas-=g;armorLvl++;return`Armor Lv. ${armorLvl}`;},
      hp:   ()=>{if(hpLvl>=3)return'HP MAX!';const[m,g]=CFG.hp_costs[hpLvl];if(minerals<m||gas<g)return needText(m,g);minerals-=m;gas-=g;hpLvl++;maxHp+=250;bunkerHp=Math.min(bunkerHp+250,maxHp);updateBunkerVisual();updatePortraitBunker();return hpLvl===3?'HP MAX — Shrike turret online, self-repair active!':hpLvl===2?'HP Lv. 2 — Neosteel frame installed':`HP Lv. ${hpLvl}`;},
      ammo: ()=>{if(ammoLvl>=3)return'Ammo MAX!';const[m,g]=CFG.ammo_costs[ammoLvl];if(minerals<m||gas<g)return needText(m,g);minerals-=m;gas-=g;ammoLvl++;maxAmmo+=10;ammo=Math.min(ammo+10,maxAmmo);return ammoLvl===3?'Ammo MAX!':`Ammo Lv. ${ammoLvl} (+10)`;},
      marine:()=>hireUnit('marine'),
    })[type]?.();
    setStatus(s??'Unknown');
    SFX.play(minerals+gas<spent0?'buy':'deny');
    updateHUD();
    achState();
  }

  // ── Wave ─────────────────────────────────────────────────────────────────
  function startWave(){
    // Gentle early ramp: 2, 3, 4, 6, 8, 10, 13, 16, 19, 23, 27 ... then linear
    const ZERGLING_TABLE = [0, 2, 3, 4, 6, 8, 10, 13, 16, 19, 23, 27];
    let zc = wave < ZERGLING_TABLE.length
      ? ZERGLING_TABLE[wave]
      : 27 + (wave - 11) * 4;
    let rc = wave >= CFG.roach_wave
      ? Math.floor((wave - CFG.roach_wave + 1) * 1.8)
      : 0;
    const finalWave = gameMode === 'campaign' && wave === CFG.victory_wave;
    if (finalWave) { zc = Math.round(zc * 1.25); rc = Math.round(rc * 1.25); } // final assault
    // Spawn interval: starts slow (1.4s), gets faster as waves progress (min 0.4s)
    spawnInterval = Math.max(0.4, 1.4 - wave * 0.08);
    spawnQueue = [...Array(zc).fill('z'), ...Array(rc).fill('r')].sort(() => Math.random() - 0.5);
    spawnTimer = 0; wavePhase = 'combat'; waveKills = 0; waveNukes = 0; waveAirs = 0; waveCrates = 0;
    _waveHurt = false;
    const roachMsg = rc > 0 ? ` + ${rc} Roach${rc > 1 ? 'es' : ''}` : '';
    const boostMsg = wave === CFG.metabolic_wave ? ' — Metabolic Boost: Zerglings run faster!' : endlessWaves() ? ` — bunker reinforced ×${endlessWaves()}` : '';
    setStatus(finalWave
      ? `FINAL WAVE ${wave}: ${zc} Zerglings${roachMsg} — hold the line!`
      : `Wave ${wave}: ${zc} Zergling${zc > 1 ? 's' : ''}${roachMsg}${boostMsg}`);
    SFX.play('wave');
  }

  function waveCleared(){
    wavePhase='cleared';
    achWaveCleared(gameMode==='endless', wave, _waveHurt, maxHp>0?bunkerHp/maxHp:0, dnEnabled&&_dnFactor>=.5);
    const bm=40+wave*15, bg=10+wave*5;
    minerals+=bm; gas+=bg; updateHUD();
    setStatus(`Wave ${wave} cleared! +◆${bm} +▲${bg} — ${gameMode==='endless'?'Armory open (B) · resupply incoming...':'Resupply incoming...'}`);
    SFX.play('clear');
    // Game-time sequence: frozen while paused, dropped by Restart/Load.
    after(1.5, ()=>{
      // Countdown: 3... 2... 1... once the magazine is full again
      const countdown=()=>{
        setStatus('Next wave in 3...');
        after(1, ()=>setStatus('Next wave in 2...'));
        after(2, ()=>setStatus('Next wave in 1...'));
        after(3, ()=>{
          wave++;
          reinforce();                                  // Endless: the bunker is reinforced as the swarm grows
          setStatus(`Wave ${wave} — incoming!`);
          startWave();
        });
      };
      // One crate per wave (see resupply): the Viking's crate is still on its way,
      // or already came in — no second crate run
      if(_crateCbs){ awaitCrate(countdown); setStatus('Resupply: the Viking\'s crate restocks the bunker'); return; }
      if(waveCrates>0){ ammo=maxAmmo; updateHUD(); SFX.play('crate'); countdown(); return; }
      const[tx,tz]=randPos();
      makeBeam(tx,tz,0xff8800);
      spawnParts(new THREE.Vector3(tx,.5,tz),0xff8800,14);
      awaitCrate(countdown);
      deliverCrate(tx,tz);
    });
    // Campaign won: the resupply above waits (scheduler is frozen) until the
    // player chooses "Continue · Endless" on the victory screen.
    if (gameMode === 'campaign' && wave >= CFG.victory_wave) campaignVictory(); // writes its own checkpoint
    else autoSave();   // checkpoint: the title screen offers CONTINUE from here
  }

  // Endless reinforcements: waves fought past the campaign's last one (0 in the campaign).
  // Damage and repair scale with it; max HP and the magazine grow by a step each wave.
  function endlessWaves(){ return gameMode==='endless' ? Math.max(0, wave-CFG.victory_wave) : 0; }
  // Max HP and the magazine grow by a step per Endless wave; endlessSteps counts the steps
  // granted, so a resumed checkpoint, an old save or a wave-skipping cheat catches up
  let endlessSteps = 0;
  function reinforce(){
    const n = endlessWaves() - endlessSteps;
    if (n <= 0) return;
    endlessSteps += n;
    maxHp += CFG.endless_hp*n; bunkerHp += CFG.endless_hp*n; maxAmmo += CFG.endless_ammo*n; ammo += CFG.endless_ammo*n;
    floatTexts.push({x:0,y:3.4,z:0,txt:`REINFORCED  +${CFG.endless_hp*n} HP  +${Math.round(CFG.endless_dmg*100*n)}% DMG`,life:2600,maxLife:2600,color:'#ffd24a'});
  }
  const repairMult = () => 1 + CFG.endless_repair * endlessWaves();
  // Endless armory: cost of the next purchase of a kind (+30% each), the cooldown factor,
  // and buying (Endless only, any time — the roster button pulses between waves when one is affordable)
  function armoryCost(key){
    const [m,g]=ARMORY_DEF[key].cost, k=(key==='ammo'?CFG.armory_ammo_growth:CFG.armory_growth)**armory[key];
    return [Math.round(m*k/5)*5, Math.round(g*k/5)*5];
  }
  function armoryCdMult(n=armory.cd){ return Math.max(CFG.armory_cd_min, CFG.armory_cd**n); }
  const strikeCooldown = () => CFG.airstrike_cd*armoryCdMult(), nukeCooldown = () => CFG.nuke_cd*armoryCdMult();
  const armoryAffordable = () => Object.keys(ARMORY_DEF).some(k => { const [m,g]=armoryCost(k); return !ARMORY_DEF[k].maxed?.()&&minerals>=m&&gas>=g; });
  function buyArmory(key){
    const def=ARMORY_DEF[key];
    if(!def||gameMode!=='endless') return;
    if(def.maxed?.()){ setStatus(`${def.name} is maxed`); SFX.play('deny'); return; }
    const [m,g]=armoryCost(key);
    if(minerals<m||gas<g){ setStatus(needText(m,g)); SFX.play('deny'); return; }
    minerals-=m; gas-=g; armory[key]++;
    if(key==='hp'){ maxHp+=CFG.armory_hp; bunkerHp+=CFG.armory_hp; }
    if(key==='ammo'){ maxAmmo+=CFG.armory_ammo; ammo+=CFG.armory_ammo; }
    if(key==='cd'){ airCD=Math.min(airCD,strikeCooldown()); nukeCD=Math.min(nukeCD,nukeCooldown()); }
    setStatus(`${def.name} ×${armory[key]}: ${def.fx()} (total ${def.total(armory[key])})`);
    SFX.play('buy'); updateHUD();
  }

  // Bunker repair per second: the Lv3 hull's self-repair and the Super Stimpack (while
  // stimmed) stack — 25 + 6 = 31 HP/s with both — and Endless reinforcements speed it up
  function repairRate(){
    return ((hpLvl>=3?CFG.repair_rate:0)+(superStimUnlocked&&stimT>0?CFG.superstim_heal:0))*repairMult();
  }

  // ── Shoot ────────────────────────────────────────────────────────────────
  // spread = angular offset (radians) from the muzzle→target direction.
  // The round flies straight from the muzzle (ox, oy, oz) through the aim point
  // at height ty (enemy body height) and keeps going on the same line — so two
  // barrels aimed at one point converge into a V there and cross into an X past
  // it. Height is visual only: hits are tested in the ground plane, as before.
  const AIM_Y = 0.45;
  function makeBulletTyped(tx,tz,spread,unitType,ox=0,oy=1.9,oz=0,ty=AIM_Y){
    const def=UNIT_DEF[unitType];
    const a=Math.atan2(tz-oz,tx-ox)+spread;
    const vx=Math.cos(a)*def.bulletSpeed, vz=Math.sin(a)*def.bulletSpeed;
    const D=Math.hypot(tx-ox,tz-oz), vy=D>0.05?(ty-oy)/D*def.bulletSpeed:0;   // per-frame drop to reach ty at the aim point
    const b={mesh:{position:new THREE.Vector3(ox,oy,oz)},vx,vy,vz,color:def.bulletColor,
             alive:true,dist:0,speed:def.bulletSpeed,unitType,
             len:1.8}; // mesh = position holder; drawn by syncBullets(). len: the streak, alike for every round (bunker and Shrike: as bright; the Shrike's V reads clearly)
    _orientBullet(b);
    return b;
  }
  // yaw + pitch of the tracer from its velocity (local +Z along the flight path)
  function _orientBullet(b){
    const yaw=Math.atan2(b.vx,b.vz), len=Math.hypot(b.vx,b.vy,b.vz)||1, p=-Math.asin(Math.max(-1,Math.min(1,b.vy/len)));
    b.sin=Math.sin(yaw); b.cos=Math.cos(yaw); b.sinP=Math.sin(p); b.cosP=Math.cos(p);
  }

  // Find nearest enemy of a given type (or any) from bunker origin
  function nearestEnemy(preferType) {
    const alive = allEnemies().filter(e => !e.dead);
    const preferred = preferType ? alive.filter(e => e.type === preferType) : [];
    const pool = preferred.length ? preferred : alive;
    if (!pool.length) return null;
    return pool.reduce((best, e) => {
      const d = e.mesh.position.length();
      return (!best || d < best.dist) ? {e, dist: d} : best;
    }, null)?.e;
  }

  // Each click fires one volley: every Marine and Ghost in the bunker shoots once
  // (the Marauders fire on their own: marauderFireTick)
  function shoot(tx,tz){
    if(shootCD>0||wavePhase!=='combat'||ammo<=0)return;
    if(roster.every(u=>u==='marauder')) return;        // nobody to fire it
    if(stimAuto&&stimT<=0) doStim(true);                // autocast: the volley that finds it ready stims first
    ammo--; shootCD=.1;
    const n=roster.length||1;
    const stimExtra=stimT>0&&_stimVolley++%2===0;      // stimmed: +1 round every other volley (+50%)
    roster.forEach((utype,i)=>{
      if(utype==='marauder') return;
      // Each unit fires through its own slit on the wall facing its target
      // (slits fan out ~11° apart); the round leaves from the slit toward the aim point.
      const p=bunkerPort(Math.atan2(tz,tx)+(i-(n-1)/2)*0.2);
      const fire=(spread,dy)=>{
        const b=makeBulletTyped(tx,tz,spread,utype,p.x,p.y+dy,p.z,AIM_Y);
        if(utype==='marine'&&stimT>0) b.color=STIM_COLOR;
        bullets.push(b);
        return b;
      };
      const blt=fire((i-(n-1)/2)*.006,0);
      if(stimExtra&&utype==='marine') fire((i-(n-1)/2)*.006+.02,.05);   // stimmed Marines
      muzzleFlash(p.x,p.y,p.z,blt.vx/blt.speed,blt.vz/blt.speed,UNIT_DEF[utype].bulletColor,false);
    });
    new Set(roster.filter(u=>u!=='marauder')).forEach(u=>SFX.play(u));   // one gunshot voice per unit type
    updateHUD();
    if(ammo===0) setStatus('Out of ammo — R: Airstrike  N: Nuke');
  }

  // ── Marauders: a punisher grenade each every MG_INTERVAL s, on their own ──
  // Not with the volleys; every MG_PER_ROUND grenades (the Marauders' together) cost a round;
  // stimmed, 50% faster. Each picks its target among the enemies in sight (at night: lit, or a
  // Sensor Tower blip) within MG_REACH: the nearest one not slowed yet and outside the blasts
  // already on their way (the grenades in flight), else the nearest not slowed, else the nearest
  // outside them, else the nearest. None: it holds its fire
  const MG_INTERVAL = 0.7, MG_REACH = 14, MG_PER_ROUND = 3;
  function _marauderTarget() {
    const onTheWay = bullets.filter(b => b.alive && b.unitType === 'marauder').map(b => b.aim), blastR = MG_RADIUS[concussiveLvl];
    const pick = [null, null, null, null], pd = [0, 0, 0, 0];
    for (const e of allEnemies()) {
      if (e.dead || !(e.mesh.visible || _sensed(e))) continue;
      const q = e.mesh.position, d = Math.hypot(q.x, q.z);
      if (d > MG_REACH) continue;
      const tier = (slowedEnemies.has(e.mesh.uuid) ? 2 : 0) + (onTheWay.some(t => Math.hypot(t[0] - q.x, t[1] - q.z) < blastR) ? 1 : 0);
      if (!pick[tier] || d < pd[tier]) { pick[tier] = e; pd[tier] = d; }
    }
    const best = pick.find(e => e);
    return best ? [best.mesh.position.x, best.mesh.position.z] : null;
  }
  function marauderFireTick() {
    if (wavePhase !== 'combat') return;
    const n = _count('marauder');
    while (marauderReady.length < n) marauderReady.push(0);
    for (let mi = 0; mi < n; mi++) {
      if (_gameT < marauderReady[mi]) continue;
      const t = _marauderTarget();
      if (!t) { marauderReady[mi] = _gameT + 0.1; continue; }   // look again shortly
      if (_marauderShots % MG_PER_ROUND === 0) {                  // every third grenade costs a round
        if (ammo <= 0) { marauderReady[mi] = _gameT + 0.1; continue; }   // out of ammo: they hold fire too
        if (--ammo === 0) setStatus('Out of ammo — R: Airstrike  N: Nuke');
        updateHUD();
      }
      _marauderShots++;
      if (stimAuto && stimT <= 0) doStim(true);                  // autocast: its attack stims too
      // the next one: a full interval on, nudged apart from the others so they keep a ripple
      marauderReady[mi] = _gameT + MG_INTERVAL / (stimT > 0 ? 1.5 : 1) * (0.94 + 0.12 * Math.random());
      const p = bunkerPort(Math.atan2(t[1], t[0]) + (mi - (n - 1) / 2) * 0.2);
      const b = makeBulletTyped(t[0], t[1], 0, 'marauder', p.x, p.y, p.z, 0.15);
      b.range = Math.min(18, Math.hypot(t[0] - p.x, t[1] - p.z)); b.trail = []; b.aim = t;   // the grenade comes down on its target
      bullets.push(b);
      muzzleFlash(p.x, p.y, p.z, b.vx / b.speed, b.vz / b.speed, UNIT_DEF.marauder.bulletColor, true);
      SFX.play('marauder');
    }
  }

  // ── Input ────────────────────────────────────────────────────────────────
  function groundPt(ex,ey){
    const r=canvas.getBoundingClientRect();
    MV.x=((ex-r.left)/r.width)*2-1; MV.y=-((ey-r.top)/r.height)*2+1;
    RC.setFromCamera(MV,camera);
    const h=RC.intersectObject(groundMesh);
    return h.length?h[0].point:null;
  }
  document.addEventListener('mouseup',e=>{ const bt=e.target.closest&&e.target.closest('button'); if(bt) setTimeout(()=>bt.blur(),0); });
  canvas.addEventListener('wheel',e=>{
    e.preventDefault();                                   // page must not scroll
    zoomView(-Math.max(-300,Math.min(300,e.deltaY))*0.0012); // ~8 wheel notches overview → close-up
  },{passive:false});
  canvas.addEventListener('mousemove',e=>{const r=canvas.getBoundingClientRect();mx=(e.clientX-r.left)/r.width;my=(e.clientY-r.top)/r.height;});
  // Fire: a press fires one volley; held past HOLD_DELAY the button keeps firing
  // at the gun's rate (shootCD) where the pointer is — full auto, which empties
  // the magazine fast. The pointer is captured, so a release off the canvas ends it.
  const HOLD_DELAY=.25;
  let _hold=null;                                   // {id, x, y, t} while the fire button is down
  canvas.addEventListener('pointerdown',e=>{
    if(e.button!==0||!e.isPrimary||phase!=='playing'||isPaused())return;
    _hold={id:e.pointerId,x:e.clientX,y:e.clientY,t:0};
    try{ canvas.setPointerCapture(e.pointerId); }catch(err){}
    // Ghost snipe check first (click on enemy)
    if(snipeUnlocked && trySnipe(e.clientX, e.clientY)) return;
    const pt=groundPt(e.clientX,e.clientY); if(!pt)return;
    if(ammo>0) shoot(pt.x,pt.z);
    else setStatus('No ammo — R: Airstrike  N: Nuke');
  });
  canvas.addEventListener('pointermove',e=>{
    if(!_hold||e.pointerId!==_hold.id) return;
    // Releasing the left button while another is still down sends no pointerup
    if(!(e.buttons&1)){ _hold=null; return; }
    _hold.x=e.clientX; _hold.y=e.clientY;
  });
  ['pointerup','pointercancel','lostpointercapture'].forEach(t=>canvas.addEventListener(t,e=>{ if(_hold&&e.pointerId===_hold.id) _hold=null; }));
  addEventListener('blur',()=>{ _hold=null; });
  function holdFire(dt){                            // live frames only: frozen while paused
    if(!_hold) return;
    _hold.t+=dt;
    if(_hold.t<HOLD_DELAY||shootCD>0||ammo<=0) return;
    const pt=groundPt(_hold.x,_hold.y); if(pt) shoot(pt.x,pt.z);
  }
  // Secret cheat sequence: type 'dotd' (D-O-T-D) at any time during gameplay
  let _cheatBuf = '';
  document.addEventListener('keydown',e=>{
    // When cheat console open, only ESC (even if its input lost focus); the input handles the rest
    if(_cheatOpen){
      if(e.key==='Escape') closeCheat();
      return;
    }
    // Browser shortcuts (Ctrl+1 tab switch, Ctrl+± page zoom, Ctrl+K…) are not game keys
    if(e.ctrlKey||e.metaKey||(e.altKey&&!(e.getModifierState&&e.getModifierState('AltGraph')))) return;
    // A focused button must not be re-triggered by Space/Enter
    if((e.key===' '||e.key==='Enter')&&e.target&&e.target.closest&&e.target.closest('button')){ e.preventDefault(); e.target.blur(); return; }
    // View controls work everywhere except while typing a cheat (handled above)
    if(e.key==='Insert'||e.key==='Delete'){ e.preventDefault(); if(!e.repeat) rotateView(e.key==='Insert'?-1:1); return; } // one step per press
    if(e.key==='Home'){ e.preventDefault(); resetView(); return; }
    if(e.key==='+'||e.key==='='){ zoomView(0.15); return; }
    if(e.key==='-'||e.key==='_'){ zoomView(-0.15); return; }
    if(e.repeat) return; // held keys must not flicker the menu/roster open and shut
    // When menu open, only ESC/M closes it
    if(_menuOpen){
      if(e.key==='Escape'||e.key==='m'||e.key==='M') closeMenu();
      // ↑ ↓ switch tabs (not while the volume slider has the keys)
      else if((e.key==='ArrowUp'||e.key==='ArrowDown')&&!(e.target.matches&&e.target.matches('input[type=range]'))){
        e.preventDefault();
        menuTab(MENU_TABS[(MENU_TABS.indexOf(_menuTab)+(e.key==='ArrowDown'?1:MENU_TABS.length-1))%MENU_TABS.length]);
      }
      return;
    }
    // HUD tour: Enter / Space / → next, ← back, Esc ends it. Hint: Enter / Space /
    // Esc close it; a key it names (R, B, N, T, 1-4, M) closes it and does its job
    if(_tutStep&&_tourI>=0){                   // other keys (F5, F11, Tab...) keep their browser meaning
      if(e.key==='Enter'||e.key===' '||e.key==='ArrowRight'){ e.preventDefault(); tutNext(); }
      else if(e.key==='ArrowLeft'){ e.preventDefault(); tutBack(); }
      else if(e.key==='Escape'){ e.preventDefault(); tutDismiss(); }
      return;
    }
    if(_tutStep){
      if(e.key==='Enter'||e.key===' '||e.key==='Escape'){ e.preventDefault(); tutDismiss(); return; }
      if(!(_tutStep.keys||[]).includes(e.key.toLowerCase())) return;
      tutDismiss();
    }
    // Title / game-over screen: only the menu (for Load and settings)
    if(phase!=='playing'){
      if(e.key==='m'||e.key==='M'||e.key==='Escape') openMenu();
      return;
    }
    // When roster open, only ESC/B closes it
    if(rosterPaused){
      if(e.key==='Escape'||e.key==='b'||e.key==='B') G.closeRoster();
      return;
    }
    if(e.key>='1'&&e.key<='4') buy(['dmg','armor','hp','ammo'][+e.key-1]); // upgrade hotkeys
    if(e.key==='k'||e.key==='K') toggleMute();
    if(e.key==='r'||e.key==='R') doAirstrike();
    if(e.key==='n'||e.key==='N') doNuke();
    if((e.key==='t'||e.key==='T')&&!_cheatBuf.endsWith('do')) doStim();   // T = Stimpack (not while typing "dotd")
    if(e.key==='b'||e.key==='B') G.openRoster();   // B = Bunker roster
    if(e.key==='q'||e.key==='Q') toggleGfx();      // Q = toggle graphics quality
    if(e.key==='m'||e.key==='M') openMenu();        // M = menu
    if(e.key==='y'||e.key==='Y') toggleDayNight(); // Y = day/night toggle
    if(e.key==='Escape') openMenu();               // (roster/menu/cheat cases handled above)
    // Secret cheat sequence
    _cheatBuf = (_cheatBuf + e.key.toLowerCase()).slice(-4);
    if(_cheatBuf === 'dotd') { _cheatBuf=''; G.openCheat(); }
  });

  // ── HUD ──────────────────────────────────────────────────────────────────
  function $(id){return document.getElementById(id);}
  // SC2 resource icons for every cost / gain / shortfall shown in HTML.
  // Status messages are written with ◆ (minerals) and ▲ (gas); setStatus swaps in the icons.
  const MIN_ICON = `<img class="ri" src="${UI_ICONS.mineral}" alt="minerals">`;
  const GAS_ICON = `<img class="ri" src="${UI_ICONS.gas}" alt="gas">`;
  // "[mineral] 250 [gas] 150"; omitZero drops a zero part (for shortfalls)
  function resHTML(m, g, omitZero) {
    return [m || !omitZero ? MIN_ICON + Math.ceil(m) : '', g || !omitZero ? GAS_ICON + Math.ceil(g) : ''].filter(Boolean).join(' ');
  }
  const shortfallHTML = (m, g) => resHTML(Math.max(0, m - minerals), Math.max(0, g - gas), true);
  // Status text for a purchase that is short (the ◆ / ▲ markers become icons)
  function needText(m, g) {
    const nm = Math.max(0, Math.ceil(m - minerals)), ng = Math.max(0, Math.ceil(g - gas));
    return 'Not enough — need ' + [nm ? '◆' + nm : '', ng ? '▲' + ng : ''].filter(Boolean).join(' ') + ' more';
  }
  function setStatus(t){
    const html = String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
      .replace(/◆/g, () => MIN_ICON).replace(/▲/g, () => GAS_ICON);
    const el1=$('tv-status');
    if(el1){ el1.innerHTML=html; el1.classList.remove('flash'); void el1.offsetWidth; el1.classList.add('flash'); }
    const el2=$('con-status-text'); if(el2) el2.innerHTML=html;
  }
  function flash(id){
    const el=$(id);
    if(!el) return;
    el.style.transition='opacity 0.05s';
    el.style.opacity='1';
    // Nuke: bright flash then slow fade
    if(id.includes('nuke')){
      setTimeout(()=>{el.style.transition='opacity 0.6s';el.style.opacity='0';},80);
    } else {
      setTimeout(()=>{el.style.transition='opacity 0.3s';el.style.opacity='0';},100);
    }
  }

  // ── Hologram portrait (2D wireframe projector) ───────────────────────────────
  // The bunker's feature edges are extracted once from the loaded model and
  // projected onto the 2D portrait canvas every frame. This deliberately uses
  // NO second WebGL context: that context could be lost (GPU reset, sleep,
  // too many contexts) and its restore path left a frozen copy of the old
  // hologram on screen, so upgrades stopped showing up.
  // Base edges = green structure. Upgrade edges (Mesh.002, the HP-upgrade
  // plates) = tier-coloured overlay drawn additively on top, with a
  // "materialize" animation when the upgrade appears.
  let _pCtx = null, _pW = 0, _pH = 0, _pDpr = 1;
  let _pBase = null, _pUpg = null, _pTur = null; // Float32Array segment endpoints (x0,y0,z0,x1,y1,z1,…), normalised space
  let _pTurPivot = [0, 0];   // turret yaw pivot (x, z) in normalised space
  let _pAngle = 0;
  let _pUpgradeTarget = 0;   // desired frame strength (0 hidden → 1 shown), HP Lv2+
  let _pUpgradeAnim   = 0;   // current animated value (eased toward target)
  let _pTurTarget = 0, _pTurAnim = 0; // same for the Shrike turret, HP Lv3
  let _pBuilt = false;       // edge sets built yet?
  let _pBuildTried = false;  // build in-flight?
  let _pRetry = 0;           // retry timer (s)
  let _pRedraw = 0;          // time until next portrait redraw (s)
  const _pVP = new THREE.Matrix4(), _pM = new THREE.Matrix4(), _pMVP = new THREE.Matrix4();
  const _pM2 = new THREE.Matrix4(), _pM3 = new THREE.Matrix4(), _pM4 = new THREE.Matrix4();

  // Upgrade hologram colours: frame blue at Lv2, frame + turret gold at Lv3 (as in 3D).
  const _HOLO_BLUE = '#44aaff', _HOLO_GOLD = '#ffd24a';

  function initPortrait() {
    const pc = document.getElementById('portrait-canvas');
    if (!pc || _pCtx) return;
    _pW = pc.width; _pH = pc.height;               // CSS size (from the width/height attributes)
    _pDpr = Math.min(window.devicePixelRatio || 1, 2);
    pc.width = Math.round(_pW * _pDpr); pc.height = Math.round(_pH * _pDpr);
    _pCtx = pc.getContext('2d');

    // Fixed projector camera (same framing as the old 3D portrait scene).
    const cam = new THREE.PerspectiveCamera(45, _pW / _pH, 0.1, 50);
    cam.position.set(1.6, 1.2, 1.6);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    _pVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    _tryBuildPortrait();
  }

  function _tryBuildPortrait() {
    if (_pBuilt || _pBuildTried || !_pCtx) return;
    _pBuildTried = true;
    ModelLoader.load('bunker')
      .then(t => _buildPortraitMesh(t))
      .catch(err => {
        // Model unavailable (e.g. opened via file://) — show the outline of the
        // procedural bunker instead, and say so in the console.
        console.warn('Hologram: bunker model failed to load, using box outline.', err);
        _buildPortraitMesh(null);
      });
  }

  // Extract feature edges from the bunker template (null → procedural box
  // outline) into flat segment arrays: base structure, Mesh.002 frame and —
  // when its model is loaded — the Shrike turret seated on the roof.
  function _buildPortraitMesh(template) {
    const baseChunks = [], upgChunks = [], turChunks = [];
    let turY = null;
    if (template && ModelLoader.isReady('shrike')) {
      const tur = ModelLoader.clone('shrike');
      turY = _shrikeMountY(template);
      tur.position.y += turY;
      tur.updateMatrixWorld(true);
      tur.traverse(ch => {
        if (!ch.isMesh || !ch.geometry?.attributes.position) return;
        const wGeo = ch.geometry.clone(); wGeo.applyMatrix4(ch.matrixWorld);
        const pos = new THREE.EdgesGeometry(wGeo, 12).attributes.position; // dense model: coarser edge angle
        wGeo.dispose();
        if (pos && pos.count) turChunks.push(pos.array);
      });
    }
    if (template) {
      template.updateMatrixWorld(true); // template is scene-less; compute world matrices
      template.traverse(ch => {
        if (!ch.isMesh || !ch.geometry || !ch.geometry.attributes.position) return;
        // Bake the mesh's world transform so every part shares one space.
        const wGeo = ch.geometry.clone();
        wGeo.applyMatrix4(ch.matrixWorld);
        const pos = new THREE.EdgesGeometry(wGeo, 5).attributes.position;
        wGeo.dispose();
        if (!pos || pos.count === 0) return;
        (ch.name === 'Mesh.002' ? upgChunks : baseChunks).push(pos.array);
      });
    }
    if (!baseChunks.length && !upgChunks.length) {
      baseChunks.push(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.4, 0.9, 1.4)).attributes.position.array);
    }
    const concat = chunks => {
      const out = new Float32Array(chunks.reduce((n, a) => n + a.length, 0));
      let o = 0; chunks.forEach(a => { out.set(a, o); o += a.length; });
      return out;
    };
    const base = concat(baseChunks), upg = concat(upgChunks), tur = concat(turChunks);

    // Centre + scale so the model fills the projector view. The box covers every
    // stage (base + frame + turret) so the framing never jumps on an upgrade.
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    [base, upg, tur].forEach(a => { for (let i = 0; i < a.length; i += 3) box.expandByPoint(v.set(a[i], a[i+1], a[i+2])); });
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const sc = 2.2 / (Math.max(size.x, size.y, size.z) || 1);
    _pTurPivot = [-center.x * sc, -center.z * sc];
    [base, upg, tur].forEach(a => {
      for (let i = 0; i < a.length; i += 3) {
        a[i]   = (a[i]   - center.x) * sc;
        a[i+1] = (a[i+1] - center.y) * sc + 0.25;
        a[i+2] = (a[i+2] - center.z) * sc;
      }
    });

    _pBase = base; _pUpg = upg.length ? upg : null; _pTur = tur.length ? tur : null;
    _pBuilt = true;
    updatePortraitBunker(true); // sync immediately to current state (no anim)
  }

  // Sync the hologram to the current HP-upgrade level. `instant` skips the
  // materialize animation (used on build and on game reset).
  function updatePortraitBunker(instant) {
    _pUpgradeTarget = (hpLvl >= 2) ? 1 : 0;   // Lv2: Neosteel frame
    _pTurTarget     = (hpLvl >= 3) ? 1 : 0;   // Lv3: Shrike turret
    if (instant) { _pUpgradeAnim = _pUpgradeTarget; _pTurAnim = _pTurTarget; }
    _updateHoloBezel();
    if (!_pBuilt) _tryBuildPortrait(); // self-heal if init ran before model cached
  }

  // Project segment endpoints with _pMVP and stroke them as one path.
  function _strokeSegments(a) {
    const e = _pMVP.elements, ctx = _pCtx, W = _pW, H = _pH;
    ctx.beginPath();
    for (let i = 0; i < a.length; i += 6) {
      const x0 = a[i], y0 = a[i+1], z0 = a[i+2], x1 = a[i+3], y1 = a[i+4], z1 = a[i+5];
      const w0 = e[3]*x0 + e[7]*y0 + e[11]*z0 + e[15];
      const w1 = e[3]*x1 + e[7]*y1 + e[11]*z1 + e[15];
      if (w0 <= 0 || w1 <= 0) continue; // behind the projector
      ctx.moveTo(((e[0]*x0 + e[4]*y0 + e[8]*z0 + e[12]) / w0 * 0.5 + 0.5) * W,
                 (0.5 - (e[1]*x0 + e[5]*y0 + e[9]*z0 + e[13]) / w0 * 0.5) * H);
      ctx.lineTo(((e[0]*x1 + e[4]*y1 + e[8]*z1 + e[12]) / w1 * 0.5 + 0.5) * W,
                 (0.5 - (e[1]*x1 + e[5]*y1 + e[9]*z1 + e[13]) / w1 * 0.5) * H);
    }
    ctx.stroke();
  }

  function tickPortrait(dt) {
    if (!_pCtx) return;

    // Lazy/self-healing build (covers any init-before-model-ready ordering).
    if (!_pBuilt) {
      _pRetry += dt;
      if (_pRetry > 0.4) { _pRetry = 0; _tryBuildPortrait(); }
    }

    _pAngle += dt * 0.45;

    // Ease the upgrade materialize value toward its target (in faster, out slower).
    const spd = dt * 3.2;
    const ease = (a, t) => a < t ? Math.min(t, a + spd) : a > t ? Math.max(t, a - spd * 1.6) : a;
    _pUpgradeAnim = ease(_pUpgradeAnim, _pUpgradeTarget);
    _pTurAnim     = ease(_pTurAnim, _pTurTarget);

    // Redraw at ~30 Hz — the projector spins slowly, so this halves its cost.
    _pRedraw -= dt;
    if (_pRedraw > 0) return;
    _pRedraw = 1 / 30;

    const ctx = _pCtx;
    ctx.setTransform(_pDpr, 0, 0, _pDpr, 0, 0);
    ctx.clearRect(0, 0, _pW, _pH);
    if (!_pBase) return;
    ctx.lineWidth = 0.8;

    // Base structure — green, always visible.
    _pM.makeRotationY(_pAngle);
    _pMVP.multiplyMatrices(_pVP, _pM);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = '#00ff88';
    _strokeSegments(_pBase);

    // Upgrades — additive on top, rising gently as they form.
    const pulse = 0.80 + 0.20 * Math.sin(performance.now() * 0.005);
    ctx.globalCompositeOperation = 'lighter';
    if (_pUpg && _pUpgradeAnim > 0.001) {        // Neosteel frame: blue (Lv2) / gold (Lv3)
      _pM.makeRotationY(_pAngle).setPosition(0, (1 - _pUpgradeAnim) * 0.1, 0);
      _pMVP.multiplyMatrices(_pVP, _pM);
      ctx.globalAlpha = _pUpgradeAnim * pulse;
      ctx.strokeStyle = hpLvl >= 3 ? _HOLO_GOLD : _HOLO_BLUE;
      _strokeSegments(_pUpg);
    }
    if (_pTur && _pTurAnim > 0.001) {            // Shrike turret: gold, tracks its target like the real one
      const [px, pz] = _pTurPivot;
      _pM.makeRotationY(_pAngle)
         .multiply(_pM2.makeTranslation(px, (1 - _pTurAnim) * 0.12, pz))
         .multiply(_pM3.makeRotationY(_shrikeYaw))
         .multiply(_pM4.makeTranslation(-px, 0, -pz));
      _pMVP.multiplyMatrices(_pVP, _pM);
      ctx.globalAlpha = _pTurAnim * pulse;
      ctx.strokeStyle = _HOLO_GOLD;
      _strokeSegments(_pTur);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // Light up the projector bezel (tier dots + status text) to match HP-upgrade level.
  function _updateHoloBezel() {
    const dots = document.querySelectorAll('#holo-tier .ht-dot');
    dots.forEach((d, i) => d.classList.toggle('on', i < hpLvl));
    const st = document.getElementById('holo-status');
    if (st) {
      if      (hpLvl >= 3) { st.textContent = '\u25C8 FORTIFIED';  st.style.color = '#ffd24a'; }
      else if (hpLvl >= 1) { st.textContent = '\u25C8 REINFORCED'; st.style.color = '#66ddff'; }
      else                 { st.textContent = '\u25C8 ONLINE';     st.style.color = '#44ff88'; }
    }
  }



  function _updateUpgradeChips() {
    const chips = [
      { id:'upg-dmg',   lvl:dmgLvl,       show:true },
      { id:'upg-armor', lvl:armorLvl,      show:true },
      { id:'upg-hp',    lvl:hpLvl,         show:true },
      { id:'upg-ammo',  lvl:ammoLvl,       show:true },
      { id:'upg-conc',  lvl:concussiveLvl, show:concussiveUnlocked },
      { id:'upg-snipe', lvl:snipeLvl,      show:snipeUnlocked },
      { id:'upg-sensor', lvl:sensorLvl,    show:sensorLvl>=1 },
      { id:'upg-superstim', lvl:superStimLvl, show:superStimUnlocked },
      { id:'upg-shrike',    lvl:3,         show:hpLvl>=3 },            // Shrike turret (hull Lv3)
    ];
    chips.forEach(c => {
      const el = document.getElementById(c.id);
      if (!el) return;
      el.style.display = c.show ? 'flex' : 'none';
      el.classList.toggle('active', c.lvl > 0);
      el.classList.toggle('maxed',  c.lvl >= 3);
      el.querySelectorAll('.upg-pip').forEach((pip, i) => pip.classList.toggle('on', i < c.lvl));
    });
    const en = endlessWaves(), ec = $('upg-endless');
    const bought = Object.keys(ARMORY_DEF).filter(k => armory[k]).map(k => ARMORY_DEF[k].total(armory[k]));
    if (ec) {
      ec.style.display = en || bought.length ? 'flex' : 'none';
      $('upg-endless-n').textContent = en ? '+' + en : '';
      ec.title = [en && `Endless reinforcements ×${en}: damage +${Math.round(CFG.endless_dmg * en * 100)}%, max HP +${CFG.endless_hp * en}, repair +${Math.round(CFG.endless_repair * en * 100)}%, magazine +${CFG.endless_ammo * en}`,
                  bought.length && 'Armory: ' + bought.join(', ')].filter(Boolean).join('\n');
    }
    const od = shrikeOverdrive(), sh = $('upg-shrike');
    if (sh) { sh.classList.toggle('od', od); sh.title = od ? 'Shrike overdrive — six Marines inside: rate of fire ×2.5' : 'Shrike turret — auto-fire, firepower of 2 marines'; }
    const sn = $('upg-sensor');
    if (sn) sn.title = `Sensor Tower — blips out to ${SENSOR_RANGE[sensorLvl]}`;
    // Ten chips shown (Sensor Tower with all the others) take a fourth column: four rows overflow the console
    const box = $('con-upgrades');
    if (box) box.classList.toggle('wide', [...box.children].filter(c => c.style.display !== 'none').length > 9);
  }

  // DOM caches: slot pips are rebuilt only when the roster changes; text and
  // HTML writes are skipped when unchanged.
  let _slotSig=null, _slotBarSig=null;
  const _hudText=new Map(), _hudHTML=new Map(); // id → last value written
  let _lastMin=0, _lastGas=0;
  function _pop(id){ const e=$(id); if(!e) return; e.classList.remove('pop'); void e.offsetWidth; e.classList.add('pop'); }
  function _setHTML(id,h){ if(_hudHTML.get(id)===h) return; _hudHTML.set(id,h); const e=$(id); if(e) e.innerHTML=h; }
  function _setSrc(id,src){ const e=$(id); if(e&&e.getAttribute('src')!==src) e.src=src; }
  // Command card button state: disabled / ready pulse / radial cooldown sweep
  function _cmdState(id,o){
    const b=$(id); if(!b) return;
    b.classList.toggle('disabled',!!o.disabled); b.classList.toggle('ready',!!o.ready);
    const cd=$(id+'-cd'); if(!cd) return;
    const on=o.cd>0||!!o.cdText;
    cd.classList.toggle('on',on);
    if(on){ cd.style.setProperty('--p',Math.max(0,Math.min(1,o.cd||0)).toFixed(3)); const t=String(o.cdText??''); if(cd.textContent!==t) cd.textContent=t; }
  }
  // HP / AMMO bars: no segment tick under the label or the value (css .ticks mask); the
  // spans are watched, so the mask follows the value's width as its digits come and go
  const _barMask=new ResizeObserver(es=>es.forEach(({target})=>{
    const bar=target.parentNode, l=bar.querySelector('.bar-l'), v=bar.querySelector('.bar-v');
    bar.style.setProperty('--ml',(l.offsetLeft+l.offsetWidth+2)+'px');
    bar.style.setProperty('--mr',(bar.clientWidth-v.offsetLeft+2)+'px');
  }));
  document.querySelectorAll('.bar .bar-l,.bar .bar-v').forEach(s=>_barMask.observe(s));

  function updateHUD(){
    const set=(id,v)=>{v=String(v);if(_hudText.get(id)===v)return;_hudText.set(id,v);const e=document.getElementById(id);if(e)e.textContent=v;};
    const rk=getRank(kills), camp=gameMode==='campaign';

    // ── Top bar ──
    set('tv-wave', wave);
    set('tv-wave-max', camp ? '/'+CFG.victory_wave : ' ∞');
    set('tv-score', score);
    set('tv-kills', kills);
    const t=Math.floor(_gameT); set('tv-time', Math.floor(t/60)+':'+String(t%60).padStart(2,'0'));
    set('tv-mode', camp ? 'CAMPAIGN' : 'ENDLESS'); $('tv-mode')?.classList.toggle('endless', !camp);
    set('tv-cheat', _run.legacy ? 'OLD SAVE' : 'CHEATS'); $('tv-cheat').hidden = !(_run.cheated && phase !== 'menu');   // achievements off: a cheat, or a save from before them
    set('tv-rank', rk.name); const rkTop=$('tv-rank'); if(rkTop) rkTop.style.color=rk.color;
    // (tv-status is owned by setStatus)

    // ── Centre: HP bar (ticks every 250 HP) ──
    const hpPct=Math.max(0,Math.min(1,bunkerHp/maxHp));
    const hpBar=$('hp-bar');
    if(hpBar){
      $('con-hp-fill').style.width=(hpPct*100)+'%';
      hpBar.classList.toggle('mid',hpPct<=.5&&hpPct>.25); hpBar.classList.toggle('low',hpPct<=.25);
      hpBar.style.setProperty('--tick',(250/maxHp*100)+'%');
    }
    const rr=bunkerHp<maxHp?repairRate():0;   // repairing: show the stacked rate
    set('con-hp-nums', Math.max(0,Math.round(bunkerHp))+' / '+Math.round(maxHp)+(rr>0?'  +'+Math.round(rr)+'/s':''));
    // ── Centre: ammo bar (one tick per round — no per-round DOM pips) ──
    const ammoBar=$('ammo-bar');
    if(ammoBar){
      const ap=maxAmmo?Math.min(1,ammo/maxAmmo):0;
      $('con-ammo-fill').style.width=(ap*100)+'%';
      ammoBar.style.setProperty('--tick',(100/Math.max(1,maxAmmo))+'%');
      ammoBar.classList.toggle('low',ammo>0&&ap<=.2); ammoBar.classList.toggle('empty',ammo<=0);
    }
    set('con-ammo-nums', ammo+' / '+maxAmmo);
    set('con-armor', 'ARMOR '+armorLvl);

    // ── Centre: Slot pips (rebuild only when roster changes) ──
    const cpips=document.getElementById('con-slot-pips');
    if(cpips){
      const od=shrikeOverdrive(), sig=roster.join(',')+(hpLvl>=3?'+T':'')+(od?'!':'');
      if(sig!==_slotSig){
        _slotSig=sig;
        cpips.innerHTML='';
        let used=0;
        roster.forEach(u=>{
          const p=document.createElement('div');
          p.className='csp '+u; p.title=UNIT_DEF[u].name;
          cpips.appendChild(p);
          used+=UNIT_DEF[u].slots;
        });
        for(let i=used;i<6;i++){
          const p=document.createElement('div');
          p.className='csp empty';
          cpips.appendChild(p);
        }
        if(hpLvl>=3) for(let i=0;i<2;i++){            // Shrike turret = 2 extra (automatic) marines
          const p=document.createElement('div');
          p.className='csp turret'+(od?' od':'');
          p.title=od?'Shrike overdrive — six Marines inside: rate of fire ×2.5':'Shrike turret — auto-fire, firepower of 2 marines';
          cpips.appendChild(p);
        }
        set('con-slot-count', used+'/6'+(hpLvl>=3?(od?' +2 ×2.5':' +2'):''));
      }
    }

    // ── Centre: resources (pop when they rise) + rank ──
    const mi=Math.round(minerals), ga=Math.round(gas);
    if(mi>_lastMin) _pop('res-min'); if(ga>_lastGas) _pop('res-gas');
    _lastMin=mi; _lastGas=ga;
    set('cr-min', mi); set('cr-gas', ga);
    const rb=$('con-rank-badge');
    if(rb){ set('con-rank-name', rk.name); rb.style.color=rk.color; rb.style.borderColor=rk.color+'66'; }

    // ── Left panel: wave + campaign progress ──
    set('cw-wave', wave); set('cw-wave-max', camp ? '/'+CFG.victory_wave : '∞');
    const prog=$('cw-prog');
    if(prog){
      prog.classList.toggle('endless', !camp);
      if(camp) prog.style.width=Math.min(100,((wave-1)+(wavePhase==='combat'?0:1))/CFG.victory_wave*100)+'%';
    }

    // ── Upgrade chips ──
    _updateUpgradeChips();

    // ── Command card: abilities ──
    const airBlocked=airCD>0||ammo>0||wavePhase!=='combat';
    _cmdState('cmd-air',{disabled:airBlocked, ready:!airBlocked, cd:airCD>0?airCD/strikeCooldown():0, cdText:airCD>0?Math.ceil(airCD):''});
    const nukeLocked=wave<CFG.nuke_wave, nukeReady=!nukeLocked&&nukeCD===0&&!_nukeInFlight;
    const stimOn=stimT>0, stimReady=stimUnlocked()&&!stimOn&&(!stimCost()||bunkerHp>stimCost())&&wavePhase==='combat';
    _cmdState('cmd-stim',{disabled:!stimReady&&!stimOn, ready:stimReady,
      cd:stimOn?stimT/CFG.stim_duration:!stimUnlocked()?1:0, cdText:stimOn?Math.ceil(stimT):!stimUnlocked()?stimNeed()+'M':''});
    $('cmd-stim')?.classList.toggle('stim-on',stimOn);
    $('cmd-stim')?.classList.toggle('autocast',stimAuto);   // SC2's autocast mark (css)
    $('cmd-roster')?.classList.toggle('ready',gameMode==='endless'&&wavePhase!=='combat'&&phase==='playing'&&armoryAffordable());   // Endless: shop before the next wave
    _cmdState('cmd-nuke',{disabled:!nukeReady, ready:nukeReady,
      cd:nukeLocked?1:nukeCD>0?nukeCD/nukeCooldown():0, cdText:nukeLocked?'W'+CFG.nuke_wave:nukeCD>0?Math.ceil(nukeCD):''});

    // ── SC2 button art that follows the level: Infantry Weapons 0-3, ammo storage tiers, Super Stimpack ──
    _setSrc('cmd-dmg-ico', UI_ICONS.dmg[dmgLvl]); _setSrc('upg-dmg-ico', UI_ICONS.dmg[dmgLvl]);
    _setSrc('cmd-ammo-ico', UI_ICONS.ammo[ammoLvl]); _setSrc('upg-ammo-ico', UI_ICONS.ammo[ammoLvl]);
    const ss=$('cmd-stim-img'); if(ss&&ss.hidden===superStimUnlocked){ ss.hidden=!superStimUnlocked; $('cmd-stim-svg').style.display=superStimUnlocked?'none':''; }

    // ── Command card: upgrades (level pips + cost, red where short) ──
    [['dmg',dmgLvl,CFG.dmg_costs],['armor',armorLvl,CFG.armor_costs],['hp',hpLvl,CFG.hp_costs],['ammo',ammoLvl,CFG.ammo_costs]].forEach(([k,lvl,costs])=>{
      const btn=$('cmd-'+k); if(!btn) return;
      const maxed=lvl>=3, c=maxed?null:costs[lvl], short=!!c&&(minerals<c[0]||gas<c[1]);
      btn.classList.toggle('disabled', maxed||short);
      btn.classList.toggle('researched', maxed);
      $('cmd-'+k+'-lv')?.querySelectorAll('i').forEach((p,i)=>p.classList.toggle('on',i<lvl));
      _setHTML('cmd-'+k+'-cost', maxed ? '<span style="color:var(--gold)">MAX</span>'
        : `<span class="m${minerals<c[0]?' no':''}">${c[0]}</span><span class="g${gas<c[1]?' no':''}">${c[1]}</span>`);
      $('cmd-'+k+'-cost')?.classList.toggle('short', short);
    });
    if(_tipCmd) _renderTip();

    // ── Slot overlay + roster panel ──
    renderSlotBar();
    renderRosterPanel();
  }

  // ── Command card tooltips (live: cost, level, why it is disabled) ─────────
  const CMD_INFO = {
    air:    { t:'AIRSTRIKE', k:'R', d:'A Viking fires a missile at every enemy cluster and drops an ammo crate by the bunker — your reload once the magazine is empty.' },
    stim:   { t:'STIMPACK', k:'T', d:'Unlocked by six Marines in the bunker (fewer with Super Stimpack\'s tiers: 4, 2, 1). For 11 s the Marines and Marauders fire 50% faster (Marines: an extra round every other volley, no extra ammo). Costs 10 HP per Marine and 20 per Marauder, paid by the bunker — free and repairing with the Super Stimpack research, which also lets you right-click it for autocast: it stims whenever you fire (a gold light runs round the button).' },
    nuke:   { t:'NUKE', k:'N', d:'Tactical nuke on the centre of the swarm after a 2-second warning. Wipes out everything in a huge radius.' },
    roster: { t:'BUNKER ROSTER', k:'B', d:'Hire Marines, Marauders and Ghosts (6 slots) and research their upgrades. In Endless its armory sells more HP, damage, ammo and shorter strike / nuke cooldowns. The game pauses while it is open.' },
    view:   { t:'RESET VIEW', k:'HOME', d:'Back to the overview. Mouse wheel or + / − zooms in on the bunker; Insert / Delete rotate the view 90°.' },
    menu:   { t:'MENU', k:'M', d:'Save / load, graphics and sound, the controls, the tutorial, the main menu. The game pauses while it is open.' },
    dmg:    { t:'WEAPON DAMAGE', k:'1', d:'Every round from every unit hits harder.',
              fx: l => `Damage ×${(1+l*.6).toFixed(1)}${l<3?` → ×${(1+(l+1)*.6).toFixed(1)}`:''}` },   // before Endless reinforcements
    armor:  { t:'BUNKER ARMOR', k:'2', d:'Reduces the damage Zerg deal to the bunker (bites and acid).',
              fx: l => `Damage taken ×${(1/(1+l*.35)).toFixed(2)}${l<3?` → ×${(1/(1+(l+1)*.35)).toFixed(2)}`:''}` },
    hp:     { t:'BUNKER HULL', k:'3', d:'+250 max HP per level. Lv2 adds the Neosteel frame; Lv3 mounts the Shrike auto-turret (= 2 Marines, no ammo) and self-repair (25 HP/s, stacks with the Super Stimpack). Six Marines inside overdrive the turret: ×2.5 rate of fire.',
              fx: l => ['Next: +250 HP','Next: +250 HP · Neosteel frame','Next: +250 HP · Shrike turret · self-repair',''][l] },
    ammo:   { t:'AMMO STORAGE', k:'4', d:'+10 rounds per level. One round = one volley from every unit in the bunker.',
              fx: l => l<3 ? `${maxAmmo} → ${maxAmmo+10} rounds` : '' },
  };
  let _tipCmd=null;
  function _renderTip(){
    const tip=$('cmd-tip'), info=CMD_INFO[_tipCmd];
    if(!tip||!info) return;
    let lv='', fx='', cost='', warn='', ok=false;
    const up={dmg:[dmgLvl,CFG.dmg_costs],armor:[armorLvl,CFG.armor_costs],hp:[hpLvl,CFG.hp_costs],ammo:[ammoLvl,CFG.ammo_costs]}[_tipCmd];
    if(up){
      const [l,costs]=up; lv='Lv '+l+'/3'; fx=info.fx?info.fx(l):'';
      const en=endlessWaves(), extra=en&&{dmg:`+${Math.round(CFG.endless_dmg*en*100)}% damage`,hp:`+${CFG.endless_hp*en} max HP, repair +${Math.round(CFG.endless_repair*en*100)}%`,ammo:`+${CFG.endless_ammo*en} rounds`}[_tipCmd];
      if(extra) fx+=(fx?'<br>':'')+'Endless reinforcements: '+extra;
      const ak={dmg:'dmg',hp:'hp',ammo:'ammo'}[_tipCmd];
      if(ak&&armory[ak]) fx+=(fx?'<br>':'')+'Armory: '+ARMORY_DEF[ak].total(armory[ak]);
      if(l>=3) warn='FULLY UPGRADED';
      else {
        const [m,g]=costs[l];
        cost=`<div class="tip-c"><span class="m${minerals<m?' no':''}">${MIN_ICON}${m}</span><span class="g${gas<g?' no':''}">${GAS_ICON}${g}</span></div>`;
        if(minerals<m||gas<g) warn='Need '+shortfallHTML(m,g)+' more';
      }
    }
    if(_tipCmd==='air'){
      if(airCD>0) warn='Recharging — '+Math.ceil(airCD)+' s';
      else if(wavePhase!=='combat') warn='Only during a wave';
      else if(ammo>0) warn='Only when out of ammo ('+ammo+' left)';
      else { warn='READY'; ok=true; }
    }
    if(_tipCmd==='stim'){
      if(!stimUnlocked()) warn=superStimLvl>=3?'Needs a Marine or a Marauder in the bunker':'Needs '+stimNeed()+' Marines in the bunker ('+stimCount()+'/'+stimNeed()+')';
      else if(stimT>0) warn='Stimmed — '+Math.ceil(stimT)+' s left';
      else if(stimCost()&&bunkerHp<=stimCost()) warn='Not enough HP ('+stimCost()+' needed)';
      else if(superStimUnlocked&&wavePhase==='combat') { warn='READY — Super Stimpack: no HP cost, repairs the bunker'+(hpLvl>=3?' (stacks with self-repair)':''); ok=true; }
      else if(wavePhase!=='combat') warn='Only during a wave';
      else { warn='READY'; ok=true; }
      if(superStimUnlocked) warn+=stimAuto?'<br>Autocast ON — stims as you fire (right-click: off)':'<br>Right-click: autocast';
    }
    if(_tipCmd==='nuke'){
      if(wave<CFG.nuke_wave) warn='Unlocks at wave '+CFG.nuke_wave;
      else if(_nukeInFlight) warn='Launch in progress';
      else if(nukeCD>0) warn='Recharging — '+Math.ceil(nukeCD)+' s';
      else { warn='READY'; ok=true; }
    }
    _setHTML('cmd-tip', `<div class="tip-h"><span class="tip-t">${info.t}</span><span class="tip-k">${info.k}</span>${lv?`<span class="tip-lv">${lv}</span>`:''}</div>`+
      `<div class="tip-d">${info.d}</div>${fx?`<div class="tip-fx">${fx}</div>`:''}${cost}${warn?`<div class="tip-w"${ok?' style="color:var(--ok)"':''}>${warn}</div>`:''}`);
  }
  (()=>{
    const grid=$('con-cmd-grid'), tip=$('cmd-tip');
    if(!grid||!tip) return;
    grid.addEventListener('mouseover',e=>{
      const b=e.target.closest('.cmd-btn[data-cmd]');
      if(!b){ _tipCmd=null; tip.classList.remove('on'); return; }
      if(_tipCmd!==b.dataset.cmd){ _tipCmd=b.dataset.cmd; _renderTip(); }
      tip.classList.add('on');
    });
    grid.addEventListener('mouseleave',()=>{ _tipCmd=null; tip.classList.remove('on'); });
  })();

  // ── HDR post-processing ──────────────────────────────────────────────────
  // (the desktop's post.h) The scene renders into a float target (R11G11B10F, RGBA16F if refused; 4x MSAA on
  // HIGH), then a bloom chain and a composite pass (exposure, a hue-preserving tone curve, a vignette, dither)
  // write the canvas. The scene stays display-referred: lit surfaces are clamped at 1 (below), so only emitters —
  // fire, tracers, lamps, additive sprites — go past 1, and only they bloom. The DOM HUD is not touched. No
  // float target (WebGL1, no EXT_color_buffer_float, a refused allocation): straight to the canvas as before.
  //
  // The lit term is clamped as the 8-bit canvas clamped it, emission on top: lit surfaces look as before and
  // never bloom, smoke over a bright hull stays as dense. (Only lit materials have an emissive: Basic has none.)
  // Patched before any material compiles.
  THREE.ShaderChunk.emissivemap_pars_fragment += '\n#define LIT_CLAMP';
  THREE.ShaderChunk.dithering_fragment = `#ifdef LIT_CLAMP
	gl_FragColor.rgb = min( gl_FragColor.rgb, 1.0 + totalEmissiveRadiance );
#endif
` + THREE.ShaderChunk.dithering_fragment;
  const POST_DPR = 1.5;                              // the post path's pixel ratio at most (HiDPI: 4x MSAA float targets at DPR 2 are ~230 MB)
  // per quality: on, MSAA samples, bloom levels, the first level's size (1/div of the scene), the bloom's gain (fewer levels: less)
  const POST_Q = { HIGH: { on: true, samples: 4, levels: 6, div: 2, gain: 1 }, LOW: { on: true, samples: 0, levels: 4, div: 4, gain: 1.3 } };
  const POST_FMT = [['R11F_G11F_B10F', THREE.RGBAFormat], [null, THREE.RGBAFormat]];   // (null: RGBA16F. Half the size: on an integrated GPU, 4x MSAA in RGBA16F costs 12 ms a frame)
  const _post = { ok: HDR_OK && renderer.capabilities.isWebGL2, on: false, q: null, w: 0, h: 0, rt: null, bloom: [] };   // q: the settings allocated
  _post.on = _post.ok && POST_Q[gfxQuality].on;
  let _hdr = false;      // the last frame went through the post passes: emitters burn past 1 (they bloom)
  const POST_VS = 'varying vec2 vUv;\nvoid main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4( position.xy, 0.0, 1.0 ); }';
  // Bloom level 0: the 13-tap downsample of Jimenez (CoD AW), its four outer groups luma-weighted (Karis) so a
  // lone hot spark does not flicker, the centre group plain so small emitters (tracers) still bloom; then a soft
  // threshold at 1
  const POST_PRE = `uniform sampler2D uSrc; uniform vec2 uTexel; uniform vec4 uThr;   // T, T-K, 2K, 0.25/K
    varying vec2 vUv;
    vec3 S( vec2 d ) { vec3 c = min( texture2D( uSrc, vUv + d * uTexel ).rgb, vec3( 64.0 ) ); return any( isnan( c ) ) ? vec3( 0.0 ) : c; }
    float W( vec3 c ) { return 1.0 / ( 1.0 + 0.25 * dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ) ); }
    void main() {
      vec3 A = S( vec2( -1, -1 ) ), B = S( vec2( 1, -1 ) ), C = S( vec2( -1, 1 ) ), D = S( vec2( 1, 1 ) );
      vec3 E = S( vec2( -2, -2 ) ), F = S( vec2( 0, -2 ) ), G = S( vec2( 2, -2 ) ), H = S( vec2( -2, 0 ) ), I = S( vec2( 0, 0 ) );
      vec3 J = S( vec2( 2, 0 ) ), K = S( vec2( -2, 2 ) ), L = S( vec2( 0, 2 ) ), M = S( vec2( 2, 2 ) );
      vec3 g0 = ( A + B + C + D ) * 0.25, g1 = ( E + F + H + I ) * 0.25, g2 = ( F + G + I + J ) * 0.25;
      vec3 g3 = ( H + I + K + L ) * 0.25, g4 = ( I + J + L + M ) * 0.25;
      float w1 = 0.125 * W( g1 ), w2 = 0.125 * W( g2 ), w3 = 0.125 * W( g3 ), w4 = 0.125 * W( g4 );
      vec3 c = ( g0 * 0.5 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4 ) / ( 0.5 + w1 + w2 + w3 + w4 );
      float br = max( c.r, max( c.g, c.b ) );
      float rq = clamp( br - uThr.y, 0.0, uThr.z );
      rq = uThr.w * rq * rq;
      gl_FragColor = vec4( c * max( rq, br - uThr.x ) / max( br, 1e-4 ), 1.0 );
    }`;
  const POST_DOWN = `uniform sampler2D uSrc; uniform vec2 uTexel;
    varying vec2 vUv;
    vec3 S( vec2 d ) { return texture2D( uSrc, vUv + d * uTexel ).rgb; }
    void main() {
      vec3 c = ( S( vec2( -1, -1 ) ) + S( vec2( 1, -1 ) ) + S( vec2( -1, 1 ) ) + S( vec2( 1, 1 ) ) ) * 0.125
             + ( S( vec2( -2, -2 ) ) + S( vec2( 2, -2 ) ) + S( vec2( -2, 2 ) ) + S( vec2( 2, 2 ) ) ) * 0.03125
             + ( S( vec2( 0, -2 ) ) + S( vec2( -2, 0 ) ) + S( vec2( 2, 0 ) ) + S( vec2( 0, 2 ) ) ) * 0.0625
             + S( vec2( 0, 0 ) ) * 0.125;
      gl_FragColor = vec4( c, 1.0 );
    }`;
  // up the chain with a 3x3 tent, added into the next larger level
  const POST_UP = `uniform sampler2D uSrc; uniform vec2 uTexel;
    varying vec2 vUv;
    vec3 S( vec2 d ) { return texture2D( uSrc, vUv + d * uTexel ).rgb; }
    void main() {
      vec3 c = S( vec2( 0, 0 ) ) * 4.0 + ( S( vec2( 1, 0 ) ) + S( vec2( -1, 0 ) ) + S( vec2( 0, 1 ) ) + S( vec2( 0, -1 ) ) ) * 2.0
             + S( vec2( 1, 1 ) ) + S( vec2( -1, 1 ) ) + S( vec2( 1, -1 ) ) + S( vec2( -1, -1 ) );
      gl_FragColor = vec4( c / 16.0, 1.0 );
    }`;
  // Scene + bloom, exposure and a radial flash, then a hue-preserving tone curve: the identity below the knee;
  // above it the brightest channel rolls off and the others keep their ratio, so fire stays orange; only very hot
  // light (> ~4) runs on to white. Then the vignette and a dither (no banding in the fog and the bloom's tails)
  const POST_COMP = `uniform sampler2D uScene, uBloom; uniform vec2 uBloomTexel;
    uniform float uBloomStrength, uExposure, uKnee, uAspect, uVignette;
    uniform vec3 uFlashColor; uniform vec2 uFlashPos; uniform float uFlashRadius, uFlashGlobal;
    uniform sampler2D uHaze; uniform float uHazeOn;   // the nuke's heat haze: uv offsets (see _hz)
    varying vec2 vUv;
    float ign( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
    void main() {
      vec2 uv = vUv;
      if ( uHazeOn > 0.5 ) { vec4 h = texture2D( uHaze, vUv ); uv += ( h.xz - h.yw ) * ${HZ_RANGE.toFixed(2)}; }
      vec3 c = texture2D( uScene, uv ).rgb;
      vec2 bt = uBloomTexel * 0.5;   // four bilinear taps: a tent over the bloom's first level
      vec3 b = texture2D( uBloom, vUv - bt ).rgb + texture2D( uBloom, vUv + bt ).rgb
             + texture2D( uBloom, vUv + vec2( bt.x, -bt.y ) ).rgb + texture2D( uBloom, vUv + vec2( -bt.x, bt.y ) ).rgb;
      c += b * ( 0.25 * uBloomStrength );
      vec2 fd = ( vUv - uFlashPos ) * vec2( uAspect, 1.0 );
      c = c * uExposure + uFlashColor * ( uFlashGlobal + exp( -dot( fd, fd ) / max( uFlashRadius * uFlashRadius, 1e-4 ) ) );
      c = max( c, vec3( 0.0 ) );
      float m = max( c.r, max( c.g, c.b ) );
      if ( m > uKnee ) {
        float s = min( ( m - uKnee ) / ( 1.0 - uKnee ), 1e4 );
        float mt = uKnee + ( 1.0 - uKnee ) * s / ( 1.0 + s );
        c *= mt / m;
        c = mix( c, vec3( mt ), clamp( ( m - 4.0 ) / 8.0, 0.0, 1.0 ) );   // white-hot
      }
      float r = length( ( vUv - 0.5 ) * vec2( uAspect, 1.0 ) ) / length( vec2( 0.5 * uAspect, 0.5 ) );
      c *= 1.0 - uVignette * smoothstep( 0.6, 1.1, r );
      gl_FragColor = vec4( c + ( ign( gl_FragCoord.xy ) - 0.5 ) / 255.0, 1.0 );
    }`;
  const _postMat = (fs, uniforms, add) => new THREE.ShaderMaterial({ vertexShader: POST_VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false,
    blending: add ? THREE.CustomBlending : THREE.NoBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor });
  const _postSrcU = () => ({ uSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  const _postPre = _postMat(POST_PRE, { ..._postSrcU(), uThr: { value: new THREE.Vector4(1, 1 - .15, 2 * .15, .25 / .15) } });   // threshold 1, knee 0.15
  const _postDown = _postMat(POST_DOWN, _postSrcU()), _postUp = _postMat(POST_UP, _postSrcU(), true);
  const _postComp = _postMat(POST_COMP, { uScene: { value: null }, uBloom: { value: null }, uBloomTexel: { value: new THREE.Vector2() },
    uBloomStrength: { value: .6 }, uExposure: { value: 1 }, uKnee: { value: .9 }, uAspect: { value: 1 }, uVignette: { value: 0 },
    uFlashColor: { value: new THREE.Color(0, 0, 0) }, uFlashPos: { value: new THREE.Vector2(.5, .5) }, uFlashRadius: { value: .35 }, uFlashGlobal: { value: 0 }, uHaze: { value: null }, uHazeOn: { value: 0 } });
  // one triangle over the whole target
  const _postTri = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3)), _postComp);
  _postTri.frustumCulled = false;
  const _postCam = new THREE.Camera(), _postV = new THREE.Vector2(), _gl = renderer.getContext();
  // three r128 will not allocate an RGB float target (it asks for RGBA), and R11F_G11F_B10F takes only RGB: the upload's format is put right here
  const _glTexImage2D = _gl.texImage2D;
  _gl.texImage2D = function (...a) { if (a.length === 9 && a[2] === _gl.R11F_G11F_B10F) a[6] = _gl.RGB; return _glTexImage2D.apply(_gl, a); };
  if (_post.ok) for (const m of [_postPre, _postDown, _postUp, _postComp]) { _postTri.material = m; renderer.compile(_postTri, _postCam); }   // no hitch on the first frame
  // A target: the scene's has depth (24-bit with stencil: three's depth-only buffer is 16-bit) and 4x MSAA on HIGH
  function _postTarget(w, h, fmt, sceneRT) {
    const o = { format: fmt[1], type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: sceneRT, stencilBuffer: sceneRT };
    const rt = sceneRT && _post.q.samples ? new THREE.WebGLMultisampleRenderTarget(w, h, o) : new THREE.WebGLRenderTarget(w, h, o);
    if (rt.isWebGLMultisampleRenderTarget) rt.samples = Math.min(_post.q.samples, renderer.capabilities.maxSamples);
    rt.texture.internalFormat = fmt[0];
    return rt;
  }
  function _postComplete(rt) {   // allocates it; false: refused
    renderer.setRenderTarget(rt);
    const ok = () => _gl.checkFramebufferStatus(_gl.FRAMEBUFFER) === _gl.FRAMEBUFFER_COMPLETE;
    let good = ok();
    if (good && rt.isWebGLMultisampleRenderTarget) {   // and the texture it resolves into
      const p = renderer.properties.get(rt);
      _gl.bindFramebuffer(_gl.FRAMEBUFFER, p.__webglFramebuffer); good = ok();
      _gl.bindFramebuffer(_gl.FRAMEBUFFER, p.__webglMultisampledFramebuffer);
    }
    return good && _gl.getError() !== _gl.OUT_OF_MEMORY;
  }
  function _postFree() {
    for (const rt of [_post.rt, ..._post.bloom]) rt?.dispose();
    _post.rt = _post.q = null; _post.bloom = []; _post.w = _post.h = 0;
  }
  // (Re)allocates the targets for the drawing buffer's size and the quality (resize); a refused allocation turns
  // the post off for the session
  function _postEnsure() {
    const v = renderer.getDrawingBufferSize(_postV), q = POST_Q[gfxQuality];
    if (!_post.on) { _postFree(); return; }
    if (_post.rt && v.x === _post.w && v.y === _post.h && q === _post.q) return;
    _postFree();
    if (v.x < 16 || v.y < 16) return;   // minimised or tiny: no post until the next resize
    for (const fmt of POST_FMT) {
      _post.q = q;
      _post.rt = _postTarget(v.x, v.y, fmt, true);
      let ok = _postComplete(_post.rt), bw = Math.max(1, Math.round(v.x / q.div)), bh = Math.max(1, Math.round(v.y / q.div));
      for (let i = 0; ok && i < q.levels && Math.min(bw, bh) >= 8; i++) {
        const l = _postTarget(bw, bh, fmt, false);
        _post.bloom.push(l); ok = _postComplete(l);
        bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
      }
      renderer.setRenderTarget(null);
      if (ok && _post.bloom.length) { _post.w = v.x; _post.h = v.y; return; }
      _postFree();
    }
    console.warn(`Post-processing: no float target at ${v.x}x${v.y}: drawing without it`);
    _post.ok = _post.on = false;
    resize();   // the canvas's own pixel ratio again
  }
  function _postPass(mat, dst, src) {
    if (src) { mat.uniforms.uSrc.value = src.texture; mat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height); }
    _postTri.material = mat;
    renderer.setRenderTarget(dst);
    renderer.render(_postTri, _postCam);
  }
  // 4x MSAA costs an integrated GPU some 10 ms a frame (Iris Xe at 720p: 30 ms with it, 19 ms without, the rest of HIGH
  // keeping 50 FPS). Under 45 FPS for two windows of 4 s with it on: off, for the session. (Frames over 250 ms are not
  // counted: a hidden tab, a hitch)
  const _aa = { t: 0, n: 0, last: 0, slow: 0 };
  function _aaWatch() {
    const q = _post.q, now = performance.now(), d = now - _aa.last;
    _aa.last = now;
    if (!q || !q.samples || d > 250) return;
    _aa.t += d; _aa.n++;
    if (_aa.t < 4000) return;
    _aa.slow = _aa.t / _aa.n > 1000 / 45 ? _aa.slow + 1 : 0;
    _aa.t = _aa.n = 0;
    if (_aa.slow < 2) return;
    q.samples = 0; _postFree(); _postEnsure();
    console.info('Post-processing: under 45 FPS with 4x MSAA: drawing without it');
  }
  // The frame: through the post passes when they run, else straight to the canvas
  function renderFrame() {
    syncGround();
    _aaWatch();
    _hdr = !!_post.rt;
    if (!_hdr) { renderer.setRenderTarget(null); renderScene(); return; }
    const rt = _post.rt, B = _post.bloom, n = B.length, u = _postComp.uniforms;
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);   // (and resolves the MSAA)
    // the heat haze: its offsets, by which the composite bends the scene
    const hz = _hz.on;
    if (hz) {
      _hzTargets();
      const a = renderer.getClearAlpha(), P = camera.projectionMatrix.elements;
      _hz.U.uAspectInv.value = P[0] / P[5];
      renderer.setRenderTarget(_hz.ht); renderer.setClearAlpha(0); renderer.render(_hz.scene, camera); renderer.setClearAlpha(a);
    }
    u.uHaze.value = hz ? _hz.ht.texture : null; u.uHazeOn.value = hz ? 1 : 0;
    renderer.autoClear = false;
    // bloom: prefilter into level 0, down the chain, then back up adding each level into the larger one
    _postPass(_postPre, B[0], rt);
    for (let i = 1; i < n; i++) _postPass(_postDown, B[i], B[i - 1]);
    for (let i = n - 1; i >= 1; i--) _postPass(_postUp, B[i - 1], B[i]);
    // composite into the canvas. Bloom carries further at night (the up chain sums every level into level 0:
    // normalised by their number); a light vignette (the Zerg come in at the edges)
    u.uScene.value = rt.texture; u.uBloom.value = B[0].texture; u.uBloomTexel.value.set(1 / B[0].width, 1 / B[0].height);
    u.uBloomStrength.value = (0.6 + 0.3 * _dnFactor) / Math.max(1, n - 1) * _post.q.gain;
    u.uVignette.value = 0.08 + 0.04 * _dnFactor;
    u.uAspect.value = rt.width / rt.height;
    _postPass(_postComp, null);
    renderer.autoClear = true;
  }

    // ── Resize ───────────────────────────────────────────────────────────────
  function resize(){
    W=Math.max(1,window.innerWidth); H=window.innerHeight;
    const consoleH=148, topBarH=32;
    const gameH=Math.max(1,H-consoleH-topBarH); // a very short window gave a negative viewport
    // Store logical (CSS-pixel) dimensions BEFORE renderer.setSize, which will
    // overwrite canvas.width/height with physical pixels (logical × devicePixelRatio)
    _logW=W; _logH=gameH;
    // DPR can change (window moved to another monitor, browser zoom) — re-read it
    const dpr=Math.min(window.devicePixelRatio||1,2);
    renderer.setPixelRatio(gfxQuality==='HIGH'?(_post.on?Math.min(dpr,POST_DPR):dpr):1);   // (the post path's: capped)
    // Overlay canvas: backing store at device pixels (crisp text), drawn in logical units
    chCanvas.width=Math.round(W*dpr); chCanvas.height=Math.round(gameH*dpr);
    chCtx.setTransform(dpr,0,0,dpr,0,0);
    renderer.setSize(W,gameH);               // sets gc.width = W*dpr internally
    camera.aspect=W/gameH; camera.updateProjectionMatrix();
    // Particle sprites: pixels per world unit at depth 1 (drawing-buffer pixels)
    _partScale.value=gameH*renderer.getPixelRatio()/(2*Math.tan(camera.fov*Math.PI/360));
    _postEnsure();
  }
  window.addEventListener('resize',resize); resize();

  // ── Crosshair ────────────────────────────────────────────────────────────
  // ── Enemy HP bars — 2D canvas billboard ────────────────────────────────────
  // Projects each enemy's world position to screen space and draws
  // a compact HP bar above their head. Zergling: small, Roach: wider.
  const _projV = new THREE.Vector3(); // reused projection temp
  const barY = e => e.type==='r' ? 1.4 : 1.1;   // its HP bar's height over its feet (the hit numbers ride on it)
  // A queue over each enemy: a new hit (or MISS) comes in just over its HP bar (a Roach's: over its HP
  // figure too) and moves the older ones up a row; the one pushed out fades in the row above in FT_OUT ms,
  // and goes at the next push. It follows the enemy while it lives
  const FT_ROWS = 2, FT_OUT = 250;
  function hitText(e,txt,color){
    if(!dmgNumbersOn) return;   // switched off: the HP bars tell the damage
    for(const f of floatTexts){
      if(f.on!==e) continue;   // another enemy's
      if(++f.row>FT_ROWS) f.life=0;
      else if(f.row===FT_ROWS&&f.life>FT_OUT){ f.life=FT_OUT; f.maxLife=2*FT_OUT; }   // from full to nothing: the alpha is life / maxLife * 2
    }
    if(floatTexts.length>=60) floatTexts.shift(); // cap: late waves produce ~60 numbers/s, each two text draws
    const p=e.mesh.position;
    floatTexts.push({x:p.x,y:p.y+barY(e),z:p.z,txt,life:900,maxLife:900,color,lift:e.type==='r'?9:2,on:e,row:0});
  }
  function setDmgNumbers(on) {   // Menu → Settings
    dmgNumbersOn = !!on; _store.set('dotd_dmg_numbers', dmgNumbersOn ? '1' : '0');
    if (!dmgNumbersOn) floatTexts = floatTexts.filter(f => !f.on);   // the REINFORCED banner is not a damage number
  }
  function drawEnemyHPBars() {
    if(phase!=='playing') return;
    const ctx = chCtx;
    const cW = _logW, cH = _logH;
    // Night fog culling: hide HP bars beyond fog.far (enemy is invisible in fog)
    // and fade them with the fog in front of it, as the radial fog fades the enemy
    const fogRange = _dnFactor > 0.1 ? scene.fog.far : Infinity, fogNear = scene.fog.near;

    allEnemies().forEach(e => {
      if(e.dead || !e.mesh.visible) return;   // none on a Zerg hidden under its Sensor Tower blip (its bar and badge would tell which kind)
      ctx.globalAlpha = 1;
      // Cull if enemy is beyond night fog range
      if (fogRange < Infinity) {
        const ex = e.mesh.position.x, ez = e.mesh.position.z, d = Math.sqrt(ex*ex + ez*ez);
        if (d > fogRange) return;
        const k = Math.max(0, Math.min(1, (d - fogNear) / (fogRange - fogNear)));
        ctx.globalAlpha = 1 - k * k * (3 - 2 * k);
      }
      const pct = Math.max(0, e.hp / e.maxHp);

      // Project world pos → screen (reused temp vector)
      const worldPos = _projV.copy(e.mesh.position);
      worldPos.y += barY(e); // above head
      worldPos.project(camera);

      // Skip if behind camera or off screen
      if(worldPos.z > 1) return;
      const sx = ( worldPos.x * 0.5 + 0.5) * cW;
      const sy = (-worldPos.y * 0.5 + 0.5) * cH;
      if(sx < -20 || sx > cW+20 || sy < -10 || sy > cH+10) return;

      const barW = e.type==='r' ? 36 : 24;
      const barH = e.type==='r' ? 5 : 4;
      const bx = sx - barW/2;
      const by = sy - barH/2;

      // Only draw if not at full HP (less visual clutter)
      if(pct >= 1.0) return;

      // Attribute badge: small tag right of the bar showing Light/Armored
      const tag = (e.attrs||[]).includes('armored') ? 'ARM'
                : (e.attrs||[]).includes('light')   ? 'LGT' : '';
      const tx = bx + barW + 3;
      ctx.font = 'bold 6px "Courier New"';

      // Background track, under the badge too (bare, it was lost on the grass and the Zerg)
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(bx-1, by-1, tag ? tx + ctx.measureText(tag).width + 3 - bx : barW+2, barH+2);

      // HP fill — green→yellow→red
      const col = pct > 0.5 ? `rgb(${Math.round(255*(1-pct)*2)},200,0)`
                             : `rgb(255,${Math.round(255*pct*2)},0)`;
      ctx.fillStyle = col;
      ctx.fillRect(bx, by, barW*pct, barH);

      // Thin border
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(bx, by, barW, barH);

      if(tag){
        ctx.textAlign = 'left';
        const tagCol = tag==='ARM' ? 'rgba(255,150,50,0.85)' : 'rgba(100,220,255,0.85)';
        ctx.fillStyle = tagCol;
        ctx.fillText(tag, tx, by + barH - 1);
      }
      // Numeric HP for Roaches
      if((e.attrs||[]).includes('armored')){
        ctx.fillStyle = 'rgba(255,255,255,0.65)';
        ctx.font = '7px "Courier New"';
        ctx.textAlign = 'center';
        ctx.fillText(Math.ceil(e.hp), sx, by - 2);
      }
    });
    ctx.globalAlpha = 1;
  }

  // ── Sensor Tower: radar blips for Zerg in the dark ─────────────────────────
  // Every live enemy hidden by the night fog (mesh not visible) within
  // SENSOR_RANGE shows as a pulsing red "!" disc lying on the ground under it,
  // upright as the camera sees it — the same marker for every kind, no HP bar.
  // At night a glowing ring on the ground marks the range, with a triangle every
  // 30° pointing at the bunker. (The Shrike engages blips too: _shrikePick.)
  function _sensed(e) {
    const p = e.mesh.position;
    return sensorLvl >= 1 && !e.dead && !e.mesh.visible && Math.hypot(p.x, p.z) <= SENSOR_RANGE[sensorLvl];
  }
  // The ring per level: a soft band with a brighter core (the glow texture's centre
  // column gives the profile across it) and 12 small equilateral triangles, tips toward the bunker
  const _sensorRings = [], _sensorRingMat = Object.assign(_glowMat(), { color: new THREE.Color(0xff503c) });
  function _sensorRing(lvl) {
    if (_sensorRings[lvl]) return _sensorRings[lvl];
    const R = SENSOR_RANGE[lvl], pos = [], uv = [];
    const vtx = (x, z, v) => { pos.push(x, 0, z); uv.push(0.5, v); };
    const band = w => {   // inner edge v = 0, outer v = 1
      const S = 160;
      for (let i = 0; i < S; i++) {
        const a0 = i / S * Math.PI * 2, a1 = (i + 1) / S * Math.PI * 2, ri = R - w, ro = R + w;
        const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        vtx(c0 * ri, s0 * ri, 0); vtx(c0 * ro, s0 * ro, 1); vtx(c1 * ro, s1 * ro, 1);
        vtx(c0 * ri, s0 * ri, 0); vtx(c1 * ro, s1 * ro, 1); vtx(c1 * ri, s1 * ri, 0);
      }
    };
    band(0.45); band(0.12);   // glow, core
    const side = 0.5, h = side * Math.sqrt(3) / 2;   // equilateral, its centre on the ring
    for (let k = 0; k < 12; k++) {
      const a = k * Math.PI / 6, c = Math.cos(a), s = Math.sin(a), rBase = R + h / 3, rTip = R - 2 * h / 3, hw = side / 2;
      vtx(c * rBase - s * hw, s * rBase + c * hw, 0.5);
      vtx(c * rBase + s * hw, s * rBase - c * hw, 0.5);
      vtx(c * rTip, s * rTip, 0.5);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const m = new THREE.Mesh(g, _sensorRingMat.clone());   // its own: each level's ring fades on its own (syncSensor)
    m.position.y = 0.03; m.renderOrder = 1; m.visible = false;
    scene.add(m);
    return (_sensorRings[lvl] = m);
  }
  // The blip: a red disc and ring around a pale "!", drawn once
  const _blipTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    g.beginPath(); g.arc(64, 64, 51, 0, Math.PI * 2); g.fillStyle = 'rgba(255,59,47,0.22)'; g.fill();
    g.lineWidth = 9; g.strokeStyle = '#ff3b2f'; g.stroke();
    g.strokeStyle = g.fillStyle = '#ffd0c8'; g.lineWidth = 11.5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(64, 34.5); g.lineTo(64, 65.3); g.stroke();   // the bar
    g.beginPath(); g.arc(64, 85, 6.4, 0, Math.PI * 2); g.fill();          // the dot
    return new THREE.CanvasTexture(c);
  })();
  const BLIP_CAP = 128;
  const _blipIM = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    Object.assign(_glowMat(), { map: _blipTex }), BLIP_CAP);
  _blipIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _blipIM.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(BLIP_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
  _blipIM.frustumCulled = false; _blipIM.count = 0; _blipIM.renderOrder = 2;
  scene.add(_blipIM);
  const _blipM = new THREE.Matrix4(), _blipF = new THREE.Vector3(), _blipR = new THREE.Vector3(), _blipU = new THREE.Vector3(0, 1, 0);
  // Each level's ring eases (real time: also behind the menu) toward shown — the level owned,
  // while playing, as strong as the night is dark — or hidden: it fades in when researched,
  // the levels crossfade on an upgrade, it follows the night and fades out with the game
  const SENSOR_RING_FADE = 0.35;   // s: the time constant (~1 s to show or hide)
  const _sensorRingA = [0, 0, 0, 0];
  let _sensorT = performance.now();
  function syncSensor() {
    const now = performance.now(), k = 1 - Math.exp(-Math.min(0.1, (now - _sensorT) / 1000) / SENSOR_RING_FADE);
    _sensorT = now;
    for (let l = 1; l <= 3; l++) {
      _sensorRingA[l] += ((phase === 'playing' && sensorLvl === l ? _dnFactor : 0) - _sensorRingA[l]) * k;
      const show = _sensorRingA[l] >= 0.003;
      if (!show && !_sensorRings[l]) continue;
      const ring = _sensorRing(l);
      ring.visible = show;
      ring.material.opacity = 0.75 * _sensorRingA[l];
    }
    if (phase !== 'playing' || sensorLvl < 1) { _blipIM.count = 0; return; }
    // the blips come in with the ring (fresh research), and each fades in as it crosses into
    // range and out only as its Zerg comes out of the dark (well inside the lit edge, where the
    // fog still left it black, or in a grenade's light): gone just as the Zerg shows (the enemy
    // loop), so no gap, and no Zerg seen under its blip
    const blipsA = Math.max(0, Math.min(1, _sensorRingA[sensorLvl] / Math.max(0.1, _dnFactor)));
    const range = SENSOR_RANGE[sensorLvl];
    // the screen's up direction on the ground: the camera's up and forward axes, flattened (no roll)
    const e = camera.matrixWorld.elements;
    _blipF.set(e[4] - e[8], 0, e[6] - e[10]);
    if (_blipF.lengthSq() < 1e-8) _blipF.set(0, 0, -1);
    _blipF.normalize();
    _blipR.crossVectors(_blipF, _blipU);
    // pulse on real time: blips keep blinking while paused
    const pulse = 0.65 + 0.35 * Math.sin(performance.now() / 1000 * Math.PI * 2 * 1.5), s = 1.4 * (0.94 + 0.06 * pulse);
    let n = 0;
    for (const en of allEnemies()) {
      if (n >= BLIP_CAP || en.dead) continue;
      const p = en.mesh.position, d = Math.hypot(p.x, p.z);
      const a = blipsA * _sstep(SENSOR_SHOW_DARK, SENSOR_SHOW_DARK + SENSOR_BLIP_FADE, _nightDark(p.x, p.z)) * (1 - _sstep(range - 0.8, range, d));
      if (a < 0.01) continue;
      // the glyph's top (the quad's -z: the canvas top, flipped up the plane) → F, its x → the screen's right
      _blipM.set(_blipR.x * s, 0, -_blipF.x * s, p.x,
                 _blipR.y * s, 1, -_blipF.y * s, 0.05,
                 _blipR.z * s, 0, -_blipF.z * s, p.z,
                 0, 0, 0, 1);
      _blipIM.setMatrixAt(n, _blipM);
      _tmpCol.setRGB(pulse * a, pulse * a, pulse * a); _blipIM.setColorAt(n, _tmpCol);   // additive: the colour scales its light
      n++;
    }
    _blipIM.count = n;
    _blipIM.instanceMatrix.needsUpdate = true;
    _blipIM.instanceColor.needsUpdate = true;
  }

  function drawCH(){
    const gameH=_logH;
    chCtx.clearRect(0,0,_logW,gameH);
    syncSensor();
    drawEnemyHPBars();
    if(floatTexts.length>0){   // floating damage numbers, queued over each enemy (hitText)
      chCtx.textAlign='center'; chCtx.textBaseline='middle'; chCtx.lineJoin='round';   // (a miter's spikes stood over the M of MISS)
      chCtx.font='15px "Share Tech Mono", Consolas, monospace';
      const W2=W/2, H2=gameH/2, m=chCtx.measureText('0');
      const h=m.fontBoundingBoxAscent+m.fontBoundingBoxDescent||15, step=.8*h;   // a row: digits fill ~0.8 of the line
      floatTexts.forEach(f=>{
        const v=_projV.set(f.x,f.y,f.z).project(camera);
        const sx=(v.x+1)*W2, sy=(-v.y+1)*H2;
        if(sx<-20||sx>W+20||sy<-20||sy>gameH+20)return;
        const cy=sy-(f.lift||0)-h/2-(f.row||0)*step;
        const t=f.life/f.maxLife;
        chCtx.globalAlpha=Math.min(1,t*2);
        chCtx.strokeStyle='rgba(0,0,0,0.7)'; chCtx.lineWidth=3;
        chCtx.strokeText(f.txt,sx,cy);
        chCtx.fillStyle=f.color;
        chCtx.fillText(f.txt,sx,cy);
      });
      chCtx.globalAlpha=1; chCtx.textAlign='left'; chCtx.textBaseline='alphabetic'; chCtx.lineJoin='miter';
    }
    if(phase!=='playing')return;
    const px=mx*W,py=my*gameH;
    const nukeReady=wave>=CFG.nuke_wave&&nukeCD===0;
    chCtx.strokeStyle=nukeReady?'#ffff00':ammo>0?'#00ff44':'#ff6600';
    chCtx.lineWidth=1.5; chCtx.globalAlpha=.85; const s=11;
    chCtx.beginPath();chCtx.moveTo(px-s,py);chCtx.lineTo(px-3,py);chCtx.stroke();
    chCtx.beginPath();chCtx.moveTo(px+3,py);chCtx.lineTo(px+s,py);chCtx.stroke();
    chCtx.beginPath();chCtx.moveTo(px,py-s);chCtx.lineTo(px,py-3);chCtx.stroke();
    chCtx.beginPath();chCtx.moveTo(px,py+3);chCtx.lineTo(px,py+s);chCtx.stroke();
    chCtx.beginPath();chCtx.arc(px,py,3.5,0,Math.PI*2);chCtx.stroke();
    chCtx.globalAlpha=1;
  }

  // ── Bunker fire (HP < 50%) ──────────────────────────────────────────────────
  // Damage spots on the bunker's upper surfaces ignite one after another as HP
  // falls below 50%. Each burning spot emits flame tongues (additive,
  // yellow→red, shrinking as they rise), embers, and a smoke plume that
  // thickens and darkens with damage; a flickering fire light lights the hull.
  const FIRE_HP = 0.5;
  // Ignition order (x, z) — sampled onto the model surface by raycast
  const FIRE_SPOTS_XZ = [[0.55,0.35],[-0.6,-0.3],[0.1,-0.8],[-0.4,0.75],[0.95,-0.35],[-1.0,0.15]];
  let _fireSpots = null;   // world points on the bunker (re-sampled when the model swaps in)
  const _fireAccum = [];   // per spot: emission accumulators [flame, smoke, ember]
  function _findFireSpots() {
    const rc = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0), from = new THREE.Vector3();
    if (bunkerGroup) bunkerGroup.updateMatrixWorld(true);
    return FIRE_SPOTS_XZ.map(([x, z]) => {
      rc.set(from.set(x, 10, z), down);
      const hit = bunkerGroup ? rc.intersectObject(bunkerGroup, true).find(h => h.object.visible) : null;
      return new THREE.Vector3(x, hit ? hit.point.y : 1.2, z);
    });
  }
  function updateBunkerFire(dt) {
    const hpPct = bunkerHp / maxHp;
    if (phase !== 'playing' || hpPct >= FIRE_HP) { if (_fireLight) _fireLight.intensity = 0; return; }
    if (!_fireSpots) _fireSpots = _findFireSpots();
    const sev = Math.min(1, (FIRE_HP - hpPct) / 0.4);   // 0 at 50% HP → 1 at 10% and below
    const lit = Math.min(_fireSpots.length, 1 + Math.floor(sev * _fireSpots.length));
    const R = Math.random;
    let lx = 0, lz = 0;
    for (let s = 0; s < lit; s++) {
      const p = _fireSpots[s], acc = _fireAccum[s] || (_fireAccum[s] = [0, 0, 0]);
      lx += p.x; lz += p.z;
      acc[0] += (8 + 12 * sev) * dt; acc[1] += (2.5 + 5 * sev) * dt; acc[2] += (1 + 5 * sev) * dt;
      while (acc[0] >= 1) { acc[0]--;   // flame tongue
        const sz = (0.34 + 0.18 * sev) * (0.7 + 0.6 * R());
        emitParticle(_glow, p.x + (R() - .5) * .24, p.y + R() * .05, p.z + (R() - .5) * .24,
          (R() - .5) * .5, .9 + R() * .9 + .6 * sev, (R() - .5) * .5,
          .35 + R() * .3, sz, .08, .55, 0xffb347, 0xff2200, -1.5, 1.0, 0); // modest alpha: additive overlap must not blow out to white
      }
      while (acc[1] >= 1) { acc[1]--;   // smoke (drifts downwind, grows, darker when heavy)
        emitParticle(_smoke, p.x + (R() - .5) * .2, p.y + .35, p.z + (R() - .5) * .2,
          .25 + (R() - .5) * .3, .55 + R() * .5, (R() - .5) * .3,
          2.0 + R() * 1.2, .35, 1.4 + .6 * sev, .28 + .3 * sev, sev > .6 ? 0x141414 : 0x3a3a3a, 0x6a6a6a, -.2, .3, 1);
      }
      while (acc[2] >= 1) { acc[2]--;   // ember
        emitParticle(_glow, p.x, p.y + .1, p.z,
          (R() - .5) * 1.6, 1.5 + R() * 1.8, (R() - .5) * 1.6,
          .8 + R() * .7, .07, .03, 1, 0xffc060, 0xff3000, -.3, .6, 0);
      }
    }
    if (_fireLight) {
      _fireLight.position.set(lx / lit, 1.8, lz / lit);
      _fireLight.intensity = (0.5 + 2.3 * sev) * (0.8 + 0.2 * Math.sin(_gameT * 23) * Math.sin(_gameT * 7.3)) * (0.7 - 0.1 * _dnLitF);
    }
  }

  // ── Day/Night cycle update ───────────────────────────────────────────────
  // Night factor at time t of the cycle: 0 through the day, eased up through dusk,
  // 1 through the night, eased down through dawn (smootherstep: no jump in the
  // level, its rate or its acceleration). The old curve snapped from full night
  // back to day at the end of dusk, then faded in again.
  function _dnCycleFactor(t) {
    const ease = x => x * x * x * (x * (x * 6 - 15) + 10);
    if (t < DN_DAY) return 0;
    if (t < DN_DAY + DN_FADE) return ease((t - DN_DAY) / DN_FADE);
    if (t < DN_DAY + DN_FADE + DN_NIGHT) return 1;
    return 1 - ease((t - DN_DAY - DN_FADE - DN_NIGHT) / DN_FADE);
  }
  function updateDayNight(dt) {
    if (dnEnabled) _dnTime = (_dnTime + dt) % DN_CYCLE;
    const target = dnEnabled ? _dnCycleFactor(_dnTime) : 0;
    // Slew-limited: the cycle itself moves slower than this, so only switching
    // the cycle on / off is blended (the night lifts over DN_SLEW s, not at once)
    const step = dt / DN_SLEW;
    _dnFactor = Math.max(_dnFactor - step, Math.min(_dnFactor + step, target));
    // Lights and fog follow the effective factor (a burning flare lifts the
    // night); the DAY / NIGHT label and the flare trigger keep the true one
    const fe = _dnEffFactor();
    if (fe !== _dnLitF) { _dnLitF = fe; _applyDNLights(fe); }
    _updateDNIndicator();
  }
  // A flare lifts the night toward FLARE_F, a nuke's fireball toward NUKE_LIGHT_F
  function _dnEffFactor() {
    return _dnFactor - Math.max(_flareK() * Math.max(0, _dnFactor - FLARE_F), _nukeLightK() * Math.max(0, _dnFactor - NUKE_LIGHT_F));
  }

  // Day-time light levels per graphics quality. Day/night blends from these,
  // so the two settings no longer overwrite each other.
  const GFX_LIGHTS = {
    HIGH: { ambCol: 0x99aabb, amb: 0.7, sun: 1.8, fill: 0.5 },
    LOW:  { ambCol: 0xaaaaaa, amb: 1.0, sun: 1.1, fill: 0   },
  };
  function _applyDNLights(f) {
    const b = GFX_LIGHTS[gfxQuality];
    if (_ambientLight) {
      _ambientLight.color.copy(_dnLerpCol(b.ambCol, 0x223459, f));
      _ambientLight.intensity = b.amb * (1 - f) + 0.26 * f;
    }
    // Sun: day full → night off, through a warm low sun at dusk / dawn. (A little stronger than it was when higher: the field keeps its tone)
    if (_sunLight) {
      _sunLight.color.copy(f < 0.45 ? _dnLerpCol(0xfff4cc, 0xff9a55, f / 0.45) : _dnLerpCol(0xff9a55, 0x001122, (f - 0.45) / 0.55));
      _sunLight.intensity = b.sun * 1.12 * (1 - f);
    }
    // the day's fill light becomes a cool moon from behind left (no shadows: cheaper, and a shadow could give a hidden Zerg away)
    if (_fillLight) {
      _fillLight.color.copy(_dnLerpCol(0x4488cc, 0x8fa8e8, f));
      _fillLight.position.set(-8 - f, 10 + 6 * f, -6 - 6 * f);
      _fillLight.intensity = b.fill * (1 - f) + 0.32 * f;
    }
    // Bunker light: off during day, warm white at night
    if (_bunkerLight) {
      _bunkerLight.intensity = f * 4.4;
    }
    // Fog: the radius shrinks by the same ratio every second (geometric blend).
    // Blended linearly, it stayed outside the battlefield for the first 60% of
    // dusk, then closed in on the bunker all at once.
    if (scene.fog) {
      scene.fog.near  = DN_DAY_FOG_NEAR * Math.pow(DN_NIGHT_FOG_NEAR / DN_DAY_FOG_NEAR, f);
      scene.fog.far   = DN_DAY_FOG_FAR  * Math.pow(DN_NIGHT_FOG_FAR  / DN_DAY_FOG_FAR,  f);
      // the sky: violet at dusk against the low orange sun, night blue (the fogged field itself fades to its own moonlit value)
      scene.fog.color.copy(f < .5 ? _dnLerpCol(0x2a3a18, 0x1d1f33, f / .5) : _dnLerpCol(0x1d1f33, 0x070c18, (f - .5) / .5));
    }
    // Background matches fog
    if (scene.background) {
      scene.background.copy(scene.fog ? scene.fog.color : new THREE.Color(0x2a3a18));
    }
    // the night's ground, and the sky the water and the polished surfaces mirror: blue, or the clouds' grey (dark under a
    // downpour), a violet dusk, night blue
    const cl = wx.cloud, rn = wx.rain, dusk = 4 * f * (1 - f), G = GLOW_LIGHTS, U = _groundU;
    U.uNight.value = f; U.uNightDesat.value = .55 * f;
    if (_fillLight) U.uMoonDir.value.copy(_fillLight.position).normalize();
    G.fogNight.value = f;
    G.fogGround.value.copy(U.uMoonTint.value).multiplyScalar(.24 * (.45 + .55 * U.uMoonDir.value.y));   // the mean grass's moonlit value
    G.skyZen.value.setHex(0x5a7cab).lerp(_wxC.setHex(0x6c747a).multiplyScalar(1 - .4 * rn), cl).lerp(_wxC.setHex(0x141c30), f).lerp(_wxC.setHex(0x3a2f58), .5 * dusk);
    G.skyHor.value.setHex(0x9db2c6).lerp(_wxC.setHex(0x858c90).multiplyScalar(1 - .3 * rn), cl).lerp(_wxC.setHex(0x222a40), f).lerp(_wxC.setHex(0x7a5060), .5 * dusk);
    _wxLights(f);   // under the clouds (weather)
  }

  function _updateDNIndicator() {
    const el = document.getElementById('tv-dn');
    if (!el) return;
    // (a night still lifting after the cycle restarted at day reads DAWN)
    const text = !dnEnabled ? '' : (_dnFactor > 0.5 ? '☽ ' : '☀ ') + (_dnFactor > 0.97 ? 'NIGHT' : _dnFactor < 0.03 ? 'DAY'
      : _dnTime >= DN_DAY && _dnTime < DN_DAY + DN_FADE + DN_NIGHT ? 'DUSK' : 'DAWN');
    // the countdown to the next phase: "DUSK IN 0:42" (day), "NIGHT IN" (dusk), "DAWN IN" (night), "DAY IN" (dawn)
    const next = document.getElementById('tv-dn-next');
    if (next) {
      const ends = [DN_DAY, DN_DAY + DN_FADE, DN_DAY + DN_FADE + DN_NIGHT, DN_CYCLE], names = ['DUSK', 'NIGHT', 'DAWN', 'DAY'];
      let k = 0;
      while (k < 3 && _dnTime >= ends[k]) k++;
      let until = ends[k] - _dnTime;
      // the label turns NIGHT / DAY at factor 0.97 / 0.03, a moment before that phase begins:
      // then count to the one after ("NIGHT IN 0:01" under NIGHT read wrong)
      if (names[k] === (_dnFactor > 0.97 ? 'NIGHT' : _dnFactor < 0.03 ? 'DAY' : '')) {
        until = k < 3 ? ends[k + 1] - _dnTime : DN_CYCLE + ends[0] - _dnTime;
        k = (k + 1) % 4;
      }
      const sec = Math.max(0, Math.ceil(until));
      const nt = !dnEnabled ? '' : `${names[k]} IN ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      if (next.textContent !== nt) next.textContent = nt;
    }
    if (el.textContent === text) return;   // called every frame
    el.textContent = text;
    el.style.color = _dnFactor > 0.5 ? '#8899ff' : '#ffcc44';
  }

  function toggleDayNight() {
    dnEnabled = !dnEnabled;
    if (!dnEnabled) {
      // Back to day: the night lifts over DN_SLEW s (updateDayNight — run by the
      // loop while the cycle is off even when the game is paused or over)
      _dnTime = 0;
      _updateDNIndicator();
    }
    // Update MENU checkbox
    const cb = document.getElementById('menu-dn-cb');
    if (cb) cb.checked = dnEnabled;
    // Show/hide top-bar indicator wrapper
    const wrap = document.getElementById('tv-dn-wrap');
    if (wrap) wrap.style.display = dnEnabled ? '' : 'none';
    if (!dnEnabled) { const lbl = document.getElementById('tv-dn'); if(lbl) lbl.textContent=''; }
    setStatus(dnEnabled ? 'Day/Night cycle ON — [Y] to toggle' : 'Day/Night cycle OFF');
  }

  // ── Weather ──────────────────────────────────────────────────────────────
  // The sky wanders at random between clear, clouded over and rain (desktop
  // weather.cpp), on game time: live frames only. Rounds miss in the rain
  // (rainMiss), the clouds dim and grey the light (_wxLights), the rain falls
  // in a box over the field and is heard (RainBed). Every game starts clear;
  // not saved. Menu → Settings switches it (stored, on by default).
  const WX_KEY = 'dotd_weather', RAIN_MISS = [0.05, 0.10];
  let wxOn = (() => { try { return localStorage.getItem(WX_KEY) !== '0'; } catch (e) { return true; } })();   // (_store is defined further down)
  const wx = { sky: 'clear', hold: 0, afterRain: false, showerMax: 0, spell: 0, cloud: 0, rain: 0,
               windX: 0, windZ: 0, blownX: 0, blownZ: 0, driftX: 0, driftZ: 0, fall: 0, t: 0, wet: 0, puddle: 0 };   // spell: before a shower may turn · blown / fall: the drops (m)
  let _wxLitC = 0, _wxLitR = 0, _wxSaid = 'CLEAR';   // the cloud / rain the lights were last applied at · the sky last announced
  const _uni = (a, b) => a + Math.random() * (b - a);
  const wxHeavy = () => wx.showerMax >= 0.5;
  const wxName = () => wx.sky === 'rain' ? (wxHeavy() ? 'DOWNPOUR' : 'DRIZZLE') : wx.sky === 'overcast' ? 'OVERCAST' : 'CLEAR';
  function _wxWind(s) { const a = _uni(0, 6.2832); wx.windX = Math.cos(a) * s; wx.windZ = Math.sin(a) * s; }
  function wxReset() {               // a new game (and the title): clear and dry, the first change a while off
    Object.assign(wx, { sky: 'clear', hold: _uni(45, 100), afterRain: false, showerMax: 0, spell: 0, cloud: 0, rain: 0, blownX: 0, blownZ: 0, fall: 0, t: 0 });
    _wxWind(1.2); _wxSaid = 'CLEAR';
    if (_wxLitC || _wxLitR) _applyDNLights(_dnLitF);
    syncRain();
  }
  function wxPour(hard) { wx.showerMax = hard ? _uni(0.7, 1) : _uni(0.15, 0.35); wx.spell = _uni(15, 30); }   // a downpour, or a drizzle
  function wxSet(sky) {
    wx.sky = sky; wx.afterRain = false;
    if (sky === 'rain') {             // a drizzle or a downpour (even odds), its wind (harder in a downpour), how long it lasts
      wxPour(Math.random() < 0.5);
      _wxWind(wxHeavy() ? _uni(1.2, 3.2) : _uni(0.3, 1.2));
      wx.hold = _uni(40, 90);
    } else wx.hold = sky === 'clear' ? _uni(80, 170) : _uni(25, 45);
  }
  // Clear (80-170 s) → overcast (25-45 s) → a shower half the time (40-90 s), else clear; after a shower
  // it stays overcast a while (20-40 s) and rains again a quarter of the time. Every 15-30 s a shower may
  // turn from a drizzle to a downpour or back (two times in five). Off: the sky clears
  function wxUpdate(dt) {
    const on = wxOn;
    wx.t += dt;
    if (on && wx.sky === 'rain' && (wx.spell -= dt) <= 0) { if (Math.random() < 0.4) wxPour(!wxHeavy()); else wx.spell = _uni(15, 30); }
    if (on && (wx.hold -= dt) <= 0) {
      if (wx.sky === 'clear') { wx.sky = 'overcast'; wx.afterRain = false; wx.hold = _uni(25, 45); }
      else if (wx.sky === 'overcast') wxSet(Math.random() < (wx.afterRain ? 0.25 : 0.5) ? 'rain' : 'clear');
      else { wx.sky = 'overcast'; wx.afterRain = true; wx.hold = _uni(20, 40); }
    }
    // the clouds roll in (and out) over ~18 s; the rain starts once they are in, comes up over ~6 s
    // and stops over ~4 s, wavering a little as it falls
    wx.cloud += Math.max(-dt / 18, Math.min(dt / 18, (on && wx.sky !== 'clear' ? 1 : 0) - wx.cloud));
    const waver = 0.88 + 0.12 * Math.sin(0.31 * wx.t) * Math.sin(0.13 * wx.t + 1);
    wx.rain += Math.max(-dt / 4, Math.min(dt / 6, (on && wx.sky === 'rain' && wx.cloud > 0.75 ? wx.showerMax * waver : 0) - wx.rain));
    wx.blownX += wx.windX * dt; wx.blownZ += wx.windZ * dt;
    wx.fall += (5 + 7 * wx.rain) * dt;  // a drizzle's fine drops fall at ~6 m/s, a downpour's at 12
    wx.driftX += wx.windX * 1.5 * dt; wx.driftZ += wx.windZ * 1.5 * dt;   // the clouds drift with the wind
    // the ground: soaked after ~12 s of a downpour, the puddles full after ~45 s more; once the rain stops it dries in
    // about a minute under the sun (two under clouds), the puddles seep away slower. Switched off, four times as fast
    const off = on ? 1 : 4;
    if (wx.rain > 0.02) {
      wx.wet = Math.min(1, wx.wet + dt * wx.rain / 12);
      wx.puddle = Math.min(1, wx.puddle + dt * wx.rain * wx.wet / 45);
    } else {
      wx.wet = Math.max(0, wx.wet - dt * off / (50 + 70 * wx.cloud));
      wx.puddle = Math.max(0, wx.puddle - dt * off / (100 + 100 * wx.cloud));
    }
  }
  function updateWeather(dt) {        // a live frame: the sky, the light under it, the rain
    wxUpdate(dt);
    const nm = wxName();
    if (nm !== _wxSaid) {             // the player is told what the rain does to the aim (also after the rain cheat)
      if (wx.sky === 'rain') setStatus(`${nm} — ${Math.round(100 * RAIN_MISS[+wxHeavy()])}% of rounds miss`);
      else if (_wxSaid === 'DRIZZLE' || _wxSaid === 'DOWNPOUR') setStatus('The rain stops');
      _wxSaid = nm;
    }
    if (wx.cloud !== _wxLitC || wx.rain !== _wxLitR) _applyDNLights(_dnLitF);
    syncRain();
  }
  // 5% in a drizzle, 10% in a downpour, between the two as the rain grows (none in the last of it)
  function rainMiss() {
    const r = wx.rain, s = Math.max(0, Math.min(1, (r - 0.35) / 0.35));
    return r < 0.05 ? 0 : RAIN_MISS[0] + (RAIN_MISS[1] - RAIN_MISS[0]) * s * s * (3 - 2 * s);
  }
  function setWeather(on) {           // Menu → Settings
    wxOn = !!on; _store.set(WX_KEY, wxOn ? '1' : '0');
    if (wxOn) RainBed.prime();
    $('menu-wx-cb').checked = wxOn;
    setStatus(wxOn ? 'Weather ON — clear skies, clouds, now and then rain' : 'Weather OFF — the sky clears');
  }
  // After _applyDNLights (day / night, a flare's or a nuke's lift): clouds dim the sun and grey it,
  // flatten the ambient toward grey and dim it a little, dim the fill as it fades at dusk; a downpour
  // darkens the day a little more and hazes the distance. The night is left as it is: its fog is what
  // the player sees by, and the web has no moon (the desktop's fill turns into one, which clouds hide
  // in part; ours is off at night). A clear sky changes nothing
  const _wxHaze = new THREE.Color(0x3c4648), _wxC = new THREE.Color();
  function _wxGrey(c, k) { const l = c.r * .299 + c.g * .587 + c.b * .114; c.r += (l - c.r) * k; c.g += (l - c.g) * k; c.b += (l - c.b) * k; }
  function _wxLights(f) {
    const cl = _wxLitC = wx.cloud, rn = _wxLitR = wx.rain, cd = cl * (1 - f), haze = Math.max(0.35 * cl, rn);
    if (!cl && !rn) return;
    if (_ambientLight) { _wxGrey(_ambientLight.color, 0.5 * cd); _ambientLight.intensity *= (1 + 0.3 * cd) * (1 - 0.15 * rn * (1 - f)); }
    if (_sunLight) { _wxGrey(_sunLight.color, 0.4 * cl); _sunLight.intensity *= (1 - 0.6 * cl) * (1 - 0.35 * rn); }
    if (_fillLight) _fillLight.intensity *= 1 - 0.4 * cl * f;
    if (scene.fog) {
      scene.fog.near *= Math.pow(1 - 0.45 * haze, 1 - f); scene.fog.far *= Math.pow(1 - 0.35 * haze, 1 - f);
      scene.fog.color.lerp(_wxHaze, 0.6 * cd);
      if (scene.background) scene.background.copy(scene.fog.color);
    }
  }
  // The rain: streaks falling through a box over the field (fixed in the world: they do not swim as the
  // view turns) and small rings where drops hit the ground. Each drop is a quad placed in the vertex
  // shader from its index (position.z; xy: the corner), so nothing is simulated on the CPU
  const RAIN_N = { HIGH: [12000, 2000], LOW: [5000, 800] };   // streaks, splashes at full rain (fewer as it eases; many out of view)
  const RAIN_VS = `
    uniform float uFall, uTime, uSpeed, uLen, uWidth, uAlpha, uPx, uCount, fogNear, fogFar;
    uniform vec2 uWind, uBlown;   // uBlown: how far the wind has carried the drops
    uniform vec3 uLight, uLampCol;
    varying vec2 vQ; varying float vA; varying vec3 vCol;
    const float HALF = 26.0, TOP = 12.0;   // the box: the field, and the air over it to well under the overview camera
    vec4 h41(float n) {
      vec4 p = fract(vec4(n) * vec4(.1031, .1030, .0973, .1099));
      p += dot(p, p.wzxy + 33.33);
      return fract((p.xxyz + p.yzzw) * p.zywx);
    }
    void main() {
      vec2 c = position.xy;
      float id = position.z;
      vec4 h = h41(id + 0.5);
      float a = clamp(uCount - id, 0.0, 1.0);   // the last few fade as the rain eases
      vec3 P;
    #if KIND == 0
      // a streak falls at its own pace, wraps from the ground back to the top and drifts with the wind
      float pace = 0.85 + 0.3 * h.w;
      float y = TOP - mod(uFall * pace + h.z * TOP, TOP);
      vec2 xz = mod(h.xy * 2.0 * HALF + uBlown, 2.0 * HALF) - HALF;
      vec3 dir = normalize(vec3(uWind.x, -uSpeed * pace, uWind.y));
      P = vec3(xz.x, y, xz.y) - dir * (uLen * c.y);   // c.y: head (0) to tail (1)
      vec3 toCam = cameraPosition - P, side = cross(dir, toCam);
      float dist = length(toCam), w = max(uWidth, dist * uPx);   // never thinner than a pixel: fainter instead
      P += side * ((c.x - 0.5) * w / max(length(side), 1e-4));
      a *= uAlpha * uWidth / w * smoothstep(3.0, 8.0, dist);    // none close to the lens (the close-up stands in the rain)
      vQ = vec2(c.x * 2.0 - 1.0, c.y);
    #else
      // a splash: a ring on the ground for 0.18 s, somewhere new each time
      float period = 0.5 + 0.6 * h.w, cyc = uTime / period + h.z * 17.0, life = fract(cyc) * period / 0.18;
      vec4 g = h41(id * 7.13 + floor(cyc) * 131.7);
      float r = life < 1.0 ? 0.03 + 0.1 * sqrt(life) : 0.0;   // (spent: a point, nothing drawn)
      P = vec3((g.x * 2.0 - 1.0) * HALF + (c.x * 2.0 - 1.0) * r, 0.025, (g.y * 2.0 - 1.0) * HALF + (c.y * 2.0 - 1.0) * r);
      a *= 0.35 * (1.0 - life) * (1.0 - life);
      vQ = c * 2.0 - 1.0;
    #endif
      a *= 1.0 - smoothstep(0.75 * HALF, HALF, max(abs(P.x), abs(P.z)));   // no edge to the box
      a *= 1.0 - smoothstep(fogNear, fogFar, length(P.xz));                 // into the night's dark
      float l = clamp(1.0 - length(P - vec3(0.0, 2.6, 0.0)) / 15.0, 0.0, 1.0);   // where the bunker's light catches them
      vCol = uLight + uLampCol * l * l;
      vA = a;
      gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
    }`;
  const RAIN_FS = `
    varying vec2 vQ; varying float vA; varying vec3 vCol;
    void main() {
    #if KIND == 0
      float a = vA * (1.0 - vQ.x * vQ.x) * (1.0 - 0.75 * vQ.y);   // soft across, fading toward the tail
    #else
      float d = length(vQ);
      float a = vA * smoothstep(0.45, 0.8, d) * (1.0 - smoothstep(0.8, 1.0, d));   // a thin ring
    #endif
      if (a < 0.003) discard;
      gl_FragColor = vec4(vCol, a);
    }`;
  const _rainU = { uFall: { value: 0 }, uTime: { value: 0 }, uSpeed: { value: 5 }, uLen: { value: .2 }, uWidth: { value: .01 }, uAlpha: { value: .4 }, uPx: { value: .001 },
                   uWind: { value: new THREE.Vector2() }, uBlown: { value: new THREE.Vector2() }, uLight: { value: new THREE.Color() }, uLampCol: { value: new THREE.Color() } };
  const _rainC = new THREE.Color();
  // kind 0: the streaks, after the other see-through things (they hang through the whole view);
  // 1: the splashes, on the ground under them
  const _rainMesh = (n, kind) => {
    const pos = new Float32Array(n * 12), idx = new (n * 4 > 65535 ? Uint32Array : Uint16Array)(n * 6);
    for (let i = 0; i < n; i++) { pos.set([0, 0, i, 1, 0, i, 1, 1, i, 0, 1, i], i * 12); const v = i * 4; idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);   // dry: an empty range, never hidden, so the program compiles with the first frame (not at the first shower, mid-fight)
    const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog), _rainU, { uCount: { value: 0 } }),
      defines: { KIND: kind }, vertexShader: RAIN_VS, fragmentShader: RAIN_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true }));
    m.frustumCulled = false; m.renderOrder = kind ? 0 : 9; scene.add(m);
    return m;
  };
  const _rainMeshes = [_rainMesh(RAIN_N.HIGH[0], 0), _rainMesh(RAIN_N.HIGH[1], 1)];
  function syncRain() {
    const r = wx.rain;
    if (r < 0.005) { _rainMeshes.forEach(m => m.geometry.setDrawRange(0, 0)); return; }
    const U = _rainU, mod = (v, m) => v - m * Math.floor(v / m);
    // a drizzle's drops: fine, short and faint; a downpour's: long streaks, thicker, brighter
    U.uFall.value = wx.fall; U.uTime.value = wx.t % 2048; U.uSpeed.value = 5 + 7 * r;
    U.uLen.value = .2 + .35 * r; U.uWidth.value = .01 + .008 * r; U.uAlpha.value = .4 + .25 * r;
    U.uPx.value = 2 / (camera.projectionMatrix.elements[5] * Math.max(1, _logH * renderer.getPixelRatio()));   // world size of a pixel per unit of distance
    U.uWind.value.set(wx.windX, wx.windZ); U.uBlown.value.set(mod(wx.blownX, 52), mod(wx.blownZ, 52));   // (the box repeats: no jump)
    // lit by the sky, the sun through the clouds and the day's fill; near the bunker at night they glint in its
    // light's own colour, 1.32 × at full night (desktop: .3 × its lamp's 4.4). 5.5: the lamp at full night
    // (_applyDNLights): change the two together
    const L = U.uLight.value.copy(_ambientLight.color).multiplyScalar(_ambientLight.intensity);
    L.add(_rainC.copy(_sunLight.color).multiplyScalar(.25 * _sunLight.intensity)).add(_rainC.copy(_fillLight.color).multiplyScalar(.3 * _fillLight.intensity));
    U.uLampCol.value.copy(_bunkerLight.color).multiplyScalar(1.32 / 5.5 * _bunkerLight.intensity);
    RAIN_N[gfxQuality].forEach((max, k) => {
      const m = _rainMeshes[k];
      m.material.uniforms.uCount.value = max * r; m.geometry.setDrawRange(0, 6 * Math.ceil(max * r));
    });
  }

  // ── Main loop ────────────────────────────────────────────────────────────
  function loop(){
    requestAnimationFrame(loop);
    const dt=Math.min(clock.getDelta(),.05);
    updateCamera(dt); // also while paused: the player can look around
    placeSlotOverlay();
    if(_muzzleLight) _muzzleLight.intensity=Math.max(0,_muzzleLight.intensity-dt*45); // flash decays in ~60 ms
    _gunI*=Math.exp(-dt*11);                             // its pool on the ground: a quarter left by the next volley (sustained fire glows)
    if(_gunLight) _gunLight.intensity=_gunI*(.4+.6*_dnLitF);
    RainBed.set(phase==='playing'?wx.rain:0,dt); // heard while paused too, not under the title / results
    if(phase!=='playing'||isPaused()){
      // Game clock, survival timer and scheduled events are frozen here
      if(phase==='playing'){ syncEnemyPools(); syncBullets(); updateParticles(_glow,0); updateParticles(_smoke,0); }
      // A night switched off still lifts behind the menu, title and results (it is
      // not game time: with the cycle off nothing else moves). Left frozen, the
      // title showed the night and the next game started in it.
      if(!dnEnabled&&_dnFactor>0) updateDayNight(dt);
      drawCH();tickPortrait(dt);renderFrame();return;
    }
    _gameT+=dt;

    // Throttled HUD refresh (~7Hz). The HUD used to be rebuilt every frame
    // from inside the enemy-damage loop — by far the biggest CPU cost.
    _hudTick-=dt;
    if(_hudTick<=0){_hudTick=0.15;updateHUD();}
    _dmgFlashCD=Math.max(0,_dmgFlashCD-dt);

    shootCD=Math.max(0,shootCD-dt);
    holdFire(dt);
    airCD=Math.max(0,airCD-dt);
    if(stimT>0){
      stimT=Math.max(0,stimT-dt);
      if(superStimUnlocked){                            // Super Stimpack: the squad patches the bunker up (repairRate)
        if(Math.random()<dt*14){ const a=Math.random()*6.28, r=1.1+Math.random()*.4;
          emitParticle(_glow,Math.cos(a)*r,.3+Math.random()*.6,Math.sin(a)*r,0,1.4,0,.7,.22,.05,.9,0x6aff8a,0x1a9a3a,0,0,0); }
      }
    }
    if(nukeCD>0) nukeCD=Math.max(0,nukeCD-dt);

    // Scheduled game events (wave countdown, Viking, its missiles, nuke)
    tickScheduler(dt);
    if(phase!=='playing') return; // an event may have ended the game

    // Beams fade
    beams.forEach(b=>{
      b.life-=dt;
      b.mesh.material.opacity=Math.max(0,b.life/.5*.8);
      if(b.life<=0) _removeBeam(b);
    });
    beams=beams.filter(b=>b.life>0);

    // Spawn
    if(wavePhase==='combat'&&spawnQueue.length>0){
      spawnTimer-=dt;
      if(spawnTimer<=0){
        const type=spawnQueue.pop();
        const r=13+Math.random()*2,a=Math.random()*Math.PI*2;
        if(type==='z') zerglings.push(makeZergling(Math.cos(a)*r,Math.sin(a)*r));
        else           roaches.push(makeRoach(Math.cos(a)*r,Math.sin(a)*r));
        spawnTimer = type === 'r' ? spawnInterval * 1.6 : spawnInterval;
      }
    }

    // Enemies
    const arm=1/(1+armorLvl*.35);
    // Night fog: enemies beyond this dist become invisible (fog culling)
    const _nightFogFar = _dnFactor > 0.1 ? scene.fog.far : Infinity;   // also while the night lifts after switching it off
    allEnemies().forEach(e=>{
      if(e.dead)return;
      e.leg+=dt*(e.type==='r'?5:9);
      if(e.flash>0) e.flash-=dt;
      const ex=e.mesh.position.x,ez=e.mesh.position.z;
      const d=Math.sqrt(ex*ex+ez*ez);
      // Hide enemy mesh when beyond night fog range (a grenade's light shows it too); within a Sensor
      // Tower's range it is its blip only (not which kind) until the night leaves it SENSOR_SHOW_DARK dark
      if (_nightFogFar < Infinity) {
        const blip = sensorLvl >= 1 && d <= SENSOR_RANGE[sensorLvl];
        e.mesh.visible = blip ? _nightDark(ex, ez) < SENSOR_SHOW_DARK : d < _nightFogFar * 1.05 || _glowLit(ex, ez); // slight buffer so pop-in is smooth
      } else {
        e.mesh.visible = true;
      }
      if(d<attackReach(e)){
        if(e.type==='r') roachAttack(e,dt,ex,ez);       // ranged: acid (damage lands on impact)
        else {                                          // melee: bites the hull
          bunkerHp=Math.max(0,bunkerHp-e.dmg*dt*arm); // HUD refresh handled by throttled tick
          _waveHurt=true;
          let bite;
          if(e.attack){                                  // SC2 Attack animation on a loop; bites as the jaws close
            const t0=e.atkT; e.atkT+=dt*ANIM_SPEED/ZERGLING_BITE.anim;
            bite=t0<ZERGLING_BITE.bite&&e.atkT>=ZERGLING_BITE.bite;
            e.atkT%=1;
            e.pool=e.attack[Math.floor(e.atkT*e.attack.length)];
            e.mesh.rotation.y=Math.atan2(-ex,-ez); e.mesh.position.y=0;
          } else {
            e.biteT=(e.biteT??Math.random()*.4)-dt;
            if((bite=e.biteT<=0)) e.biteT=.45+Math.random()*.35;
            if(e.walk) walkStep(e, dt*.5);              // claws at the hull: tread on the spot
            else e.mesh.position.y=Math.abs(Math.sin(e.leg))*.07;
          }
          if(bite){                                      // sparks where it bites the hull
            const k=1.45/Math.max(.01,d);
            spawnParts({x:ex*k,y:.45+Math.random()*.4,z:ez*k},0xffcc66,3);
            SFX.play('bite');
          }
          if(_dmgFlashCD<=0){flash('dmg-flash');_dmgFlashCD=0.6;} // hit feedback vignette
          if(bunkerHp<=0){gameOver();return;}
        }
      } else {
        const slowF=slowedEnemies.has(e.mesh.uuid)?slowedEnemies.get(e.mesh.uuid).factor:1;
        const move=e.speed*slowF*60*dt;
        e.mesh.position.x-=ex/d*move;
        e.mesh.position.z-=ez/d*move;
        // SC2 walk cycle paced by the distance covered; procedural blocks hop;
        // a model without a walk cycle bobs and sways
        if(e.walk) walkStep(e, move);
        else {
          e.mesh.position.y=Math.abs(Math.sin(e.leg))*(e.model?.035:e.type==='r'?.1:.13);
          if(e.model) e.mesh.rotation.z=Math.sin(e.leg)*.05;
        }
        e.mesh.rotation.y=Math.atan2(-ex,-ez);
      }
    });
    zerglings=zerglings.filter(z=>!z.dead);
    roaches=roaches.filter(r=>!r.dead);
    updateAcids(dt);                                    // acid in flight (keeps going if its Roach died)
    if(bunkerHp<=0){gameOver();return;}

    // Bullets
    const baseDmg=10*(1+dmgLvl*.6)*(1+CFG.endless_dmg*endlessWaves())*(1+CFG.armory_dmg*armory.dmg);
    // Tick slow debuff expiry (game time — slows don't run out while paused)
    slowedEnemies.forEach((v,uuid)=>{if(_gameT>v.until)slowedEnemies.delete(uuid);});
    const _fs=dt*60; // frame scale: movement tuned at 60fps, now Hz-independent
    const _enemyList=allEnemies(); // hoisted — was re-allocated per bullet
    bullets.forEach(b=>{
      if(!b.alive)return;
      // Swept hit test along this frame's path: a point test let fast rounds
      // (0.65 units/frame at 60 fps, double at 30 fps) skip through zerglings.
      const px=b.mesh.position.x, pz=b.mesh.position.z;
      const sx=b.vx*_fs, sz=b.vz*_fs, sLen2=sx*sx+sz*sz||1;
      b.mesh.position.x+=sx; b.mesh.position.z+=sz; b.dist+=b.speed*_fs;
      if(b.vy){
        b.mesh.position.y+=b.vy*_fs;
        if(b.mesh.position.y<0.12){ b.mesh.position.y=0.12; b.vy=0; _orientBullet(b); } // past the aim point: skim the ground
      }
      if(b.unitType==='marauder'){                     // punisher grenade: its light streak (the flame is drawn; smoke
        const p=b.mesh.position, k=.5*MG_LEN/(Math.hypot(b.vx,b.vy,b.vz)||1);   // puffs, one a frame at its speed, dotted the path)
        b.trail.push([p.x-b.vx*k,p.y-b.vy*k,p.z-b.vz*k,_gameT]);
        while(b.trail.length>2&&_gameT-b.trail[0][3]>MG_STREAK) b.trail.shift();
      }
      let e=null, tBest=2;
      for(const c of _enemyList){
        if(c.dead||c===b.passed)continue;
        const ex=c.mesh.position.x-px, ez=c.mesh.position.z-pz;
        const t=Math.max(0,Math.min(1,(ex*sx+ez*sz)/sLen2)); // closest point on the segment
        const dx=ex-sx*t, dz=ez-sz*t, hitR=c.type==='r'?.75:.5;
        if(dx*dx+dz*dz<hitR*hitR&&t<tBest){ tBest=t; e=c; }  // keep the first one along the path
      }
      if(e&&b.unitType!=='marauder'&&Math.random()<rainMiss()){ b.passed=e; hitText(e,'MISS','#8cd8ff'); e=null; } // the rain spoils the aim: it flies on past, MISS in rain blue
      if(e){
        const t=tBest;
        {
          b.mesh.position.set(px+sx*t,b.mesh.position.y,pz+sz*t); // impact point (for sparks)
          const def=UNIT_DEF[b.unitType]||UNIT_DEF.marine;
          // Damage bonus: check enemy attrs against unit's bonusVs list
          const eAttrs = e.attrs || [];
          const hasBonus = def.bonusVs && def.bonusVs.some(tag => eAttrs.includes(tag));
          const bonus = hasBonus ? def.bonusMult : 1.0;
          const actualDmg = baseDmg*def.dmgMult*bonus;
          e.hp-=actualDmg;
          e.flash=0.08; SFX.play('hit');                 // white hit flash (instance colour) + tick
          hitText(e,Math.round(actualDmg).toString(),bonus>1?'#ff6600':'#ffffff');
          if(b.unitType==='marauder') marauderBlast(b.mesh.position,e,baseDmg,_enemyList);   // the rest of the blast, and the slow
          const vl=Math.hypot(b.vx,b.vz)||1;
          bloodFx(e,b.mesh.position,b.vx/vl,b.vz/vl);
          b.alive=false;
          if(e.hp<=0) killEnemy(e,true);
        }
      }
      if(b.alive&&b.dist>=(b.range||18)){
        if(b.unitType==='marauder') marauderBlast(b.mesh.position,null,baseDmg,_enemyList);   // came down on its target point
        b.alive=false;
      }
    });
    bullets=bullets.filter(b=>b.alive);
    syncBullets();

    // Particles (pooled + dt-scaled)
    // Particles (GPU points, 2 draw calls)
    updateParticles(_glow,dt); updateParticles(_smoke,dt);

    // Repair: Lv3 self-repair + Super Stimpack, stacked — HUD refresh handled by throttled tick
    const rr=repairRate();
    if(rr>0&&bunkerHp<maxHp) bunkerHp=Math.min(maxHp,bunkerHp+rr*dt);

    // Bunker fire particles
    updateBunkerFire(dt);


    // Wave clear check
    // (acid still in the air lands first: its damage belongs to this wave and its checkpoint)
    if(wavePhase==='combat'&&spawnQueue.length===0&&zerglings.length===0&&roaches.length===0&&acids.length===0){
      wavePhase='clearing'; waveCleared();
    }

    updateMarines(dt);
    syncUnitLamps();          // their chest lamps at night
    updateViking(dt);
    updateVikingMissiles(dt);
    syncMissiles();             // the Viking's and the Marauders' grenades
    syncBlasts(dt);
    syncGlows();                // their light (the bursts' and the grenades')
    checkBunkerHover(dt);
    ghostSnipeTick(dt);
    marauderFireTick();
    updateShrike(dt);
    updateCorpses(dt);
    updateFlare(dt);            // before the lights: they follow its strength (and the nuke light's)
    updateNukeLight(dt);
    updateWeather(dt);          // likewise: the light under the clouds
    updateDayNight(dt);
    syncNukeBlasts(dt);
    tutorialTick();
    // Update floating damage numbers
    floatTexts.forEach(f=>{
      f.life-=dt*1000; f.y+=dt*0.8;
      if(f.on&&!f.on.dead){ f.x=f.on.mesh.position.x; f.z=f.on.mesh.position.z; }   // a running Zergling would pass under it
    });
    floatTexts=floatTexts.filter(f=>f.life>0);
    syncEnemyPools();
    drawCH();
    tickPortrait(dt);
    renderFrame();
  }

  // ── Start / game over ─────────────────────────────────────────────────────
  function clearEntities(){
    clearScheduler();        // drop pending wave countdown / Viking / missile launches / nuke (runs their cleanup)
    removeViking();
    vMissiles=[]; mBlasts=[]; syncBlasts(0); GLOW_LIGHTS.glowCount.value=0;
    clearNukeBlasts();
    _nukeLightT=-1; if(_nukeLight) _nukeLight.intensity=0;
    clearFlare();            // the flare and the nuke light go: relights the scene at the true night factor
    _crateCbs=null; waveCrates=0;   // the crate on its way went with the Viking / marines; a stale wait would stall the next game
    _nukeInFlight=false;
    clearParticles(); _fireAccum.length=0;
    beams.forEach(_removeBeam);
    _shrikeTgt=null; _shrikeVel=0; _shrikeRecoil=0; _shrikeCD=0; // no target survives into the next game
    stimT=0; _stimVolley=0; _shrikeOD=false;
    [...zerglings,...roaches].forEach(e=>{ e.dead=true; });
    [...zerglings,...roaches,...crates,...marines].forEach(e=>{
      if(e.mesh) scene.remove(e.mesh);
    });
    zerglings=[];roaches=[];bullets=[];beams=[];crates=[];marines=[];spawnQueue=[];corpses=[];acids=[];
    syncBullets(); syncMissiles(); syncEnemyPools(); syncAcids(); syncUnitLamps();
    wxReset();               // a new game (and the title) under a clear sky
  }

  // ── Victory / defeat ──────────────────────────────────────────────────────
  const ENDLESS_KEY = 'dotd_endless_unlocked', BEST_KEY = 'dotd_endless_best';
  // localStorage with an in-memory mirror, so unlocks/records still work for
  // this session when the browser blocks site storage
  const _mem = {};
  const _store = {
    get(k) { try { const v = localStorage.getItem(k); if (v !== null) return v; } catch (e) {} return k in _mem ? _mem[k] : null; },
    set(k, v) { _mem[k] = String(v); try { localStorage.setItem(k, v); } catch (e) {} },
  };
  function endlessUnlocked() { return _store.get(ENDLESS_KEY) === '1'; }
  function _bestEndless() { try { return JSON.parse(_store.get(BEST_KEY) || 'null'); } catch (e) { return null; } }

  function gameOver(){
    achFlush();
    if(phase!=='playing') return;          // several biters can drop the hull to 0 in one frame
    phase='gameover';
    let record=false;
    if(gameMode==='endless'){
      const b=_bestEndless();
      if(!b||wave>b.wave||(wave===b.wave&&score>b.score)){ _store.set(BEST_KEY,JSON.stringify({wave,score})); record=true; }
    }
    showResults(false,false,record);
  }

  // Campaign won (final wave cleared): unlock Endless, show the victory screen.
  function campaignVictory(){
    if(victoryAchieved||phase!=='playing') return;
    victoryAchieved=true;
    score+=5000;                            // victory bonus
    achVictory();
    const newly=!endlessUnlocked();
    _store.set(ENDLESS_KEY,'1');
    // Checkpoint = "Continue · Endless": CONTINUE on the title resumes in Endless,
    // not as a 16th campaign wave that would bring this screen back
    _writeSave(AUTO_KEY,{gameMode:'endless'});
    phase='victory';                        // freezes the game behind the results screen
    flash('nuke-flash'); SFX.play('clear');
    updateHUD();
    showResults(true,newly,false);
  }
  function continueEndless(){
    if(phase!=='victory') return;
    gameMode='endless';
    $('overlay').style.display='none';
    phase='playing';
    setStatus('ENDLESS MODE — the swarm never stops. Resupply incoming...');
    Music.play('battle');
    updateHUD();
  }

  // ── Achievements ──────────────────────────────────────────────────────────
  // What the player has earned across games, the lifetime stats some of them
  // count, and the rules that unlock them (the desktop's achievements.cpp). One
  // _store key, JSON {earned:{id: unix s}, stats:{kills, snipes}}. Unlocks are
  // written at once; stats at a cleared wave, a new game, game over and when the
  // page is hidden. A game in which a cheat code was used (or loaded from a save
  // made before achievements) earns nothing and counts toward nothing.
  const ACH_KEY = 'dotd_achievements', ACH_CATS = ['CAMPAIGN', 'ENDLESS', 'COMBAT', 'COMMAND', 'FEATS'];
  const _GEN = RANKS[RANKS.length - 1];
  // In display order. Points as StarCraft II's: 10 / 20 / 30 / 50. icon: 'svg:<sprite symbol>' or a file in assets/ui
  const ACH = [   // id, name, what to do, category (ACH_CATS), points, icon, lifetime stat, its goal, hidden (??? until earned)
    ['boot_camp', 'BOOT CAMP', 'Finish the HUD tour.', 0, 10, 'svg:help'],
    ['first_blood', 'FIRST BLOOD', 'Kill your first Zerg.', 0, 10, 'svg:rank'],
    ['wave5', 'HOLD THE LINE', 'Clear wave 5.', 0, 10, 'svg:campaign'],
    ['wave10', 'DIG IN', 'Clear wave 10.', 0, 20, 'svg:campaign'],
    ['victory', 'THE DOMINION STANDS', `Win the campaign: clear wave ${CFG.victory_wave}.`, 0, 30, 'svg:campaign'],
    ['endless20', 'NO END IN SIGHT', 'Clear wave 20 in Endless.', 1, 20, 'svg:endless'],
    ['endless25', 'THE SWARM GROWS', 'Clear wave 25 in Endless.', 1, 30, 'svg:endless'],
    ['endless30', 'LEGEND OF KORHAL', 'Clear wave 30 in Endless.', 1, 50, 'svg:endless'],
    ['kills100', 'EXTERMINATOR', 'Kill 100 Zerg in one game.', 2, 10, 'svg:rank'],
    ['general', 'FOUR STARS', `Reach the rank of ${_GEN.name} in one game (${_GEN.kills} kills).`, 2, 20, 'svg:rank'],
    ['kills1000', 'VETERAN', 'Kill 1,000 Zerg in all.', 2, 20, 'svg:rank', 'kills', 1000],
    ['kills5000', 'HIVE BREAKER', 'Kill 5,000 Zerg in all.', 2, 50, 'svg:rank', 'kills', 5000],
    ['nuke10', 'NUCLEAR OPTION', 'Kill 10 Zerg with one nuke.', 2, 20, 'nukes_coop.png'],
    ['strike10', 'AIR SUPERIORITY', 'Kill 10 Zerg with one airstrike.', 2, 20, 'btn-progression-hornerhan-5-fleetcalldown.png'],
    ['grenade5', 'SHRAPNEL', 'Kill 5 Zerg with one Marauder grenade.', 2, 20, 'btn-upgrade-terran-explosiveshrapnelshells.png'],
    ['snipe50', 'ONE SHOT, ONE KILL', 'Kill 50 Zerg with Ghost snipes, in all.', 2, 20, 'btn-upgrade-terran-ui-lazertargetingsystem.png', 'snipes', 50],
    ['maxed', 'FULLY UPGRADED', 'Max damage, armor, hull and ammo storage in one game.', 3, 20, 'btn-upgrade-terran-infantryweaponslevel3.png'],
    ['shrike', 'SHRIKE ONLINE', 'Mount the Shrike turret: bunker hull level 3.', 3, 10, 'btn-upgrade-terran-hisecautotracking.png'],
    ['overdrive', 'OVERDRIVE', 'Six Marines in a level 3 bunker: the Shrike in overdrive.', 3, 20, 'btn-upgrade-terran-hisecautotracking.png'],
    ['combined', 'COMBINED ARMS', 'A Marine, a Marauder and a Ghost in the bunker at once.', 3, 10, 'svg:roster'],
    ['superstim', 'SUPER SOLDIERS', 'Research all three Super Stimpack tiers.', 3, 20, 'btn-upgrade-terran-superstimppack.png'],
    ['sensor3', 'EYES IN THE DARK', 'Research the Sensor Tower to level 3.', 3, 10, 'svg:sensor'],
    ['untouchable', 'UNTOUCHABLE', 'Clear wave 5 or later with no Zerg damage to the bunker.', 4, 20, 'btn-upgrade-terran-buildingarmor.png'],
    ['last_stand', 'LAST STAND', 'Clear a wave with the bunker below 10% HP.', 4, 20, 'btn-upgrade-terran-neosteelframe.png', '', 0, true],
    ['night_watch', 'NIGHT WATCH', 'Clear a wave at night (Menu → Settings → day/night cycle).', 4, 10, 'svg:sensor'],
    ['marines_only', 'BAND OF BROTHERS', 'Win the campaign without hiring a Marauder or a Ghost.', 4, 50, 'svg:roster'],
    ['no_support', 'NO AIR SUPPORT', 'Win the campaign without calling an airstrike or a nuke.', 4, 50, 'svg:lock'],
  ].map(([id, name, desc, cat, points, icon, stat = '', goal = 0, hidden = false]) => ({ id, name, desc, cat, points, icon, stat, goal, hidden }));
  const ACH_TOTAL = ACH.reduce((p, a) => p + a.points, 0);
  const _achDef = id => ACH.find(a => a.id === id);
  function _achRead() {                         // the stored record (a new player: nothing earned)
    const b = { earned: {}, stats: {} };
    try {
      const d = JSON.parse(_store.get(ACH_KEY) || 'null') || {};
      for (const [id, t] of Object.entries(d.earned || {})) if (_achDef(id)) b.earned[id] = +t > 0 ? +t : 1;   // ids of removed achievements drop out
      for (const [k, n] of Object.entries(d.stats || {})) if (isFinite(n)) b.stats[k] = +n;
    } catch (e) {}
    return b;
  }
  const _ach = Object.assign(_achRead(), { dirty: false });
  _ach.base = { ..._ach.stats };                // the stats as last read or written: this page has added stats - base since
  // This game's facts the rules need (saved with the game): cheated also covers legacy, a save from
  // before achievements whose past is unknown; usedSupport = an airstrike or nuke called; hiredOther =
  // a Marauder or Ghost hired. _runAch: earned this game (the results); _waveHurt: a bite or acid this wave
  const _newRun = () => ({ cheated: false, legacy: false, usedSupport: false, hiredOther: false });
  let _run = _newRun(), _runAch = [], _waveHurt = false, _airRunKills = 0;
  // Another tab of the game writes the same record: fold what is stored now into this page's copy, never
  // write over it. Earned: either's (the earlier date); stats: the stored ones plus what this page added
  function _achMerge(d) {
    for (const [id, t] of Object.entries(d.earned)) if (!(_ach.earned[id] <= t)) _ach.earned[id] = t;
    for (const k of new Set([...Object.keys(d.stats), ...Object.keys(_ach.stats)])) _ach.stats[k] = (d.stats[k] || 0) + (_ach.stats[k] || 0) - (_ach.base[k] || 0);
    _ach.base = { ...d.stats };
  }
  function _achSave() {
    _achMerge(_achRead());
    _ach.dirty = false; _ach.base = { ..._ach.stats };
    _store.set(ACH_KEY, JSON.stringify({ earned: _ach.earned, stats: _ach.stats }));
  }
  function achFlush() { if (_ach.dirty) _achSave(); }
  addEventListener('pagehide', achFlush);       // the web has no shutdown hook
  document.addEventListener('visibilitychange', () => { if (document.hidden) achFlush(); });
  addEventListener('storage', e => { if (e.key === ACH_KEY) { _achMerge(_achRead()); _achRedraw(); } });   // another tab earned or counted something
  const achCount = () => Object.keys(_ach.earned).length;
  const achPoints = () => ACH.reduce((p, a) => p + (_ach.earned[a.id] ? a.points : 0), 0);
  function _achUnlock(id) {
    if (_ach.earned[id] || !_achDef(id)) return;
    _ach.earned[id] = Math.floor(Date.now() / 1000);
    _achSave();                                 // at once: the toast must not be lost
    _runAch.push(id);
    _toasts.push(id); if (_toasts.length === 1) _toastShow(); else _toastKick();
    if (phase !== 'playing') _achRedraw();      // under a card: the HUD tour run from the title, the list or the results
  }
  function _achAdd(key, n) {                    // a lifetime stat; earns the ones counting it at their goal
    const v = _ach.stats[key] = (_ach.stats[key] || 0) + n;
    _ach.dirty = true;
    ACH.forEach(a => { if (a.goal > 0 && a.stat === key && v >= a.goal) _achUnlock(a.id); });
  }
  // ── rules ──
  function achKill(gameKills) {                 // a Zerg killed for its reward; gameKills: this game's total
    if (_run.cheated) return;
    _achUnlock('first_blood'); _achAdd('kills', 1);
    if (gameKills >= 100) _achUnlock('kills100');
    if (gameKills >= _GEN.kills) _achUnlock('general');
  }
  function achSnipe() { if (!_run.cheated) _achAdd('snipes', 1); }
  function achMultiKill(by, n) {                // 'nuke' (one blast), 'strike' (one airstrike), 'grenade' (one burst)
    if (_run.cheated) return;
    if (by === 'nuke' && n >= 10) _achUnlock('nuke10');   // (20 was out of reach: rarely 20 alive at once)
    else if (by === 'strike' && n >= 10) _achUnlock('strike10');
    else if (by === 'grenade' && n >= 5) _achUnlock('grenade5');
  }
  function achWaveCleared(endless, w, hurt, hpFrac, night) {
    if (_run.cheated) return;
    if (w >= 5) _achUnlock('wave5');
    if (w >= 10) _achUnlock('wave10');
    if (endless && w >= 20) _achUnlock('endless20');
    if (endless && w >= 25) _achUnlock('endless25');
    if (endless && w >= 30) _achUnlock('endless30');
    if (w >= 5 && !hurt) _achUnlock('untouchable');
    if (hpFrac > 0 && hpFrac < 0.1) _achUnlock('last_stand');
    if (night) _achUnlock('night_watch');
    achFlush();                                 // a wave is a checkpoint: the lifetime kills and snipes are stored with it
  }
  function achVictory() {
    if (_run.cheated) return;
    _achUnlock('victory');
    if (!_run.hiredOther) _achUnlock('marines_only');
    if (!_run.usedSupport) _achUnlock('no_support');
  }
  function achState() {                         // after a purchase, a hire, a research, the overdrive, a load
    if (_run.cheated) return;
    if (dmgLvl >= 3 && armorLvl >= 3 && hpLvl >= 3 && ammoLvl >= 3) _achUnlock('maxed');
    if (hpLvl >= 3) _achUnlock('shrike');
    if (shrikeOverdrive()) _achUnlock('overdrive');
    if (['marine', 'marauder', 'ghost'].every(u => roster.includes(u))) _achUnlock('combined');
    if (superStimLvl >= 3) _achUnlock('superstim');
    if (sensorLvl >= 3) _achUnlock('sensor3');
  }
  function achTourDone() { _achUnlock('boot_camp'); }   // the caller skips a cheated game
  // ── drawing: the icon, the row (the list, the menu, the results, the toast reuse them) ──
  const _MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const _achDate = t => { if (!(t > 1)) return ''; const d = new Date(t * 1000); return `${d.getDate()} ${_MON[d.getMonth()]} ${d.getFullYear()}`; };   // 24 OCT 2026: day and month cannot be swapped
  const _thousands = n => n.toLocaleString('en-US');
  // One of the HUD's StarCraft II buttons, else a stroke icon on a dark tile; dimmed and grey until earned
  function _achIconHTML(a, got = !!_ach.earned[a.id]) {
    return `<span class="ach-ico${got ? ' got' : ''}">${a.icon.startsWith('svg:') ? `<svg class="ico"><use href="#i-${a.icon.slice(4)}"/></svg>` : `<img src="${UI_DIR + a.icon}" alt="">`}${!got && a.hidden ? '<b>?</b>' : ''}</span>`;
  }
  // As StarCraft II lists it: the icon in its frame, a blue panel with the name and what to do (a lifetime
  // stat's bar along its foot), and a box with the points, large, and the date earned (else the progress, else LOCKED)
  function _achRowHTML(a) {
    const t = _ach.earned[a.id], got = !!t, secret = a.hidden && !got, p = a.goal ? Math.min(_ach.stats[a.stat] || 0, a.goal) : 0;
    return `<div class="ach-row${got ? ' got' : ''}">${_achIconHTML(a, got)}<div class="ach-main"><b>${secret ? '???' : a.name}</b><span>${secret ? 'Hidden — keep playing to find it.' : a.desc}</span>` +
      `${a.goal && !got ? `<i class="ach-prog"><i style="width:${p / a.goal * 100}%"></i></i>` : ''}</div>` +
      `<div class="ach-pts"><b>${a.points}</b><span>${got ? _achDate(t) : a.goal ? _thousands(p) + '/' + _thousands(a.goal) : 'LOCKED'}</span></div></div>`;
  }
  const _achSum = () => `${achCount()} / ${ACH.length} earned · ${achPoints()} / ${ACH_TOTAL} points`;
  const _achTotalsHTML = () => `<div class="ach-tot">${_achSum()}</div><div class="ach-bar"><i style="width:${achPoints() / ACH_TOTAL * 100}%"></i></div>`;
  // Toasts: one box under the top bar, one at a time, 4.6 s each on real time (CSS + setTimeout), so they
  // show over the roster, the menu and the results; the chime as each first shows. A hidden page stops
  // the clock (no toast runs out unseen, no chime from a background tab): back, the toast starts again
  let _toasts = [], _toastTimer = 0;
  function _toastShow() {
    const el = $('ach-toast'), a = _achDef(_toasts[0]);
    clearTimeout(_toastTimer); el.classList.remove('on');
    if (!a || document.hidden) return;          // the queue is empty; hidden: shown when the page is back
    el.innerHTML = `<div class="at-box">${_achIconHTML(a, true)}<div class="at-txt"><div class="at-k"></div><b>${a.name}</b><span>${a.desc}</span></div>` +
      `<div class="at-pts"><b>${a.points}</b><span>${_achDate(_ach.earned[a.id])}</span></div></div>`;
    _toastKick();
    void el.offsetWidth; el.classList.add('on');   // restart the animation
    SFX.play('achieve');
    _toastTimer = setTimeout(() => { _toasts.shift(); _toastShow(); }, 4600);
  }
  function _toastKick() { const k = document.querySelector('#ach-toast .at-k'); if (k) k.textContent = 'ACHIEVEMENT EARNED' + (_toasts.length > 1 ? ` · ${_toasts.length - 1} MORE` : ''); }
  document.addEventListener('visibilitychange', _toastShow);
  // Title → ACHIEVEMENTS: the totals, a tab per category (how many earned), the category's rows in an
  // area sized for the largest category (the card keeps its height on every tab), BACK
  let _achTab = 0;
  function showAchievements() {
    if (phase !== 'menu') return;
    _showCard(_achListHTML(), true);
    achTab(_achTab);
  }
  function _achListHTML() {
    const most = Math.max(...ACH_CATS.map((c, i) => ACH.filter(a => a.cat === i).length));
    return `<div class="ov-kicker">SERVICE RECORD</div>
      <div class="ov-title ov-title-sm">ACHIEVEMENTS</div>${_achTotalsHTML()}
      <div class="ach-tabs" id="ach-tabs" role="tablist"></div><div class="ach-list" id="ach-list" style="--n:${most}"></div>
      <div class="ov-row ach-back"><button class="ov-btn" onclick="G.showTitle()"><svg class="ico"><use href="#i-home"/></svg><span class="ob-t">BACK</span></button></div>`;
  }
  function achTab(c) {
    if (!$('ach-list')) return;
    _achTab = c;
    $('ach-tabs').innerHTML = ACH_CATS.map((name, i) => {
      const all = ACH.filter(a => a.cat === i), got = all.filter(a => _ach.earned[a.id]).length;
      return `<button class="ach-tab${i === c ? ' active' : ''}" role="tab" onclick="G.achTab(${i})">${name}<span class="num${got === all.length ? ' all' : ''}">${got}/${all.length}</span></button>`;
    }).join('');
    $('ach-list').innerHTML = ACH.filter(a => a.cat === c).map(_achRowHTML).join('');
  }
  // MENU → ACHIEVEMENTS: the totals, the icon grid, the one under the cursor (else the last hovered) as a row
  let _achHover = 0;
  function _syncAchUI() {
    const el = $('menu-ach'); if (!el) return;
    el.innerHTML = _achTotalsHTML() + (_run.cheated && phase !== 'menu' ? `<div class="menu-note ach-off">${_run.legacy
        ? 'This game was loaded from a save made before achievements: it earns none.' : 'A cheat turned achievements off for the rest of this game.'}</div>` : '') +
      `<div class="ach-grid">${ACH.map((a, i) => `<button class="ach-cell" data-i="${i}" aria-label="${a.hidden && !_ach.earned[a.id] ? '???' : a.name}">${_achIconHTML(a)}</button>`).join('')}</div>` +
      `<div id="menu-ach-row">${_achRowHTML(ACH[_achHover])}</div>`;
  }
  ['pointerover', 'focusin'].forEach(t => $('menu-ach')?.addEventListener(t, e => {
    const c = e.target.closest && e.target.closest('.ach-cell');
    if (c && +c.dataset.i !== _achHover) { _achHover = +c.dataset.i; $('menu-ach-row').innerHTML = _achRowHTML(ACH[_achHover]); }
  }));
  // The cards draw the counts once: an unlock under one (the HUD tour run from the title, the list or the
  // results; another tab of the game) redraws them in place, the overlay left as it is
  function _achRedraw() {
    const sum = $('ov-ach-sum'); if (sum) sum.textContent = _achSum();   // the title's ACHIEVEMENTS button
    if ($('ach-list')) { $('ov-card').innerHTML = _achListHTML(); achTab(_achTab); }
    const st = document.querySelector('#ov-card .ov-stats');           // the results: earned this game
    if (st) { document.querySelector('#ov-card .ach-res')?.remove(); st.insertAdjacentHTML('afterend', _achResHTML()); }
    if (_menuOpen && _menuTab === 'achievements') _syncAchUI();
  }

  // ── Tutorial: HUD tour + hints for new players ────────────────────────────
  // The first game opens with a HUD tour: the console and each command-card
  // button in turn, spotlit (the rest of the screen dimmed), BACK / NEXT, and
  // OK, LET'S ROLL at the end. After it, the first time a mechanic matters the
  // game pauses on a short hint, spotlighting the control it is about, until
  // GOT IT, Enter / Space / Esc, a key it names or a click anywhere else (which
  // then does its job). Each shows once; MENU → TUTORIAL turns the hints off,
  // replays them or runs the tour again (so does HOW TO PLAY on the title).
  const TUT_KEY = 'dotd_tutorial', TUT_GAP = 3;   // game seconds between two hints
  const TUT_GRACE = 800;   // ms after a hint opens in which clicks are swallowed: mid-fight clicks must not close it unread
  const _canUpgrade = () => [[dmgLvl,CFG.dmg_costs],[armorLvl,CFG.armor_costs],[hpLvl,CFG.hp_costs],[ammoLvl,CFG.ammo_costs]]
    .some(([l,c]) => l < 3 && minerals >= c[l][0] && gas >= c[l][1]);
  // The tour: welcome, the console, the ten command-card buttons (in card order,
  // with their tooltip text from CMD_INFO), ready
  const TOUR = [
    { title:'WELCOME, COMMANDER', text:'The Zerg attack the bunker from every side, wave after wave. <b>Click on the ground</b> to fire: every unit inside the bunker shoots one volley at that spot. <b>Hold the button</b> for full auto. First, a look at your console.' },
    { focus:['#hp-bar'], title:'BUNKER HP', text:'The squad\'s life. Below half the bunker burns; at zero it falls and the game is lost.' },
    { focus:['#ammo-bar'], title:'AMMO', text:'One round per volley — full auto empties it fast. The magazine is refilled after every wave.' },
    { focus:['#res-min','#res-gas'], title:'MINERALS &amp; GAS', text:'Paid for every kill and every cleared wave. Spend them on the command card and in the roster.' },
    { focus:['#con-cmd-grid'], title:'COMMAND CARD', text:'Your orders and upgrades. The hotkey is in the corner of each button, the cost in minerals and gas under it; in game, hover a button for its details.' },
    ...['air','nuke','roster','view','menu','dmg','armor','hp','ammo','stim'].map(k => ({ focus:['#cmd-'+k], cmd:k })),
    { focus:['#con-cmd-grid'], title:'READY', last:true },
  ];
  // The tour's own words for each button: shorter than the hover tooltips (CMD_INFO),
  // which name things a new player has not met yet
  const TOUR_TEXT = {
    air:    'When the magazine is empty: a Viking fires a missile at every Zerg group and drops an ammo crate by the bunker.',
    nuke:   `From wave ${CFG.nuke_wave} (the button shows W${CFG.nuke_wave} until then): a nuke on the middle of the swarm wipes out everything in a huge radius. It recharges after each launch.`,
    roster: 'Hire Marines, Marauders and Ghosts into the bunker\'s 6 slots and research their upgrades. Marines and Ghosts fire with each volley, Marauders on their own. The game pauses while it is open.',
    view:   'Back to the overview. The mouse wheel zooms in on the bunker; INSERT / DELETE rotate the view.',
    menu:   'Save and load, settings, the controls and this tutorial. The game pauses while it is open.',
    dmg:    'Every round from every unit hits harder. Three levels.',
    armor:  'The bunker takes less damage from bites and acid. Three levels.',
    hp:     '+250 max HP per level. Level 3 adds a Shrike auto-turret and self-repair.',
    ammo:   '+10 rounds in the magazine per level.',
    stim:   `With six Marines in the bunker (fewer with Super Stimpack's tiers): ${CFG.stim_duration} s of 50% faster fire for the Marines and Marauders, paid with a little bunker HP.`,
  };
  const _tutLeft = () => _tut.on && TUT_STEPS.some(s => !s.tour && !_tut.seen.has(s.id));
  // In priority order; `after` = shown only once that one has been seen; `keys` = the
  // keys the hint names, which close it and do their job
  const TUT_STEPS = [
    { id:'tour', when:()=>true, tour:true },
    { id:'strike', when:()=>wavePhase==='combat'&&ammo<=0&&airCD<=0&&!vikingActive, focus:['#cmd-air'], keys:['r'], title:'OUT OF AMMO',
      text:'Call an airstrike: press <kbd>R</kbd> or click STRIKE. A Viking fires a missile at every Zerg group and drops an ammo crate by the bunker — that crate is also this wave\'s resupply.' },
    { id:'cleared', when:()=>wavePhase==='cleared', focus:['#res-min','#res-gas'], title:'WAVE CLEARED',
      text:'Kills and cleared waves pay minerals and vespene gas. A Marine runs out for the wave\'s supply crate (unless the Viking\'s crate already came in), the magazine is refilled, then the next wave comes. The game autosaves after every wave.' },
    { id:'upgrade', after:'cleared', when:_canUpgrade, focus:['#cmd-dmg','#cmd-ammo'], keys:['1','2','3','4'], title:'UPGRADES',
      text:'You can afford an upgrade: press <kbd>1</kbd>–<kbd>4</kbd> or click a lit button — damage, armor, bunker hull, ammo storage.' },
    { id:'roster', after:'cleared', when:()=>wave>=2&&wavePhase!=='combat', focus:['#cmd-roster'], keys:['b'], title:'BUNKER ROSTER',
      text:'Between waves is a good moment to press <kbd>B</kbd>: hire more units into the bunker\'s 6 slots. <b>Marines</b> (1 slot) fire where you click. ' +
           '<b>Ghosts</b> (2) too, with +150% damage to Light Zerg, and snipe on their own once you research Snipe. ' +
           '<b>Marauders</b> (2) lob slowing grenades on their own — every 3 cost 1 round.' },
    { id:'marauder', when:()=>wavePhase==='combat'&&roster.includes('marauder'), title:'MARAUDER',   // its first wave
      text:'Your Marauder fires on its own: a punisher grenade every 0.7 s at the nearest Zerg not slowed yet, out to 14. Its blast hurts and slows everything around it, ' +
           'double damage to Armored. No click needed — but every 3 grenades cost 1 round of ammo, and out of ammo it stops too.' },
    { id:'ghost', when:()=>wavePhase==='combat'&&roster.includes('ghost'), title:'GHOST',
      text:'Your Ghost fires with your volleys — click where it should shoot — with +150% damage to Light Zerg (Zerglings). Research Snipe in the roster ' +
           '(<kbd>B</kbd>) and it also snipes the most dangerous Zerg on its own every few seconds.' },
    { id:'roach', when:()=>roaches.some(r=>!r.dead), title:'ROACHES',
      text:'Roaches are <b>Armored</b> and spit acid from range. Marauders deal Armored enemies double damage; armor (<kbd>2</kbd>) cuts the damage the bunker takes.' },
    { id:'nuke', when:()=>wave>=CFG.nuke_wave&&wavePhase==='combat'&&nukeCD<=0&&!_nukeInFlight, focus:['#cmd-nuke'], keys:['n'], title:'NUKE READY',
      text:`From wave ${CFG.nuke_wave}, press <kbd>N</kbd> or click NUKE: a Ghost marks the middle of the swarm and the warhead wipes out everything in the blast. It recharges after each launch.` },
    { id:'hull', when:()=>wavePhase==='combat'&&bunkerHp<maxHp*0.5, focus:['#hp-bar'], title:'BUNKER DAMAGED',
      text:'Below half HP the bunker burns — if it falls, the game is lost. Armor reduces the damage; bunker hull level 3 mounts a Shrike turret and repairs itself.' },
    { id:'stim', when:()=>wavePhase==='combat'&&stimUnlocked()&&stimT<=0, focus:['#cmd-stim'], keys:['t'], title:'STIMPACK',
      text:`Your squad can stim: press <kbd>T</kbd> or click STIM. For ${CFG.stim_duration} s the Marines and Marauders fire 50% faster, for ${CFG.stim_hp} HP per Marine and ${CFG.stim_hp_marauder} per Marauder from the bunker (free with the Super Stimpack research).` },
    { id:'autostim', after:'stim', when:()=>wavePhase==='combat'&&superStimUnlocked&&stimUnlocked()&&!stimAuto, focus:['#cmd-stim'], title:'STIMPACK AUTOCAST',   // a right-click on STIM closes it (toggleStimAuto)
      text:'Super Stimpack makes the stim free, so it can run itself: <b>right-click</b> STIM for autocast, as in StarCraft II. It stims whenever you fire, and a gold light runs round the button. Right-click it again to turn it off.' },
  ];
  const _tut = (() => {
    try { const d = JSON.parse(_store.get(TUT_KEY) || 'null'); if (d && Array.isArray(d.seen)) return { on: d.on !== false, seen: new Set(d.seen.filter(id => TUT_STEPS.some(s => s.id === id))) }; } catch (e) {}   // ids of removed hints drop out
    return { on: true, seen: new Set() };       // a new player: hints on
  })();
  let _tutNext = 0;                             // no new hint before this _gameT
  let _tutShownAt = 0, _tutSwallow = false;     // performance.now() when it opened; a swallowed press's click is swallowed too
  let _tourI = -1, _tourOverlay = false;        // tour page shown (-1 = none); the title / results card it hid
  function _tutSave() { _store.set(TUT_KEY, JSON.stringify({ on: _tut.on, seen: [..._tut.seen] })); }
  function tutorialTick() {                     // live frames only (paused / title: never)
    // phase: the frame that wins the campaign still runs to the end — a hint
    // raised there would hide under the victory card
    if (phase !== 'playing' || !_tut.on || _tutStep || _gameT < _tutNext) return;
    const st = TUT_STEPS.find(s => !_tut.seen.has(s.id) && (!s.after || _tut.seen.has(s.after)) && s.when());
    if (!st) return;
    if (st.tour) { startTour(); return; }
    _tut.seen.add(st.id); _tutSave();
    _tutOpen(st);
  }
  // One box for both: a hint (GOT IT) or a tour page (BACK / NEXT / OK, LET'S ROLL)
  function _tutOpen(st) {
    _tutStep = st;
    const tour = _tourI >= 0, last = tour && _tourI === TOUR.length - 1;
    $('tut-kind').textContent = tour ? 'HUD TOUR' : 'TUTORIAL';
    $('tut-n').textContent = tour ? `${_tourI + 1} / ${TOUR.length}` : `${_tut.seen.size} / ${TUT_STEPS.length}`;
    $('tut-title').innerHTML = st.title;
    $('tut-text').innerHTML = st.text;
    $('tut-skip').textContent = tour ? 'Skip the tour' : 'Skip the tutorial';
    $('tut-back').hidden = !tour || _tourI === 0;
    $('tut-ok-t').textContent = !tour ? 'GOT IT' : last ? 'OK, LET\'S ROLL' : 'NEXT';
    const box = $('tut-box');
    box.classList.add('open'); box.classList.toggle('tour', tour); box.classList.toggle('nogame', phase !== 'playing');
    $('gw').classList.add('tut-open');        // hides the command-card tooltip, which covered the hint on narrow screens
    _tutShownAt = performance.now();
    _tutPlace();
  }
  function _tourPage(i) {
    _tourI = i;
    const p = TOUR[i], c = p.cmd && CMD_INFO[p.cmd];
    _tutOpen({ id: 'tour', focus: p.focus,
      title: c ? `${c.t} <kbd>${c.k}</kbd>` : p.title,
      text: c ? TOUR_TEXT[p.cmd] : p.last ? 'Those are your controls. ' + (_tutLeft() ? 'A hint will pause the game the first time something new happens — read it, then carry on.' : 'In game, hover any button for its cost and details.') : p.text });
  }
  // From the title / results (HOW TO PLAY, the menu) the card is hidden for the
  // tour, so the console shows, and comes back after it
  function startTour() {
    tutDismiss();
    if (rosterPaused) closeRoster();            // it covered the console the tour lights up
    if (phase === 'menu') { newGameState(); updateHUD(); }   // title: nothing to keep, show a new game's console
    if (phase !== 'playing' && $('overlay').style.display !== 'none') { _tourOverlay = true; $('overlay').style.display = 'none'; }
    _tut.seen.add('tour'); _tutSave(); _syncTutUI();
    _tourPage(0);
  }
  // A page whose control is off-screen (a narrow window cuts the command card)
  // is skipped: the screen would dim with nothing lit. The last page always shows.
  const _tourShown = i => i === 0 || i === TOUR.length - 1 || !!_focusRect(TOUR[i].focus);
  function tutNext() {                          // GOT IT / NEXT / OK, LET'S ROLL
    if (_tourI === TOUR.length - 1 && (phase !== 'playing' || !_run.cheated)) achTourDone();   // OK, LET'S ROLL: BOOT CAMP
    if (_tourI < 0 || _tourI === TOUR.length - 1) { tutDismiss(); return; }
    let i = _tourI + 1; while (!_tourShown(i)) i++;
    _tourPage(i);
  }
  function tutBack() {
    if (_tourI <= 0) return;
    let i = _tourI - 1; while (!_tourShown(i)) i--;
    _tourPage(i);
  }
  function tutDismiss() {
    if (!_tutStep) return;
    _tutStep = null; _tourI = -1; _tutNext = _gameT + TUT_GAP;
    $('tut-box').classList.remove('open', 'tour');
    $('gw').classList.remove('tut-open');
    $('tut-ring').style.display = 'none';
    if (_tourOverlay) { _tourOverlay = false; if (phase !== 'playing') $('overlay').style.display = 'flex'; }
  }
  // Spotlight on the union of the step's controls (a ring element whose huge
  // shadow dims the rest — the command buttons are clipped polygons, an outline
  // would be clipped too) and the box just above it, centred on it as far as the
  // screen allows. No control: no dimming, the box centred above the console.
  // Union rect of a step's controls, or null when there are none or it is off-screen
  function _focusRect(focus) {
    const els = (focus || []).map(s => document.querySelector(s)).filter(el => el && el.offsetParent !== null);
    if (!els.length) return null;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    els.forEach(el => { const q = el.getBoundingClientRect(); l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom); });
    const g = $('gw').getBoundingClientRect();
    return r - l > 0 && b - t > 0 && l >= g.left - 1 && r <= g.right + 1 && t >= g.top - 1 && b <= g.bottom + 1 ? { l, t, r, b } : null;
  }
  function _tutPlace() {
    const ring = $('tut-ring'), box = $('tut-box'), q = _focusRect(_tutStep?.focus);
    Object.assign(box.style, { left: '', bottom: '', transform: '' });
    if (!q) { ring.style.display = 'none'; return; }
    const g = $('gw').getBoundingClientRect(), { l, t, r, b } = q;
    Object.assign(ring.style, { display: 'block', left: (l - g.left - 4) + 'px', top: (t - g.top - 4) + 'px', width: (r - l + 8) + 'px', height: (b - t + 8) + 'px' });
    const w = box.offsetWidth, x = Math.max(12, Math.min(g.width - w - 12, (l + r) / 2 - g.left - w / 2));
    const c = $('con-right').getBoundingClientRect(), top = l >= c.left && t >= c.top && r <= c.right && b <= c.bottom ? c.top : t;   // on the command card: above the whole card (above a button it lay over the card's header)
    Object.assign(box.style, { left: x + 'px', bottom: (g.bottom - top + 14) + 'px', transform: 'none' });
  }
  addEventListener('resize', () => { if (_tutStep) _tutPlace(); });
  // A press anywhere outside the box (and the menu) closes a hint first — the
  // click then does what it would have done (fire, open the roster, ...). In the
  // first TUT_GRACE ms the press and its click are swallowed instead: a player
  // clicking away mid-fight would otherwise close the hint before reading it.
  // The tour only moves with its own buttons and keys.
  document.addEventListener('pointerdown', e => {
    _tutSwallow = false;
    if (!_tutStep || (e.target.closest && e.target.closest('#tut-box, #menu-overlay'))) return;
    if (_tourI >= 0 || performance.now() - _tutShownAt < TUT_GRACE) { _tutSwallow = true; e.stopPropagation(); e.preventDefault(); return; }
    tutDismiss();
  }, true);
  document.addEventListener('click', e => { if (_tutSwallow) { _tutSwallow = false; e.stopPropagation(); e.preventDefault(); } }, true);
  function setTutorial(on) { _tut.on = !!on; if (!_tut.on && _tourI < 0) tutDismiss(); _tutSave(); _syncTutUI(); }
  function replayTutorial() { _tut.seen.clear(); _tut.on = true; _tutNext = 0; _tutSave(); _syncTutUI(); }
  function tutSkip() {
    if (_tourI >= 0) { tutDismiss(); return; }  // the tour only: the hints stay on
    setTutorial(false); setStatus('Tutorial hints off — MENU → TUTORIAL turns them back on');
  }
  function _syncTutUI() {
    ['menu-tut-cb', 'ov-tut-cb'].forEach(id => { const cb = $(id); if (cb) cb.checked = _tut.on; });
    const n = $('menu-tut-note'); if (n) n.textContent = `${_tut.seen.size} / ${TUT_STEPS.length} seen`;
  }

  // ── Title / results screens (one overlay card) ──────────────────────────
  const _esc = v => String(v).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  function _showCard(html,wide){ const c=$('ov-card'); if(c){ c.innerHTML=html; c.classList.toggle('wide',!!wide); } $('overlay').style.display='flex'; }
  const _KEYS_HTML = `<div class="ov-keys">
      <kbd>CLICK / HOLD</kbd><span>Fire a volley / full auto</span><kbd>R</kbd><span>Airstrike + resupply</span>
      <kbd>N</kbd><span>Nuke (wave 5+)</span><kbd>B</kbd><span>Roster (pauses)</span>
      <kbd>1-4</kbd><span>Upgrades</span><kbd>M / ESC</kbd><span>Menu</span>
      <kbd>WHEEL</kbd><span>Zoom on the bunker</span><kbd>INS / DEL</kbd><span>Rotate view 90°</span>
    </div>`;
  function showTitle(){
    Music.play('title');
    clearEntities();
    closeRoster(); closeMenu(); closeCheat(); tutDismiss();
    phase='menu'; wavePhase='idle';
    $('tv-cheat').hidden=true;   // no game on: no CHEATS chip (updateHUD does not run on the title)
    const unlocked=endlessUnlocked(), best=_bestEndless();
    const auto=_readSave(AUTO_KEY), manual=_readSave(SAVE_KEY);
    _showCard(`<div class="ov-kicker">TERRAN DOMINION · BUNKER DEFENSE</div>
      <div class="ov-title">DEFENSE OF THE<br>DOMINION</div>
      <div class="ov-sub">Hold the bunker. Click to fire — the Marauders lob grenades on their own.</div>
      <div class="ov-modes">
        <button class="ov-btn" data-play onclick="G.start('campaign')"><svg class="ico"><use href="#i-campaign"/></svg>
          <span><span class="ob-t">CAMPAIGN</span><span class="ob-d">Clear ${CFG.victory_wave} waves of the swarm to win</span></span></button>
        <button class="ov-btn gold" data-play data-locked="${unlocked?0:1}" ${unlocked?'':'disabled'} onclick="G.start('endless')"><svg class="ico"><use href="#i-${unlocked?'endless':'lock'}"/></svg>
          <span><span class="ob-t">ENDLESS</span><span class="ob-d">${unlocked ? (best ? `Best: wave ${_esc(best.wave)} · score ${_esc(best.score)}` : 'No wave limit — how long can you hold?') : 'Locked — win the campaign to unlock'}</span></span></button>
        ${_validSave(auto)?`<button class="ov-btn" data-play onclick="G.loadGame('auto')"><svg class="ico"><use href="#i-play"/></svg>
          <span><span class="ob-t">CONTINUE</span><span class="ob-d">Autosave — ${_esc(_saveLabel(auto))}</span></span></button>`:''}
        ${_validSave(manual)?`<button class="ov-btn" data-play onclick="G.loadGame()"><svg class="ico"><use href="#i-load"/></svg>
          <span><span class="ob-t">LOAD GAME</span><span class="ob-d">Saved game — ${_esc(_saveLabel(manual))}</span></span></button>`:''}
        <div class="ov-pair"><button class="ov-btn" onclick="G.showHowTo()"><svg class="ico"><use href="#i-help"/></svg>
          <span><span class="ob-t">HOW TO PLAY</span><span class="ob-d">Rules, controls, units</span></span></button>
        <button class="ov-btn" onclick="G.menuTab('settings');G.openMenu()"><svg class="ico"><use href="#i-gfx"/></svg>
          <span><span class="ob-t">SETTINGS</span><span class="ob-d">Graphics, sound, day/night</span></span></button></div>
        <button class="ov-btn gold" onclick="G.showAchievements()"><svg class="ico"><use href="#i-trophy"/></svg>
          <span><span class="ob-t">ACHIEVEMENTS</span><span class="ob-d" id="ov-ach-sum">${_achSum()}</span></span></button>
      </div>
      <div class="ov-load" id="ov-load"><div class="ol-bar"><i></i></div><span class="ol-t"></span><button class="ol-skip" onclick="G.skipAssetWait()">start now</button></div>
      ${_KEYS_HTML}<div class="ov-legal">${BLIZZARD_NOTICE}</div>`);
    _assetGate();
    if (!_gateTimer) _gateTimer = setInterval(_assetGate, 200);
  }
  // Title → HOW TO PLAY: the rules on one card (the in-game hints teach them one at a time)
  function showHowTo(){
    if (phase !== 'menu') return;
    _showCard(`<div class="ov-kicker">FIELD MANUAL</div>
      <div class="ov-title ov-title-sm">HOW TO PLAY</div>
      <div class="ov-howto">
        <b>GOAL</b><span>Hold the bunker against the Zerg swarm. Campaign: clear ${CFG.victory_wave} waves to win — that unlocks Endless mode.</span>
        <b>FIRE</b><span>Click the ground: every Marine and Ghost inside the bunker fires one volley at that spot, for one round (the Marauders fire on their own). Hold the button for full auto — it empties the magazine fast.</span>
        <b>AMMO</b><span>After each wave a Marine fetches a supply crate that refills the magazine. Out of ammo mid-wave? <kbd>R</kbd> calls a Viking: it fires missiles into the swarm and drops an ammo crate — one crate covers the wave.</span>
        <b>MONEY</b><span>Kills and cleared waves pay minerals and gas. Spend them on upgrades <kbd>1</kbd>–<kbd>4</kbd> (damage, armor, hull, ammo) and on units in the roster <kbd>B</kbd>, which pauses the game.</span>
        <b>UNITS</b><span>The bunker has 6 slots. <b>Marine</b> (1 slot): fires where you click, the cheapest. <b>Ghost</b> (2): fires where you click, +150% damage to Light; researches Snipe, which fires on its own. <b>Marauder</b> (2): fires on its own at the Zerg not slowed yet, a grenade that blasts and slows an area, double damage to Armored — every 3 grenades cost 1 round. You choose the unit that runs out for supply crates in the roster.</span>
        <b>POWERS</b><span><kbd>N</kbd> nuke from wave ${CFG.nuke_wave}. <kbd>T</kbd> Stimpack with six Marines (fewer with Super Stimpack's tiers), for Marines and Marauders. Bunker hull level 3: Shrike auto-turret and self-repair.</span>
        <b>ZERG</b><span>Zerglings: fast, Light, bite the hull. Roaches from wave ${CFG.roach_wave}: Armored, spit acid from range. From wave ${CFG.metabolic_wave} the Zerglings run faster.</span>
      </div>
      ${_KEYS_HTML}
      <label class="menu-check ov-tut"><input type="checkbox" id="ov-tut-cb" ${_tut.on ? 'checked' : ''} onchange="G.setTutorial(this.checked)">TUTORIAL HINTS IN GAME — pause on each new mechanic</label>
      <div class="ov-row"><button class="ov-btn gold" onclick="G.startTour()"><svg class="ico"><use href="#i-help"/></svg><span class="ob-t">HUD TOUR</span></button>
        <button class="ov-btn" onclick="G.showTitle()"><svg class="ico"><use href="#i-home"/></svg><span class="ob-t">BACK</span></button></div>`);
  }
  // Title screen: asset loading progress. The start buttons wait until the first
  // two LOAD_STAGES (bunker, first waves' units) have loaded or failed — later
  // ones keep loading in the background — unless the player skips the wait.
  const ESSENTIAL = LOAD_STAGES.slice(0, 2).flat();
  let _skipWait = false, _gateTimer = 0;
  function _assetGate(){
    const box = $('ov-load');
    if (!box || phase !== 'menu') { clearInterval(_gateTimer); _gateTimer = 0; return; }
    const { done, total } = ModelLoader.progress(), ready = _skipWait || ESSENTIAL.every(k => ModelLoader.isSettled(k));
    box.hidden = done >= total;
    box.querySelector('.ol-bar i').style.width = (total ? done / total * 100 : 100) + '%';
    box.querySelector('.ol-t').textContent = ready ? `Ready — ${total - done} more files loading in the background` : `Loading StarCraft II assets… ${done} / ${total}`;
    box.querySelector('.ol-skip').hidden = ready;
    document.querySelectorAll('#ov-card .ov-btn[data-play]').forEach(b => { b.disabled = !ready || b.dataset.locked === '1'; });
  }
  function skipAssetWait(){ _skipWait = true; _assetGate(); }
  // earned this game (before any cheat): the best three as rows (most points, then the latest), then a count
  function _achResHTML(){
    const best=_runAch.slice().reverse().map(_achDef).filter(Boolean).sort((a,b)=>b.points-a.points).slice(0,3);
    return best.length?`<div class="ach-res"><div class="ach-res-h">ACHIEVEMENTS EARNED · ${_runAch.length}</div>${best.map(_achRowHTML).join('')}
        ${_runAch.length>best.length?`<div class="ach-res-n">+${_runAch.length-best.length} more — ACHIEVEMENTS on the title screen</div>`:''}</div>`:'';
  }
  function showResults(victory,newlyUnlocked,newRecord){
    Music.play(victory ? 'victory' : 'defeat');
    const rk=getRank(kills), t=Math.floor(_gameT), camp=gameMode==='campaign';
    const stats=[['WAVE',wave+(camp?' / '+CFG.victory_wave:'')],['TIME',Math.floor(t/60)+':'+String(t%60).padStart(2,'0')],['KILLS',kills],
                 ['SCORE',score],['RANK',`<span style="color:${rk.color}">${rk.name}</span>`],['MODE',camp?'CAMPAIGN':'ENDLESS']];
    const sub=victory?`All ${CFG.victory_wave} waves held. The Dominion stands.`
      :camp?`Overrun on wave ${wave} of ${CFG.victory_wave}.`:`The swarm broke through on wave ${wave}.`;
    _showCard(`<div class="ov-kicker">${victory?'CAMPAIGN COMPLETE':camp?'CAMPAIGN':'ENDLESS MODE'}</div>
      <div class="ov-title ${victory?'victory':'defeat'}">${victory?'VICTORY':'BUNKER LOST'}</div>
      <div class="ov-sub">${sub}</div>
      ${newlyUnlocked?'<div class="ov-badge"><svg class="ico"><use href="#i-endless"/></svg>ENDLESS MODE UNLOCKED</div>':''}
      ${newRecord?'<div class="ov-badge">NEW ENDLESS RECORD</div>':''}
      <div class="ov-stats">${stats.map(([l,v])=>`<div class="ov-stat"><b>${v}</b><span>${l}</span></div>`).join('')}</div>
      ${_achResHTML()}
      ${_run.cheated?`<div class="ach-res-off">${_run.legacy?'Loaded from a save made before achievements: none this game.':'A cheat turned achievements off for the rest of this game.'}</div>`:''}
      <div class="ov-row">${victory
        ?'<button class="ov-btn gold" onclick="G.continueEndless()"><svg class="ico"><use href="#i-endless"/></svg><span class="ob-t">CONTINUE · ENDLESS</span></button>'
        :'<button class="ov-btn" onclick="G.start(G.mode())"><svg class="ico"><use href="#i-restart"/></svg><span class="ob-t">PLAY AGAIN</span></button>'}
        <button class="ov-btn" onclick="G.showTitle()"><svg class="ico"><use href="#i-home"/></svg><span class="ob-t">MAIN MENU</span></button></div>`);
  }

  // mode: 'campaign' | 'endless' (needs the unlock) | omitted = keep the current mode
  function start(mode){
    if(mode==='endless'&&gameMode!=='endless'&&!endlessUnlocked()) return; // replaying Endless never needs the flag
    if(mode==='campaign'||mode==='endless') gameMode=mode;
    SFX.ensure();             // start() always runs from a click — unlocks Web Audio
    if(wxOn) RainBed.prime();
    Music.play('battle');
    achFlush();               // the last game's lifetime stats
    clearEntities();
    newGameState();
    _run=_newRun(); _runAch=[]; _airRunKills=0;   // a new game (loadGame restores a saved one's flags after this)
    tutDismiss(); _tutNext=0;       // a hint left open (Restart / Load from the menu) goes with the old game
    $('overlay').style.display='none';
    phase='playing';
    updateHUD();
    startWave();
  }
  // A new game's bunker, squad, resources and cooldowns — start(), and the HUD
  // tour on the title, which shows the console as a new game has it
  function newGameState(){
    score=0;wave=1;kills=0;minerals=150;gas=50;
    ammo=CFG.base_ammo;maxAmmo=CFG.base_ammo;_marauderShots=0;
    bunkerHp=750;maxHp=750;
    dmgLvl=0;armorLvl=0;hpLvl=0;ammoLvl=0;
    armory={hp:0,dmg:0,ammo:0,cd:0}; endlessSteps=0;
    // IMPORTANT: do NOT null bunkerModelRoot here. The bunker model is built once
    // in buildScene() and persists across games. Nulling it (when the .obj had
    // already finished loading) was the cause of the "upgrade hologram sometimes
    // doesn't appear" bug — updateBunkerVisual() would then early-return forever,
    // and the portrait (reached only through it) stopped updating. We now just
    // reset the visual state instead.
    updateBunkerVisual(); updatePortraitBunker(true);
    _pAngle=0;
    floatTexts=[];
    victoryAchieved=false;
    resetRoster();
    airCD=0;nukeCD=0;shootCD=0;wavePhase='idle';
    _gameT=0;_hudTick=0;_dmgFlashCD=0;
    _slotSig=null;_slotBarSig=null; // force pip rebuild on fresh state
  }

  // Kick off model loading in the background, in LOAD_STAGES order. The title
  // screen shows the progress; anything not loaded yet is drawn procedurally
  // and swapped for its SC2 model when it arrives.
  ModelLoader.preloadAll(LOAD_STAGES);
  // An SC2 skin needs one instance pool per walk / attack frame (up to 40): bake them as
  // soon as the model has loaded, so the first spawn of a skin does not stall a frame
  ['zergling','zergling_upgrade','zergling_webby','roach','roach_ex1a','roach_ex3']
    .forEach(k => ModelLoader.ready(k).then(() => enemyLook(k)));
  buildScene();
  warmNukeShaders(); ModelLoader.ready('nukeMissile').then(warmNukeShaders);   // (the warhead: once it has loaded)
  initPortrait(); // hologram builds itself as soon as the bunker model is cached
  loop();

  // ── Bunker Roster System ─────────────────────────────────────────────────

  function hireUnit(type) {
    const def = UNIT_DEF[type];
    if (!def) return 'Unknown unit';
    if (slotsLeft() < def.slots) return `Need ${def.slots} slots (only ${slotsLeft()} free)`;
    const [m, g] = def.cost;
    if (minerals < m || gas < g) return needText(m, g);
    minerals -= m; gas -= g;
    roster.push(type);
    if (type !== 'marine') _run.hiredOther = true;   // BAND OF BROTHERS: Marines only
    if (type === 'ghost') snipeReady.push(0); // new ghost (last in roster order) may snipe at once
    if (type === 'marauder') marauderReady.push(0);   // ... and a new Marauder fire
    syncMarines(); updateHUD();
    achState();
    return `${def.name} hired! (${slotsUsed()}/6 slots)`;
  }

  // The roster: click a unit to send it out for the supply crates (again: back to any)
  function electRunner(idx) {
    if (idx < 0 || idx >= roster.length) return;
    runnerIdx = runnerIdx === idx ? -1 : idx;
    setStatus(runnerIdx < 0 ? 'Crate runner: a Marine, else any free unit' : `Crate runner: this ${roster[idx]} runs out for the supply crates`);
    renderRosterPanel();
  }
  function dismissUnit(idx) {
    if (idx < 0 || idx >= roster.length) return;
    // An empty bunker fires nothing, yet clicks would still spend ammo
    if (roster.length <= 1) { setStatus('The bunker needs at least one unit!'); return; }
    if (idx === runnerIdx) runnerIdx = -1;   // the runner goes; the units after it move up a place
    else if (idx < runnerIdx) runnerIdx--;
    const utype = roster[idx];
    const def = UNIT_DEF[utype];
    // Snipe cooldowns are kept per ghost in roster order — drop this ghost's entry
    if (utype === 'ghost') snipeReady.splice(roster.slice(0, idx).filter(u => u === 'ghost').length, 1);
    if (utype === 'marauder') marauderReady.splice(roster.slice(0, idx).filter(u => u === 'marauder').length, 1);
    // 75% refund
    const [mc, gc2] = def.cost;
    const refundM = Math.floor(mc * 0.75);
    const refundG = Math.floor(gc2 * 0.75);
    minerals += refundM;
    gas      += refundG;
    roster.splice(idx, 1);
    syncMarines(); updateHUD();
    setStatus(`${def.name} dismissed — refunded ◆${refundM} ▲${refundG}`);
  }

  function researchUpgrade(key, tier) {
    const def = UPGRADE_DEF[key];
    if (!def) return;
    if (def.unit && !roster.includes(def.unit)) { setStatus(`Need a ${def.unit} in bunker first!`); return; }   // (the Sensor Tower needs none)

    if (tier === undefined) {
      // Base unlock
      const [m, g] = def.cost;
      if (minerals < m || gas < g) { setStatus(needText(m, g)); return; }
      minerals -= m; gas -= g;
      if (key === 'concussive') concussiveUnlocked = true;
      if (key === 'snipe')      snipeUnlocked      = true;
      if (key === 'superstim')  superStimUnlocked  = true;
      if (key === 'sensor')     sensorLvl          = 1;
      setStatus(key === 'sensor' ? def.tiers[0].desc : `${def.name} researched!`);
    } else {
      // Tier upgrade
      const td = def.tiers[tier];
      if (!td) return;
      const [m, g] = td.cost;
      if (minerals < m || gas < g) { setStatus(needText(m, g)); return; }
      minerals -= m; gas -= g;
      if (key === 'concussive') concussiveLvl = tier + 1;
      if (key === 'snipe')      snipeLvl      = tier + 1;
      if (key === 'superstim')  superStimLvl  = tier + 1;
      if (key === 'sensor')     sensorLvl     = tier + 1;
      setStatus(td.desc);
    }
    updateHUD();
    achState();
  }

  // ── SC2-style slot bar overlay (positioned over bunker in world→screen) ──

  function getBunkerScreenPos() {
    // Returns canvas-relative pixel coordinates (origin = top-left of the 3D canvas)
    // Uses logical (_logW/_logH) so it's invariant to devicePixelRatio
    const v = new THREE.Vector3(0, 1.8, 0);
    v.project(camera);
    return {
      x: (v.x * 0.5 + 0.5) * _logW,
      y: (-v.y * 0.5 + 0.5) * _logH,
    };
  }

  function renderSlotBar() {
    const bar = document.getElementById('slot-bar');
    // Rebuild pips only when the roster actually changes
    const sig = roster.join(',');
    if (sig !== _slotBarSig) {
      _slotBarSig = sig;
      bar.innerHTML = '';
      // 6 pips: filled = unit color/width, empty = grey
      let used = 0;
      roster.forEach(utype => {
        const def = UNIT_DEF[utype];
        const pip = document.createElement('div');
        pip.className = `slot-pip occupied-${utype}`;
        if (def.slots === 2) pip.style.width = '30px';
        bar.appendChild(pip);
        used += def.slots;
      });
      for (let i = used; i < 6; i++) {
        const pip = document.createElement('div');
        pip.className = 'slot-pip empty';
        bar.appendChild(pip);
      }
    }
    placeSlotOverlay();
  }
  // Keep the slot bar above the bunker in screen space (called every frame: the
  // camera can zoom/rotate even while paused). Hidden in the close-up view.
  // (no module-level cache variable: loop() first runs during boot, before a
  //  'let' declared down here would be initialised — the element holds it instead)
  function placeSlotOverlay() {
    const ov = document.getElementById('slot-overlay');
    if (!ov) return;
    const pos = getBunkerScreenPos();                 // canvas-relative; +32 for the top bar
    const key = Math.round(pos.x) + ',' + Math.round(pos.y);
    if (key !== ov._pos) {
      ov._pos = key;
      ov.style.left = Math.round(pos.x) + 'px';
      ov.style.top  = Math.round(pos.y + 32 - 50) + 'px';
      ov.style.transform = 'translateX(-50%)';
    }
    if (rosterPaused) ov.style.opacity = _zoom < 0.3 ? '1' : '0';
    else if (_zoom >= 0.3) ov.style.opacity = '0';
  }

  function renderRosterPanel() {
    // Skip entirely while hidden — this rebuilds three DOM sections and used
    // to run on every HUD update even with the panel closed.
    const panel = document.getElementById('roster-panel');
    if (panel && !panel.classList.contains('visible')) return;
    // ── Slot display ──
    const slotsEl = document.getElementById('roster-slots');
    slotsEl.innerHTML = '';
    let ghostOrd = 0;
    roster.forEach((utype, idx) => {
      const def = UNIT_DEF[utype];
      const el = document.createElement('div');
      el.className = `rs ${def.cls}${idx === runnerIdx ? ' runner' : ''}`;
      // Ghost snipe cooldown / Marauder slow level shown in place of the name line
      let tag = '', tagCol = '';
      if (utype === 'ghost' && snipeUnlocked) {
        const cdLeft = Math.max(0, (snipeReady[ghostOrd] || 0) - _gameT);
        tag = cdLeft > 0 ? 'SNIPE ' + Math.ceil(cdLeft) + 's' : 'SNIPE RDY'; tagCol = cdLeft > 0 ? '#d6b0ff' : '#e08aff';
      }
      if (utype === 'marauder' && concussiveUnlocked) { tag = 'SLOW' + (concussiveLvl > 0 ? ' A' + concussiveLvl : ''); tagCol = '#ffbd8a'; }
      if (utype === 'ghost') ghostOrd++;
      el.innerHTML = `<span>${def.label}</span><span class="rs-lbl"${tag ? ` style="color:${tagCol};opacity:1"` : ''}>${tag || def.name}</span><span class="rs-rem" title="Dismiss (75% refund)">✕</span>`;
      // Only the ✕ dismisses (a click anywhere on the tile used to, and a
      // double-click then dismissed the next unit too)
      el.querySelector('.rs-rem').addEventListener('click', () => { dismissUnit(idx); });
      // the rest of the tile elects the crate runner
      el.title = idx === runnerIdx ? 'Crate runner — click: any unit again' : 'Click: this unit runs out for the supply crates';
      el.addEventListener('click', e => { if (!e.target.closest('.rs-rem')) electRunner(idx); });
      slotsEl.appendChild(el);
    });
    const left = slotsLeft();
    for (let i = 0; i < left; i++) {
      const el = document.createElement('div');
      el.className = 'rs em';
      el.innerHTML = '<span style="font-size:14px;opacity:.3">+</span>';
      slotsEl.appendChild(el);
    }
    document.getElementById('roster-slots-label').textContent =
      `${slotsUsed()}/6 slots — ${left} free` + (hpLvl >= 3 ? ' · Shrike turret: +2 marines (auto)' : '');

    // ── Unit shop ──
    const shop = document.getElementById('unit-shop');
    shop.innerHTML = '';
    Object.entries(UNIT_DEF).forEach(([type, def]) => {
      const [mc, gc2] = def.cost;
      const canAfford = minerals >= mc && gas >= gc2;
      const canFit = slotsLeft() >= def.slots;
      const el = document.createElement('div');
      el.className = `ushop ${type}`;
      // Generated from UNIT_DEF so the text can't drift from the numbers again
      const bonusNote = (def.dmgMult !== 1 ? `×${def.dmgMult} dmg` : 'balanced')
        + (def.bonusVs.length ? `, +${Math.round((def.bonusMult - 1) * 100)}% vs ${def.bonusVs.join('/')}` : ', no bonus')
        + (type === 'marauder' ? ', fires on its own, blast slows' : '');
      el.innerHTML = `
        <div class="ushop-name ${type}">${def.name}</div>
        <div class="ushop-slot">${def.slots} slot${def.slots>1?'s':''}</div>
        <div class="ushop-desc">${bonusNote}</div>
        <div class="ushop-cost">${MIN_ICON}${mc} <span class="g">${GAS_ICON}${gc2}</span></div>
        <button class="ushop-btn" ${(!canAfford||!canFit)?'disabled':''}>
          ${!canFit ? 'NO SLOTS' : !canAfford ? `NEED ${shortfallHTML(mc, gc2)}` : 'HIRE'}
        </button>`;
      el.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        const msg = hireUnit(type);
        setStatus(msg);
      });
      shop.appendChild(el);
    });

    // ── Upgrade row ──
    const upgRow = document.getElementById('upgrade-row');
    upgRow.innerHTML = '';
    Object.entries(UPGRADE_DEF).forEach(([key, def]) => {
      const [unlocked, curTierLvl] = { concussive: [concussiveUnlocked, concussiveLvl], snipe: [snipeUnlocked, snipeLvl], superstim: [superStimUnlocked, superStimLvl],
                                       sensor: [sensorLvl > 0, sensorLvl] }[key];
      const hasUnit    = !def.unit || roster.includes(def.unit);   // the Sensor Tower needs no unit
      const cls        = def.unit || key;
      const el = document.createElement('div');
      el.className = `upgrow ${cls} ${!hasUnit&&!unlocked?'locked':''}`;

      // What's the current status line?
      let statusLine = def.desc;
      if (unlocked) {
        if (key === 'snipe')      statusLine = `CD: ${(SNIPE_CD[snipeLvl]/1000).toFixed(1)}s | tier ${snipeLvl}/3`;
        if (key === 'concussive') statusLine = `Slow 40% for 2.5s | blast radius ${MG_RADIUS[concussiveLvl].toFixed(1)} | tier ${concussiveLvl}/3`;
        if (key === 'superstim')  statusLine = `Stim: no HP cost, +${CFG.superstim_heal} HP/s to the bunker | needs ${superStimLvl >= 3 ? 'a Marine or a Marauder' : stimNeed() + ' Marines'} | tier ${superStimLvl}/3`;
        if (key === 'sensor')     statusLine = `Blips out to ${SENSOR_RANGE[sensorLvl]} | tier ${sensorLvl}/3`;
      }

      // Determine next action
      let btnLabel, btnDisabled, btnHandler;
      if (!unlocked) {
        const [mc,gc2] = def.cost;
        const canAfford = minerals >= mc && gas >= gc2;
        btnLabel = !hasUnit ? 'LOCKED' : !canAfford ? `${resHTML(mc, gc2)} — NEED ${shortfallHTML(mc, gc2)}` : `RESEARCH  ${resHTML(mc, gc2)}`;
        btnDisabled = !hasUnit || !canAfford;
        btnHandler = () => researchUpgrade(key);
      } else if (curTierLvl < def.tiers.length) {
        const td = def.tiers[curTierLvl];
        const [mc,gc2] = td.cost;
        const canAfford = minerals >= mc && gas >= gc2;
        btnLabel = !canAfford ? `LV.${curTierLvl+1}: ${resHTML(mc, gc2)} — NEED ${shortfallHTML(mc, gc2)}` : `UPGRADE LV.${curTierLvl+1}  ${resHTML(mc, gc2)}`;
        btnDisabled = !canAfford;
        btnHandler = () => researchUpgrade(key, curTierLvl);
      } else {
        btnLabel = '★ MAXED';
        btnDisabled = true;
        btnHandler = null;
      }

      // No button art yet (Sensor Tower): the sprite glyph in a dark framed square of the same size
      const ico = def.icon ? `<img class="upgrow-ico" src="${def.icon}" alt="">`
                           : `<span class="upgrow-ico upgrow-glyph"><svg class="ico"><use href="#i-${key}"/></svg></span>`;
      el.innerHTML = `
        <div class="upgrow-head">${ico}<div>
          <div class="upgrow-name ${cls}">${def.name}${unlocked?' ✓':''}</div>
          <div class="upgrow-desc">${statusLine}${!hasUnit&&!unlocked?' — need '+def.unit:''}</div></div></div>
        <button class="upgrow-btn" ${btnDisabled?'disabled':''}>${btnLabel}</button>`;
      if (btnHandler && !btnDisabled) el.querySelector('button').addEventListener('click', btnHandler);
      upgRow.appendChild(el);
    });

    // ── Endless armory ──
    if (gameMode === 'endless') {
      const head = document.createElement('div');
      head.className = 'armory-head';
      head.innerHTML = 'ENDLESS ARMORY <span>spend the surplus — each purchase costs 30% more (ammo 15%)</span>';
      upgRow.appendChild(head);
      const grid = document.createElement('div');
      grid.className = 'armory-grid';
      upgRow.appendChild(grid);
      Object.entries(ARMORY_DEF).forEach(([key, def]) => {
        const n = armory[key], maxed = def.maxed?.(), [mc, gc2] = armoryCost(key), canAfford = minerals >= mc && gas >= gc2;
        const el = document.createElement('div');
        el.className = 'upgrow armory';
        el.innerHTML = `
          <div class="upgrow-head"><img class="upgrow-ico" src="${def.icon}" alt=""><div>
            <div class="upgrow-name armory">${def.name}${n ? ` ×${n}` : ''}</div>
            <div class="upgrow-desc">${def.fx()}${n ? `<br>now ${def.total(n)}` : ''}</div></div></div>
          ${!maxed && !canAfford ? `<div class="upgrow-need">need ${shortfallHTML(mc, gc2)} more</div>` : ''}
          <button class="upgrow-btn" ${maxed || !canAfford ? 'disabled' : ''}>${maxed ? '★ MAXED' : (canAfford ? 'BUY ' : '') + resHTML(mc, gc2)}</button>`;
        if (!maxed && canAfford) el.querySelector('button').addEventListener('click', () => buyArmory(key));
        grid.appendChild(el);
      });
    }
  }

  // ── Hover detection: show roster panel when mouse near bunker ────────────
  function checkBunkerHover(dt) {
    // Slot bar (pips above bunker) shows on hover — roster panel does NOT
    if (rosterPaused) return; // roster already open, don't interfere
    const pos = getBunkerScreenPos();
    const px = mx * _logW, py = my * _logH;
    const dist = Math.sqrt((px - pos.x) ** 2 + (py - pos.y) ** 2);
    const near = dist < 110 && _zoom < 0.3; // close-up: the bar would cover the bunker itself
    const slotOv = document.getElementById('slot-overlay');
    if (near) {
      slotOv.style.opacity = '1';
      bunkerHoverTimer = 0.5;
    } else if (bunkerHoverTimer > 0) {
      bunkerHoverTimer -= dt;
      if (bunkerHoverTimer <= 0) slotOv.style.opacity = '0';
    }
  }

  function openRoster() {
    const rp = document.getElementById('roster-panel');
    if (phase !== 'playing' && phase !== 'menu') return;
    rp.classList.add('visible');
    document.getElementById('slot-overlay').style.opacity = '1';
    document.getElementById('pause-dim').classList.add('visible');
    rosterPaused = true;
    renderRosterPanel();
  }

  function closeRoster() {
    document.getElementById('roster-panel').classList.remove('visible');
    document.getElementById('pause-dim').classList.remove('visible');
    rosterPaused = false;
    document.getElementById('slot-overlay').style.opacity = '0';
    bunkerHoverTimer = 0;
  }

  function toggleRoster() {
    const rp = document.getElementById('roster-panel');
    rp.classList.contains('visible') ? closeRoster() : openRoster();
  }

  // ── Ghost auto-snipe AI ──────────────────────────────────────────────────
  // Priority: threat score = hp / distance. High-HP enemies near the bunker
  // (e.g. Roach) are eliminated first — they deal the most damage if ignored.
  function ghostSnipeTick(dt) {
    if (!snipeUnlocked) return;
    const ghosts = roster.filter(u => u === 'ghost').length;

    for (let gi = 0; gi < ghosts; gi++) {   // gi = ghost ordinal (index into snipeReady)
      if (_gameT < (snipeReady[gi] || 0)) continue;  // still on cooldown

      // Threat score = hp / distance: high-HP enemies close to the bunker are most dangerous.
      // This naturally prioritises tanky units (Roach > Zergling) that are near the base.
      const alive = allEnemies().filter(e => !e.dead);
      if (!alive.length) return;

      const target = alive.reduce((best, e) => {
        const d = Math.max(0.5, e.mesh.position.length());
        const threat = (e.hp || 1) / d;
        return (!best || threat > best.threat) ? {e, threat} : best;
      }, null)?.e;

      if (!target) return;

      snipeReady[gi] = _gameT + SNIPE_CD[snipeLvl] / 1000;
      // Snipe visual: purple beam from bunker to target
      const beamGeo = new THREE.CylinderGeometry(0.04, 0.04, target.mesh.position.length(), 4);
      const beamMat = new THREE.MeshBasicMaterial({color: 0xcc44ff, transparent: true, opacity: 0.9});
      const beam = new THREE.Mesh(beamGeo, beamMat);
      const mid = target.mesh.position.clone().multiplyScalar(0.5);
      beam.position.copy(mid);
      beam.lookAt(target.mesh.position);
      beam.rotateX(Math.PI / 2);
      scene.add(beam);
      beams.push({mesh: beam, life: 0.3});

      killEnemy(target, true);
      achSnipe();
      spawnParts(target.mesh.position.clone(), 0xcc44ff, 18);
      const tname = target.type === 'r' ? 'Roach' : target.type === 'h' ? 'Hydralisk' : 'Zergling';
      setStatus(`Ghost snipe — ${tname} eliminated!`);
      SFX.play('snipe');
    }
  }

  // Kept for potential manual use / click override
  function trySnipe(ex, ey) { return false; }

  // ── Reset roster on game restart ─────────────────────────────────────────
  function resetRoster() {
    roster = ['marine','marine'];
    concussiveUnlocked = false;
    snipeUnlocked = false;
    superStimUnlocked = false;
    superStimLvl = 0;
    stimAuto = false;
    snipeLvl = 0;
    concussiveLvl = 0;
    sensorLvl = 0;
    slowedEnemies.clear();
    snipeReady = [];
    marauderReady = [];
    runnerIdx = -1;
    syncMarines();
  }

  // ── Roster panel hover state tracking ────────────────────────────────────
  // roster hover tracking removed — roster opens only via explicit action

    // ── Cheat system (original game: press C) ────────────────────────────────
  const CHEATS = {
    // ── Original game codes ──────────────────────────────────────────────
    'mng': {
      desc: '💰 7500 Minerals + 7500 Gas',
      fn: () => { minerals=7500; gas=7500; updateHUD(); }
    },
    'fu': {
      desc: '⬆️ All bunker upgrades maxed — self-repair online!',
      fn: () => {
        maxHp+=Math.max(0,3-hpLvl)*250;   // keeps Endless / armory HP
        dmgLvl=3; armorLvl=3; hpLvl=3; bunkerHp=maxHp;
        updateBunkerVisual(); // upgrade plates + hologram follow hpLvl
        updateHUD();
      }
    },
    'endv': {
      desc: '🏆 Victory!',
      fn: () => { if(gameMode!=='campaign'||victoryAchieved){ setStatus('Victory cheat works only in an unfinished campaign'); return; } campaignVictory(); }
    },
    'endd': {
      desc: '💀 Bunker destroyed!',
      fn: () => { bunkerHp=0; gameOver(); }
    },

    // ── Terran faction cheats (StarCraft original cheat names) ────────────
    'korhal': {
      desc: '☢️ All cooldowns reset (Airstrike + Nuke ready)',
      fn: () => { nukeCD=0; airCD=0; updateHUD(); }
    },
    'medic': {
      desc: '💊 Bunker fully repaired',
      fn: () => { bunkerHp=maxHp; updateHUD(); }
    },
    'terran': {
      desc: '👥 +2 Marines deployed',
      fn: () => {
        hireUnit('marine'); hireUnit('marine'); updateHUD();
      }
    },
    'siege': {
      desc: '🔫 Damage maxed (lv3) instantly',
      fn: () => { dmgLvl=3; updateHUD(); }
    },
    'bunker': {
      desc: '🏰 HP maxed + Armor maxed instantly',
      fn: () => {
        maxHp+=Math.max(0,3-hpLvl)*250;   // keeps Endless / armory HP
        armorLvl=3; hpLvl=3; bunkerHp=maxHp;
        updateBunkerVisual(); // upgrade plates + hologram follow hpLvl
        updateHUD();
      }
    },
    'sensor': {
      desc: '📡 Sensor Tower maxed — blips out to 16',
      fn: () => { sensorLvl=3; setStatus('Sensor Tower maxed — blips out to 16'); updateHUD(); }
    },

    // ── Zerg faction cheats ───────────────────────────────────────────────
    'zergrush': {
      desc: '🐛 Skip +5 waves — Zerg hive mind surges!',
      fn: () => {
        const cap = gameMode==='campaign' ? (wavePhase==='combat' ? CFG.victory_wave : CFG.victory_wave-1) : 99;
        wave=Math.max(wave,Math.min(wave+5,cap)); // campaign: stop at the final wave (it must still be fought)
        // Between waves the pending countdown starts the next one — starting it
        // here too used to run two waves on top of each other.
        if(wavePhase==='combat'){ reinforce(); startWave(); }   // between waves the pending wave++ catches up
        updateHUD();
      }
    },
    'swarm': {
      desc: '👁️ Spawn 10 Zerglings right now',
      fn: () => {
        for(let i=0;i<10;i++){
          const r=12+Math.random()*3,a=Math.random()*Math.PI*2;
          zerglings.push(makeZergling(Math.cos(a)*r,Math.sin(a)*r));
        }
        setStatus('The swarm has been reinforced!');
      }
    },
    'roachwave': {
      desc: '🔴 Spawn 5 Roaches right now',
      fn: () => {
        for(let i=0;i<5;i++){
          const r=11+Math.random()*3,a=Math.random()*Math.PI*2;
          roaches.push(makeRoach(Math.cos(a)*r,Math.sin(a)*r));
        }
        setStatus('Roach swarm inbound!');
      }
    },

    // ── Fun / Easter egg cheats ───────────────────────────────────────────
    'nuclear': {
      desc: '💥 Triple nuke — all enemies obliterated',
      fn: () => {
        // force: any wave, no cooldown. Spaced so each detonates before the next launches.
        doNuke(true); after(2.2, ()=>doNuke(true)); after(4.4, ()=>doNuke(true));
      }
    },
    'rain': {
      desc: '🌧️ A downpour now (again: a drizzle, then clear)',
      fn: () => {   // the clouds in at once (≥ .8): the downpour starts now; the status line follows (updateWeather)
        if(!wxOn){ setStatus('Weather is off — Menu → Settings'); return; }
        if(wx.sky!=='rain'){ wxSet('rain'); wxPour(true); wx.cloud=Math.max(wx.cloud,.8); }
        else if(wxHeavy()) wxPour(false);
        else wxSet('clear');
      }
    },
    'airstrike': {
      desc: '✈️ 5 consecutive airstrikes',
      fn: () => {
        for(let i=0;i<5;i++){
          after(i*0.4, ()=>{
            const[tx,tz]=randPos();
            strikeAt(tx,tz,0xff8800,5);
            spawnParts(new THREE.Vector3(tx,.5,tz),0xff8800,14);
          });
        }
        after(2.0, ()=>{ammo=maxAmmo;updateHUD();setStatus('Air support complete!');});
      }
    },
    'mineral': {
      desc: '💎 +500 Minerals',
      fn: () => { minerals+=500; updateHUD(); }
    },
    'gas': {
      desc: '🧪 +500 Gas',
      fn: () => { gas+=500; updateHUD(); }
    },
    'wave': {
      desc: '⏩ Skip to next wave immediately',
      fn: () => {
        // Between waves the next one is already on its way — clearing again paid the bonus twice
        if(wavePhase!=='combat'){ setStatus('Already between waves — next wave incoming'); return; }
        allEnemies().forEach(e=>killEnemy(e,false));
        zerglings=[]; roaches=[]; spawnQueue=[];
      }
    },
    'immortal': {
      desc: '🛡️ Bunker HP set to 99999 (godmode)',
      fn: () => { bunkerHp=99999; maxHp=99999; updateHUD(); }
    },
    'kaboom': {
      desc: '🌋 Nuke every enemy position individually',
      fn: () => {
        const enemies=[...allEnemies()];
        if(!enemies.length){setStatus('No enemies to kaboom!');return;}
        enemies.forEach((e,i)=>{
          after(i*0.18, ()=>{
            if(!e.dead) strikeAt(e.mesh.position.x,e.mesh.position.z,0xff3300,3);
          });
        });
      }
    },
    'general': {
      desc: '🎖️ Instant rank: GENERAL (280 kills added)',
      fn: () => { kills+=280; score+=2800; updateHUD(); }
    },
    'help': {
      desc: '📋 Lists all cheat codes',
      fn: () => {   // in the console itself, widened (the list stays until a code or ESC)
        const m = document.getElementById('cheat-msg');
        m.innerHTML = Object.entries(CHEATS).map(([code,{desc}])=>`<b>${code.padEnd(11)}</b>${_esc(desc)}`).join('\n');
        m.classList.add('list'); document.getElementById('cheat-wrap').classList.add('wide');
      }
    },
  };

  let _cheatCloseT = 0;   // the console closes itself a moment after a code (a stale one must not close the next)
  function openCheat() {
    if(phase!=='playing') return;
    _cheatOpen = true; // pauses gameplay
    clearTimeout(_cheatCloseT);
    document.getElementById('cheat-wrap').style.display='block';
    document.getElementById('cheat-wrap').classList.remove('wide');
    document.getElementById('cheat-backdrop').style.display='block';
    document.getElementById('cheat-input').value='';
    document.getElementById('cheat-msg').textContent=''; document.getElementById('cheat-msg').classList.remove('list');
    setTimeout(()=>document.getElementById('cheat-input').focus(), 50);
  }
  function closeCheat() {
    _cheatOpen = false;
    document.getElementById('cheat-wrap').style.display='none';
    document.getElementById('cheat-backdrop').style.display='none';
  }
  function submitCheat(code) {
    const key = code.trim().toLowerCase();
    const entry = CHEATS[key];
    const msgEl = document.getElementById('cheat-msg');
    clearTimeout(_cheatCloseT);
    msgEl.classList.remove('list'); document.getElementById('cheat-wrap').classList.remove('wide');
    if(entry) {
      // Any code but help turns achievements off for the rest of this game — before it acts:
      // endv wins the campaign and terran hires, and both would earn achievements first
      const first = key !== 'help' && !_run.cheated;
      if(first){ _run.cheated = true; updateHUD(); }
      msgEl.style.color='#44ff88';
      entry.fn();
      if(key === 'help') return;   // open to read the list
      msgEl.textContent = entry.desc + (first ? '\nAchievements are off for the rest of this game.' : '');
      _cheatCloseT = setTimeout(closeCheat, first ? 2600 : 1400);   // time to read it
    } else {
      msgEl.style.color='#f44';
      msgEl.textContent = key ? `Unknown: "${key}" — try 'help'` : 'Enter a code!';
      document.getElementById('cheat-input').select();
    }
  }

  // ── Graphics quality ────────────────────────────────────────────────────────
  function applyGfx(q) {
    if (q === gfxQuality && renderer.shadowMap.enabled === (q === 'HIGH')) { _syncGfxUI(); return; }
    gfxQuality = q;
    const hi = q === 'HIGH';
    renderer.shadowMap.enabled = hi;
    _post.on = _post.ok && POST_Q[q].on;
    resize(); // applies the quality's pixel ratio and keeps _logW/_logH accurate

    if (_sunLight) _sunLight.castShadow = hi;
    _groundU.groundHD.value = GLOW_LIGHTS.cloudOn.value = hi ? 1 : 0;   // the ground's fine layers, the cloud shadows (uniforms: no recompile)
    if (_grass) _grass.visible = hi;
    _applyDNLights(_dnLitF); // light levels for this quality, blended with day/night (and a flare)

    if (hi && _sunLight && _sunLight.shadow.map) { _sunLight.shadow.map.dispose(); _sunLight.shadow.map = null; }
    warmNukeShaders();   // (the shadows are in every program's key)
    _syncGfxUI();
  }

  // Graphics labels/buttons only — safe to call any time (the menu used to
  // re-run applyGfx on open, relighting a night scene as day).
  function _syncGfxUI() {
    const hi = gfxQuality === 'HIGH';
    const el = document.getElementById('tv-gfx');
    if (el) { el.textContent = gfxQuality; el.style.color = hi ? '#44ff88' : '#fa4'; }
    // Sync menu buttons
    document.getElementById('menu-gfx-high') && document.getElementById('menu-gfx-high').classList.toggle('active', hi);
    document.getElementById('menu-gfx-low')  && document.getElementById('menu-gfx-low') .classList.toggle('active', !hi);
    const desc = document.getElementById('menu-gfx-desc');
    if (desc) desc.textContent = hi ? 'Shadows • 3D grass • detailed ground • cloud shadows • hi-res rendering' : 'No shadows or grass • plain ground • fast, battery-friendly';
  }

  function toggleGfx() { applyGfx(gfxQuality === 'HIGH' ? 'LOW' : 'HIGH'); }
  function setGfx(q)   { applyGfx(q); }

  // ── Menu ────────────────────────────────────────────────────────────────────
  // (_menuOpen is declared with the game state — opening the menu pauses gameplay)
  // Tabs: the last one chosen opens again (GAME first)
  const MENU_TABS = ['game', 'settings', 'controls', 'tutorial', 'achievements', 'cheats'];
  let _menuTab = 'game';
  function menuTab(t) {
    if (!MENU_TABS.includes(t)) return;
    _menuTab = t;
    if (t === 'achievements') _syncAchUI();
    document.querySelectorAll('.menu-tab').forEach(b => { const on = b.dataset.tab === t; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
    document.querySelectorAll('.menu-page').forEach(p => p.classList.toggle('active', p.dataset.page === t));
  }
  function openMenu() {
    _menuOpen = true;
    const ov = document.getElementById('menu-overlay');
    if (ov) { ov.style.display = 'flex'; }
    menuTab(_menuTab);
    // title / results: BACK, nothing to restart; MAIN MENU from the results only (as the desktop)
    $('menu-resume').querySelector('span').textContent = phase === 'playing' ? 'RESUME' : 'BACK';
    $('menu-restart').disabled = phase !== 'playing';
    $('menu-main').disabled = phase === 'menu';
    _syncGfxUI(); // sync button active states
    _syncSoundUI();
    _syncSaveUI();
    _syncTutUI();
    // Sync day/night checkbox
    const cb = document.getElementById('menu-dn-cb');
    if (cb) cb.checked = dnEnabled;
    $('menu-wx-cb').checked = wxOn;
    $('menu-dmg-cb').checked = dmgNumbersOn;
  }
  function _syncSoundUI() {
    const cb = document.getElementById('menu-mute-cb'), vol = document.getElementById('menu-vol'), val = document.getElementById('menu-vol-val');
    if (cb) cb.checked = SFX.muted;
    const mc = document.getElementById('menu-music-cb'); if (mc) mc.checked = Music.on;
    if (vol) vol.value = Math.round(SFX.volume * 100);
    if (val) val.textContent = SFX.muted ? 'OFF' : Math.round(SFX.volume * 100) + '%';
    const sb = document.getElementById('tv-snd');
    if (sb) { sb.classList.toggle('off', SFX.muted); sb.querySelector('use')?.setAttribute('href', SFX.muted ? '#i-snd-off' : '#i-snd'); }
  }
  function toggleMute() { SFX.ensure(); SFX.setMuted(!SFX.muted); _syncSoundUI(); }
  function setVolume(v) { SFX.ensure(); SFX.setVolume(v); _syncSoundUI(); SFX.play('buy'); }
  function setMuted(m) { SFX.ensure(); SFX.setMuted(m); _syncSoundUI(); }
  function setMusic(on) { SFX.ensure(); Music.setOn(on); _syncSoundUI(); }
  function closeMenu() {
    _menuOpen = false;
    const ov = document.getElementById('menu-overlay');
    if (ov) { ov.style.display = 'none'; }
  }

  // ── Save / Load (localStorage) ──────────────────────────────────────────────
  // Two slots: the manual save (menu SAVE / LOAD, title LOAD GAME) and an
  // autosave written after every cleared wave (title CONTINUE — also a
  // checkpoint after the bunker falls). Results are reported inside the menu:
  // the top-bar status line is hidden behind the menu overlay.
  const SAVE_KEY = 'dotd_save_v1', AUTO_KEY = 'dotd_autosave_v1';
  function _snapshot() {
    return {
      wave, score, kills, minerals, gas,
      bunkerHp, maxHp, ammo, maxAmmo,
      dmgLvl, armorLvl, hpLvl, ammoLvl,
      roster: [...roster],
      concussiveUnlocked, snipeUnlocked, concussiveLvl, snipeLvl, superStimUnlocked, superStimLvl, stimAuto, runnerIdx, sensorLvl,
      armory: { ...armory }, endlessSteps,
      gfxQuality,
      wavePhase, gameT: _gameT, victoryAchieved, gameMode,
      // An airstrike's crate run / a nuke countdown can't be saved; loading would
      // keep the cooldown but lose the effect (e.g. 0 ammo with R blocked for 20 s).
      airCD: (vikingActive || marines.some(m => m.cb)) ? 0 : airCD,
      nukeCD: _nukeInFlight ? 0 : nukeCD,
      stimT, stimVolley: _stimVolley,   // the bunker HP already paid for this stim
      cheated: _run.cheated, legacy: _run.legacy, usedSupport: _run.usedSupport, hiredOther: _run.hiredOther,   // achievements
      ts: Date.now()
    };
  }
  function _writeSave(key, override) { try { localStorage.setItem(key, JSON.stringify({ ..._snapshot(), ...override })); return true; } catch (e) { return false; } }
  function _readSave(key) { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
  // Reject saves we cannot restore BEFORE the running game is torn down
  function _validSave(d) {
    const num = v => typeof v === 'number' && isFinite(v);
    return !!d && num(d.wave) && d.wave >= 1 && num(d.score) && num(d.minerals) && num(d.gas) && num(d.bunkerHp) && num(d.maxHp)
      && num(d.ammo) && num(d.maxAmmo) && Array.isArray(d.roster) && d.roster.length > 0 && d.roster.every(u => UNIT_DEF[u]);
  }
  function _ago(ts) {
    const m = Math.round((Date.now() - (ts || 0)) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
  }
  function _saveLabel(d) {
    return (d.gameMode === 'endless' ? 'Endless' : 'Campaign') + ' · wave ' + d.wave + (d.wavePhase === 'combat' ? '' : ' cleared') + ' · ' + _ago(d.ts);
  }
  // Menu save panel: slot description, or the result of the last action
  function _syncSaveUI(msg, ok) {
    const info = $('menu-save-info'), d = _readSave(SAVE_KEY), lb = $('menu-load-btn');
    if (lb) lb.disabled = !_validSave(d);
    if (!info) return;
    info.className = msg ? (ok ? 'ok' : 'err') : '';
    info.textContent = msg ? (ok ? '✓ ' : '✗ ') + msg : d ? 'Saved game: ' + _saveLabel(d) : 'No saved game yet';
  }
  function saveGame() {
    if (phase !== 'playing') { _syncSaveUI('Nothing to save — start a game first', false); return; }
    const ok = _writeSave(SAVE_KEY);
    _syncSaveUI(ok ? 'Saved — ' + _saveLabel(_readSave(SAVE_KEY)) : 'Save failed — browser storage is blocked', ok);
    setStatus(ok ? 'Game saved ✓' : 'Save failed — browser storage is blocked');
    SFX.play(ok ? 'buy' : 'deny');
  }
  function autoSave() { if (phase === 'playing') _writeSave(AUTO_KEY); }
  // slot: 'auto' = autosave (title CONTINUE), otherwise the manual save
  function loadGame(slot) {
    const d = _readSave(slot === 'auto' ? AUTO_KEY : SAVE_KEY);
    if (!_validSave(d)) {
      const msg = d ? 'This save cannot be loaded (damaged or from an old version)' : 'No saved game found';
      _syncSaveUI(msg, false); setStatus(msg); SFX.play('deny');
      return;
    }
    try {
      // Restart cleanly then restore state
      start();
      wave = d.wave; score = d.score; kills = d.kills || 0;
      minerals = d.minerals; gas = d.gas;
      bunkerHp = d.bunkerHp; maxHp = d.maxHp;
      ammo = d.ammo; maxAmmo = d.maxAmmo;
      dmgLvl = d.dmgLvl || 0; armorLvl = d.armorLvl || 0; hpLvl = d.hpLvl || 0; ammoLvl = d.ammoLvl || 0;
      roster = [...d.roster];
      concussiveUnlocked = !!d.concussiveUnlocked; snipeUnlocked = !!d.snipeUnlocked; superStimUnlocked = !!d.superStimUnlocked;
      concussiveLvl = d.concussiveLvl || 0; snipeLvl = d.snipeLvl || 0; sensorLvl = d.sensorLvl || 0;   // older saves: no Sensor Tower
      superStimLvl = Math.max(0, Math.min(3, d.superStimLvl || 0));                                      // ... nor Super Stimpack tiers
      stimAuto = superStimUnlocked && !!d.stimAuto;
      runnerIdx = Number.isInteger(d.runnerIdx) && d.runnerIdx < roster.length ? d.runnerIdx : -1;   // older saves: none elected
      armory = { hp: 0, dmg: 0, ammo: 0, cd: 0, ...(d.armory || {}) };   // HP / ammo purchases are already in maxHp / maxAmmo
      snipeReady = roster.filter(u => u === 'ghost').map(() => 0);
      marauderReady = roster.filter(u => u === 'marauder').map(() => 0);
      // Survival clock, victory and cooldowns (absent in older saves → defaults)
      _gameT = d.gameT || 0; victoryAchieved = !!d.victoryAchieved;
      gameMode = d.gameMode || (victoryAchieved ? 'endless' : 'campaign'); // older saves have no mode
      if (gameMode === 'endless' && !endlessUnlocked()) _store.set(ENDLESS_KEY, '1'); // an Endless save means the campaign was won
      airCD = d.airCD || 0; nukeCD = d.nukeCD || 0;
      stimT = d.stimT || 0; _stimVolley = d.stimVolley || 0;   // a stim paid for keeps running
      // a save from before achievements has no flags: what happened in that game is unknown, so it earns none
      _run.legacy = !('cheated' in d) || !!d.legacy; _run.cheated = _run.legacy || !!d.cheated;
      _run.usedSupport = !!d.usedSupport; _run.hiredOther = !!d.hiredOther;
      syncMarines(); // marine meshes must match the restored roster
      if (d.gfxQuality) applyGfx(d.gfxQuality);
      updateBunkerVisual();
      // start() queued wave 1 — rebuild the queue for the restored wave. A save
      // taken between waves already holds that wave's clear bonus, so resume
      // at the next wave (with the resupply it would have received).
      if (d.wavePhase === 'cleared' || d.wavePhase === 'clearing') { wave = d.wave + 1; ammo = maxAmmo; }
      // steps already in maxHp / maxAmmo (older saves have none) — then the resumed wave's own step
      endlessSteps = typeof d.endlessSteps === 'number' ? d.endlessSteps : 0;
      reinforce();
      _slotSig = null;
      startWave();
      updateHUD();
      _shrikeOD = shrikeOverdrive();   // a restored overdrive is not news: keep the "Loaded" message
      achState();
      setStatus(`Loaded — ${gameMode === 'endless' ? 'Endless' : 'Campaign'} wave ${wave} (saved ${_ago(d.ts)})`);
      closeMenu();
    } catch (e) {
      console.error('Load failed', e);
      _syncSaveUI('Load failed: ' + e.message, false); setStatus('Load failed');
    }
  }

  _syncSoundUI();
  showTitle();
  return {start, buy, buyArmory, skipAssetWait, doAirstrike, doNuke, doStim, toggleStimAuto, openCheat, closeCheat, submitCheat, toggleRoster, openRoster, closeRoster, toggleGfx, setGfx, openMenu, closeMenu,
          saveGame, loadGame, toggleDayNight, setVolume, setMuted, setMusic, toggleMute, resetView, showTitle, continueEndless, mode: () => gameMode,
          showHowTo, tutDismiss, tutNext, tutBack, tutSkip, startTour, setTutorial, replayTutorial, menuTab, setWeather, showAchievements, achTab, setDmgNumbers};
})();
