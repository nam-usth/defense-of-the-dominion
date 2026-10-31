# Defense of the Dominion

A StarCraft II–style bunker defense game that runs in the browser — Three.js, no build step.

Hold a Terran bunker against waves of Zerg. Every unit inside the bunker fires with each click; spend the minerals and gas you earn on upgrades and new units, raise the bunker to the Shrike auto-turret, call in Viking airstrikes and nukes, and clear **15 waves** to win — which unlocks **Endless** mode.

![Title screen](docs/screenshots/title.jpg)

| Battle (wave 9: winged Metabolic Boost Zerglings) | Shrike turret (Bunker Lv3) |
|---|---|
| ![Battle](docs/screenshots/battle.jpg) | ![Shrike turret firing](docs/screenshots/shrike.jpg) |
| **Zerglings: base, Metabolic Boost, webby skin — and a Roach spitting acid** | **Endless armory (roster panel)** |
| ![Zergling tiers and a Roach](docs/screenshots/zerglings.jpg) | ![Endless armory](docs/screenshots/armory.jpg) |

![Console with StarCraft II button art: Infantry Weapons Lv2, Magfield Accelerator, research chips, Shrike overdrive, Super Stimpack](docs/screenshots/hud.jpg)

## Running the game

**Play online:** <https://nam-usth.github.io/defense-of-the-dominion/> — published by GitHub Pages on every push to `main` (`.github/workflows/pages.yml`; only `index.html`, `css/`, `js/`, `assets/models/`, `assets/ui/` and `assets/audio/` go online). The repository settings must have **Pages → Source: GitHub Actions**.

On the web the StarCraft II assets (4.8 MiB gzipped) load in priority order — the bunker, then the Zerglings and the Marine, then the Roach, Viking and nuke, then the rest (`LOAD_STAGES` in `js/config.js`). The title screen shows the progress, and its start buttons wait for the first two stages (or *start now* skips the wait); everything else streams in while you play.

To run it locally you need a desktop browser with WebGL 2 (Chrome, Edge or Firefox) and, for the local server, Node.js 18 or newer.

```bash
npm start
```

Then open <http://localhost:8080>. To use another port: `node tools/serve.mjs 3000`.

Any static web server works (for example `python -m http.server 8080`). Opening `index.html` straight from disk is **not** enough: browsers block loading the 3D models over `file://`, and the game then falls back to simple procedural shapes.

An internet connection is needed for three.js (loaded from a CDN). The UI fonts also come from Google Fonts; without them the game uses system fonts.

## How to play

New players get a **tutorial**. The first game opens with a **HUD tour**: the HP and ammo bars, minerals and gas, then each command-card button in turn are spotlit (the rest of the screen dims) with what they do — BACK / NEXT, and **OK, LET'S ROLL** on the last page. After that, the first time something new happens (out of ammo, a cleared wave, an upgrade you can afford, room in the roster, the first Roach, the nuke, a damaged bunker, the Stimpack and, once Super Stimpack is researched, its autocast) the game pauses on a short hint that spotlights the control it is about. On a narrow screen the tour skips buttons that do not fit. Each shows once; **Menu → TUTORIAL** turns the hints off, starts them over or runs the tour again. **HOW TO PLAY** on the title screen has all the rules on one card, and its HUD TOUR button.

- **Campaign** — clear wave 15 (a bigger final assault) to win. Winning unlocks Endless for good (stored in the browser).
- **Endless** — no wave limit. Past wave 15 the swarm keeps growing, and so does the bunker: every wave adds **+5% damage, +60 max HP, +10% repair speed and +2 rounds** (the ∞ chip on the console shows the total; the damage, hull and ammo tooltips list it too). Your best wave and score are shown on the title screen.
- **Endless armory** — in Endless the roster panel (B) also sells repeatable upgrades for the minerals and gas that pile up once everything is researched: **Hull plating** +150 max HP, **Weapon tuning** +10% damage, **Magazine** +15 rounds (half a starting magazine), **Fleet logistics** airstrike and nuke cooldowns ×0.9 (down to 40%, i.e. an 8 s airstrike and a 6 s nuke). Each purchase costs 30% more (the Magazine 15%, so it can keep growing) than the last of its kind; the ROSTER button pulses between waves when you can afford one.
- **Shooting** — each click fires one volley: every Marine and Ghost in the bunker shoots once at the cursor (the Marauders fire on their own, below). One volley costs one round of ammo. **Hold** the button for full auto: after 0.25 s it fires a volley every 0.1 s wherever the cursor is, until you let go or the magazine is empty. The damage numbers ride above each Zerg's HP bar as a two-row queue: a new hit comes in just over the bar and pushes the older one up, and the one pushed out fades (Menu → Settings → DAMAGE NUMBERS hides them; the HP bars still show the damage). In the rain some rounds miss (see **Weather**).
- **Ammo** — when the magazine is empty, press **R**: a Viking fires an air-to-ground missile at every enemy cluster and drops an ammo crate, which one of your units (the one you elected in the roster, else a Marine if one is free) runs out to fetch — at night with a twin white LED pod on its chest armour, two soft hot spots in one soft glow and a soft pool of light on the ground ahead with no edge anywhere, like the Marines' flashlights in StarCraft II, and a real spot light that lights the hull, the Zerg and the rocks it faces. The bunker blocks it (a cylinder fitted to its walls): a runner coming home lights the hull it faces, not the ground, Zerg or rocks behind it, and the pool on the ground is cut by the same shadow. The missiles leave the muzzles of its two launcher tubes (either side of the nose) in turn, run ahead, then dive on their targets, homing on the lead Zerg, with an exhaust flame, a light streak and a smoke trail. Ammo is also restocked after every wave by a supply crate — **one crate per wave**: if the Viking's crate is still on its way when the wave ends (its missiles killed the last Zerg), the next wave waits for that crate instead of a second one, and if it already came in this wave, the magazine is refilled on the spot.
- **Resources** — kills and cleared waves pay minerals ◆ and vespene gas ▲.

