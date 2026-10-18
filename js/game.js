// ─── GAME ────────────────────────────────────────────────────────────────────
const G = (() => {
  // Three.js
  const canvas = document.getElementById('gc');
  const chCanvas = document.getElementById('crosshair-canvas');
  const chCtx = chCanvas.getContext('2d');
  let W, H;
  let _logW = 0, _logH = 0; // logical (CSS) canvas dimensions — never multiplied by devicePixelRatio

  let gfxQuality = 'HIGH'; // 'LOW' | 'HIGH'
  let _ambientLight, _sunLight, _fillLight, _bunkerLight, _fireLight, _muzzleLight;

  // ── Day/Night cycle (experimental) ──────────────────────────────────────
  let dnEnabled = false;     // opt-in toggle
  let _dnTime   = 0;         // seconds into current cycle (0..DN_CYCLE)
  let _dnFactor = 0;         // 0=full day, 1=full night (smooth blend)
  const DN_CYCLE   = 180;    // full cycle length in seconds (3 min)
  const DN_DAY     = 0.55;   // fraction of cycle that is day
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
    };
    const MIN_GAP = { hit: .045, bite: .22, spit: .07, acid: .06, marine: .03, marauder: .05, ghost: .05, shrike: .05, zdie: .035, rdie: .06, boom: .07 };
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
      setVolume(v) { volume = Math.max(0, Math.min(1, v)); if (volume > 0) muted = false; apply(); save(); },
      setMuted(m) { muted = !!m; apply(); save(); },
      get muted() { return muted; },
      get volume() { return volume; },
    };
  })();
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
  const UPGRADE_DEF = {
    superstim:  { cost:[250,150], unit:'marine',   name:'Super Stimpack', icon:UI_ICONS.superstim,
                  desc:"Nova's Marines: Stimpack costs no HP and repairs the bunker while it lasts (stacks with the hull's self-repair)",
                  tiers:[] },
    concussive: { cost:[300,75],  unit:'marauder', name:'Concussive Shell', icon:UI_ICONS.concussive,
                  desc:'Marauder hits slow the target to 40% speed for 2.5s — single target',
                  tiers:[
                    { cost:[250, 80],  desc:'AOE Lv.1 — slow blast radius 1.5' },
                    { cost:[400,130],  desc:'AOE Lv.2 — radius 2.2' },
                    { cost:[600,200],  desc:'AOE Lv.3 — radius 3.0 (MAX)' },
                  ]},
    snipe:      { cost:[250,100], unit:'ghost',    name:'Snipe', icon:UI_ICONS.snipe,
                  desc:'Ghost auto-snipes highest-threat enemy (8s CD)',
                  tiers:[
                    { cost:[200, 80],  desc:'Snipe Lv.1 — CD 8s → 6s' },
                    { cost:[320,130],  desc:'Snipe Lv.2 — CD 6s → 4s' },
                    { cost:[500,200],  desc:'Snipe Lv.3 — CD 4s → 2.5s (MAX)' },
                  ]},
  };
  // Snipe CD per level (ms): base + 3 tiers
  const SNIPE_CD   = [8000, 6000, 4000, 2500];
  // Concussive AOE radius per level (units): 0 = single target
  const CONC_RADIUS = [0, 1.5, 2.2, 3.0];

  let roster = ['marine','marine'];   // start with 2 marines (2 slots used)
  let snipeReady = [];                // per ghost, in roster order: _gameT when it may snipe again
  let concussiveUnlocked = false;
  let superStimUnlocked = false;   // Super Stimpack research (Marines)
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
  let slowedEnemies = new Map();      // enemy mesh uuid → {until (_gameT), factor}
  let rosterHover = false;
  let bunkerHoverTimer = 0;
  let rosterPaused = false;  // game pauses while roster is open
  let _menuOpen = false;     // game pauses while menu is open
  let _cheatOpen = false;    // game pauses while cheat console is open
  function isPaused(){ return rosterPaused||_menuOpen||_cheatOpen; }
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
    ModelLoader.load('shrike').then(_mountShrike)
      .catch(err => console.warn('Shrike turret model failed to load — the HP Lv3 turret still fires, but is not drawn.', err));
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
      if (e.dead || !e.mesh.visible) continue;
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

  // Stimpack (T): a full Marine squad (6/6) can stim, as in SC2 — for 11 s the
  // Marines fire 50% faster (an extra round every other volley, no extra ammo),
  // at the SC2 price of 10 HP per Marine, paid by the bunker.
  const STIM_COLOR = 0xff6a3a;
  let stimT = 0, _stimVolley = 0;
  function stimUnlocked() { return roster.length === 6 && roster.every(u => u === 'marine'); }
  function stimCost() { return superStimUnlocked ? 0 : CFG.stim_hp * roster.length; }   // Super Stimpack: free
  function doStim() {
    if (phase !== 'playing' || isPaused()) return;
    if (wavePhase !== 'combat') { setStatus('Stimpack only during a wave'); SFX.play('deny'); return; }
    if (!stimUnlocked()) { setStatus('Stimpack needs a full Marine squad (6/6)'); SFX.play('deny'); return; }
    if (stimT > 0) { setStatus('Already stimmed!'); return; }
    const cost = stimCost();
    if (cost && bunkerHp <= cost) { setStatus('Not enough HP to stim'); SFX.play('deny'); return; }
    bunkerHp -= cost; stimT = CFG.stim_duration; _stimVolley = 0;
    setStatus(superStimUnlocked
      ? `Super Stimpack! Marines fire 50% faster, bunker repair +${Math.round(repairRate())} HP/s for ${CFG.stim_duration} s`
      : `Stimpack! Marines fire 50% faster for ${CFG.stim_duration} s (−${cost} HP)`);
    SFX.play('stim');
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
      blt.len = 1.8;                              // longer streaks: the V reads clearly
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
  function setUnitModel(m, type, idx) {
    if (m.type === type && !(m.fallback && ModelLoader.isReady(type))) return;
    m.mesh.clear();
    const frames = ModelLoader.animFrames(type, 'walk');
    const model = frames ? frames[0].clone() : ModelLoader.clone(type) || ModelLoader.clone('marine', () => _proceduralMarine(idx));
    if (model) m.mesh.add(model);
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
    new THREE.MeshBasicMaterial({ color: 0xffffff }), BULLET_CAP);
  _bulletIM.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  _bulletIM.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(BULLET_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
  _bulletIM.frustumCulled = false; // instances spread far from the mesh origin
  _bulletIM.count = 0;
  scene.add(_bulletIM);
  const _tmpCol = new THREE.Color();
  // R = Ry(yaw)·Rx(pitch) + translation, column-major (local +Z → flight direction);
  // L stretches the round along its flight axis
  function _writeBulletMatrix(m, o, b, L) {
    const sy = b.sin, cy = b.cos, sp = b.sinP, cp = b.cosP, p = b.mesh.position;
    m[o] = cy;        m[o+1] = 0;     m[o+2] = -sy;      m[o+3] = 0;
    m[o+4] = sy*sp;   m[o+5] = cp;    m[o+6] = cy*sp;    m[o+7] = 0;
    m[o+8] = sy*cp*L; m[o+9] = -sp*L; m[o+10] = cy*cp*L; m[o+11] = 0;
    m[o+12] = p.x;    m[o+13] = p.y;  m[o+14] = p.z;     m[o+15] = 1;
  }
  // Marauder rounds are SC2 punisher grenades (MarauderMissile.m3: body +
  // fireball, modelled nose along +Z like the tracers). Its texture was not
  // extracted, so the body gets plain gunmetal and the fireball an additive glow.
  const MISSILE_CAP = 128;
  let _missileIMs = null;
  function _missileParts() {
    if (_missileIMs || !ModelLoader.isReady('marauderMissile')) return _missileIMs;
    const body = new THREE.MeshStandardMaterial({ color: 0x6b7078, metalness: .6, roughness: .35, emissive: 0x301000 });
    const glow = new THREE.MeshBasicMaterial({ color: 0xff9a3a, transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false });
    const t = ModelLoader.clone('marauderMissile');
    t.position.set(0, 0, 0);                      // centred on the round, not stood on the ground
    t.traverse(ch => { if (ch.isMesh) ch.material = ch.name === 'region_1' ? glow : body; });
    _missileIMs = bakeTemplate(t).map(p => {
      const im = new THREE.InstancedMesh(p.geo, p.mat, MISSILE_CAP);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false; im.castShadow = p.mat === body; im.count = 0;
      scene.add(im);
      return im;
    });
    return _missileIMs;
  }
  function syncBullets() {
    const m = _bulletIM.instanceMatrix.array, c = _bulletIM.instanceColor.array;
    const mis = _missileParts();
    let n = 0, nm = 0;
    for (const b of bullets) {
      if (!b.alive) continue;
      if (mis && b.unitType === 'marauder') {
        if (nm < MISSILE_CAP) for (const im of mis) _writeBulletMatrix(im.instanceMatrix.array, nm * 16, b, 1);
        nm++;
        continue;
      }
      if (n >= BULLET_CAP) continue;
      _writeBulletMatrix(m, n * 16, b, b.len || 1);
      _tmpCol.setHex(b.color); _tmpCol.toArray(c, n * 3);
      n++;
    }
    _bulletIM.count = n;
    _bulletIM.instanceMatrix.needsUpdate = true;
    _bulletIM.instanceColor.needsUpdate = true;
    if (mis) for (const im of mis) { im.count = Math.min(nm, MISSILE_CAP); im.instanceMatrix.needsUpdate = true; }
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
    varying float vAlpha; varying vec3 vColor; varying float vFogD;
    void main() {
      vAlpha = aAlpha; vColor = aColor;
      vFogD = length( ( modelMatrix * vec4( position, 1.0 ) ).xz );   // radial, like the scene fog
      vec4 mv = modelViewMatrix * vec4( position, 1.0 );
      gl_PointSize = aSize * uScale / -mv.z;
      gl_Position = projectionMatrix * mv;
    }`;
  const PARTICLE_FS = `
    varying float vAlpha; varying vec3 vColor; varying float vFogD;
    #ifdef USE_FOG
      uniform float fogNear; uniform float fogFar;
    #endif
    void main() {
      float d = length( gl_PointCoord - 0.5 ) * 2.0;
      float a = vAlpha * ( 1.0 - smoothstep( 0.15, 1.0, d ) ); // soft round sprite
      #ifdef USE_FOG
        a *= 1.0 - smoothstep( fogNear, fogFar, vFogD );      // fade out in the night fog
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

  const _bombGeo = new THREE.SphereGeometry(0.18, 6, 5);
  const _bombMat = new THREE.MeshBasicMaterial({color: 0xff6600});
  function dropBomb(wx, wz) {
    // Bomb visual — falls from Viking altitude to the ground, then strikes
    const bomb = new THREE.Mesh(_bombGeo, _bombMat);
    bomb.position.set(wx, 5, wz);
    scene.add(bomb);
    let life = 0.35;
    addTicker(dt => {
      life -= dt;
      bomb.position.y = Math.max(0.2, bomb.position.y - 37.5 * dt);
      if (life > 0) return true;
      strikeAt(wx, wz, 0xff8800, 4.5); // impact
      return false;
    }, () => scene.remove(bomb));
  }

  // bombTargets: [{x, z, e}] — e = lead enemy of the cluster (may be undefined)
  function launchViking(bombTargets, cratePos) {
    if (vikingActive) return;
    vikingActive = true;

    vikingMesh = makeVikingMesh();
    // Start far left at mid-Z, high altitude, facing the direction of travel (+X)
    vikingMesh.position.set(-22, 5, 0);
    vikingMesh.rotation.y = Math.PI / 2;
    scene.add(vikingMesh);

    // Viking travels x=-22 → +22 at 14 units/s (~3.1 s). Each bomb drops as it
    // passes the target's x and re-aims at the lead enemy's CURRENT position —
    // enemies keep moving during the run, so launch-time positions missed.
    const SPEED = 14, TOTAL_X = 44, START_X = -22;
    bombTargets.forEach(tgt => {
      after(Math.max(0.2, (tgt.x - START_X) / SPEED), () => {
        const live = tgt.e && !tgt.e.dead;
        dropBomb(live ? tgt.e.mesh.position.x : tgt.x, live ? tgt.e.mesh.position.z : tgt.z);
      });
    });

    // Drop crate near the bunker as the Viking exits (~2.7 s in)
    after((22 - START_X) / SPEED * 0.85, () => {
      makeCrate(cratePos[0], cratePos[1]);
      setStatus('Crate deployed! Marine incoming...');
      sendMarine(cratePos[0], cratePos[1], () => {
        ammo = maxAmmo; updateHUD(); SFX.play('crate');
        setStatus('Ammo restocked! Good hunting, Commander.');
      });
    });

    // Cleanup after the Viking leaves the screen
    after(TOTAL_X / SPEED + 0.4, removeViking);
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
  function sendMarine(tx,tz,cb){
    // Only one unit leaves the bunker: a crate dropped while one is already out
    // (airstrike + end-of-wave resupply) joins its trip, both resupplies apply on its return
    const out=marines.find(m=>m.state==='running');
    if(out){
      out.queue.push({x:tx,z:tz});
      const prev=out.cb; out.cb=()=>{prev?.();cb?.();};
      if(out.target.phase==='return') out.target={...out.queue.shift(),phase:'goto'};
      return;
    }
    // A Marine fetches the crate when one is free, else any idle unit
    const free=i=>marines[i]?.state==='bunker';
    let i=roster.findIndex((u,k)=>u==='marine'&&free(k));
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

    // Build bomb target list — one per enemy cluster (group nearby enemies together)
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

    // ── Phase 2: Laser designator beam (thin red line, 2s) ──────────────
    const laserGeo = new THREE.CylinderGeometry(0.04, 0.04, 28, 5);
    const laserMat = new THREE.MeshBasicMaterial({color:0xff0000, transparent:true, opacity:0.85});
    const laser = new THREE.Mesh(laserGeo, laserMat);
    laser.position.set(tx, 14, tz);
    scene.add(laser);

    // Blinking target marker on the ground: the SC2 nuke reticle (red on black,
    // drawn additively), or a plain red ring until that texture has loaded
    const dotGeo = _nukeTargetTex ? new THREE.PlaneGeometry(2.6, 2.6) : new THREE.RingGeometry(0.3, 0.6, 16);
    const dotMat = _nukeTargetTex
      ? new THREE.MeshBasicMaterial({map:_nukeTargetTex, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false})
      : new THREE.MeshBasicMaterial({color:0xff0000, side:THREE.DoubleSide, transparent:true});
    const dot = new THREE.Mesh(dotGeo, dotMat);
    dot.rotation.x = -Math.PI/2;
    dot.position.set(tx, 0.05, tz);
    scene.add(dot);

    // The warhead itself falls down the laser, nose first (SC2 model, if loaded)
    const NUKE_DROP_H = 9;                        // stays well below the overview camera (y 22)
    const missile = ModelLoader.clone('nukeMissile');
    const missileHalf = missile ? missile.position.y : 0;  // the template floats by half its height
    if (missile) {
      missile.rotation.x = Math.PI;               // modelled nose up; flips about its centre
      missile.position.set(tx, missileHalf + NUKE_DROP_H, tz);
      scene.add(missile);
    }

    // Expanding warning ring — unit ring, animated via scale (no geometry churn)
    const warnMat = new THREE.MeshBasicMaterial({color:0xff2200, side:THREE.DoubleSide, transparent:true, opacity:0.6});
    const warnRing = new THREE.Mesh(_ringGeo, warnMat);
    warnRing.scale.setScalar(0.1);
    warnRing.rotation.x = -Math.PI/2;
    warnRing.position.set(tx, 0.06, tz);
    scene.add(warnRing);

    // Animate warning ring expanding and dot blinking (game time — freezes on pause)
    let warnT = 0;
    const WARN_DUR = 2.0; // seconds
    const NUKE_RADIUS = 16; // kills everything within this range
    addTicker(dt => {
      warnT += dt;
      const prog = Math.min(1, warnT / WARN_DUR);
      // Ring expands to show blast radius
      warnRing.scale.setScalar(Math.max(0.1, prog * NUKE_RADIUS));
      warnRing.material.opacity = 0.4 + Math.sin(warnT*12)*0.3; // pulse
      // Dot blinks faster as impact nears
      dot.material.opacity = Math.sin(warnT*(6+prog*14)) > 0 ? 0.9 : 0.1;
      laser.material.opacity = 0.5 + Math.sin(warnT*8)*0.35;
      if (missile) {                              // accelerating drop, lands at detonation
        missile.position.y = missileHalf + NUKE_DROP_H * (1 - prog * prog);
        missile.rotation.y += dt * 4;
        spawnParts({x: tx, y: missile.position.y + missileHalf, z: tz}, 0xffaa55, 1);   // exhaust at the tail
      }
      if (warnT < WARN_DUR) return true;
      detonate();
      return false;
    }, () => {
      // Remove designator visuals (warnRing uses shared _ringGeo — don't dispose it).
      // Also runs when Restart/Load drops the launch mid-countdown.
      scene.remove(laser); scene.remove(dot); scene.remove(warnRing);
      if (missile) scene.remove(missile);         // shares the template's geometry — no dispose
      laser.geometry.dispose(); dot.geometry.dispose();
      laser.material.dispose(); dot.material.dispose(); warnRing.material.dispose();
      _nukeInFlight = false;
    });

    // ── Phase 3: DETONATION (2.0s) ──────────────────────────────────────
    function detonate() {
      SFX.play('nukeBoom');
      // Shockwave ring — expands outward rapidly (scale-animated unit ring)
      const shockMat = new THREE.MeshBasicMaterial({color:0xff6600, side:THREE.DoubleSide, transparent:true, opacity:0.9});
      const shock = new THREE.Mesh(_ringGeo, shockMat);
      shock.scale.setScalar(0.2);
      shock.rotation.x = -Math.PI/2;
      shock.position.set(tx, 0.1, tz);
      scene.add(shock);
      beams.push({mesh: shock, life: 1.2, isShock: true, tx, tz, startLife: 1.2});

      // Main explosion column — tall, fat, bright
      const expGeo = new THREE.CylinderGeometry(0.1, 3.5, 18, 10);
      const expMat = new THREE.MeshBasicMaterial({color:0xff4400, transparent:true, opacity:0.92});
      const exp = new THREE.Mesh(expGeo, expMat);
      exp.position.set(tx, 9, tz);
      scene.add(exp);
      beams.push({mesh: exp, life: 0.9});

      // Secondary fireball
      const fbGeo = new THREE.SphereGeometry(4, 12, 8);
      const fbMat = new THREE.MeshBasicMaterial({color:0xff8800, transparent:true, opacity:0.85});
      const fb = new THREE.Mesh(fbGeo, fbMat);
      fb.position.set(tx, 1.5, tz);
      scene.add(fb);
      beams.push({mesh: fb, life: 0.7});

      // Screen flash — strong white then orange
      flash('nuke-flash');

      // Massive particle burst
      spawnParts(new THREE.Vector3(tx, 0.5, tz), 0xff6600, 50);
      spawnParts(new THREE.Vector3(tx, 3,   tz), 0xff4400, 30);
      spawnParts(new THREE.Vector3(tx, 0.5, tz), 0xffaa00, 25);

      // Kill ALL enemies in radius — bunker excluded (hardened)
      let killed = 0;
      allEnemies().forEach(e => {
        if(e.dead) return;
        const dx=e.mesh.position.x-tx, dz=e.mesh.position.z-tz;
        if(Math.sqrt(dx*dx+dz*dz) <= NUKE_RADIUS){
          killEnemy(e, true);
          killed++;
        }
      });

      setStatus(`Nuclear detonation — ${killed} unit${killed!==1?'s':''} annihilated. Bunker intact.`);
    }
  }

  // ── Kill / upgrade ────────────────────────────────────────────────────────
  function killEnemy(e,reward){
    if(e.dead)return; e.dead=true;
    slowedEnemies.delete(e.mesh.uuid);
    spawnParts(e.mesh.position.clone(),e.type==='r'?0xff6600:0x22cc44,e.type==='r'?12:7);
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
    spawnTimer = 0; wavePhase = 'combat'; waveKills = 0; waveNukes = 0; waveAirs = 0;
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
      const[tx,tz]=randPos();
      makeBeam(tx,tz,0xff8800);
      spawnParts(new THREE.Vector3(tx,.5,tz),0xff8800,14);
      makeCrate(tx,tz);
      sendMarine(tx,tz,()=>{
        ammo=maxAmmo; updateHUD(); SFX.play('crate');
        // Countdown: 3... 2... 1...
        setStatus('Next wave in 3...');
        after(1, ()=>setStatus('Next wave in 2...'));
        after(2, ()=>setStatus('Next wave in 1...'));
        after(3, ()=>{
          wave++;
          reinforce();                                  // Endless: the bunker is reinforced as the swarm grows
          setStatus(`Wave ${wave} — incoming!`);
          startWave();
        });
      });
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
    const [m,g]=ARMORY_DEF[key].cost, k=CFG.armory_growth**armory[key];
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
             alive:true,dist:0,speed:def.bulletSpeed,unitType}; // mesh = position holder; drawn by syncBullets()
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

  function shoot(tx,tz){
    if(shootCD>0||wavePhase!=='combat'||ammo<=0)return;
    ammo--; shootCD=.1;
    const n=roster.length||1;
    const stimExtra=stimT>0&&_stimVolley++%2===0;      // stimmed: +1 round every other volley (+50%)
    roster.forEach((utype,i)=>{
      let atx=tx, atz=tz;
      // Marauder bonus vs Armored — auto-aim toward nearest Armored enemy
      if(utype==='marauder'){
        const armoredTarget = allEnemies()
          .filter(e=>!e.dead && e.attrs && e.attrs.includes('armored'))
          .reduce((best,e)=>{
            const d=e.mesh.position.length();
            return (!best||d<best.dist)?{e,dist:d}:best;
          }, null)?.e;
        if(armoredTarget){
          atx=armoredTarget.mesh.position.x;
          atz=armoredTarget.mesh.position.z;
        }
      }
      // Each unit fires through its own slit on the wall facing its target
      // (slits fan out ~11° apart); the round leaves from the slit toward the aim point.
      const p=bunkerPort(Math.atan2(atz,atx)+(i-(n-1)/2)*0.2);
      const blt=makeBulletTyped(atx,atz,(i-(n-1)/2)*.006,utype,p.x,p.y,p.z);
      bullets.push(blt);
      if(utype==='marine'&&stimT>0){
        blt.color=STIM_COLOR;
        if(stimExtra){ const b2=makeBulletTyped(atx,atz,(i-(n-1)/2)*.006+.02,utype,p.x,p.y+.05,p.z); b2.color=STIM_COLOR; bullets.push(b2); }
      }
      muzzleFlash(p.x,p.y,p.z,blt.vx/blt.speed,blt.vz/blt.speed,UNIT_DEF[utype].bulletColor,utype==='marauder');
    });
    new Set(roster).forEach(u=>SFX.play(u));            // one gunshot voice per unit type
    updateHUD();
    if(ammo===0) setStatus('Out of ammo — R: Airstrike  N: Nuke');
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
  canvas.addEventListener('click',e=>{
    if(phase!=='playing'||isPaused())return;
    // Ghost snipe check first (click on enemy)
    if(snipeUnlocked && trySnipe(e.clientX, e.clientY)) return;
    const pt=groundPt(e.clientX,e.clientY); if(!pt)return;
    if(ammo>0) shoot(pt.x,pt.z);
    else setStatus('No ammo — R: Airstrike  N: Nuke');
  });
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
      return;
    }
    // Title / game-over screen: only the menu (for Load and settings)
    if(phase!=='playing'){
      if(e.key==='m'||e.key==='M') openMenu();
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
      { id:'upg-superstim', lvl:3,         show:superStimUnlocked },   // single research: shown as maxed
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
      cd:stimOn?stimT/CFG.stim_duration:!stimUnlocked()?1:0, cdText:stimOn?Math.ceil(stimT):!stimUnlocked()?'6M':''});
    $('cmd-stim')?.classList.toggle('stim-on',stimOn);
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
    stim:   { t:'STIMPACK', k:'T', d:'Unlocked by a full Marine squad (6/6). For 11 s the Marines fire 50% faster (an extra round every other volley, no extra ammo). Costs 10 HP per Marine, paid by the bunker — free and repairing with the Super Stimpack research.' },
    nuke:   { t:'NUKE', k:'N', d:'Tactical nuke on the centre of the swarm after a 2-second warning. Wipes out everything in a huge radius.' },
    roster: { t:'BUNKER ROSTER', k:'B', d:'Hire Marines, Marauders and Ghosts (6 slots) and research their upgrades. In Endless its armory sells more HP, damage, ammo and shorter strike / nuke cooldowns. The game pauses while it is open.' },
    view:   { t:'RESET VIEW', k:'HOME', d:'Back to the overview. Mouse wheel or + / − zooms in on the bunker; Insert / Delete rotate the view 90°.' },
    menu:   { t:'MENU', k:'M', d:'Graphics, sound, save / load, controls, main menu.' },
    dmg:    { t:'WEAPON DAMAGE', k:'1', d:'Every round from every unit hits harder.',
              fx: l => `Damage ×${(1+l*.6).toFixed(1)}${l<3?` → ×${(1+(l+1)*.6).toFixed(1)}`:''}` },   // before Endless reinforcements
    armor:  { t:'BUNKER ARMOR', k:'2', d:'Reduces the damage Zerg deal to the bunker (bites and acid).',
              fx: l => `Damage taken ×${(1/(1+l*.35)).toFixed(2)}${l<3?` → ×${(1/(1+(l+1)*.35)).toFixed(2)}`:''}` },
    hp:     { t:'BUNKER HULL', k:'3', d:'+250 max HP per level. Lv2 adds the Neosteel frame; Lv3 mounts the Shrike auto-turret (= 2 marines, no ammo) and self-repair (25 HP/s, stacks with the Super Stimpack). Six Marines inside overdrive the turret: ×2.5 rate of fire.',
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
      if(!stimUnlocked()) warn='Needs 6 Marines in the bunker ('+roster.filter(u=>u==='marine').length+'/6)';
      else if(stimT>0) warn='Stimmed — '+Math.ceil(stimT)+' s left';
      else if(stimCost()&&bunkerHp<=stimCost()) warn='Not enough HP ('+stimCost()+' needed)';
      else if(superStimUnlocked&&wavePhase==='combat') { warn='READY — Super Stimpack: no HP cost, repairs the bunker'+(hpLvl>=3?' (stacks with self-repair)':''); ok=true; }
      else if(wavePhase!=='combat') warn='Only during a wave';
      else { warn='READY'; ok=true; }
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
    const fogRange = (dnEnabled && _dnFactor > 0.1) ? scene.fog.far : Infinity;

    allEnemies().forEach(e => {
      if(e.dead) return;
      // Cull if enemy is beyond night fog range
      if (fogRange < Infinity) {
        const ex = e.mesh.position.x, ez = e.mesh.position.z;
        if (Math.sqrt(ex*ex + ez*ez) > fogRange) return;
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
  }

  function drawCH(){
    const gameH=_logH;
    chCtx.clearRect(0,0,_logW,gameH);
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
  function updateDayNight(dt) {
    if (!dnEnabled) {
      // Ensure lights are at full day state when disabled
      if (_dnFactor !== 0) {
        _dnFactor = 0;
        _applyDNLights(0);
      }
      return;
    }
    _dnTime = (_dnTime + dt) % DN_CYCLE;
    // Build smooth factor: 0=day, 1=night
    // Cycle shape: day (0..DN_DAY*cycle) → dusk → night → dawn → day
    const t = _dnTime / DN_CYCLE;                        // 0..1
    const dayFrac = DN_DAY;
    let raw;
    if (t < dayFrac) {
      // Full day — last 8% fade to dusk
      const fade = Math.max(0, (t - (dayFrac - 0.08)) / 0.08);
      raw = Math.max(0, fade);
    } else {
      // Past day: night approaches, peaks at midpoint of night, fades back
      const nightT = (t - dayFrac) / (1 - dayFrac); // 0..1 through night+dawn
      // Smooth tent: rises to 1 at nightT=0.5, back to 0 at nightT=1
      raw = Math.sin(nightT * Math.PI);
    }
    // Apply smoothstep to soften edges
    _dnFactor = raw * raw * (3 - 2 * raw);
    _applyDNLights(_dnFactor);
    _updateDNIndicator();
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
    // Sun: day full → night off
    if (_sunLight) {
      _sunLight.color.copy(_dnLerpCol(0xfff4cc, 0x001122, f));
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
    // Fog
    if (scene.fog) {
      scene.fog.near  = DN_DAY_FOG_NEAR  + f * (DN_NIGHT_FOG_NEAR - DN_DAY_FOG_NEAR);
      scene.fog.far   = DN_DAY_FOG_FAR   + f * (DN_NIGHT_FOG_FAR  - DN_DAY_FOG_FAR);
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
    if (!dnEnabled) { el.textContent = ''; return; }
    const icon  = _dnFactor > 0.5 ? '☽' : '☀';
    const label = _dnFactor > 0.75 ? 'NIGHT' : _dnFactor > 0.25 ? 'DUSK' : 'DAY';
    el.textContent = icon + ' ' + label;
    el.style.color = _dnFactor > 0.5 ? '#8899ff' : '#ffcc44';
  }

  function toggleDayNight() {
    dnEnabled = !dnEnabled;
    if (!dnEnabled) {
      // Reset to full day
      _dnTime = 0; _dnFactor = 0;
      _applyDNLights(0);
      if (scene.fog) { scene.fog.near = DN_DAY_FOG_NEAR; scene.fog.far = DN_DAY_FOG_FAR; scene.fog.color.set(0x2a3a18); }
      if (scene.background) scene.background.set(0x2a3a18);
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
      drawCH();tickPortrait(dt);renderer.render(scene,camera);return;
    }
    _gameT+=dt;

    // Throttled HUD refresh (~7Hz). The HUD used to be rebuilt every frame
    // from inside the enemy-damage loop — by far the biggest CPU cost.
    _hudTick-=dt;
    if(_hudTick<=0){_hudTick=0.15;updateHUD();}
    _dmgFlashCD=Math.max(0,_dmgFlashCD-dt);

    shootCD=Math.max(0,shootCD-dt);
    airCD=Math.max(0,airCD-dt);
    if(stimT>0){
      stimT=Math.max(0,stimT-dt);
      if(superStimUnlocked){                            // Super Stimpack: the squad patches the bunker up (repairRate)
        if(Math.random()<dt*14){ const a=Math.random()*6.28, r=1.1+Math.random()*.4;
          emitParticle(_glow,Math.cos(a)*r,.3+Math.random()*.6,Math.sin(a)*r,0,1.4,0,.7,.22,.05,.9,0x6aff8a,0x1a9a3a,0,0,0); }
      }
    }
    if(nukeCD>0) nukeCD=Math.max(0,nukeCD-dt);

    // Scheduled game events (wave countdown, Viking, bombs, nuke)
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
    const _nightFogFar = (dnEnabled && _dnFactor > 0.1) ? scene.fog.far : Infinity;
    allEnemies().forEach(e=>{
      if(e.dead)return;
      e.leg+=dt*(e.type==='r'?5:9);
      if(e.flash>0) e.flash-=dt;
      const ex=e.mesh.position.x,ez=e.mesh.position.z;
      const d=Math.sqrt(ex*ex+ez*ez);
      // Hide enemy mesh when beyond night fog range
      if (_nightFogFar < Infinity) {
        e.mesh.visible = d < _nightFogFar * 1.05; // slight buffer so pop-in is smooth
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
      if(b.unitType==='marauder'&&_missileIMs){        // punisher grenade: fire trail from its tail
        const p=b.mesh.position, k=.35/(Math.hypot(b.vx,b.vy,b.vz)||1);
        emitParticle(_glow,p.x-b.vx*k,p.y-b.vy*k,p.z-b.vz*k,(Math.random()-.5)*.4,Math.random()*.3,(Math.random()-.5)*.4,.16,.28,.08,.95,0xffa040,0xc02000,0,1,0);
        emitParticle(_smoke,p.x-b.vx*k*1.5,p.y-b.vy*k*1.5,p.z-b.vz*k*1.5,(Math.random()-.5)*.3,.35,(Math.random()-.5)*.3,.55,.16,.5,.5,0x9a9488,0x55524c,-.1,.6,1);
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
          // Concussive shell slow (marauder upgrade)
          if(b.unitType==='marauder'&&concussiveUnlocked){
            const slowUntil = _gameT+2.5;
            slowedEnemies.set(e.mesh.uuid,{until:slowUntil,factor:0.4});
            // AOE slow if concussiveLvl >= 1
            const aoeR = CONC_RADIUS[concussiveLvl];
            if(aoeR > 0){
              _enemyList.forEach(other=>{
                if(other.dead||other===e) return;
                const dx=other.mesh.position.x-e.mesh.position.x;
                const dz=other.mesh.position.z-e.mesh.position.z;
                if(dx*dx+dz*dz <= aoeR*aoeR)
                  slowedEnemies.set(other.mesh.uuid,{until:slowUntil,factor:0.4});
              });
              spawnParts(e.mesh.position.clone(),0x4488ff,10);
            }
          }
          spawnParts(b.mesh.position.clone(),def.bulletColor,4);
          b.alive=false;
          if(e.hp<=0) killEnemy(e,true);
        }
      }
      if(b.alive&&b.dist>18) b.alive=false;
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
    updateViking(dt);
    checkBunkerHover(dt);
    ghostSnipeTick(dt);
    updateShrike(dt);
    updateCorpses(dt);
    updateDayNight(dt);
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
    clearScheduler();        // drop pending wave countdown / Viking / bombs / nuke (runs their cleanup)
    removeViking();
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
    syncBullets(); syncEnemyPools(); syncAcids();
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
    updateHUD();
  }

  // ── Title / results screens (one overlay card) ──────────────────────────
  const _esc = v => String(v).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  function _showCard(html){ const c=$('ov-card'); if(c) c.innerHTML=html; $('overlay').style.display='flex'; }
  const _KEYS_HTML = `<div class="ov-keys">
      <kbd>CLICK</kbd><span>Fire a volley</span><kbd>R</kbd><span>Airstrike + resupply</span>
      <kbd>N</kbd><span>Nuke (wave 5+)</span><kbd>B</kbd><span>Roster (pauses)</span>
      <kbd>1-4</kbd><span>Upgrades</span><kbd>M / ESC</kbd><span>Menu</span>
      <kbd>WHEEL</kbd><span>Zoom on the bunker</span><kbd>INS / DEL</kbd><span>Rotate view 90°</span>
    </div>`;
  function showTitle(){
    clearEntities();
    closeRoster(); closeMenu(); closeCheat();
    phase='menu'; wavePhase='idle';
    const unlocked=endlessUnlocked(), best=_bestEndless();
    const auto=_readSave(AUTO_KEY), manual=_readSave(SAVE_KEY);
    _showCard(`<div class="ov-kicker">TERRAN DOMINION · BUNKER DEFENSE</div>
      <div class="ov-title">DEFENSE OF THE<br>DOMINION</div>
      <div class="ov-sub">Hold the bunker. Every unit inside fires with each click.</div>
      <div class="ov-modes">
        <button class="ov-btn" onclick="G.start('campaign')"><svg class="ico"><use href="#i-campaign"/></svg>
          <span><span class="ob-t">CAMPAIGN</span><span class="ob-d">Clear ${CFG.victory_wave} waves of the swarm to win</span></span></button>
        <button class="ov-btn gold" ${unlocked?'':'disabled'} onclick="G.start('endless')"><svg class="ico"><use href="#i-${unlocked?'endless':'lock'}"/></svg>
          <span><span class="ob-t">ENDLESS</span><span class="ob-d">${unlocked ? (best ? `Best: wave ${_esc(best.wave)} · score ${_esc(best.score)}` : 'No wave limit — how long can you hold?') : 'Locked — win the campaign to unlock'}</span></span></button>
        ${_validSave(auto)?`<button class="ov-btn" onclick="G.loadGame('auto')"><svg class="ico"><use href="#i-play"/></svg>
          <span><span class="ob-t">CONTINUE</span><span class="ob-d">Autosave — ${_esc(_saveLabel(auto))}</span></span></button>`:''}
        ${_validSave(manual)?`<button class="ov-btn" onclick="G.loadGame()"><svg class="ico"><use href="#i-load"/></svg>
          <span><span class="ob-t">LOAD GAME</span><span class="ob-d">Saved game — ${_esc(_saveLabel(manual))}</span></span></button>`:''}
      </div>${_KEYS_HTML}<div class="ov-legal">${BLIZZARD_NOTICE}</div>`);
  }
  function showResults(victory,newlyUnlocked,newRecord){
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
    clearEntities();
    score=0;wave=1;kills=0;minerals=150;gas=50;
    ammo=CFG.base_ammo;maxAmmo=CFG.base_ammo;
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
    $('overlay').style.display='none';
    phase='playing';
    updateHUD();
    startWave();
  }

  // Kick off model loading in background — game starts with procedural
  // meshes instantly and swaps to OBJ models as they load.
  ModelLoader.preloadAll();
  // An SC2 skin needs one instance pool per walk / attack frame (up to 40): bake them as
  // soon as the model has loaded, so the first spawn of a skin does not stall a frame
  ['zergling','zergling_upgrade','zergling_webby','roach','roach_ex1a','roach_ex3']
    .forEach(k => ModelLoader.load(k).then(() => enemyLook(k)).catch(() => {}));
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
    syncMarines(); updateHUD();
    return `${def.name} hired! (${slotsUsed()}/6 slots)`;
  }

  function dismissUnit(idx) {
    if (idx < 0 || idx >= roster.length) return;
    // An empty bunker fires nothing, yet clicks would still spend ammo
    if (roster.length <= 1) { setStatus('The bunker needs at least one unit!'); return; }
    const utype = roster[idx];
    const def = UNIT_DEF[utype];
    // Snipe cooldowns are kept per ghost in roster order — drop this ghost's entry
    if (utype === 'ghost') snipeReady.splice(roster.slice(0, idx).filter(u => u === 'ghost').length, 1);
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
    if (!roster.includes(def.unit)) { setStatus(`Need a ${def.unit} in bunker first!`); return; }

    if (tier === undefined) {
      // Base unlock
      const [m, g] = def.cost;
      if (minerals < m || gas < g) { setStatus(needText(m, g)); return; }
      minerals -= m; gas -= g;
      if (key === 'concussive') concussiveUnlocked = true;
      if (key === 'snipe')      snipeUnlocked      = true;
      if (key === 'superstim')  superStimUnlocked  = true;
      setStatus(`${def.name} researched!`);
    } else {
      // Tier upgrade
      const td = def.tiers[tier];
      if (!td) return;
      const [m, g] = td.cost;
      if (minerals < m || gas < g) { setStatus(needText(m, g)); return; }
      minerals -= m; gas -= g;
      if (key === 'concussive') concussiveLvl = tier + 1;
      if (key === 'snipe')      snipeLvl      = tier + 1;
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
      el.className = `rs ${def.cls}`;
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
        + (def.bonusVs.length ? `, +${Math.round((def.bonusMult - 1) * 100)}% vs ${def.bonusVs.join('/')}` : ', no bonus');
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
      const [unlocked, curTierLvl] = { concussive: [concussiveUnlocked, concussiveLvl], snipe: [snipeUnlocked, snipeLvl], superstim: [superStimUnlocked, 0] }[key];
      const hasUnit    = roster.includes(def.unit);
      const el = document.createElement('div');
      el.className = `upgrow ${def.unit} ${!hasUnit&&!unlocked?'locked':''}`;

      // What's the current status line?
      let statusLine = def.desc;
      if (unlocked) {
        if (key === 'snipe')      statusLine = `CD: ${(SNIPE_CD[snipeLvl]/1000).toFixed(1)}s | tier ${snipeLvl}/3`;
        if (key === 'concussive') statusLine = concussiveLvl===0 ? 'Single target' : `AOE radius ${CONC_RADIUS[concussiveLvl].toFixed(1)} | tier ${concussiveLvl}/3`;
        if (key === 'superstim')  statusLine = `Stim: no HP cost, +${CFG.superstim_heal} HP/s to the bunker for ${CFG.stim_duration} s (stacks with self-repair)`;
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

      el.innerHTML = `
        <div class="upgrow-head"><img class="upgrow-ico" src="${def.icon}" alt=""><div>
          <div class="upgrow-name ${def.unit}">${def.name}${unlocked?' ✓':''}</div>
          <div class="upgrow-desc">${statusLine}${!hasUnit&&!unlocked?' — need '+def.unit:''}</div></div></div>
        <button class="upgrow-btn" ${btnDisabled?'disabled':''}>${btnLabel}</button>`;
      if (btnHandler && !btnDisabled) el.querySelector('button').addEventListener('click', btnHandler);
      upgRow.appendChild(el);
    });

    // ── Endless armory ──
    if (gameMode === 'endless') {
      const head = document.createElement('div');
      head.className = 'armory-head';
      head.innerHTML = 'ENDLESS ARMORY <span>spend the surplus — each purchase costs 30% more</span>';
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
    snipeLvl = 0;
    concussiveLvl = 0;
    slowedEnemies.clear();
    snipeReady = [];
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
    _applyDNLights(_dnFactor); // light levels for this quality, blended with day/night

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
  function openMenu() {
    _menuOpen = true;
    const ov = document.getElementById('menu-overlay');
    if (ov) { ov.style.display = 'flex'; }
    _syncGfxUI(); // sync button active states
    _syncSoundUI();
    _syncSaveUI();
    // Sync day/night checkbox
    const cb = document.getElementById('menu-dn-cb');
    if (cb) cb.checked = dnEnabled;
  }
  function _syncSoundUI() {
    const cb = document.getElementById('menu-mute-cb'), vol = document.getElementById('menu-vol'), val = document.getElementById('menu-vol-val');
    if (cb) cb.checked = SFX.muted;
    if (vol) vol.value = Math.round(SFX.volume * 100);
    if (val) val.textContent = SFX.muted ? 'OFF' : Math.round(SFX.volume * 100) + '%';
    const sb = document.getElementById('tv-snd');
    if (sb) { sb.classList.toggle('off', SFX.muted); sb.querySelector('use')?.setAttribute('href', SFX.muted ? '#i-snd-off' : '#i-snd'); }
  }
  function toggleMute() { SFX.ensure(); SFX.setMuted(!SFX.muted); _syncSoundUI(); }
  function setVolume(v) { SFX.ensure(); SFX.setVolume(v); _syncSoundUI(); SFX.play('buy'); }
  function setMuted(m) { SFX.ensure(); SFX.setMuted(m); _syncSoundUI(); }
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
      concussiveUnlocked, snipeUnlocked, concussiveLvl, snipeLvl, superStimUnlocked,
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
      concussiveLvl = d.concussiveLvl || 0; snipeLvl = d.snipeLvl || 0;
      armory = { hp: 0, dmg: 0, ammo: 0, cd: 0, ...(d.armory || {}) };   // HP / ammo purchases are already in maxHp / maxAmmo
      snipeReady = roster.filter(u => u === 'ghost').map(() => 0);
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
  return {start, buy, buyArmory, doAirstrike, doNuke, doStim, openCheat, closeCheat, submitCheat, toggleRoster, openRoster, closeRoster, toggleGfx, setGfx, openMenu, closeMenu,
          saveGame, loadGame, toggleDayNight, setVolume, setMuted, toggleMute, resetView, showTitle, continueEndless, mode: () => gameMode};
})();
