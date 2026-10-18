// Game constants, asset paths and rank table (globals shared by the scripts below).
// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const CFG = {
  base_ammo: 30,
  victory_wave: 15,           // campaign: clearing this wave wins and unlocks Endless
  airstrike_cd: 20, nuke_cd: 15, nuke_wave: 5, roach_wave: 4,
  stim_duration: 11, stim_hp: 10,   // SC2 Stimpack: 11 s, 10 HP per Marine (paid by the bunker)
  superstim_heal: 6,                // Super Stimpack (Nova's Marines): no HP cost, repairs the bunker 6 HP/s while active
  metabolic_wave: 8, metabolic_boost: 1.6,   // Metabolic Boost: from wave 8 Zerglings grow wings and run 60% faster (SC2: 4.13 → 6.58)
  webby_wave: 12,                   // the boosted Zerglings' "webby" collection skin
  repair_rate: 25,  // 25 HP/s — meaningful heal vs heavy Zerg pressure
  // Endless: every wave past the campaign's last one reinforces the bunker while the
  // swarm keeps growing — per wave +5% damage, +60 max HP, +10% repair, +2 rounds
  endless_dmg: 0.05, endless_hp: 60, endless_repair: 0.10, endless_ammo: 2,
  // Endless armory (roster panel, Endless only): repeatable purchases for the surplus
  // minerals and gas — each one costs 30% more than the last of its kind.
  // Per purchase: +150 max HP · +10% damage · +6 rounds · strike and nuke cooldowns ×0.9 (down to 40%)
  armory_growth: 1.3, armory_hp: 150, armory_dmg: 0.10, armory_ammo: 6, armory_cd: 0.9, armory_cd_min: 0.4,
  dmg_costs:   [[100,20],[160,32],[256,51]],
  armor_costs: [[125,30],[200,48],[320,77]],
  hp_costs:    [[150,40],[255,68],[434,116]],
  ammo_costs:  [[80,15],[130,25],[200,40]],
  // unit and research costs live in UNIT_DEF / UPGRADE_DEF in game.js
};