### Units (bunker roster, 6 slots — press B)

| Unit | Slots | Cost | Strengths | Research |
|---|---|---|---|---|
| Marine | 1 | 50 ◆ | balanced | Six Marines in the bunker unlock **Stimpack** (T): 11 s of +50% fire rate for the Marines and Marauders, for 10 HP per Marine and 20 per Marauder, paid by the bunker. **Super Stimpack** (250 ◆ 150 ▲, Nova's Marines) makes it free and repairs the bunker 6 HP/s while it lasts, and its tiers (200 ◆ 80 ▲, 320 ◆ 130 ▲, 500 ◆ 200 ▲) bring the Marines Stimpack needs down to 4, 2 and 1 — at the last a Marine or a Marauder, so even three Marauders can stim; and right-clicking STIM then turns on **autocast**, as in StarCraft II: it stims whenever you fire, a gold light running round the button's border — on top of the Lv3 hull's self-repair, so 31 HP/s with both (the HP bar shows the current rate). With the Shrike turret, six Marines also **overdrive** it: 2.5× rate of fire, red rounds |
| Marauder | 2 | 150 ◆ 25 ▲ | ×1.2 damage, +100% vs armored (Roach). It fires on its own, not with the volleys: a punisher grenade every 0.7 s each (stimmed: 50% faster) at enemies within 14, and every 3 grenades (the Marauders' together) cost 1 round of ammo — out of ammo, they stop too. Each aims at an enemy in sight (at night: lit, or a Sensor Tower blip; none in sight: it holds its fire): the nearest one not slowed yet and outside the blasts already on their way (the grenades in flight), else the nearest not slowed, else the nearest outside them, else the nearest — so the slows spread over the swarm. Stimpack stims them too (20 HP each): their grenades come 50% sooner. The grenade, drawn as the Viking's missile with its flame and light streak, is a small weak light (reach 2.4) that lights the ground and the Zerg it passes and lifts the night around it, so Zerg out in the dark show as it flies by; its burst lights the blast brighter for 0.35 s (up to 8 such lights, in the radial-fog shader chunk, which the particles honour too). It bursts on the first enemy in its path or on its target point: everyone else within 1.5 takes half the round's damage (double vs armored), and all of them slow to 70% speed for 1.5 s. The burst is a small ball of light with a few sparks over a soft glow on the ground across the blast radius (no edge, gone in half a second) | Concussive Shells — the blast slows to 40% speed for 2.5 s, and the grenade's flame, streak and burst turn icy blue, as in StarCraft II; tiers widen the blast (radius 2.0 / 2.6 / 3.2) |
| Ghost | 2 | 200 ◆ 50 ▲ | ×1.4 damage, +150% vs light (Zergling) | Snipe — auto-snipes the biggest threat; cooldown 8 → 6 → 4 → 2.5 s |

Dismissing a unit refunds 75%. Units fight from inside the bunker; you see them (StarCraft II models, walking) when one runs out to fetch a supply crate — the one you elected (click it in the roster: a gold border and a little crate in its corner; click again for any unit), else a Marine if you have one. A hint introduces each unit type the first time it fights, and the roster hint sums up all three. The research and armory cards keep one height whatever their text (three lines). Only one unit leaves at a time, for one crate per wave. The bunker's HP is the squad's health: the Stimpack is paid from it, and only the Lv3 self-repair and Super Stimpack restore it.

### Enemies

- **Zergling** — light and fast, from wave 1; it bites the hull with its StarCraft II attack animation. From wave 8 it has **Metabolic Boost**: the winged model, 60% faster (SC2: 4.13 → 6.58); from wave 12 it wears the "webby" skin. Drawn at 0.8× its SC2 size so it reads smaller than the Roach.
- **Roach** — armored and tough, from wave 4. A ranged attacker, as in StarCraft II: it stops at range 4 from the hull and spits acid (damage lands when the glob hits). Its skin changes as the waves get harder: brown (wave 4), grey with green glow (wave 9), black with orange glow (wave 13).

### Upgrades (command card, keys 1–4)

| Key | Upgrade | Per level |
|---|---|---|
| 1 | Weapon damage | +60% damage |
| 2 | Bunker armor | damage taken (bites and acid) × 1/(1 + 0.35·level) |
| 3 | Bunker hull | +250 HP. **Lv2** adds the Neosteel frame; **Lv3** mounts the **Shrike turret** (auto-targets, twin barrels = 2 extra marines, no ammo; overdriven by a full Marine squad) and self-repair (25 HP/s; stacks with the Super Stimpack) |
| 4 | Ammo storage | +10 rounds |

The command card and the upgrade chips use StarCraft II button art that follows the level: Infantry Weapons Level 0 → 3 for damage; Magrail Munitions (Lv0–1), Magfield Accelerator (Lv2) and Enhanced Munitions (Lv3) for ammo; Fleet Calldown for the airstrike, the co-op nuke, the Detector eye for the view. Research has its own art (Super Stimpack — which also replaces the STIM icon once researched —, Explosive Shrapnel Shells for Concussive Shells, Laser Targeting System for Snipe), and the Shrike turret shows as a Hi-Sec Auto Tracking chip that pulses red in overdrive.

The **nuke** (N) unlocks at wave 5: a two-second warning, then the warhead streaks down the targeting laser from the sky, trailing one straight white-hot streak as in StarCraft; huge blast radius, 15 s cooldown. Its blast is StarCraft II's, timed from SC2's own (`Nuke.m3`) on one closed-form timeline (`nk` in `js/game.js`, as the desktop's `nuke_fx.h`). The flash whitens the field in 25 ms, brightest round ground zero, and is mostly gone by 0.3 s; the ambient light, the fog and the fireball's light surge with it, and for a moment afterwards the field dims a little round the fireball, as if the eyes were dazzled. It is drawn over the scene, under the HUD, which stays clear (the desktop blows the field out through its exposure instead). A six-rayed star opens flat over the flash, and SC2's glow cards swell into a soft ball of light round the fireball, which rolls straight up into the mushroom cloud. The cloud is one vortex ring of cauliflower billows: each rides round the ring's tube, up the inside, out over the top and under at the rim, so from above the cap's surface flows out from its heart and curls over at its edge. It burns white-yellow and orange all over, its billows soft-edged like glowing gas; then soot takes the billows' crowns while the fire glows on in soft patches in the hollows between them, sinking into the heart and deepening to red. From above it reads as a hot heart, the rolling ring and a darker sooty skirt. As in SC2 it is all gone by about 5 s: the soot breaks up and dims out with the fire, and no grey cloud lingers. Embers keep rising off the crater until 9 s. A pale condensation ring flashes out round the cap's foot, sparks spiral up and out off its rim, SC2's three rings of fire roll faintly under it, and by day the cap's soft shadow, cast away from the sun, shows its height. The cloud thins where it hangs between the camera and the bunker. The air bends: a shock bubble swells out to the kill radius, a ripple runs over the ground behind it, and heat shimmers round the cap and over the crater until about 12 s. While a blast is young the HDR composite bends the scene by the haze. Without the HDR targets the scene is copied and redrawn bent where the haze is, and what stands in front of the haze is not bent. A ragged shock front races over the ground under a fading shock dome (33 units/s at the blast, past the kill radius at 0.7 s), a slow ring of burning ground spreads behind it (0.5–2.9 s), and a ring of dust with a burning leading edge rolls out past the kill radius. The Zerg within 3.5 of ground zero vanish in the fireball. The rest catch fire in the flash and run on, slowing and staggering, until the front flings them out, burning and charring, to bounce once and smoulder out where they land (no blood). The flames on the bodies share one budget: 40 bodies at full rate, 20 on GFX LOW. On LOW the cloud also has half the billows (larger), a third of the dust and half the sparks, with no shock dome, condensation ring or rings of fire, and the heat haze is worked out at a quarter of the resolution. The shock booms as it passes the bunker (sooner the closer the blast), then a long rumble. The blast leaves a small pit of scorched earth whose cracks open behind the front and glow deep red, cool and fade by 16 s (the last three are kept). Its fireball lights the field, and at night the dark lifts and settles back, out in the dark too. The fire covers the bright grass instead of adding light to it, which would turn it lime, and it never burns past pale yellow. The nuke's shaders are compiled at load, so the first nuke does not stall a frame. A round hitting a Zerg spurts a little of its blood out the far side, and a dying Zerg leaves a low splash of blood (sparks flung up and out read as fireworks). Below 50% HP the bunker starts to burn.

## Controls

| Input | Action |
|---|---|
| Left click | Fire a volley at the cursor |
| Hold left button | Full auto: a volley every 0.1 s (empties the magazine fast) |
| R | Airstrike + resupply (only when out of ammo) |
| N | Nuke (wave 5+) |
| T | Stimpack (six Marines in the bunker; fewer with Super Stimpack) — the Marines and Marauders fire 50% faster for 11 s |
| B | Bunker roster — hire units, research (pauses the game) |
| 1 · 2 · 3 · 4 | Upgrade damage · armor · bunker · ammo |
| Mouse wheel, + / − | Zoom in on the bunker / back out |
| Insert / Delete | Rotate the view 90° left / right (the view stays on the bunker) |
| Home | Reset the view |
| M or Esc | Menu (pauses), in tabs: GAME (save / load), SETTINGS (graphics, sound, damage numbers, day/night, weather), CONTROLS, TUTORIAL, ACHIEVEMENTS, CHEATS — ↑ ↓ switch tabs. On the title screen the SETTINGS button (beside HOW TO PLAY) opens it on SETTINGS |
| Q | Graphics quality HIGH / LOW |
| Y | Day/night cycle (experimental): a 3-minute cycle — day 78 s, dusk 24 s, night 54 s, dawn 24 s |
| K | Sound on / off |
| Enter, Space or Esc | Close a tutorial hint (a key the hint names, such as R or B, closes it and acts) |
| Enter / Space / →, ←, Esc | HUD tour: next page, previous page, end the tour |

Hover a command-card button for a tooltip with its cost, effect, and why it is disabled.

**At night** (Y) the light reaches only about 9 units from the bunker, and the Zerg come in from 13–15. The top bar shows the phase and the time to the next one (`☀ DAY  DUSK IN 0:42`, then `NIGHT IN`, `DAWN IN`, `DAY IN`). Tracers burn through the dark — white-hot in a soft halo over a faint pool of light on the ground — so a volley shows where it goes past the lit edge (every round from the bunker and the Shrike draws the same streak, so both are as bright); the nuke's laser, trail, reticle and warning ring glow in the dark too. The **Sensor Tower** research in the roster (B — needs no unit; 100 ◆ 25 ▲, then 175 ◆ 50 ▲ and 275 ◆ 100 ▲) shows Zerg in the dark as pulsing red **!** blips, without telling which kind, out to 10.75 / 12.5 / 16 units — lying flat on the ground under them, upright as the camera sees them — inside a glowing ring at its range marked with 12 small equilateral triangles pointing at the bunker, which fades in when researched, crossfades on an upgrade and follows the night out (each blip fades in as it crosses into range and out only as its Zerg comes out of the dark — well inside the lit edge, where the fog still leaves it 60% black, or in a Marauder grenade's light; until then the Zerg itself is not drawn, nor its HP bar, whose size and ARM / LGT badge would tell which kind, and it shows just as its blip has faded out — no gap, and no Zerg seen under a blip); the Shrike turret engages blips as it does Zerg in the light. Its icon is a placeholder radar glyph until the StarCraft II button art is exported. An airstrike (R) called at night also drops a **Viking flare**: for 7.5 s it lifts the darkness enough to show the whole field; a nuke's fireball lights it for a few seconds as it cools.

## Achievements

27 achievements worth 600 points (StarCraft II's 10 / 20 / 30 / 50), in five categories:

| Category | Achievements |
|---|---|
| Campaign | Boot Camp (finish the HUD tour) · First Blood · Hold the Line (wave 5) · Dig In (wave 10) · The Dominion Stands (win the campaign) |
| Endless | No End in Sight (wave 20) · The Swarm Grows (25) · Legend of Korhal (30) |
| Combat | Exterminator (100 kills in a game) · Four Stars (GENERAL in a game) · Veteran (1,000 kills in all) · Hive Breaker (5,000 in all) · Nuclear Option (10 with one nuke) · Air Superiority (10 with one airstrike) · Shrapnel (5 with one Marauder grenade) · One Shot, One Kill (50 snipes in all) |
| Command | Fully Upgraded (damage, armor, hull, ammo maxed) · Shrike Online · Overdrive · Combined Arms (a Marine, a Marauder and a Ghost at once) · Super Soldiers (every Super Stimpack tier) · Eyes in the Dark (Sensor Tower 3) |
| Feats | Untouchable (a wave from 5 on without the Zerg damaging the bunker) · Last Stand (hidden) · Night Watch (a wave at night) · Band of Brothers (win without a Marauder or a Ghost) · No Air Support (win without an airstrike or a nuke) |

A pop-up below the top bar announces each one as it is earned, with a chime, over the roster and the menu too: one box with the icon, the name, what it was for, and the points large with the date. **ACHIEVEMENTS** on the title screen opens the full list, a tab per category, each achievement drawn as StarCraft II does: the icon, a blue panel with the name and what to do, and a box with the points and the date it was earned (`24 OCT 2026`) — or LOCKED, or the progress (`412/1,000`) for those that count across games. **Menu → ACHIEVEMENTS** shows them all as icons; the one under the cursor is shown as its full row. The results screen shows the (up to three) best the game earned.

**A cheat code turns achievements off for the rest of that game** (any code but `help`, before it takes effect): the top bar shows a red CHEATS chip (on screens wider than 1200 px), the results screen says so, and the game counts toward nothing — not even the lifetime kills (BOOT CAMP too: a tour finished in that game does not count). What was earned before the cheat stays earned. The flag is saved with the game, so loading does not wash it out; a save made before achievements existed has no flag, so its game earns none either (the chip reads OLD SAVE). What has been earned and the lifetime stats (kills, snipes) are stored in `localStorage` (`dotd_achievements`); two tabs of the game merge their records instead of writing over each other.

## Weather

The sky wanders at random on game time: clear for 80–170 s, then clouds roll in over ~18 s and stay 25–45 s, then a shower about half the time (40–90 s), else clear again; after a shower it mostly clears. Every new game starts clear, the first change 45–100 s in. A shower is a **drizzle** (few fine, short, slow drops, a light wind) or a **downpour** (dense long streaks falling nearly twice as fast, a stronger wind, the day darker), even odds, and every 15–30 s it may turn from one to the other; the strength also wavers a little as it falls. Clouds dim the sun and grey the light. The rain has its own sound (band-limited noise and the patter of drops, as loud as it is heavy).

- **The rain** has no per-drop state: each drop is a quad the vertex shader places from its index (a hash gives its place; the distance fallen and the wind's drift build up on the CPU, so a change of speed never makes them jump) — up to 12 000 streaks and 2 000 splash rings on GFX HIGH (5 000 and 800 on LOW) in a box over the field, fixed in the world. None fall close to the lens, and at night it shows only in the light.
- **The ground** soaks through after ~12 s of a downpour and the puddles fill over ~45 s more; once the rain stops it dries in about a minute under the sun (two under clouds) and the puddles seep away slower.
- **The aim**: in the rain 5% of the rounds from the bunker and the Shrike miss in a drizzle, 10% in a downpour (in between as the rain grows): a missed round flies on past its Zerg (it may hit one behind) and a pale blue MISS rises. Marauder grenades still burst; Ghost snipes, Viking missiles and nukes still strike. The status line names the shower and its miss chance when it starts.

Menu → Settings → WEATHER switches it off (the sky clears; stored, on by default). Cheat `rain`, in turn: a downpour now, a drizzle, clear.

## Saving

- **Menu → SAVE / LOAD** — one manual save slot.
- **Autosave** after every cleared wave — **CONTINUE** on the title screen (also a checkpoint after the bunker falls).
- A save made during a wave restarts that wave; a save made between waves resumes at the next one.
- Everything is stored in the browser's `localStorage`: `dotd_save_v1`, `dotd_autosave_v1`, `dotd_endless_unlocked`, `dotd_endless_best`, `dotd_volume`, `dotd_muted`, `dotd_music`, `dotd_tutorial` (hints on / off and which ones were seen), `dotd_dmg_numbers`, `dotd_weather`, `dotd_achievements` (what has been earned, and when, and the lifetime kills and snipes).
- A save also records whether a cheat was used in its game (and whether an airstrike or nuke was called, or a Marauder or Ghost hired, for the achievements); a save made before achievements loads as OLD SAVE and earns none.

## Cheat codes

Type `dotd` during play to open the cheat console. `help` lists the codes in the console itself. Any code but `help` turns achievements off for the rest of that game.

| Code | Effect |
|---|---|
| `mng` | 7500 minerals + 7500 gas |
| `mineral` / `gas` | +500 minerals / +500 gas |
| `fu` | damage, armor and hull maxed (Shrike turret + self-repair) |
| `siege` · `bunker` | damage maxed · HP + armor maxed |
| `sensor` | Sensor Tower maxed (blips out to 16) |
| `terran` | hire 2 Marines |
| `medic` · `immortal` | full repair · 99999 HP |
| `korhal` | reset airstrike and nuke cooldowns |
| `swarm` · `roachwave` | spawn 10 Zerglings · 5 Roaches |
| `wave` · `zergrush` | finish the current wave · jump ahead 5 waves (stops at the final wave in Campaign) |
| `airstrike` · `nuclear` · `kaboom` | 5 airstrikes · 3 nukes · a strike on every enemy |
| `general` | +280 kills (rank General) |
| `rain` | a downpour now (again: a drizzle, then clear) |
| `endv` · `endd` | win the campaign · lose the bunker |

## Graphics

The field, its light and its weather are the desktop game's, with the same shaders and the same textures.

- **The ground** is drawn by a shader from three tiling 512² maps in `assets/textures/`: a noise for the broad patches of grass and dirt, single grass blades and pebbles on crumbly earth for the close-up detail (R height, G tone, BA slope). No part of the field repeats visibly and no mesh or quad is involved. The maps come from the desktop game, so both editions draw the same field: `dotd --dump-ground assets/textures` writes them again. They are data, not pictures: all four channels are read straight, with no colour conversion and no premultiplied alpha (in Chrome they read back from the GPU identical to the PNGs, texel for texel). Until they load the field is a flat colour.
- **3D grass**: 7 500 tufts of four blades out to r 30 (one mesh, 90 000 triangles), each taking the colour of the ground at its root and swaying in slow gusts. There are none on bare earth, in water or where a nuke has scorched the field.
- **The light**: a lower sun, soft cloud shadows drifting with the wind, ambient by which way a surface faces, the sky mirrored on polished surfaces. At night the field fades to its own moonlit value instead of going black.
- **Boulders**: three shapes chiselled from a sphere by 16 random planes, with creased ridges, shaded as stone on HIGH (the ground's maps projected on three axes, lichen on the faces turned up), each on a soft contact shadow.
- **Rain on the ground**: the field darkens as it soaks and water stands where the ground is low, mirroring the sky, with the rain's rings on it. It dries slowly once the rain stops.
- **HDR**: the scene renders into a float target (R11G11B10F, RGBA16F if refused) with 4x MSAA on HIGH; a bloom chain and a hue-preserving tone curve composite it before the HUD, and the nuke's heat haze bends the scene there. Without float targets (WebGL 1) it draws straight to the canvas.
- **GFX LOW** turns off shadows, MSAA, the grass and the cloud shadows, draws the field from its broad layers alone in the same tones, and drops HiDPI.
- **Frame rate**: 4x MSAA costs an integrated GPU about 10 ms a frame, so under 45 FPS for 8 s HIGH gives it up for the session and the console says so. The renderer asks the browser for the discrete GPU on a hybrid laptop. On an Iris Xe at 1280×720 in a swarm, vsync off, HIGH runs at 49–60 FPS without MSAA (about 36 with it) and LOW at 84–148; before these graphics the same scene ran at 57–79 and 113–118. That chip's speed swings with its heat.

## Project structure

```
index.html              page markup (top bar, console, menus) — loads the scripts below in order
css/hud.css             all styles
js/lib/obj-loader.js    minimal OBJ parser (THREE.OBJLoader) — for the bunker, Shrike and Viking
js/radial-fog.js        fog measured as distance from the bunker (the night vision circle), and the light's shared patches: cloud shadows, ambient by facing, sky reflections
js/config.js            game constants (CFG), model and texture paths (ASSETS), ranks
js/model-loader.js      loads GLB/OBJ models, DDS/JPG textures and baked walk/attack animations; SC2 team colour and normal maps
js/game.js              the game: scene, units, waves, combat, effects, HUD, menus, saving
assets/models/terran/   bunker, Shrike, Viking (OBJ) · Marine, Marauder, Ghost, nuke, grenade (GLB, not loaded) — models and textures
assets/models/zerg/     Zergling (base, Metabolic Boost, webby skin) and Roach (three skins) — GLB models and textures
assets/ui/              HUD icons (PNG, converted from SC2 DDS)
assets/textures/        the ground's three tiling maps (PNG, from the desktop game: see Graphics)
assets/audio/           music: the StarCraft soundtrack, AAC
assets/source/m3/       the original .m3 files of the converted models (and unused effect models)
assets/source/terran/   extra model parts and a GLB that the game does not load
tools/serve.mjs         zero-dependency local web server (npm start)
.github/workflows/pages.yml   publishes the game to GitHub Pages
tools/import-sc2.mjs    converts/copies the imported SC2 models, textures and icons
tools/m3.mjs            .m3 reader (mesh, materials, skeleton, animation)
tools/m3-to-glb.mjs     .m3 → .glb, bind pose and baked animations in one file (what the game loads); --check validates a .glb
tools/m3-to-obj.mjs     .m3 → .obj, bind pose or a baked animation; lists a model; prints attachment points
tools/dds-to-png.mjs    .dds → .png (DXT1, DXT5, uncompressed)
tools/dds-resize.mjs    shrinks a .dds by dropping its largest mip levels (1024² → 512²)
tools/encode-music.mjs  any audio Chrome can play (FLAC, WAV, MP3…) → AAC .aac, with Chrome's own encoder
docs/screenshots/       images used in this README
```

The scripts are plain (non-module) scripts that share globals, so their order in `index.html` matters. When you change a CSS or JS file, bump its `?v=` number in `index.html` so browsers do not keep serving the cached copy.

## Using StarCraft II models

Every model in the game is a StarCraft II model with its own textures: the bunker (base textures, plus the upgrade texture on the Neosteel frame), the Shrike turret, the Marine, Marauder (Black Ops), Ghost (Black Ops body, Covert Ops texture), Roach (base, ex1a and ex3 skins), Zergling (`Zergling.m3`, and `ZerglingUpgrade.m3` for Metabolic Boost with its base and webby skins), the Viking and the falling nuke.

Known issue: the Marine texture on hand (`marine.dds`, `marine_normal.dds`) does not match the UV layout of `Marine.m3`, which asks for `marine_diffuse_blood.dds` and `Marine_Normal_Blood.dds` — the rifle shows the backpack panel. Extract those two and point the Marine's `TEXTURES` lines in `import-sc2.mjs` at them.

The `.m3` and `.dds` files come from the game's CASC archive (extract them with a CASC tool such as CascView). No Blender is needed: the tools in `tools/` read `.m3` directly. (The bunker, Shrike turret and Viking are older Blender conversions; their `.obj` files are kept as they are and the importer does not rebuild them.)

The SC2 models are stored as **GLB** (binary glTF): the bind pose and every baked animation frame in one file, with the frames sharing a single set of UVs and triangles. Positions and normals are packed with the standard `KHR_mesh_quantization` extension — positions as 16-bit integers inside the model's box (a step of about 2·10⁻⁵ model units), normals as 8-bit (under 0.3°) — and the game expands them to float32 when it loads them (`--float` on `m3-to-glb.mjs` writes plain float32 instead).

| The 8 SC2 models as | Files | Gzipped | Load + parse |
|---|---|---|---|
| OBJ text | 14.1 MiB, 17 files | 3.3 MiB | 528 ms |
| GLB, float32 | 3.9 MiB, 8 files | 2.2 MiB | 49 ms |
| GLB, quantized (used) | 2.1 MiB, 8 files | 1.1 MiB | about the same |

The frame rate does not depend on the format: once loaded, every version gives the same geometry on the GPU (checked vertex by vertex — the largest differences, 5·10⁻⁵ for OBJ text and 1.7·10⁻⁵ for the quantized GLB, are rounding). With the textures cut to 512² the whole site is 4.8 MiB gzipped (it was 11.2); on a connection throttled to 200 KB/s the bunker is ready after 14 s, the game can start after 25 s and everything has loaded after 61 s.

```bash
node tools/import-sc2.mjs D:/sc2-extract
```

`import-sc2.mjs` lists every file it imports. For each model it writes a `.glb` with the bind pose and, for units, the animations the game plays baked into frames (Walk; Roach and Zergling also Attack; 8 frames each, 32 for the Zergling's two-second walk of four gallops); it copies the textures under the names `ASSETS` expects (1024² maps cut to 512² by `dds-resize.mjs`: the units are a few dozen pixels tall and the bunker covers about 250 px even at full zoom, so nothing visible is lost while the site loads half as much), converts the HUD icons to PNG and keeps the `.m3` in `assets/source/m3`. To bring in a new model, add a line to its lists and an entry to `ASSETS` in `js/config.js`.

The individual tools:

```bash
node tools/m3-to-obj.mjs Roach.m3 --list                 # regions, textures, animations
node tools/m3-to-glb.mjs Roach.m3 roach.glb --anims Walk,Attack            # bind pose + 8 frames of each animation
node tools/m3-to-glb.mjs Zergling.m3 zergling.glb --anims Walk,Attack --frames Walk:32,Attack:8
node tools/m3-to-glb.mjs --check roach.glb               # validate a .glb
node tools/m3-to-obj.mjs Roach.m3 roach.obj              # the same as OBJ text (textured regions only; --regions 0,2 to pick)
node tools/m3-to-obj.mjs Roach.m3 roach_walk.obj --anim Walk --frames 8
node tools/m3-to-obj.mjs Roach.m3 --point "Ref_Head" --anim Attack --at 420   # where the acid leaves
node tools/dds-to-png.mjs icon-gas-terran.dds icon.png   # --size 32 to resize, --channel a to inspect a mask
```

`ASSETS` entries (see the comments in `js/config.js`):

- `glb` — the model file; several entries can share one (the Roach and Zergling skins), it is parsed once. `obj` (+ `walk` / `attack` frame files) still works for OBJ models, and is the fallback if a GLB fails to load.
- `tex: { diffuse, emissive, normal, normalY }` — DDS textures are flipped to match the model UVs automatically (GLB and OBJ store UVs the same way). `meshTex` overrides them for one mesh (the bunker's upgrade frame).
- `unitScale: SC2_SCALE` keeps SC2 models in their real proportions to the bunker; `scale` instead sets the size of the largest dimension.
- `teamColor` tints the team-colour mask SC2 stores in the diffuse alpha (Terran blue, Zerg red).
- `stride` — the distance one loop of the baked walk cycle covers (SC2 movement speed × loop length), so feet keep pace with the ground; `ANIM_SPEED` (1.25) then plays every walk and attack cycle a little faster, which looks livelier at the game's slower move speeds. The frames themselves are the GLB's `Walk_k` / `Attack_k` nodes (an OBJ model names separate `walk` / `attack` frame files instead). Attack timing lives in `ROACH_ACID` (spit, mouth position) and `ZERGLING_BITE`.
- `normalY: -1` (inside `tex` or a `meshTex` entry) — SC2 normal maps are DirectX-style (green points down), except some newer ones such as the Marauder Black Ops map, which are OpenGL-style.

Enemies are drawn as instances — one instance buffer per animation frame (walk and attack), frames nobody is on are skipped — so even 120 animated Roaches take only a few draw calls.

The Marauder's punisher grenade was the mesh of `MarauderMissile.m3` (body and fireball, still in `assets/`), but without its texture (`Autoturret.dds`, not extracted) its fireball and particle trail read as a coarse tail, so it is now drawn as the Viking's procedural missile. The Roach acid (`RoachMissile.m3`, `RoachMissileImpact.m3`) is a pure particle system whose textures (`GooSplat_1.dds`, …) are missing too, so the glob and splash are drawn with the game's own particles. Not used yet, for want of their textures: the Marauder slow (`Lightning_DrkBlue.dds`), the nuke explosion (`firecloud2.dds`, `Fireball_10.dds`, `LargeSmoke2.dds`, …) and the falling nuke's smoke (`CloudSingleBlend.dds`, `Glow_Haze1.dds`). The grenade's own particle textures (`Fireball_10.dds`, `FireTail2.dds`, `ConcussiveSmoke1.dds`) are missing as well.

## Technical notes

- **Rendering** — three.js r128 from a CDN, no build tools. Enemies and bullets are `InstancedMesh`es and all particles live in two `THREE.Points` buffers, so a 140-enemy late-game fight takes about 20 draw calls.
- **Timing** — gameplay runs on a game clock with its own scheduler: pausing freezes everything, and restarting or loading drops pending events (wave countdowns, airstrikes, nukes).
- **Night** — the fog shader is patched to measure distance from the bunker, which gives the night mode its circle of vision. Dusk and dawn ease the night level in and out (smootherstep, no jump in the level or its rate); the fog radius shrinks by the same ratio every second (a geometric blend, 90 → 9 units) and the sun turns orange on the way, so the night closes in evenly instead of all at the end. Switching the cycle on or off blends over at most 2.5 s.
- **Sound** — the effects are synthesized with the Web Audio API (no audio files). The music is the StarCraft soundtrack by Glenn Stafford (`MUSIC` in `js/config.js`): *StarCraft Main Title* on the title screen, *Terran One*, *Two* and *Three* in turn during a game, *Terran Victory* / *Terran Defeat* on the results screen. The tracks are AAC 96 kbps (12 MiB in all), streamed by an `<audio>` element that only downloads the track it plays, through the same master volume and mute as the effects; the menu's MUSIC switch turns it off. Browsers allow sound only after the first click or key, so the title music starts then. To change a track: `node tools/encode-music.mjs "Terran One.flac" assets/audio/terran_one.aac` (or `ffmpeg -i in.flac -c:a aac -b:a 96k out.aac`).
- **Hologram** — the bunker portrait is a 2D-canvas projection of the model's edges and follows the bunker's upgrade stages.
- **SC2 materials** — one shader patch (`ModelLoader.teamColor`) handles the team-colour mask and rebuilds Z for SC2's two-channel (DXT5nm) normal maps.
- **Animation** — `tools/m3.mjs` decodes the skeleton and the bone tracks of an animation sequence; `m3-to-glb.mjs --anims` (or `m3-to-obj.mjs --anim`) skins the mesh offline into frames, so the game needs no skeletal animation at runtime: each frame is one more instance buffer.

## Credits

Non-commercial fan project — not affiliated with or endorsed by Blizzard Entertainment.

StarCraft® is a trademark or registered trademark of Blizzard Entertainment, Inc. The models, textures and icons in `assets/` (and the `.m3` sources in `assets/source/`) are © Blizzard Entertainment, Inc., all rights reserved, extracted from StarCraft II for this fan project. The music in `assets/audio/` is from the StarCraft soundtrack by Glenn Stafford, © Blizzard Entertainment, Inc. The game shows the same notice on its title screen. They will be taken down at Blizzard's request.

The code (`index.html`, `css/`, `js/`, `tools/`) was written for this project. three.js is © the three.js authors (MIT).
