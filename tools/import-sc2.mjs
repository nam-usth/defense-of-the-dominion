#!/usr/bin/env node
// Import StarCraft II models and textures into the game:
//   node tools/import-sc2.mjs <source folder>
//
// The source folder holds the .m3 / .dds files extracted from the game
// (CASC). The files listed below are imported: .m3 models are converted to
// .glb (tools/m3-to-glb.mjs — bind pose plus the baked animations in one
// binary file, ~10× faster to load than OBJ), textures are copied, HUD icons become .png
// (tools/dds-to-png.mjs). The .m3 files are also kept in assets/source/m3 so
// the models can be rebuilt. Add a line here to bring in a new model.
// Not covered: the bunker, Shrike turret and Viking (OBJ/MTL, their upgrade /
// Perdition DDS and the Viking JPGs) are older Blender conversions kept as is.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = 'assets/models/terran', Z = 'assets/models/zerg', UI = 'assets/ui';

// anims: also bake these animations into the .glb (8 frames each unless frames says otherwise)
const MODELS = [
  { m3: 'Marine.m3',            glb: `${T}/marine.glb`, anims: ['Walk'] },
  { m3: 'Marauder_BlackOps.m3', glb: `${T}/marauder.glb`, anims: ['Walk'] },
  { m3: 'Ghost_BlackOps.m3',    glb: `${T}/ghost.glb`, anims: ['Walk'] },   // regions 0, 2, 3 (4 is a glow plane)
  { m3: 'NukeMissile.m3',       glb: `${T}/nuke_missile.glb`, regions: '0' },   // 1 = exhaust flame (texture not extracted)
  // Punisher grenade: body + fireball (2 = fire tail, drawn with particles); its Autoturret.dds is not extracted
  { m3: 'MarauderMissile.m3',   glb: `${T}/marauder_missile.glb`, regions: '0,1' },
  { m3: 'Roach.m3',             glb: `${Z}/roach.glb`, anims: ['Walk', 'Attack'] },
  // Zergling Walk = four gallops in 2 s: 32 frames keeps 8 per gallop
  { m3: 'Zergling.m3',          glb: `${Z}/zergling.glb`, anims: ['Walk', 'Attack'], frames: { Walk: 32 } },
  { m3: 'ZerglingUpgrade.m3',   glb: `${Z}/zergling_upgrade.glb`, anims: ['Walk', 'Attack'], frames: { Walk: 32 } },   // Metabolic Boost (wings)
];
// [source, destination, max size]: 1024² maps are cut to 512² (tools/dds-resize.mjs drops the
// top mip). Units are a few dozen pixels tall on screen and even the bunker covers about
// 250 px at full zoom, so nothing visible is lost and the site loads 4× less. (The bunker
// upgrade and Perdition maps, not imported here, were cut the same way.)
const MAX = 512;
const TEXTURES = [
  ['bunker_diffuse.dds', `${T}/bunker_diffuse.dds`, MAX], ['bunker_emissive.dds', `${T}/bunker_emissive.dds`, MAX], ['bunker_normal.dds', `${T}/bunker_normal.dds`, MAX],
  ['marine.dds', `${T}/marine_diffuse.dds`], ['marine_normal.dds', `${T}/marine_normal.dds`],
  ['marauder_blackops_diff.dds', `${T}/marauder_diffuse.dds`, MAX], ['marauder_blackops_emiss.dds', `${T}/marauder_emissive.dds`, MAX], ['marauder_blackops_norm.dds', `${T}/marauder_normal.dds`, MAX],
  ['ghost_covertops_collection_diff.dds', `${T}/ghost_diffuse.dds`, MAX],
  ['nuke_missile.dds', `${T}/nuke_missile.dds`], ['nukeicon3.dds', `${T}/nuke_target.dds`],
  ['roach.dds', `${Z}/roach_diffuse.dds`],
  ['roachex1a_complete_diff.dds', `${Z}/roach_ex1a_diffuse.dds`], ['roachex1a_complete_emis.dds', `${Z}/roach_ex1a_emissive.dds`],
  ['roach_ex3_diff.dds', `${Z}/roach_ex3_diffuse.dds`], ['roach_ex3_emiss.dds', `${Z}/roach_ex3_emissive.dds`],
  // specular maps and zergling_eye_* (the portrait's eye glow) are not used
  ['zergling_diffuse.dds', `${Z}/zergling_diffuse.dds`, MAX], ['zergling_emissive.dds', `${Z}/zergling_emissive.dds`], ['zergling_normal.dds', `${Z}/zergling_normal.dds`],
  ['zerglingupgrade_collectionskin_webby_diff.dds', `${Z}/zergling_webby_diffuse.dds`, MAX], ['zerglingupgrade_collectionskin_webby_emis.dds', `${Z}/zergling_webby_emissive.dds`, MAX],
  ['zerglingupgrade_collectionskin_webby_norm.dds', `${Z}/zergling_webby_normal.dds`, MAX],
];
const ICONS = [
  ['btn-upgrade-terran-buildingarmor.dds', `${UI}/btn-upgrade-terran-buildingarmor.png`],
  ['btn-upgrade-terran-neosteelframe.dds', `${UI}/btn-upgrade-terran-neosteelframe.png`],
  ['icon-mineral-terran.dds', `${UI}/icon-mineral-terran.png`],
  ['icon-gas-terran.dds', `${UI}/icon-gas-terran.png`],
  // command card
  ['btn-progression-hornerhan-5-fleetcalldown.dds', `${UI}/btn-progression-hornerhan-5-fleetcalldown.png`],   // airstrike
  ['nukes_coop.dds', `${UI}/nukes_coop.png`], ['btn-status-detector.dds', `${UI}/btn-status-detector.png`],   // nuke · view
  // upgrades: weapons by level, ammo storage tiers, research
  ...[0, 1, 2, 3].map(l => [`btn-upgrade-terran-infantryweaponslevel${l}.dds`, `${UI}/btn-upgrade-terran-infantryweaponslevel${l}.png`]),
  ...['magrailmunitions', 'magfieldaccelerator', 'enhancedmunitions', 'explosiveshrapnelshells', 'ui-lazertargetingsystem', 'superstimppack', 'hisecautotracking']
    .map(n => [`btn-upgrade-terran-${n}.dds`, `${UI}/btn-upgrade-terran-${n}.png`]),
];