// ─── ASSET PATHS ─────────────────────────────────────────────────────────────
// SC2 models are converted with tools/import-sc2.mjs (see README). If a model
// is missing or fails to load, the game uses procedural geometry instead.
const TEAM_COLOR = { terran: 0x2f6dff, zerg: 0x9a1c1c };
const SC2_SCALE = 3.0 / 2.726;   // world units per SC2 unit (the bunker: 2.726 wide in SC2, 3.0 here)
const ZERGLING_SCALE = SC2_SCALE * 0.8;
const TERRAN_DIR = 'assets/models/terran/', ZERG_DIR = 'assets/models/zerg/';
// Baked SC2 walk / attack cycles play this much faster than the pace that
// matches the ground covered: livelier at the game's slower move speeds.
const ANIM_SPEED = 1.25;
const ASSETS = {
  // glb: SC2 model from tools/m3-to-glb.mjs — the bind pose plus its baked walk / attack
  //      frames in one binary file (~10× faster to load than the same model as OBJ)
  // obj: model path (the bunker, Shrike and Viking: older Blender conversions) · mtl: optional material file
  // walk / attack: baked frames as separate OBJ files (tools/m3-to-obj.mjs --anim), for an OBJ model
  // tex: { diffuse, emissive, normal, normalY } maps · meshTex: per-mesh overrides
  // scale: size of the largest dimension in world units · unitScale: world units per model unit
  // teamColor: tint for the team-colour mask in the diffuse alpha · yOff / rotY: placement
  // stride: world units the walk cycle covers per loop (SC2 move speed × loop length)
  bunker:   { obj: TERRAN_DIR + 'bunker.obj', mtl: TERRAN_DIR + 'bunker.mtl', scale: 3.0,
               tex: { diffuse: TERRAN_DIR + 'bunker_diffuse.dds', emissive: TERRAN_DIR + 'bunker_emissive.dds', normal: TERRAN_DIR + 'bunker_normal.dds' },
               // Mesh.002 = the Neosteel frame (HP Lv2+), mapped to the upgrade texture
               meshTex: { 'Mesh.002': { diffuse: TERRAN_DIR + 'bunker_upgrade_diffuse.dds', emissive: TERRAN_DIR + 'bunker_upgrade_emissive.dds' } } },
  // Shrike turret (HP Lv3) — SC2 "BunkerShrikeTurret", textured with the Perdition
  // upgrade maps. Same SC2 units as the bunker: 1.75 wide vs the bunker's 2.73,
  // so scale = 1.75 × (3.0 / 2.726) keeps their real proportions.
  shrike:   { obj: TERRAN_DIR + 'bunker_shrike_turret.obj', mtl: TERRAN_DIR + 'bunker_shrike_turret.mtl', scale: 1.926,
               tex: { diffuse: TERRAN_DIR + 'bunkerperditionupgrade_diffuse.dds', emissive: TERRAN_DIR + 'bunkerperditionupgrade_emissive.dds' } },
  marine:   { glb: TERRAN_DIR + 'marine.glb', unitScale: SC2_SCALE, teamColor: TEAM_COLOR.terran,
               stride: 2.25 * 0.667 * SC2_SCALE,
               tex: { diffuse: TERRAN_DIR + 'marine_diffuse.dds', normal: TERRAN_DIR + 'marine_normal.dds' } },
  marauder: { glb: TERRAN_DIR + 'marauder.glb', unitScale: SC2_SCALE, teamColor: TEAM_COLOR.terran,
               stride: 2.25 * 0.866 * SC2_SCALE,
               tex: { diffuse: TERRAN_DIR + 'marauder_diffuse.dds', emissive: TERRAN_DIR + 'marauder_emissive.dds', normal: TERRAN_DIR + 'marauder_normal.dds',
                      normalY: -1 } },   // this normal map is OpenGL-style (green = up)
  // the bind pose holds the rifle below the feet: sink it so the boots touch the ground
  ghost:    { glb: TERRAN_DIR + 'ghost.glb', unitScale: SC2_SCALE, yOff: -0.38 * SC2_SCALE, teamColor: TEAM_COLOR.terran,
               stride: 2.25 * 0.667 * SC2_SCALE,
               tex: { diffuse: TERRAN_DIR + 'ghost_diffuse.dds' } },
  nukeMissile: { glb: TERRAN_DIR + 'nuke_missile.glb', unitScale: SC2_SCALE * 0.52, tex: { diffuse: TERRAN_DIR + 'nuke_missile.dds' } },
  // Marauder punisher grenade (body + fireball); its texture is not extracted, so
  // game.js gives it plain materials. Drawn 2× its SC2 size to read at this zoom.
  marauderMissile: { glb: TERRAN_DIR + 'marauder_missile.glb', unitScale: SC2_SCALE * 2 },
  viking:   { obj: TERRAN_DIR + 'viking.obj', scale: 2.25, rotY: -Math.PI/2,
               tex: { diffuse: TERRAN_DIR + 'viking_diffuse.jpg', emissive: TERRAN_DIR + 'viking_emissive.jpg' } },
  // Zerglings by wave tier: base · Metabolic Boost (wave 8+, winged) · its webby skin (wave 12+).
  // Drawn at 0.8× SC2 size so they read smaller than the Roach (the stride shrinks with them).
  // Walk: 4 gallops in 2 s at SC2 speed 2.95 (measured from the planted feet: 2.74)
  zergling:         { glb: ZERG_DIR + 'zergling.glb', unitScale: ZERGLING_SCALE, teamColor: TEAM_COLOR.zerg,
                       stride: 2.95 * 2.0 * ZERGLING_SCALE,
                       tex: { diffuse: ZERG_DIR + 'zergling_diffuse.dds', emissive: ZERG_DIR + 'zergling_emissive.dds', normal: ZERG_DIR + 'zergling_normal.dds' } },
  zergling_upgrade: { glb: ZERG_DIR + 'zergling_upgrade.glb', unitScale: ZERGLING_SCALE, teamColor: TEAM_COLOR.zerg,
                       stride: 2.95 * 2.0 * ZERGLING_SCALE,
                       tex: { diffuse: ZERG_DIR + 'zergling_diffuse.dds', emissive: ZERG_DIR + 'zergling_emissive.dds', normal: ZERG_DIR + 'zergling_normal.dds' } },
  zergling_webby:   { glb: ZERG_DIR + 'zergling_upgrade.glb', unitScale: ZERGLING_SCALE, teamColor: TEAM_COLOR.zerg,
                       stride: 2.95 * 2.0 * ZERGLING_SCALE,
                       tex: { diffuse: ZERG_DIR + 'zergling_webby_diffuse.dds', emissive: ZERG_DIR + 'zergling_webby_emissive.dds', normal: ZERG_DIR + 'zergling_webby_normal.dds' } },
  // Roach skins by wave tier (same mesh): base · ex1a (wave 9+) · ex3 (wave 13+)
  roach:      { glb: ZERG_DIR + 'roach.glb', unitScale: SC2_SCALE, teamColor: TEAM_COLOR.zerg,
                 stride: 2.25 * 0.434 * SC2_SCALE,
                 tex: { diffuse: ZERG_DIR + 'roach_diffuse.dds' } },
  roach_ex1a: { glb: ZERG_DIR + 'roach.glb', unitScale: SC2_SCALE, teamColor: TEAM_COLOR.zerg,
                 stride: 2.25 * 0.434 * SC2_SCALE,
                 tex: { diffuse: ZERG_DIR + 'roach_ex1a_diffuse.dds', emissive: ZERG_DIR + 'roach_ex1a_emissive.dds' } },
  roach_ex3:  { glb: ZERG_DIR + 'roach.glb', unitScale: SC2_SCALE, teamColor: TEAM_COLOR.zerg,
                 stride: 2.25 * 0.434 * SC2_SCALE,
                 tex: { diffuse: ZERG_DIR + 'roach_ex3_diffuse.dds', emissive: ZERG_DIR + 'roach_ex3_emissive.dds' } },
};
// Roach acid (SC2: range 4, one spit every 2 game s = 1.43 s). The Roach stops
// when the hull is in range and plays its Attack animation; the acid leaves
// its mouth ("Ref_Head") at the lunge, 420 ms in:
//   node tools/m3-to-obj.mjs assets/source/m3/Roach.m3 --point "Ref_Head" --anim Attack --at 420
const ROACH_ACID = {
  range: 1.45 + 4 * SC2_SCALE + 0.7,   // centre distance: hull radius + SC2 range + the Roach's own reach
  cooldown: 1.43, anim: 1.0, spit: 0.42,
  mouth: [-0.013, 0.436, 0.688],       // Ref_Head at the spit, model units (OBJ axes)
  flight: 0.55, gravity: 9,            // lobbed: seconds in the air · arc gravity
};
// Zergling bite: the 533 ms SC2 Attack animation loops at the hull; the jaws
// close half way through (Ref_Head lowest and furthest forward, ~270 ms)
const ZERGLING_BITE = { anim: 0.533, bite: 0.5 };
// Standalone textures (not tied to a model)
const DECALS = { nukeTarget: TERRAN_DIR + 'nuke_target.dds' };   // SC2 nuke target reticle
// HUD icons used from script (index.html references the others directly)
const UI_DIR = 'assets/ui/';
const UI_ICONS = {
  mineral: UI_DIR + 'icon-mineral-terran.png', gas: UI_DIR + 'icon-gas-terran.png',
  // by upgrade level 0-3 — weapons: Infantry Weapons Lv0-3 · ammo storage: Magrail
  // Munitions (also shown at Lv0, as the next upgrade), Magfield Accelerator, Enhanced Munitions
  dmg: [0, 1, 2, 3].map(l => UI_DIR + `btn-upgrade-terran-infantryweaponslevel${l}.png`),
  ammo: ['magrailmunitions', 'magrailmunitions', 'magfieldaccelerator', 'enhancedmunitions'].map(n => UI_DIR + `btn-upgrade-terran-${n}.png`),
  // unit research (roster panel)
  superstim:  UI_DIR + 'btn-upgrade-terran-superstimppack.png',
  concussive: UI_DIR + 'btn-upgrade-terran-explosiveshrapnelshells.png',
  snipe:      UI_DIR + 'btn-upgrade-terran-ui-lazertargetingsystem.png',
};

// Shown on the title screen (the models, textures and icons are Blizzard's)
const BLIZZARD_NOTICE = 'StarCraft® and its models, textures and icons are © Blizzard Entertainment, Inc. Non-commercial fan project — not affiliated with or endorsed by Blizzard Entertainment.';

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
