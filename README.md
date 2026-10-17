# Defense of the Dominion

A StarCraft II–style bunker defense game that runs in the browser — Three.js, no build step.

Hold a Terran bunker against waves of Zerg. Every unit inside the bunker fires with each click; spend the minerals and gas you earn on upgrades and new units, raise the bunker to the Shrike auto-turret, call in Viking airstrikes and nukes, and clear **15 waves** to win — which unlocks **Endless** mode.

![Title screen](docs/screenshots/title.jpg)

| Battle | Shrike turret (Bunker Lv3) |
|---|---|
| ![Battle](docs/screenshots/battle.jpg) | ![Shrike turret firing](docs/screenshots/shrike.jpg) |

## Running the game

You need a desktop browser with WebGL 2 (Chrome, Edge or Firefox) and, for the local server, Node.js 18 or newer.

```bash
npm start
```

Then open <http://localhost:8080>. To use another port: `node tools/serve.mjs 3000`.

Any static web server works (for example `python -m http.server 8080`). Opening `index.html` straight from disk is **not** enough: browsers block loading the 3D models over `file://`, and the game then falls back to simple procedural shapes.

An internet connection is needed for three.js (loaded from a CDN). The UI fonts also come from Google Fonts; without them the game uses system fonts.

## How to play

- **Campaign** — clear wave 15 (a bigger final assault) to win. Winning unlocks Endless for good (stored in the browser).
- **Endless** — no wave limit. Your best wave and score are shown on the title screen.
- **Shooting** — each click fires one volley: every unit in the bunker shoots once at the cursor (Marauders lock onto the nearest Roach while one is alive). One volley costs one round of ammo.
- **Ammo** — when the magazine is empty, press **R**: a Viking bombs every enemy cluster and drops an ammo crate, which a Marine runs out to fetch. Ammo is also restocked after every wave.
- **Resources** — kills and cleared waves pay minerals ◆ and vespene gas ▲.

### Units (bunker roster, 6 slots — press B)

| Unit | Slots | Cost | Strengths | Research |
|---|---|---|---|---|
| Marine | 1 | 50 ◆ | balanced | — |
| Marauder | 2 | 150 ◆ 25 ▲ | ×1.2 damage, +100% vs armored (Roach); auto-aims at the nearest Roach | Concussive Shells — slows to 40% speed; tiers add an area slow (radius 1.5 / 2.2 / 3.0) |
| Ghost | 2 | 200 ◆ 50 ▲ | ×1.4 damage, +150% vs light (Zergling) | Snipe — auto-snipes the biggest threat; cooldown 8 → 6 → 4 → 2.5 s |

Dismissing a unit refunds 75%.

### Enemies

- **Zergling** — light and fast, from wave 1.
- **Roach** — armored and tough, from wave 4.

### Upgrades (command card, keys 1–4)

| Key | Upgrade | Per level |
|---|---|---|
| 1 | Weapon damage | +60% damage |
| 2 | Bunker armor | bite damage × 1/(1 + 0.35·level) |
| 3 | Bunker hull | +250 HP. **Lv2** adds the Neosteel frame; **Lv3** mounts the **Shrike turret** (auto-targets, twin barrels = 2 extra marines, no ammo) and self-repair (25 HP/s) |
| 4 | Ammo storage | +10 rounds |

The **nuke** (N) unlocks at wave 5: two-second warning, huge blast radius, 15 s cooldown. Below 50% HP the bunker starts to burn.

## Controls

| Input | Action |
|---|---|
| Left click | Fire a volley at the cursor |
| R | Airstrike + resupply (only when out of ammo) |
| N | Nuke (wave 5+) |
| B | Bunker roster — hire units, research (pauses the game) |
| 1 · 2 · 3 · 4 | Upgrade damage · armor · bunker · ammo |
| Mouse wheel, + / − | Zoom in on the bunker / back out |
| Insert / Delete | Rotate the view 90° left / right (the view stays on the bunker) |
| Home | Reset the view |
| M or Esc | Menu (pauses): graphics, sound, save / load, controls |
| Q | Graphics quality HIGH / LOW |
| Y | Day/night cycle (experimental) |
| K | Sound on / off |

Hover a command-card button for a tooltip with its cost, effect, and why it is disabled.

## Saving

- **Menu → SAVE / LOAD** — one manual save slot.
- **Autosave** after every cleared wave — **CONTINUE** on the title screen (also a checkpoint after the bunker falls).
- A save made during a wave restarts that wave; a save made between waves resumes at the next one.
- Everything is stored in the browser's `localStorage`: `dotd_save_v1`, `dotd_autosave_v1`, `dotd_endless_unlocked`, `dotd_endless_best`, `dotd_volume`, `dotd_muted`.