// Effect models kept for later: mostly particle systems whose textures are not
// extracted yet (MarauderSlow: Lightning_DrkBlue · Nuke: firecloud2, Fireball_10, ... ·
// NukeFalling: CloudSingleBlend, Glow_Haze1 · Roach acid: GooSplat_1, BloodSquirtRandom_R1, ...).
const KEEP = ['MarauderSlow.m3', 'Nuke.m3', 'NukeFalling.m3', 'RoachMissile.m3', 'RoachMissileImpact.m3'];

const src = process.argv[2];
if (!src) { console.error('usage: node tools/import-sc2.mjs <folder with the .m3/.dds files>'); process.exit(1); }
const from = f => { const p = path.join(src, f); if (!fs.existsSync(p)) throw new Error(`missing ${p}`); return p; };
const to = f => { const p = path.join(ROOT, f); fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };
const node = (script, ...args) => execFileSync(process.execPath, [path.join(ROOT, 'tools', script), ...args], { stdio: 'inherit' });

for (const m of MODELS) {
  const frames = ['8', ...Object.entries(m.frames || {}).map(([a, n]) => `${a}:${n}`)].join(',');
  node('m3-to-glb.mjs', from(m.m3), to(m.glb), ...(m.regions ? ['--regions', m.regions] : []),
    ...(m.anims ? ['--anims', m.anims.join(','), '--frames', frames] : []));
  fs.copyFileSync(from(m.m3), to(`assets/source/m3/${m.m3}`));
}
for (const [s, d, max] of TEXTURES) {
  if (max) node('dds-resize.mjs', from(s), to(d), '--max', String(max));
  else { fs.copyFileSync(from(s), to(d)); console.log(`${d}  ← ${s}`); }
}
for (const [s, d] of ICONS) node('dds-to-png.mjs', from(s), to(d));
for (const f of KEEP) if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), to(`assets/source/m3/${f}`));
