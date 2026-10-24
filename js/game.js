// ─── GAME ────────────────────────────────────────────────────────────────────
const G = (() => {
  // Three.js
  const canvas = document.getElementById('gc');
  const chCanvas = document.getElementById('crosshair-canvas');
  const chCtx = chCanvas.getContext('2d');
  let W, H;
  let _logW = 0, _logH = 0; // logical (CSS) canvas dimensions — never multiplied by devicePixelRatio

  let gfxQuality = 'HIGH'; // 'LOW' | 'HIGH'
  let _ambientLight, _sunLight, _fillLight, _bunkerLight, _fireLight, _muzzleLight, _nukeLight;

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

  const renderer = new THREE.WebGLRenderer({canvas, antialias:true});
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
    };
    const MIN_GAP = { hit: .045, bite: .22, spit: .07, acid: .06, marine: .03, marauder: .05, ghost: .05, shrike: .05, zdie: .035, rdie: .06, boom: .07, rocket: .06, mblast: .06 };
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
  let floatTexts = []; // {x,y,z,txt,life,maxLife,color}
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

  // ── Build scene ─────────────────────────────────────────────────────────
  function buildScene() {
    // Ambient — neutral warm-cool so textures read accurately
    _ambientLight = new THREE.AmbientLight(0x99aabb, 0.7);
    scene.add(_ambientLight);

    // Sun — primary directional light with shadow
    _sunLight = new THREE.DirectionalLight(0xfff4cc, 1.8);
    _sunLight.position.set(10, 28, 8);
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
    _bunkerLight = new THREE.PointLight(0xff9944, 0, 14, 2);
    _bunkerLight.position.set(0, 2.5, 0);
    scene.add(_bunkerLight);

    // Muzzle light — a brief orange flash on the hull at the firing slit / barrel
    _muzzleLight = new THREE.PointLight(0xffb060, 0, 4.5, 2);
    scene.add(_muzzleLight);

    // Fire light — flickers on the hull while the bunker burns (HP < 50%)
    _fireLight = new THREE.PointLight(0xff6a1a, 0, 6, 2);
    _fireLight.position.set(0, 1.8, 0);
    scene.add(_fireLight);

    // Nuke light — the fireball lights the field (strongest at night: updateNukeLight)
    _nukeLight = new THREE.PointLight(0xffa050, 0, 30, 1.5);
    scene.add(_nukeLight);

    // Fog — day: effectively invisible; night: tight range (set once, updated in updateDayNight)
    scene.fog = new THREE.Fog(0x2a3a18, DN_DAY_FOG_NEAR, DN_DAY_FOG_FAR);

    // Ground
    groundMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(120,120), // large enough that the edge is lost in the fog from the low close-up angle
      // Phong = per-pixel lighting: the bunker light can pool on the ground at night
      // (Lambert lights per vertex — on this 4-vertex quad that was no light at all)
      new THREE.MeshPhongMaterial({color:0x2d4a18,specular:0x080808,shininess:4})
    );
    groundMesh.rotation.x = -Math.PI/2; groundMesh.receiveShadow=true;
    scene.add(groundMesh);

    // Dirt patches + rocks: laid out as before, then merged into one mesh per
    // material (36 draw calls → 2)
    const props=new THREE.Group(), dirtMat=new THREE.MeshPhongMaterial({color:0x4a3a18,specular:0x080808,shininess:4}), rockMat=new THREE.MeshLambertMaterial({color:0x554433});
    for(let i=0;i<20;i++){
      const m=new THREE.Mesh(new THREE.PlaneGeometry(Math.random()*2+.4,Math.random()*1.2+.3),dirtMat);
      m.rotation.x=-Math.PI/2; m.position.set((Math.random()-.5)*36,.01,(Math.random()-.5)*22); props.add(m);
    }
    for(let i=0;i<16;i++){
      const a=i/16*Math.PI*2, r=14+Math.random()*2.5;
      const m=new THREE.Mesh(new THREE.DodecahedronGeometry(Math.random()*.5+.25),rockMat);
      m.position.set(Math.cos(a)*r,.3,Math.sin(a)*r); m.rotation.set(Math.random(),Math.random(),Math.random()); props.add(m);
    }
    bakeTemplate(props).forEach(p=>scene.add(new THREE.Mesh(p.geo,p.mat)));

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
    stimAuto = !stimAuto;
    setStatus(stimAuto ? 'Stimpack autocast on — it stims as you fire' : 'Stimpack autocast off');
    updateHUD();
  }
  function updateShrike(dt) {
    const od = shrikeOverdrive();
    if (od !== _shrikeOD) {
      _shrikeOD = od;
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
      // colour: corpse fades dark · hit flash bright · concussive slow icy blue
      let r = 1, g = 1, b = 1;
      if (e.corpse) r = g = b = Math.max(0.25, 1 - e.t * 1.4);
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
  }

  // Dying enemies: pop, roll onto their side, then sink into the ground (~1.2 s)
  let corpses = [];
  function updateCorpses(dt) {
    corpses = corpses.filter(c => {
      c.t += dt;
      const m = c.mesh;
      if (c.t < 0.12) m.position.y = c.t / 0.12 * 0.18;                                   // pop
      else m.position.y = 0.18 - Math.min(1, (c.t - 0.12) / 1.0) ** 2 * 0.9;               // sink
      m.rotation.z = c.spin * Math.min(1, c.t / 0.3) * Math.PI * 0.5;                       // roll over
      return c.t < 1.2;
    });
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
  const _lampBeamIM = new THREE.InstancedMesh(_beamGeo2, new THREE.MeshBasicMaterial({ color: 0xf2f6ff, map: _beamTex, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }), LAMP_CAP);   // white LEDs
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
        _mushPut(_lampFx, _lampP.x, _lampP.y, _lampP.z, 0.12, _lampWhite, _dnFactor);
      }
      _lampP.set(0, h, LAMP_FRONT).applyAxisAngle(_lampUp, rot).add(p);
      _mushPut(_lampFx, _lampP.x, _lampP.y, _lampP.z, 0.6, _lampGlowCol, 0.35 * _dnFactor);
      // one pool of light on the ground for the pod
      _lampP.set(0, 0, LAMP_FRONT).applyAxisAngle(_lampUp, rot).add(p).setY(.025);
      _lampBeamIM.setMatrixAt(n, _lampM.compose(_lampP, _lampQ.setFromAxisAngle(_lampUp, rot), _lampS.set(3.6, 1, 5.0)));
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
    allEnemies().forEach(e=>{if(e.dead)return;const dx=e.mesh.position.x-tx,dz=e.mesh.position.z-tz;if(Math.sqrt(dx*dx+dz*dz)<r)killEnemy(e,true);});
  }
  function randPos(){const r=8+Math.random()*4,a=Math.random()*Math.PI*2;return[Math.cos(a)*r,Math.sin(a)*r];}

  function doAirstrike(){
    if(isPaused()) return;
    if(airCD>0||wavePhase!=='combat'||ammo>0){
      setStatus(ammo>0?'Use when ammo is empty!':'Not ready yet!');return;
    }
    if(vikingActive){setStatus('Viking already inbound!');return;}
    airCD=strikeCooldown(); waveAirs++;

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

  // ── Nuke: 1 warhead, massive radius, laser designator then detonation ──────
  // SC2 lore: Terran nuclear missile. Bunker survives (hardened structure).
  // Enemies within blast radius are wiped. ~2s warning laser before impact.
  let _nukeInFlight = false;

  // force = cheat launch: skips the wave unlock, cooldown and in-flight checks
  let _nukeTargetTex = null;   // SC2 nuke reticle for the target marker, loaded at boot
  ModelLoader.texture(DECALS.nukeTarget).then(t => { _nukeTargetTex = t; })
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
      // Shockwave ring — expands outward rapidly (scale-animated unit ring)
      const shockMat = new THREE.MeshBasicMaterial({color:0xff6600, side:THREE.DoubleSide, transparent:true, opacity:0.9, fog:false});
      const shock = new THREE.Mesh(_ringGeo, shockMat);
      shock.scale.setScalar(0.2);
      shock.rotation.x = -Math.PI/2;
      shock.position.set(tx, 0.1, tz);
      scene.add(shock);
      beams.push({mesh: shock, life: 1.2, isShock: true, tx, tz, startLife: 1.2});

      // The mushroom cloud of fire (it replaces the solid cone and ball the blast used
      // to show), and the fireball's light (at night it lights the field)
      mushrooms.push({x: tx, z: tz, t: 0});
      _nukeLightT = 0;
      _nukeLight.position.set(tx, 3, tz);

      // Screen flash — strong white then orange
      flash('nuke-flash');

      // (no sparks or debris flung across the field: hard to read; the cloud, its dust
      // ring and the shockwave carry it)

      // Kill ALL enemies in radius — bunker excluded (hardened); burnt: no blood
      let killed = 0;
      allEnemies().forEach(e => {
        if(e.dead) return;
        const dx=e.mesh.position.x-tx, dz=e.mesh.position.z-tz;
        if(Math.sqrt(dx*dx+dz*dz) <= NUKE_RADIUS){
          killEnemy(e, true, false);
          killed++;
        }
      });

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
  // Flashes up in 0.08 s, holds NUKE_LIGHT_HOLD s, then cools (gone after
  // NUKE_LIGHT_DUR s): a warm point light at the blast, and at night the dark
  // lifts toward NUKE_LIGHT_F (fog far ≈ 40: past the spawn ring) — _dnEffFactor.
  const NUKE_LIGHT_DUR = 6, NUKE_LIGHT_HOLD = 0.5, NUKE_LIGHT_F = 0.35;
  let _nukeLightT = -1;          // seconds since the blast (game time); -1 = none
  function _nukeLightK() {
    if (_nukeLightT < 0) return 0;
    const t = _nukeLightT;
    return Math.min(1, t / 0.08) * (t < NUKE_LIGHT_HOLD ? 1 : Math.exp(-(t - NUKE_LIGHT_HOLD) / 1.4)) * Math.min(1, NUKE_LIGHT_DUR - t);
  }
  function updateNukeLight(dt) {   // live frames only, before updateDayNight (the lights follow it)
    if (_nukeLightT >= 0 && (_nukeLightT += dt) >= NUKE_LIGHT_DUR) _nukeLightT = -1;
    if (_nukeLight) _nukeLight.intensity = _nukeLightK() * (1 + 3 * _dnFactor);
  }

  // ── Nuke mushroom cloud ──────────────────────────────────────────────────
  // As StarCraft II draws it, in soft sprites rebuilt every frame: a cap of fire (a
  // rolling torus under a dome) on a fiery stem, burning white-yellow inside and
  // orange at the edges, cooling to dark red and soot; a grey dust ring surging out
  // along the ground around it. Smoke dims with the scene's light; fire is self-lit.
  const MUSH_DUR = 7;
  let mushrooms = [];
  const _mushSmoke = makeParticleSystem(600, THREE.NormalBlending), _mushFire = makeParticleSystem(300, THREE.AdditiveBlending);
  const _puffHash = (i, salt) => { const s = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453; return s - Math.floor(s); };
  const _FIRE_RAMP = [0x2e2420, 0x8a2a0c, 0xf06a18, 0xffb43a, 0xfff0c0].map(h => new THREE.Color(h));
  function _fireRamp(T, out) {   // white-hot → yellow → orange → deep red → soot
    T = Math.max(0, Math.min(1, T)) * 4;
    const i = Math.min(3, Math.floor(T));
    return out.copy(_FIRE_RAMP[i]).lerp(_FIRE_RAMP[i + 1], T - i);
  }
  const _sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const _mc = new THREE.Color(), _mcA = new THREE.Color(0x6a6460), _mcB = new THREE.Color(0x9a948c), _mcHot = new THREE.Color(0xfff0c0);
  function _mushPut(sys, x, y, z, size, col, alpha) {
    if (sys.n >= sys.cap) return;
    const i = sys.n++, i3 = i * 3;
    sys.pos[i3] = x; sys.pos[i3+1] = y; sys.pos[i3+2] = z;
    sys.col[i3] = col.r; sys.col[i3+1] = col.g; sys.col[i3+2] = col.b;
    sys.size[i] = size; sys.alpha[i] = alpha;
  }
  function _mushroomSprites(mc, lit) {
    const t = mc.t, g = 1 - Math.exp(-t / 0.9), spread = 1 - Math.exp(-t / 1.0), heat = Math.exp(-t / 2.8);
    const capH = 1.4 + 6.0 * g + 0.2 * t, capR = 0.9 + 2.7 * spread, tube = 0.7 + 0.9 * g, puff = 1.3 + 1.6 * g;
    const fade = Math.min(1, t / 0.15) * (1 - _sstep(MUSH_DUR - 2.5, MUSH_DUR, t));
    let n = 0;
    const add = (x, y, z, size, a, inner) => {   // inner: how hot this puff burns for the cloud's temperature (1 = its core)
      const i = n++, T = heat * inner * (0.9 + 0.2 * _puffHash(i, 1)), sz = size * (0.85 + 0.3 * _puffHash(i, 2));
      _fireRamp(T, _mc);
      if (T < 0.3) _mc.multiplyScalar(lit + (1 - lit) * T / 0.3);   // cooled to smoke: lit by the scene
      _mushPut(_mushSmoke, mc.x + x, y, mc.z + z, sz, _mc, a * fade * (0.6 + 0.4 * Math.min(1, T * 2)));
      if (T < 0.45) return;   // the hottest parts glow
      _mushPut(_mushFire, mc.x + x, y, mc.z + z, sz * 0.6, _fireRamp(Math.min(1, T + 0.2), _mc), 0.5 * Math.min(1, (T - 0.45) / 0.55) * fade);
    };
    const PI2 = Math.PI * 2, stemTop = Math.max(0.5, capH - tube * 0.6);
    for (let i = 0; i < 22; i++) {   // stem: a column of fire, wider at the foot, twisting slowly
      const f = i / 21, a = _puffHash(i, 3) * PI2 + t * 0.7, r = (0.12 + 0.25 * (1 - f)) * _puffHash(i, 4);
      add(Math.cos(a) * r, 0.3 + f * (stemTop - 0.3), Math.sin(a) * r, (1.2 + 0.9 * (1 - f)) * (0.6 + 0.4 * g), 0.6, 1.05 - 0.15 * f);
    }
    for (let k = 0; k < 90; k++) {   // cap: the rolling torus (golden-angle offsets spread the puffs over its tube)
      const a = PI2 * k / 90 + _puffHash(k, 5) * 0.1, phi = -t * 1.4 + k * 2.39996, s = Math.sin(phi), cph = Math.cos(phi);
      const rr = capR + tube * cph;
      add(Math.cos(a) * rr, capH + tube * 0.8 * s, Math.sin(a) * rr, puff * 0.85, 0.55, 0.85 + 0.2 * s - 0.1 * cph);   // the outer rim cools first
    }
    for (let k = 0; k < 18; k++) {   // dome and core of the cap: the hottest
      const a = PI2 * _puffHash(k, 6), r = capR * 0.7 * Math.sqrt(_puffHash(k, 7));
      add(Math.cos(a) * r, capH + tube * (0.2 + 0.6 * _puffHash(k, 8)), Math.sin(a) * r, puff * 1.1, 0.55, 1.1 - 0.3 * r / Math.max(capR, 0.1));
    }
    // the dust ring: grey smoke rolling out along the ground, thickest at its rim, settling
    const ringR = 1.8 + 5.0 * (1 - Math.exp(-t / 0.8)), settle = 1 - _sstep(3, MUSH_DUR, t);
    for (let k = 0; k < 56; k++) {
      const a = PI2 * k / 56 + _puffHash(k, 9) * 0.1, r = ringR + (_puffHash(k, 10) - 0.5) * 0.9;
      _mc.copy(_mcA).lerp(_mcB, 0.75 + 0.25 * _puffHash(k, 13)).multiplyScalar(lit);
      _mushPut(_mushSmoke, mc.x + Math.cos(a) * r, 0.35 + 0.3 * _puffHash(k, 11), mc.z + Math.sin(a) * r,
        (1.5 + 1.0 * g) * (0.8 + 0.4 * _puffHash(k, 12)), _mc, 0.42 * settle * Math.min(1, t / 0.2));
    }
    if (heat > 0.35)   // the white flash at the heart of the young fireball
      _mushPut(_mushFire, mc.x, capH * 0.8, mc.z, capR * 2.6, _mcHot, 0.55 * (heat - 0.35) / 0.65);
  }
  const _mushOrder = [];
  function syncMushrooms(dt) {   // live frames: they age in game time
    for (const mc of mushrooms) mc.t += dt;
    mushrooms = mushrooms.filter(mc => mc.t < MUSH_DUR);
    _mushSmoke.n = _mushFire.n = 0;
    for (const mc of mushrooms) _mushroomSprites(mc, 1 - 0.75 * _dnLitF);
    // smoke back to front (normal blending): reorder the buffers by view depth
    const S = _mushSmoke, N = S.n, v = camera.matrixWorldInverse.elements;
    if (N > 1) {
      _mushOrder.length = 0;
      for (let i = 0; i < N; i++) _mushOrder.push([v[2] * S.pos[i * 3] + v[6] * S.pos[i * 3 + 1] + v[10] * S.pos[i * 3 + 2], i]);
      _mushOrder.sort((a, b) => a[0] - b[0]);
      const pos = S.pos.slice(0, N * 3), col = S.col.slice(0, N * 3), size = S.size.slice(0, N), alpha = S.alpha.slice(0, N);
      _mushOrder.forEach(([, i], j) => {
        for (let c = 0; c < 3; c++) { S.pos[j * 3 + c] = pos[i * 3 + c]; S.col[j * 3 + c] = col[i * 3 + c]; }
        S.size[j] = size[i]; S.alpha[j] = alpha[i];
      });
    }
    for (const sys of [_mushSmoke, _mushFire]) {
      const geo = sys.points.geometry;
      geo.setDrawRange(0, sys.n);
      for (const k of ['position', 'aColor', 'aSize', 'aAlpha']) geo.attributes[k].needsUpdate = true;
    }
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
  // splash: its blood (not for a nuke: burnt)
  function killEnemy(e,reward,splash=true){
    if(e.dead)return; e.dead=true;
    slowedEnemies.delete(e.mesh.uuid);
    if(splash) deathFx(e);
    scene.remove(e.mesh);
    SFX.play(e.type==='r'?'rdie':'zdie');
    if(e.pool&&e.mesh.visible){                       // death animation (instanced corpse)
      if(corpses.length>=80) corpses.shift();
      corpses.push({mesh:e.mesh,pool:e.pool,corpse:true,t:0,spin:Math.random()<.5?-1:1});
    }
    if(reward){
      score+=e.reward.score; kills++; waveKills++;
      minerals+=e.reward.minerals; gas+=e.reward.gas;
      updateHUD();
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
    const roachMsg = rc > 0 ? ` + ${rc} Roach${rc > 1 ? 'es' : ''}` : '';
    const boostMsg = wave === CFG.metabolic_wave ? ' — Metabolic Boost: Zerglings run faster!' : endlessWaves() ? ` — bunker reinforced ×${endlessWaves()}` : '';
    setStatus(finalWave
      ? `FINAL WAVE ${wave}: ${zc} Zerglings${roachMsg} — hold the line!`
      : `Wave ${wave}: ${zc} Zergling${zc > 1 ? 's' : ''}${roachMsg}${boostMsg}`);
    SFX.play('wave');
  }

  function waveCleared(){
    wavePhase='cleared';
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
    air:    { t:'AIRSTRIKE', k:'R', d:'A Viking bombs every enemy cluster and drops an ammo crate by the bunker — your reload once the magazine is empty.' },
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
    renderer.setPixelRatio(gfxQuality==='HIGH'?dpr:1);
    // Overlay canvas: backing store at device pixels (crisp text), drawn in logical units
    chCanvas.width=Math.round(W*dpr); chCanvas.height=Math.round(gameH*dpr);
    chCtx.setTransform(dpr,0,0,dpr,0,0);
    renderer.setSize(W,gameH);               // sets gc.width = W*dpr internally
    camera.aspect=W/gameH; camera.updateProjectionMatrix();
    // Particle sprites: pixels per world unit at depth 1 (drawing-buffer pixels)
    _partScale.value=gameH*renderer.getPixelRatio()/(2*Math.tan(camera.fov*Math.PI/360));
  }
  window.addEventListener('resize',resize); resize();

  // ── Crosshair ────────────────────────────────────────────────────────────
  // ── Enemy HP bars — 2D canvas billboard ────────────────────────────────────
  // Projects each enemy's world position to screen space and draws
  // a compact HP bar above their head. Zergling: small, Roach: wider.
  const _projV = new THREE.Vector3(); // reused projection temp
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
      worldPos.y += e.type==='r' ? 1.4 : 1.1; // above head
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

      // Background track
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(bx-1, by-1, barW+2, barH+2);

      // HP fill — green→yellow→red
      const col = pct > 0.5 ? `rgb(${Math.round(255*(1-pct)*2)},200,0)`
                             : `rgb(255,${Math.round(255*pct*2)},0)`;
      ctx.fillStyle = col;
      ctx.fillRect(bx, by, barW*pct, barH);

      // Thin border
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(bx, by, barW, barH);

      // Attribute badge: small tag above bar showing Light/Armored
      const tag = (e.attrs||[]).includes('armored') ? 'ARM'
                : (e.attrs||[]).includes('light')   ? 'LGT' : '';
      if(tag){
        ctx.font = 'bold 6px "Courier New"';
        ctx.textAlign = 'left';
        const tagCol = tag==='ARM' ? 'rgba(255,150,50,0.85)' : 'rgba(100,220,255,0.85)';
        ctx.fillStyle = tagCol;
        ctx.fillText(tag, bx + barW + 2, by + barH - 1);
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
    // Floating damage numbers
    if(floatTexts.length>0){
      chCtx.textAlign='center'; chCtx.textBaseline='middle';
      chCtx.font='15px "Share Tech Mono", Consolas, monospace';
      const W2=W/2, H2=gameH/2;
      floatTexts.forEach(f=>{
        const v=_projV.set(f.x,f.y,f.z).project(camera);
        const sx=(v.x+1)*W2, sy=(-v.y+1)*H2;
        if(sx<-20||sx>W+20||sy<-20||sy>gameH+20)return;
        const t=f.life/f.maxLife;
        chCtx.globalAlpha=Math.min(1,t*2);
        chCtx.strokeStyle='rgba(0,0,0,0.7)'; chCtx.lineWidth=3;
        chCtx.strokeText(f.txt,sx,sy);
        chCtx.fillStyle=f.color;
        chCtx.fillText(f.txt,sx,sy);
      });
      chCtx.globalAlpha=1; chCtx.textAlign='left'; chCtx.textBaseline='alphabetic';
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
      _fireLight.intensity = (0.6 + 2.2 * sev) * (0.8 + 0.2 * Math.sin(_gameT * 23) * Math.sin(_gameT * 7.3));
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
    // Ambient: day base → night 0x112233 @ 0.18
    if (_ambientLight) {
      _ambientLight.color.copy(_dnLerpCol(b.ambCol, 0x112233, f));
      _ambientLight.intensity = b.amb * (1 - f) + 0.18 * f;
    }
    // Sun: day full → night off, through a warm low sun at dusk / dawn
    if (_sunLight) {
      _sunLight.color.copy(f < 0.45 ? _dnLerpCol(0xfff4cc, 0xff9a55, f / 0.45) : _dnLerpCol(0xff9a55, 0x001122, (f - 0.45) / 0.55));
      _sunLight.intensity = b.sun * (1 - f);
    }
    // Fill: day present → night off
    if (_fillLight) {
      _fillLight.intensity = b.fill * (1 - f);
    }
    // Bunker light: off during day, warm glow at night
    if (_bunkerLight) {
      _bunkerLight.intensity = f * 5.5;
    }
    // Fog: the radius shrinks by the same ratio every second (geometric blend).
    // Blended linearly, it stayed outside the battlefield for the first 60% of
    // dusk, then closed in on the bunker all at once.
    if (scene.fog) {
      scene.fog.near  = DN_DAY_FOG_NEAR * Math.pow(DN_NIGHT_FOG_NEAR / DN_DAY_FOG_NEAR, f);
      scene.fog.far   = DN_DAY_FOG_FAR  * Math.pow(DN_NIGHT_FOG_FAR  / DN_DAY_FOG_FAR,  f);
      // Fog color: day sky green → night deep blue
      scene.fog.color.copy(_dnLerpCol(0x2a3a18, 0x050a12, f));
    }
    // Background matches fog
    if (scene.background) {
      scene.background.copy(scene.fog ? scene.fog.color : new THREE.Color(0x2a3a18));
    }
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

  // ── Main loop ────────────────────────────────────────────────────────────
  function loop(){
    requestAnimationFrame(loop);
    const dt=Math.min(clock.getDelta(),.05);
    updateCamera(dt); // also while paused: the player can look around
    placeSlotOverlay();
    if(_muzzleLight) _muzzleLight.intensity=Math.max(0,_muzzleLight.intensity-dt*45); // flash decays in ~60 ms
    if(phase!=='playing'||isPaused()){
      // Game clock, survival timer and scheduled events are frozen here
      if(phase==='playing'){ syncEnemyPools(); syncBullets(); updateParticles(_glow,0); updateParticles(_smoke,0); }
      // A night switched off still lifts behind the menu, title and results (it is
      // not game time: with the cycle off nothing else moves). Left frozen, the
      // title showed the night and the next game started in it.
      if(!dnEnabled&&_dnFactor>0) updateDayNight(dt);
      drawCH();tickPortrait(dt);renderer.render(scene,camera);return;
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
      if(b.isShock){
        // Shockwave ring expands outward (scale, not geometry rebuild)
        const prog = 1-(b.life/b.startLife);
        b.mesh.scale.setScalar(Math.max(0.2, prog*18));
        b.mesh.material.opacity = Math.max(0,(b.life/b.startLife)*0.7);
      } else {
        b.mesh.material.opacity=Math.max(0,b.life/.5*.8);
      }
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
        if(c.dead)continue;
        const ex=c.mesh.position.x-px, ez=c.mesh.position.z-pz;
        const t=Math.max(0,Math.min(1,(ex*sx+ez*sz)/sLen2)); // closest point on the segment
        const dx=ex-sx*t, dz=ez-sz*t, hitR=c.type==='r'?.75:.5;
        if(dx*dx+dz*dz<hitR*hitR&&t<tBest){ tBest=t; e=c; }  // keep the first one along the path
      }
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
          if(floatTexts.length>=60) floatTexts.shift(); // cap: late waves produce ~60 numbers/s, each two text draws
          floatTexts.push({x:e.mesh.position.x,y:e.mesh.position.y+1.2,z:e.mesh.position.z,
            txt:Math.round(actualDmg).toString(),life:900,maxLife:900,
            color:bonus>1?'#ff6600':'#ffffff'});
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
    updateDayNight(dt);
    syncMushrooms(dt);
    tutorialTick();
    // Update floating damage numbers
    floatTexts.forEach(f=>{ f.life-=dt*1000; f.y+=dt*0.8; });
    floatTexts=floatTexts.filter(f=>f.life>0);
    syncEnemyPools();
    drawCH();
    tickPortrait(dt);
    renderer.render(scene,camera);
  }

  // ── Start / game over ─────────────────────────────────────────────────────
  function clearEntities(){
    clearScheduler();        // drop pending wave countdown / Viking / missile launches / nuke (runs their cleanup)
    removeViking();
    vMissiles=[]; mBlasts=[]; syncBlasts(0); GLOW_LIGHTS.glowCount.value=0;
    mushrooms=[]; syncMushrooms(0);
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
    air:    'When the magazine is empty: a Viking bombs every Zerg group and drops an ammo crate by the bunker.',
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
      text:'Call an airstrike: press <kbd>R</kbd> or click STRIKE. A Viking bombs every Zerg group and drops an ammo crate by the bunker — that crate is also this wave\'s resupply.' },
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
    Object.assign(box.style, { left: x + 'px', bottom: (g.bottom - t + 14) + 'px', transform: 'none' });
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
  function _showCard(html){ const c=$('ov-card'); if(c) c.innerHTML=html; $('overlay').style.display='flex'; }
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
    Music.play('battle');
    clearEntities();
    newGameState();
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
    if (type === 'ghost') snipeReady.push(0); // new ghost (last in roster order) may snipe at once
    if (type === 'marauder') marauderReady.push(0);   // ... and a new Marauder fire
    syncMarines(); updateHUD();
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
      desc: '📋 Lists all cheat codes in console (F12)',
      fn: () => {
        console.group('%c DOTD Cheat Codes', 'color:#44ff88;font-weight:bold;font-size:14px');
        Object.entries(CHEATS).forEach(([code,{desc}])=>{
          console.log(`%c ${code.padEnd(12)} %c ${desc}`,
            'color:#fa4;font-weight:bold','color:#aaa');
        });
        console.groupEnd();
        setStatus('Cheat list printed to F12 console!');
      }
    },
  };

  function openCheat() {
    if(phase!=='playing') return;
    _cheatOpen = true; // pauses gameplay
    document.getElementById('cheat-wrap').style.display='block';
    document.getElementById('cheat-backdrop').style.display='block';
    document.getElementById('cheat-input').value='';
    document.getElementById('cheat-msg').textContent='';
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
    if(entry) {
      entry.fn();
      const msgEl = document.getElementById('cheat-msg');
      msgEl.style.color='#44ff88';
      msgEl.textContent = entry.desc;
      setTimeout(closeCheat, 1400);
    } else {
      const msgEl = document.getElementById('cheat-msg');
      msgEl.style.color='#f44';
      msgEl.textContent = key ? `Unknown: "${key}" — try 'help' (check F12)` : 'Enter a code!';
      document.getElementById('cheat-input').select();
    }
  }

  // ── Graphics quality ────────────────────────────────────────────────────────
  function applyGfx(q) {
    if (q === gfxQuality && renderer.shadowMap.enabled === (q === 'HIGH')) { _syncGfxUI(); return; }
    gfxQuality = q;
    const hi = q === 'HIGH';
    renderer.shadowMap.enabled = hi;
    resize(); // applies the quality's pixel ratio and keeps _logW/_logH accurate

    if (_sunLight) _sunLight.castShadow = hi;
    _applyDNLights(_dnLitF); // light levels for this quality, blended with day/night (and a flare)

    if (hi && _sunLight && _sunLight.shadow.map) { _sunLight.shadow.map.dispose(); _sunLight.shadow.map = null; }
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
    if (desc) desc.textContent = hi ? 'Shadows • soft shadow maps • hi-res rendering' : 'No shadows • fast rendering • battery-friendly';
  }

  function toggleGfx() { applyGfx(gfxQuality === 'HIGH' ? 'LOW' : 'HIGH'); }
  function setGfx(q)   { applyGfx(q); }

  // ── Menu ────────────────────────────────────────────────────────────────────
  // (_menuOpen is declared with the game state — opening the menu pauses gameplay)
  // Tabs: the last one chosen opens again (GAME first)
  const MENU_TABS = ['game', 'settings', 'controls', 'tutorial', 'cheats'];
  let _menuTab = 'game';
  function menuTab(t) {
    if (!MENU_TABS.includes(t)) return;
    _menuTab = t;
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
          showHowTo, tutDismiss, tutNext, tutBack, tutSkip, startTour, setTutorial, replayTutorial, menuTab};
})();