## Cheat codes

Type `dotd` during play to open the cheat console. `help` prints the full list to the browser console (F12).

| Code | Effect |
|---|---|
| `mng` | 7500 minerals + 7500 gas |
| `mineral` / `gas` | +500 minerals / +500 gas |
| `fu` | damage, armor and hull maxed (Shrike turret + self-repair) |
| `siege` · `bunker` | damage maxed · HP + armor maxed |
| `terran` | hire 2 Marines |
| `medic` · `immortal` | full repair · 99999 HP |
| `korhal` | reset airstrike and nuke cooldowns |
| `swarm` · `roachwave` | spawn 10 Zerglings · 5 Roaches |
| `wave` · `zergrush` | finish the current wave · jump ahead 5 waves (stops at the final wave in Campaign) |
| `airstrike` · `nuclear` · `kaboom` | 5 airstrikes · 3 nukes · a strike on every enemy |
| `general` | +280 kills (rank General) |
| `endv` · `endd` | win the campaign · lose the bunker |

## Project structure

```
index.html              page markup (top bar, console, menus) — loads the scripts below in order
css/hud.css             all styles
js/lib/obj-loader.js    minimal OBJ parser (THREE.OBJLoader)
js/radial-fog.js        fog measured as distance from the bunker (the night vision circle)
js/config.js            game constants (CFG), model and texture paths (ASSETS), ranks
js/model-loader.js      loads OBJ/GLB models and DDS/JPG textures, with procedural fallbacks
js/game.js              the game: scene, units, waves, combat, effects, HUD, menus, saving
assets/models/terran/   models and textures loaded at runtime
assets/models/zerg/     empty — put converted Zerg models here (see below)
assets/source/terran/   extra model parts and a GLB that the game does not load
tools/serve.mjs         zero-dependency local web server (npm start)
docs/screenshots/       images used in this README
```

The scripts are plain (non-module) scripts that share globals, so their order in `index.html` matters. When you change a CSS or JS file, bump its `?v=` number in `index.html` so browsers do not keep serving the cached copy.

## Using StarCraft II models

The bunker, the Shrike turret and the Viking are StarCraft II models (`.m3` converted to `.obj` in Blender) with their textures (DDS for the bunker and the Shrike, JPG for the Viking).

To replace the procedural Zergling, Roach and Marine:

1. Convert the `.m3` file with a Blender m3 add-on and export it as `.obj`.
2. Save it as `assets/models/zerg/zergling.obj`, `assets/models/zerg/roach.obj` or `assets/models/terran/marine.obj`. The game picks it up automatically; scale and rotation are set in `ASSETS` in `js/config.js`.
3. For textures, add a `tex: { diffuse, emissive }` entry to that model in `ASSETS`. DDS textures are flipped to match Blender's OBJ UVs automatically.

Enemies are drawn as instances, so even a detailed model costs only a few draw calls for the whole swarm.

The textures each unit uses (as referenced inside its `.m3` file) live in the game's CASC archive and need a CASC tool such as CascView to extract:

| Model | Diffuse | Emissive |
|---|---|---|
| `Zergling.m3` | `Zergling_Diffuse.dds` | `Zergling_Emissive.dds` |
| `Roach.m3` | `Roach_Diffuse.dds` | — |
| `Marine.m3` | `marine_diffuse_blood.dds` | — |
| `Marauder.m3` | `Marauder_Diffuse.dds` | `Marauder_Emissive.dds` |
| `Ghost_BlackOps.m3` | `DOM_Ghost_diff.dds` | `BlackOps_Ghost_Emiss.dds` |

## Technical notes

- **Rendering** — three.js r128 from a CDN, no build tools. Enemies and bullets are `InstancedMesh`es and all particles live in two `THREE.Points` buffers, so a 140-enemy late-game fight takes about 20 draw calls.
- **Timing** — gameplay runs on a game clock with its own scheduler: pausing freezes everything, and restarting or loading drops pending events (wave countdowns, airstrikes, nukes).
- **Night** — the fog shader is patched to measure distance from the bunker, which gives the night mode its circle of vision.
- **Sound** — synthesized with the Web Audio API; there are no audio files.
- **Hologram** — the bunker portrait is a 2D-canvas projection of the model's edges and follows the bunker's upgrade stages.

## Credits

Fan project — non-commercial, not affiliated with or endorsed by Blizzard Entertainment. StarCraft® and the models and textures in `assets/` are © Blizzard Entertainment, Inc. Keep this repository private, or remove `assets/`, before publishing it.
