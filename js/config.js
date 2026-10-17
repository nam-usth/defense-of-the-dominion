// Game constants, asset paths and rank table (globals shared by the scripts below).
// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const CFG = {
  base_ammo: 30,
  victory_wave: 15,           // campaign: clearing this wave wins and unlocks Endless
  airstrike_cd: 20, nuke_cd: 15, nuke_wave: 5, roach_wave: 4,
  repair_rate: 25,  // 25 HP/s — meaningful heal vs heavy Zerg pressure
  dmg_costs:   [[100,20],[160,32],[256,51]],
  armor_costs: [[125,30],[200,48],[320,77]],
  hp_costs:    [[150,40],[255,68],[434,116]],
  ammo_costs:  [[80,15],[130,25],[200,40]],
  // unit and research costs live in UNIT_DEF / UPGRADE_DEF in game.js
};

// ─── ASSET PATHS ─────────────────────────────────────────────────────────────
// Point these at your .obj (or .glb) files. MTL is optional (same name, .mtl extension).
// If a model is missing or fails to load, the game uses procedural geometry instead.
// marine / zergling / roach are empty slots: drop converted SC2 models at these
// paths and they are used automatically (enemies stay instanced — see README).
const ASSETS = {
  // glb: path to self-contained GLB file (textures + PBR materials embedded — preferred)
  // obj: fallback OBJ path used when no GLB is provided
  // tex: diffuse/emissive applied to OBJ models (ignored for GLB)
  // scale = desired size in game-world units after normalization to 1 unit
  bunker:   { obj: 'assets/models/terran/bunker.obj',   mtl: 'assets/models/terran/bunker.mtl',   scale: 3.0,  yOff: 0, rotY: 0,
               tex: { diffuse:  'assets/models/terran/bunker_upgrade_diffuse.dds',
                      emissive: 'assets/models/terran/bunker_upgrade_emissive.dds' } },
  // Shrike turret (HP Lv3) — SC2 "BunkerShrikeTurret", textured with the Perdition
  // upgrade maps. Same SC2 units as the bunker: 1.75 wide vs the bunker's 2.73,
  // so scale = 1.75 × (3.0 / 2.726) keeps their real proportions.
  shrike:   { obj: 'assets/models/terran/bunker_shrike_turret.obj', mtl: 'assets/models/terran/bunker_shrike_turret.mtl', scale: 1.926, yOff: 0, rotY: 0,
               tex: { diffuse:  'assets/models/terran/bunkerperditionupgrade_diffuse.dds',
                      emissive: 'assets/models/terran/bunkerperditionupgrade_emissive.dds' } },
  marine:   { obj: 'assets/models/terran/marine.obj',   mtl: 'assets/models/terran/marine.mtl',   scale: 0.9,  yOff: 0, rotY: Math.PI },
  viking:   { obj: 'assets/models/terran/viking.obj',   scale: 2.25, yOff: 0, rotY: -Math.PI/2,
               tex: { diffuse:  'assets/models/terran/viking_diffuse.jpg',
                      emissive: 'assets/models/terran/viking_emissive.jpg' } },
  zergling: { obj: 'assets/models/zerg/zergling.obj',   mtl: 'assets/models/zerg/zergling.mtl',   scale: 0.9,  yOff: 0, rotY: Math.PI },
  roach:    { obj: 'assets/models/zerg/roach.obj',      mtl: 'assets/models/zerg/roach.mtl',      scale: 1.3,  yOff: 0, rotY: Math.PI },
};

const RANKS = [
  {name:'PRIVATE',   kills:0,  color:'#aaaaaa'}, // 6-digit: badge border appends '66' alpha
  {name:'CORPORAL',  kills:10, color:'#cd7f32'},
  {name:'SERGEANT',  kills:25, color:'#cd7f32'},
  {name:'LIEUTENANT',kills:50, color:'#c0c0c0'},
  {name:'CAPTAIN',   kills:90, color:'#c0c0c0'},
  {name:'MAJOR',     kills:140,color:'#ffd700'},
  {name:'COLONEL',   kills:200,color:'#ffd700'},
  {name:'GENERAL',   kills:280,color:'#ff4444'},
];
function getRank(k){let r=RANKS[0];for(const x of RANKS)if(k>=x.kills)r=x;return r;}

const MARINE_SLOTS = [[.3,0],[-.3,.4],[.5,-.4],[-.5,-.3],[.0,.6],[.0,-.6]];
