# FJORDFRONT

A first-person shooter that runs in the browser, set in **Kvitvika**, a fictional coastal settlement in Nordland, Norway. It mixes a Lofoten fishing village, a Nordfjord-style inlet, an industrial harbour and a WW2 coastal fort. 12 v 12 **Domination** against AI squads, on an autumn or winter version of the map.

Built with **Three.js (WebGL2) + TypeScript + Vite + Rapier**.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production bundle in dist/
npm run preview    # serve the production build
```

Use a desktop browser (Chrome, Edge or Firefox). Integrated graphics work too: on first launch the game picks a preset for your hardware, then adapts the render resolution to hold the frame rate. Click **DEPLOY** to start. The mouse is captured on click, and **Esc** pauses.

URL options: `?quality=low|medium|high|ultra`, `?weather=clear|overcast|rain|snow`, `?map=autumn|winter|random`, `?time=dynamic|dawn|day|golden|night`.

## Controls

| Action | Key |
| --- | --- |
| Move | W A S D |
| Sprint | Shift. Tap again while sprinting (or double-tap) for **tactical sprint** |
| Crouch / slide | C or Ctrl. Pressed while sprinting it starts a **slide**. Press again to slide-cancel. Jumping out of a slide keeps your momentum |
| Prone | Z, or hold C |
| Jump, mantle, vault | Space. Mantling and window/fence vaulting are detected automatically |
| Fire / aim | Left mouse / right mouse |
| Reload | R |
| Switch weapon | 1 / 2 / mouse wheel |
| Lean left / right | Hold Q / E. Peek round corners and over cover; the lean stops short of walls |
| Fire mode | B (auto / burst / semi on the K416 and KS-17) |
| Inspect weapon | Tap I. **Hold** for a magazine / chamber check |
| Lethal | G. Hold to ready, release to throw (frag cooks while held). Sticky grenade: hold to aim, release to throw. Claymore: hold to ready it, release to set it down. C4: tap to throw. Throwing knife: instant throw, walk over it to pick it up again (choose in the loadout) |
| Detonate C4 | Double-tap F, or G when you have no C4 left in hand |
| Tactical | T. Hold to ready (one-handed, you can keep firing), release to throw. Flashbang, stun, smoke, stim, snapshot or decoy (choose in the loadout) |
| Field upgrade | H. Trophy System, once its charge ring is full |
| Dolphin dive | Z while sprinting |
| Loadout in a match | Esc → LOADOUT (applies on next spawn, or right away if you just spawned) |
| Melee / combat knife | Tap V: quick melee with the gun. **Hold V**: draw the combat knife (left mouse = slash, right mouse = stab, V also attacks). 1 / 2 / mouse wheel puts the guns back |
| Ping | X or middle mouse. Enemy under the crosshair: marked for the team and called out. Anything else: a location marker |
| Killstreaks | 3 = UAV (phone), 4 = Mortar Strike (laser designator: aim, left click to call it, right click to cancel), 5 = Attack Helicopter |
| Doors | Walk into them to push them open, sprint into them to kick them open, or use F |
| Skip killcam | Space or left mouse |
| Use / spot | F. Clips onto a zipline in reach, opens or closes the door you are looking at (prompt under the crosshair), otherwise spots enemies. Space lets go of a zipline |
| Night vision | N. The left hand flips the goggles down (or back up) |
| Vault through a window | Space, facing the window close by (inside or outside): the whole window breaks |
| Performance overlay | F3 |
| Door peek | Aim down sights in front of a closed door: you ease it open a crack and lean round the edge |
| Hold breath (scoped) | Shift |
| Climb ladder | walk into it, W/S, Space to let go. From the top, walk over the edge towards the ladder to climb down |
| Tactical map | M. Scroll to zoom at the cursor, drag to pan, left click (or X) to ping, right click for a waypoint (right click it again to clear), R to re-centre. You can still move while it is open, but not shoot or aim |
| Scoreboard | Tab |
| Chat / commands (multiplayer) | Enter, or / for a command. `/help` lists them |
| Pause, settings, movement tuning | Esc |

## Features

**Movement** (`src/player/`)
- Momentum-based ground and air control, plus coyote time and jump buffering.
- Walk 4.7 m/s, sprint 7.0 m/s, tactical sprint 8.6 m/s with stamina.
- Slide: speed boost, friction, downhill acceleration and steering. You can slide-cancel or slide-jump.
- Mantling (ledge detection plus a clearance check) and vaulting through windows and over fences.
- Crouch and prone with headroom checks, using a Rapier kinematic capsule with autostep and snap-to-ground.
- Camera: footstep-synced bob, strafe and slide roll, sprint/slide FOV changes, landing and mantle springs, and a trauma-based shake.

**Weapons** (`src/weapons/`): Stille-9 suppressed SMG, MP-18 machine pistol, KVL-7 LMG, K416 carbine, MP7 PDW (flip-up notch-and-post irons, folding foregrip), Pump-12 shotgun, SKV .338 bolt-action sniper with 6× scope, and the P80 pistol.
- Detailed procedural models with separate moving parts: bolt carrier, charging handle, trigger, slide, pump, bolt handle and detachable magazines. Optics are a see-through red dot and a holographic sight.
- First-person arms with gloved, articulated fingers and two-bone IK onto each weapon's grip sockets.
- Procedural animation: exact ADS sight alignment, hip, sprint, tactical sprint, slide and crouch poses, and spring-based sway, bob, recoil and landing.
- Keyframed tactical and empty reloads (bolt catch, slide release, charging handle), shell-by-shell shotgun loading, pump and bolt cycling, inspect, and draw/holster.
- Gunplay:
  - hitscan with per-weapon RPM, damage falloff, and head/limb multipliers;
  - recoil patterns with partial recovery, plus hip spread, movement spread and bloom;
  - wall penetration through wood, glass and sandbags, and breakable windows.
- Effects: muzzle flash with dynamic light, tracers, ejected casings with bounce sounds, surface-dependent impact particles, and decals.

**Map** (`src/world/`)
- A variable-resolution terrain mesh (dense in the 370 m play area, out to 3 km of mountains).
- A splat- and triplanar-blended PBR terrain shader with height blending, anti-tiling, snow caps and a wet shoreline.
- Fjord water with planar reflections, skerries, and the far-shore massifs.
- Buildings with enterable interiors (stairs, upper floors, furniture): red, white and ochre board-and-batten houses, rorbuer on stilts, a white wooden church with a steeple, the shop, two warehouses with catwalks, container yards, a harbour crane, an office, coastal-fort bunkers, a gun pit, barracks ruins, a radio mast, a barn, a boathouse, fuel tanks, and stockfish drying racks (hjeller).
- Roads with Norwegian markings and brøytestikker (snow poles), an arch bridge, a lit road tunnel through the ridge, a wooden footbridge, docks and piers with boats, a harbour quay with a trawler, cars, jersey barriers, sandbag nests, power lines and Norwegian flags.
- Instanced spruce, pine and birch forests (several thousand trees, wind-animated), boulders, juniper, and a streamed grass field.

**Graphics** (`src/render/`)
- Every texture is a PBR surface baked on the GPU at load time (grass, granite, forest floor, gravel, asphalt, painted wood, planks, concrete, corrugated steel, roof tiles, bark, camo fabric, gloves, weapon polymer and metal).
- A sky with layered clouds and sun; image-based lighting from the sky; exponential height fog with sun in-scattering.
- Texel-snapped sun shadows and N8AO ambient occlusion.
- Post-processing: optional camera motion blur, aim depth of field, bloom, AgX-style filmic tonemapping with a cool/neutral grade, vignette, chromatic aberration, film grain, and damage/suppression effects. SMAA anti-aliasing.
- Weather presets: broken clouds, overcast, and rain with rain streaks and fog sheets.

**Audio** (`src/audio/`): all sounds are synthesized at load time with `OfflineAudioContext`.
- Gunshots per weapon (blast, low thump, supersonic crack, action noise and mountain echoes), plus distant variants that arrive with a speed-of-sound delay.
- Reload foley, surface-dependent footsteps, impacts, whizzes and suppression.
- Ambience: wind, waves, rain, seagulls and songbirds.
- HRTF spatialization with distance filtering, and indoor/outdoor reverb.

**Game** (`src/game/`, `src/ai/`, `src/ui/`)
- Team Deathmatch: score limit 50, 10-minute timer.
- Spawns are chosen to stay away from enemies and out of their line of sight. Respawn has a death cam.
- AI bots:
  - Soldier rig with walk/run blending, upper-body aim and weapon IK;
  - a nav graph with A*; perception through FOV, line of sight and hearing; reaction time and aim error that settles over time;
  - burst fire, strafing, cover seeking, and three difficulty levels.
- HUD: score bar, compass with location callouts, health, ammo pips, a dynamic crosshair, hit markers, kill feed, kill notifications, damage direction indicators and the scoreboard.
- Menus: main menu with a live map flyover, loadout, settings (gameplay, graphics, audio), pause, and the end-of-match screen.

## Update 2

- **Arms:** skinned first-person arms ("fps arms" by DJMaesen, CC BY 4.0) driven by two-bone IK. Wrist frames and finger curl axes are derived from the bind pose, giving a C-clamp support grip and a wrapped pistol grip. There is a separate arm FOV.
- **Reloads:** rebuilt as authored, phase-based animations.
  - Tactical: unlatch, pull, stow, fetch, then hook and rock the new magazine in, then a palm slap.
  - Empty: the magazine drops free into the world and clatters on the ground, then a bolt-catch slap.
  - Pistol: slingshot on the slide. Sniper: bolt cycle.
  - Every seat and release adds a spring jolt.
- **Weapon life:** full-auto shake, settle after a burst, turn inertia, ADS foley and a low-ammo tick.
- **Game feel (MW2019-inspired):**
  - hitmarkers that pop and scale with damage, a red X on kills, gold on headshots;
  - layered hit, kill and headshot sounds;
  - a score ticker that accumulates kills;
  - medals: double/triple/fury kill, headshot, longshot, point blank, wallbang, revenge, comeback, first blood.
- **Sniper:**
  - a picture-in-picture 6× scope with a mil-dot reticle and blurred periphery;
  - breathing sway, with Shift to hold your breath (and a gasp when it runs out);
  - lens glint on enemy snipers aiming at you.
- **Ballistics:** player and sniper bullets are projectiles with travel time and gravity drop.
- **Bot hit reactions:** torso flinch, head snap, shove, aim disruption, and varied deaths (crumple, thrown back, twist).
- **Bot aggression:**
  - teammates share sightings;
  - squads move in buddy pairs;
  - bots push toward recent gunfire and pre-aim the last known position instead of tracking through walls.
- **Time of day:**
  - a solar model for Lofoten in autumn: dawn, midday, golden hour over the fjord, and night with moon, stars and animated northern lights;
  - Dynamic mode lets about 3 hours pass during a match;
  - sun and fog scattering follow the sun in real time.
- **Atmosphere:**
  - screen-space god rays;
  - drifting cloud shadows on the landscape;
  - lit windows and street lamps at night;
  - sun shafts through windows.
- **Interiors:** pendant, strip and high-bay fixtures (a pool of six point lights follows the player), rugs, bookshelves, pictures, chairs, tableware, plants. The docks get fish crates, buoys, nets and rope.
- **Audio:**
  - recorded CC0 footsteps and impacts (Kenney Impact Sounds);
  - interior floorboards sound different from outdoor decks and rugs;
  - room-aware reverb that switches between outdoors, small room, hall (warehouse) and tunnel.
- **HUD:**
  - a rotating radar minimap: allies always shown, enemies when they fire unsuppressed or are spotted;
  - E to spot enemies (red diamond marker);
  - nameplates over teammates.
- **Map flow:**
  - climbable ladders to the Lager 1 roof, the harbour office roof, the fuel tank and the harbour crane;
  - a cliff path up to the fort;
  - a second plank bridge over the inlet, with a river path.
- **Movement tuning panel:** Esc → Movement Tuning. Every movement constant can be changed live and is saved to localStorage.

## Update 3

- **Building access and collision:**
  - Every doorway, stairway, catwalk and bridge link is walked by an automated test (`tools/walktest.cjs`). All 82 now pass; at the start, dozens failed.
  - Walls are now cut correctly around stacked openings, so a door with a window above no longer leaves a solid block.
  - Back doors are mirrored correctly. Houses have a new layout with reachable stairs and furniture kept clear of entrances.
  - Entrance steps follow the real terrain under each door.
  - The fort bunkers now sit on the ground instead of under the terrain mesh.
  - The warehouse catwalk has a landing and a gap in the railing. The boathouse boat is out of the doorway.
  - Open shipping containers only face free space.
  - Harbour clutter stays out of building footprints.
- **Movement physics:**
  - Manual step-up for kerbs, sills and stairs up to 0.46 m.
  - Full walking speed on ramps and slopes. The controller used to project speed into the slope.
  - A grounded probe for rotated-box ramps such as the bridge decks.
- **Terrain:**
  - The tunnel approach no longer climbs over the ridge, which had left a hole beside the south portal.
  - The hillside can no longer rise through the road-bridge deck.
  - The footbridge and plank bridge now reach dry land. The plank bridge has side guards.
  - The far fjord walls and the south-east massif rise gradually instead of as flat vertical sheets. The distant terrain mesh is denser.
- **Level design:** dry-stone walls (steingarder) and boulder clusters give cover in the open fields between the village, farm and fort.
- **Dynamic spawns** (`src/game/SpawnSystem.ts`):
  - Candidates are the curated spawns plus safe nav nodes across the map.
  - A spawn is rejected if an enemy is standing on it, can see it, or is looking at it.
  - Scoring favours teammates and the friendly side of the current front line, and spawns near the action but not inside it.
  - Recent deaths and spawns are remembered, so spawn traps don't work.
  - Spawns flip as the fight moves, and the spawn yaw faces the fight while avoiding walls.
  - In a simulated match no spawn was visible to an enemy, and the median distance to the nearest enemy was over 100 m.
- **Viewmodel:**
  - Grips are anchored on the palm: each weapon defines its grip surfaces (pistol-grip axis, handguard axis plus radius), and the wrist is solved back from the palm measured on the rigged hand.
  - The support hand wraps under the handguard. Vertical foregrips use a power grip in the curled fingers.
  - The right thumb rests along the left of the receiver instead of clipping through it.
  - The shotgun support hand now rides the pump.
- **One-handed tactical sprint (MW-style):** the right hand swings the gun up beside the face, muzzle across to the left, canted and bouncing with the stride. The support arm leaves the gun and pumps in time with the steps.
- **Slide:**
  - The slide keeps its line while you look around freely.
  - Momentum goes burst, then glide, then bleed.
  - The camera drops and pitches into the slide, the lean overshoots, the weapon dips and cants, and you get a lift on exit.
  - Walking speed holds on ramps.
- **MP7 PDW** replaces the old SMG. It is built procedurally to real proportions (638 mm long, about 170 mm tall, 51 mm wide):
  - magazine in the raked pistol grip and a folding vertical foregrip;
  - twin-rod telescoping stock and an AR-style T charging handle;
  - ambidextrous selectors;
  - flip-up irons with a 230 mm sight radius. The ADS point is on the aperture centre and the hooded front post tip is on the same axis, so the irons line up exactly.
  - It has its own reload pose, with the magazine stripped from the grip. Saved loadouts move over automatically from the old `mpx` id.
- **Eliminations:**
  - A gold "ELIMINATED" banner pops in with an overshoot, a metallic sheen sweep and a flaring underline, plus a headshot badge, the victim's name and a ×N streak.
  - A layered confirm sound: sub drop, snap and shimmer.
  - A subtle FOV punch with a micro-kick, and a gold edge flash.
  - A heavier blood mist and dust burst at the victim.
- **Assets:** I searched for legally usable MP7 models and reference reload animations. The free MP7 models I found were under royalty-free or unclear licences, not CC0 or CC BY, and this build environment can't reach asset hosts. So the MP7 and all reload choreography are authored procedurally in code, and no third-party weapon assets were added.

## Update 4

- **MP7 rebuilt from the reference images.**
  - **Scale:** the side view was measured at 0.95 mm/px, calibrated on the 226 mm sight radius. At that scale the rail-to-grip height comes out at 173 mm, close to the real 169.5 mm.
  - **Body:** two-section matte-black receiver with side rails and cooling slots on the nose, and a folded foregrip flush under the front. The magazine sits in a near-vertical grip and has a forward-extended baseplate. The thin trigger guard and ambidextrous selector match the reference.
  - **Rear:** a bolt release lever on the left, a hexagonal rear end cap with a QD boss, a wide T charging handle with ribbed tabs, and a solid adjustable stock with a tall butt and lock button.
  - **Iron sights, as in the references:** the rear is a spring-loaded base block, with the coil visible through a window, carrying a flat leaf with a square notch in the top centre. The front is a thin post between low protective ears. The ADS point is on the notch, level with the post tip, so the post sits in the notch exactly.
- **Reloads rebuilt** (`src/weapons/ReloadClips.ts`):
  - **System:** every weapon has its own authored clip. The support hand, both magazines (the one in the gun plus a separate fresh one), the weapon motion, finger poses, moving parts and foley events are all keyframed and smoothed with splines.
  - **No drift:** a magazine in the hand is attached rigidly to it, and hand poses on a magazine are derived from the magazine's pose. The magazine always sits in the palm and seats exactly in the well.
  - **Reach:** the shoulders lean in on long reaches, so the IK never falls short of a magazine.
  - **Framing:** chosen by projecting the magazine well, magazine, stock and optic into screen space, so the action stays in view and the stock leaves the frame.
  - **K416 and MP7 tactical (CoD style):** strip the old magazine and keep it in the hand, reach the pouch for a fresh one, and insert it with the old one tucked under the fresh one. The AR hooks the front lip and rocks the magazine in; the MP7 pushes straight up into the grip. Then a tap, stow the old magazine, and back to the grip.
  - **K416 empty:** the magazine drops free into the world. Fresh magazine, rock in, then palm the bolt catch.
  - **MP7 empty:** the magazine drops free. Fresh magazine into the grip, then thumb the bolt release.
  - **P80 tactical:** retention reload. The thumb drops the magazine into the support palm, which stows it, inserts a fresh one and palms it home.
  - **P80 empty:** drop free, fresh magazine, then an overhand slingshot on the slide.
  - **SKV .338 tactical:** strip and stow the box magazine, fresh one, palm tap.
  - **SKV .338 empty:** drop free, fresh magazine, then the right hand cycles the bolt while the left holds the forend.
  - **Pump-12:** keeps its shell-by-shell loading.

## Update 6

**Game mode**
- **Domination replaces Team Deathmatch.**
  - **Flags:** three flags (A, B, C) are picked each match from the landmark areas. B is balanced between the two team anchors; A and C are on each side.
  - **Capturing:** stand in a zone to capture. A neutral flag takes 7 s, an enemy flag 10 s and turns neutral halfway. More teammates capture faster, and any enemy in the zone contests it.
  - **Scoring:** every 5 s each team scores 1 point per flag held. First to 200 wins.
  - **HUD:** flag strip under the score bar, flag markers in the world with distance, flags on the radar, a capture bar inside a zone, and "SECURED / LOSING / ENEMY TOOK" announcements with stings.
  - **Spawns:** biased toward flags your team holds and away from enemy flags.
  - **Bots:** new *capture* and *defend* missions. They keep pushing to the flag while trading shots at range, hold the zone until it flips, defend threatened flags and mostly ignore distant noise while on the objective.
  - **Score reasons:** CAPTURED, NEUTRALIZED, OFFENSE and DEFENSE.

**Combat**
- **Killstreaks** (kills in a row; streak kills don't chain):
  - **UAV (3):** 30 s radar sweep.
  - **Mortar Strike (5):** three heavy rounds walk onto your crosshair point after a whistle.
  - **Attack Helicopter (7):** a 40 s gunship that circles the fight and fires on enemies it can see. It can be shot down.
  - **Bots** earn and use streaks too. An enemy UAV also tells the bots where you are.
- **Frag grenades:** two per life, cookable with a timer. They bounce and roll off walls. Damage falls off with distance, and walls between you and the blast absorb most of it. Throwing has a full viewmodel animation: grenade into the hand, pin pull, wind-up (held while cooking), throw. A HUD icon warns of nearby grenades, and bots lob frags at corners and run from live grenades.
- **Explosions:** fireball, flash, debris, shock ring, smoke column and a scorch mark. Close blasts cause camera shake and an ear ring with a muffled mix (tinnitus).
- **Melee:** rifle or pistol bash with a short lunge, one-hit kill.
- **Ballistics for every gun, bots included:** projectile travel time, drop, air drag per class, and wind drift. Wind drift is strongest on the .338. The scope shows the wind speed and direction relative to your view.
- **Doors:** 47 hinged doors in every doorway (front, back, interior, bunker). Walking into a door pushes it open away from you. Sprinting into one kicks it open with a slam, and anyone behind it takes a hit. Bots open doors the same way. A door is only solid while at rest, so it never traps anyone.
- **Inspect for every weapon.**
  - **Tap to inspect.** Each weapon has its own choreography:
    - Rifle: right side, ejection port, look at the optic, mag tap.
    - SMG: flip, side and underside.
    - Pistol: roll both ways, press-check.
    - Shotgun: loading port, half-rack.
    - Sniper: look along the scope, bolt flick.
  - **Hold for a magazine check.** The rifle, SMG and pistol replay the start of their authored reload: the hand goes to the mag, releases it and slides it out a few cm, you look at it, and it's seated again. The shotgun press-checks the pump. The sniper lifts and eases the bolt.

**Feedback**
- **Hit feedback:** blood spatter on the wall or floor behind the target, and a blood pool where they fall.
- **Damage feedback:** a view flinch away from the shooter, a heartbeat below 40 HP, and the whole mix low-passing as you get closer to death.
- **Killcam:** after you die, the last ~4 s replay from your killer's eyes. The bots are re-posed from recorded state, with a stand-in soldier for you, the killer's weapon in the viewmodel (ADS when they were aiming, scope zoom for snipers), and the recorded shots fired again. The killing shot plays in slow motion, and everything is restored afterwards. Skip with Space.
- **Acoustics:** gunshots and explosions that are blocked from the listener (for example, you are indoors and the fight is outside) are low-passed and quieter. This is on top of the room reverbs and the tunnel slap-back echo from the last update.
- **Footsteps and casings:** recorded snow footsteps and soft casing impacts on snow.

**Weather and map**
- **Wind:** a wandering direction and weather-dependent strength with gusts. It moves bullets, rain, snow and the fog.
- **Snow showers:** flakes drift with the wind, and showers come and go. **The snow settles on surfaces**: roofs, sills, car tops and the ground whiten, patchy first and then fully covered. It melts slowly afterwards. A top-down sky-occlusion map baked from the world keeps floors under roofs, the tunnel and the ground under the eaves clear.
- **Fog banks:** every few minutes a wall of sea fog forms over the fjord and rolls inland across the map with the wind, thickening the fog for whoever it engulfs.
- **Winter variant:**
  - **Look:** full snow cover, colder light, darker water, no grass.
  - **Sound and effects:** snow footsteps, and snow puffs from bullet impacts.
  - **Weather:** snow showers or cold clear skies.
  - **Choosing it:** Settings → Graphics → Map variant (random per match by default).

**Weapons and settings**
- **Weapon FOV and Arms FOV** are separate sliders. The arms FOV warps only the forearms and elbows (a depth-weighted reprojection), so the hands stay glued to the gun.
- **ADS FOV:** *Affected* scales the aimed picture with your FOV. *Independent* always uses the default 80° base.
- **MP7:** sprint and jump clutter reduced.
- **Rifle:** support hand moved so it no longer shows through the optic window.
- **Pistol:** hold reworked.

## Update 26: our own soldiers, built and animated from scratch

The stock three.js example soldier (and its 2.1 MB download) is gone. Every soldier is generated by the game: its own skeleton, body, gear kit and camouflage, animated procedurally every frame.

### The soldier (`src/character/`)

- **Modular body.**
  - A skinned body: torso, limbs, gloved hands with a finger group and thumb, and a head with jaw, cheekbones, nose, ears and eyes.
  - A skeleton with standard joint names, so the ragdoll, hit boxes, killcam and multiplayer all work unchanged.
  - Each soldier is **one skinned mesh**: one draw call and one shadow draw.
- **Fictional faction camouflage**, baked on the GPU and tileable:
  - **Kystjegerne** wear *fjordskog*: organic olive, forest-green, bark-brown and black blotches with light specks.
  - **Nordfront** wear *berg*: angular rock-splinter shards over fine rain dashes.
  - Both have winter versions on the snow map. Team armbands are kept for quick identification.
- **Role silhouettes from the weapon carried:**

| Role | Weapon class | Kit |
| --- | --- | --- |
| Rifleman | Assault rifles | Plate carrier, mag pouches, helmet with NVG mount |
| CQB | SMGs, pistols | Light chest rig, bump helmet or boonie with headset |
| Breacher | Shotguns | Heavy plates, shell bandolier, elbow and knee pads, breaching bar |
| Marksman | Marksman rifles | Boonie, rangefinder pouch |
| Sniper | Sniper rifle | Ghillie hood with burlap strands, drag bag, face paint |
| Gunner | LMG | Big pack, ammo pouch, heavier build |

- **Per-soldier variety**, chosen from a seed: build (height and width), skin tone, beard, balaclava, scarf or face paint, glasses or goggles, ear protection, helmet cover, rolled sleeves, glove and boot colours, pack type and pouch count.
- **Hands on the gun:**
  - Two-bone arm IK onto each gun's grip sockets.
  - The hands turn to match each grip, and the fingers curl round it.
  - The gun is placed so its sight sits in front of the right eye with the stock along the cheek, and the head cants onto the stock.
  - Holds (patrol, low ready, tactical sprint, reloads) pivot the gun in the firing hand.
- **Detail levels:**
  - Three mesh levels (≈12k / 3k / 1k triangles) with hysteresis. The nearer levels are built in the background while you're in the menu, not at load.
  - Past **150 m** every soldier becomes one instance of a camera-facing billboard (8 view angles × stand / two stride frames per faction), all drawn in **one draw call**. Through a magnifying scope they stay full models.
  - A pose costs 0.13 ms.

### Procedural animation (`SoldierAnim.ts`)

Nothing is keyframed in a file: the pose is computed from what the soldier is doing.

- **True 8-way (any-angle) locomotion:**
  - Feet follow gait trajectories along the actual direction of travel: planted, sliding back, lifted and carried forward.
  - Analytic two-bone leg IK turns the foot targets into hip, knee and ankle angles.
  - Walk, run and sprint blend continuously by speed (stride, lift, duty factor, bob, lean).
  - Hips turn into strafes and diagonals while the upper body keeps aiming; backpedalling keeps the hips forward.
  - A shuffle when turning on the spot.
- **Stances and moves:** crouch and crouch-walk (the same leg IK), prone and prone crawl (knees drawn up and out), slide, dolphin dive, ladder climbing (gun slung), mantle, lean (spine and head roll), airborne tuck. Families of poses blend per bone, so dropping prone or launching a slide eases between them.
- **Upper body:**
  - Aim twist and pitch spread over the spine.
  - Patrol carry, low ready while sprinting, muzzle-up one-handed tactical sprint, recoil kick.
- **Per-class reloads:** magazine (grip → well → pouch → well → grip), one shell at a time (pump and auto shotguns), bolt work, break-open, LMG box, revolver.
- **Other actions:** grenade throws (wind-up behind the head, release, recover, with the gun in the support hand), rifle butt-stroke, knife stab, weapon switch, deploying equipment.
- **Idle fidgets** while calm: looking around, shifting weight, checking the weapon, adjusting the helmet.
- **Shared by everyone:** bots, other players in multiplayer (and the killcam replay of them) and your own first-person legs all animate from the same 20-value pose (stance, sprint, slide, dive, ladder, mantle, airborne, lean, action and progress, velocity).

### Third-person details

- **Brass:** soldiers firing within 24 m eject casings (not pump, bolt, break-open or revolver).
- **Magazines:** soldiers drop their empty magazine onto the ground when reloading near you.
- **At night,** soldiers flip their NVGs down. Half of them run a white weapon light (a soft beam and lens glare); the rest use an **IR laser that you only see through your own night vision**.

### Other

- **Multiplayer pose snapshots** are quantised 16-bit integers (24 slots × 20 values in ~1.3 KB instead of ~2.4 KB of JSON text).
- **Not done yet:** bots don't yet choose prone, lean, slide or ladder moves themselves. Their poses exist (other players use them); the bot AI that picks them is Update 27.
- **Tested:**
  - 12 v 12 match.
  - Two-browser multiplayer.
  - Every gun (fire, reload, ADS, scope).
  - Ragdoll on the new skeleton, killcam, first-person legs, billboards at range, night gear.

## Update 25: performance overhaul (black flashes, loading, automatic scaling)

Every number below was measured in this project's own test setup: headless Chrome on a 4-thread cloud machine with a *software* GPU (SwiftShader). Anything the CPU does is roughly representative of a slow laptop. Anything the GPU does is many times slower there than on any real graphics card. The tools are in `tools/` (`loadtime.cjs`, `bootprof.cjs`, `frametime.cjs`, `simprof.cjs`, `allocprof.cjs`, `govtest.cjs`).

### The black flashes: what caused them and the fixes

- **Dynamic resolution was resizing the canvas.**
  - Every resolution step called `renderer.setSize`. Resizing a canvas clears it, and this happened right after the frame had been drawn, so the browser showed an empty (black) frame.
  - The low preset targeted 120 fps. On a 60 Hz screen that always read as "too slow", so it stepped down every 1.2 s until it hit 60 % resolution, flashing each time.
  - Fix: dynamic resolution now only reallocates the internal render targets. The final pass upscales to a canvas that never changes size; the live test counts 0 canvas resizes.
- **NaN/overflow pixels.** A NaN from degenerate maths, or a mirror-like sun highlight beyond the half-float range, could reach the post chain. The AO and bloom blurs and the grade's colour mixing then smeared it into black blocks. Every lit material's output and the bloom and grade inputs are now sanitised.
- **Shaders compiling on the first frame.**
  - The shader warm-up compiled every material for the canvas (sRGB output), but the game renders into linear render targets, so none of those programs were ever used.
  - All 46 programs compiled again on the first visible frame: a freeze of about 6.5 s here right after the loading screen. Starting a match added another 1.2 s.
  - Now they compile for the real render state, in parallel on driver threads (`KHR_parallel_shader_compile`). One real frame is drawn behind the loading screen, and every buffer and texture is uploaded in a 1×1-pixel pass.
  - First menu frame: **6.5 s → 0.16 s**. First match frame: **1.2 s → ~0.3 s**. Two small programs are still compiled late.
  - Nothing new is uploaded the first time you turn to face a part of the map.
- **Lost GPU context** (driver reset, out of video memory): the procedural textures used to come back black. They are now baked again when the context is restored.

### Loading: 32 s → about 2–3 s of CPU work

| Phase (this test setup) | Before | After |
| --- | --- | --- |
| Terrain height field | 10.4 s | 1.3 s on worker threads, overlapped with start-up; **0.05 s** from cache on later visits |
| Navigation graph | 9.0 s | 0.35 s |
| Texture baking (GPU) | ~15 s of stalls | ~1 s |
| Weapon models (≈70 builds) | ~2 s | 17 builds + cheap clones |
| Sounds (~400 recordings) | 2.5 s, blocking | in the background |
| Time to ready, CPU side | ~32 s | **~2.5 s** first visit, **~1.9 s** cached |

- **Terrain:**
  - Each height sample tested every building pad with trigonometry and an fbm noise call, and each road lookup scanned every road segment. Both now use spatial grids.
  - Results are bit-identical: 874k samples were compared against the old code.
  - The height field is computed in parallel Web Workers from the first millisecond of boot, and cached in IndexedDB under a fingerprint of the map functions.
- **Physics queries:** rapier.js's `intersectionWithShape` scans every collider: 3.6 ms per call with this map's 4,800 colliders. The callback form walks the BVH and gives the same answer (3,000 random tests, 0 mismatches) in **0.015 ms**. This also removes a stutter in gameplay: it is the stance check for crouch, stand and prone.
- **Texture baker:**
  - One multiple-render-target pass evaluates each procedural surface **once per texel instead of six times**. The normal map is derived from an exact float height field at the same sample positions, so it is the same normal map.
  - This halves the shader compiles, and all of them compile in parallel.
  - The low preset bakes at half resolution: a quarter of the ~190 MB of texture memory, which matters most on integrated GPUs that share system RAM.
- **Weapon models:** each gun is built once; soldiers, the viewmodel, the killcam and the warm-up get clones that share its geometry. Each clone still drives its own bipod and speedloader.
- **Downloads:**
  - The first-person arms model went from 3.1 MB to 0.94 MB. Its PNG textures were re-encoded as JPEG (same look, compared side by side), and the unused one is now a stub.
  - Models start downloading from the HTML, in parallel with the game code.
  - The loadout preview's separate WebGL context is created only when you open the loadout screen.
- **Loading screen:** it is in the HTML itself, so it shows with the first byte instead of a blank page. It has a progress bar weighted by measured phase times (it never moves backwards), a percentage, the current step and rotating tips.

### Smoothness

- **Garbage:**
  - Bot pathfinding (A*) allocated Maps, Sets and swap arrays on every search: about 45 % of all the garbage the game made, which meant GC pauses mid-fight.
  - It now reuses typed arrays: the same paths on 400 test routes, 2.2× faster.
  - With the soldiers' per-frame vectors and the door checks also fixed, garbage is down from **500 KB to 234 KB per frame**.
- Match simulation in the 12 v 12 regression test: **2.7 ms/frame** (Updates 20–24 measured 3.4–4.6 ms).

### Automatic performance scaling

- **Hardware detection on first launch:** the GPU (integrated Intel/AMD, Apple silicon, GeForce/Radeon generations, software renderers), CPU threads and memory pick a starting preset. Existing players keep their preset. A different GPU (e.g. a laptop switching graphics) is re-detected. The toggle is **Settings → Graphics → Automatic graphics**; choosing a preset by hand turns it off.
- **Frame-time governor:**
  - It measures the display's refresh rate, so the target is the lower of the frame-rate target and the screen's refresh.
  - It steps the internal resolution in small steps with hysteresis and back-off, so it settles instead of see-sawing.
  - It uses GPU timer queries, where the browser offers them, to know there is headroom before stepping back up.
  - Only if the resolution is already at its floor and the frame rate still can't hold for 4 s does it switch off, one by one: ambient occlusion, sun shafts, bloom, shadow resolution, anti-aliasing. It tells you each time, and it never touches your saved settings.
- The **F3 overlay** also shows the render resolution and scale, the detected refresh rate and target, the preset and the GPU.

### Tested

- 12 v 12 match (240 s): kills, flags, respawns and radio all work.
- Two-browser multiplayer: join, sync, chat, kills, commands.
- 132-route walk test and every ladder.
- Every gun: fire, empty reload, ADS, scope picture.
- LMG bipod and revolver speedloader clones.
- Production build: terrain worker and cache.
- Live governor run: resolution stepping with zero canvas resizes and no console errors.

## Update 24: HVAL-47 pushed out, nameplates that work while aiming

- **HVAL-47:** the rifle sat far too close to the face, both at the hip and aimed.
  - It now sits at the same distance as the other rifles, with the eye at a proper cheek weld behind the rear sight, so the iron-sight picture is much smaller and more open.
  - The sight line was raised to real-AK clearance over the dust cover, so the cover no longer climbs up the middle of the aimed view.
  - The front sight ears were trimmed back to scale.
- **Nameplates while scoped:** a scope shows a separate, magnified picture in its lens. Nameplates were still placed with the normal camera, so teammates' names floated in the wrong places.
  - Teammate names, spotted-enemy markers, pings and waypoints are now projected through the scope's own camera into the lens, so each name sits on the soldier you actually see in the glass. Anything the glass doesn't show is hidden.
  - Objective markers that would land inside the lens are placed where the flag really is in the glass, or pushed out to the lens rim.
- **Nameplates while aiming down sights:**
  - Plates switch to a compact style: smaller text on a dark backing, smaller chevrons.
  - Teammates stay labelled out to 160 m.
  - Plates right on the crosshair fade to 30 % so they never cover what you are aiming at.

## Update 23: HVAL-47 remodel, KR-98k right-hand loading, all-new equipment handling

**HVAL-47 remodelled** from a side reference and an iron-sight reference:
- **Body:** milled receiver with the long lightening cut above the magwell and a dovetail side-mount plate.
- **Dust cover and rear sight:** the dust cover with its rounded tail, and a rear sight base with its two round spring housings and the wide notch block.
- **Front sight:** a post between two hooked protective ears on a ring base.
- **Barrel and furniture:** short muzzle nut, gas block with bayonet lug, short upper handguard, straight lower handguard with a steel ferrule, sling swivel, ribbed slab magazine.
- **Sight picture:** the eye sits right behind the rear block, so you see the dark block with its small U-notch over the round base, with the hooked tips of the front ears just above it. The upper handguard and gas tube were lowered under the sight line so nothing hides the front sight.

**KR-98k reload, right hand only.**
- The left hand stays on the fore-end the whole time.
- **The right hand:**
  1. Lifts and draws the bolt.
  2. Drops to the belt.
  3. Loads, depending on what is missing:
     - **1–2 rounds missing:** thumbs in exactly those, one by one. It pinches each cartridge by the case head, lines it up over the port, and rolls the thumb over to press it down and forward.
     - **3–4 missing:** seats a stripper clip in the guides, presses the stack down in two firm thumb strokes (only as many rounds as fit), then plucks the empty clip out and flicks it away.
     - **Empty:** the same with all five, then a firmer close that chambers the first round.
  4. Drives the bolt home and returns to the wrist.
- **Fingers:** they blend between a knob grip, a cartridge pinch, a thumb press and a clip pinch, with no snapping between shapes.

**Equipment handling, rebuilt** (`src/weapons/EquipAnims.ts`). Everything is thrown when you release the key.
- **Tacticals** (flashbang, stun, smoke, decoy): the gun stays up in the right hand and **you can keep firing**.
  - The left hand pulls the grenade off the vest, hooks the ring with the thumb and twists it out (the ring rides the thumb, then drops).
  - The arm cocks back and holds until you let go, then throws overhand.
  - The decoy now has a pin like the others.
- **Snapshot:** the same one-handed hold, but its own preparation: a wrist roll turns the cap a quarter (two detent clicks, the sensor band lights up). It is held low and bowled underhand.
- **Stim:** unchanged.
- **Lethals:** the gun drops away first.
  - **Frag:** the right hand pulls it and the left fingertips pull the pin. The right arm cocks back (cooking) while the left arm points out front, until you release.
  - **Sticky:** the right hand pulls it and the left index presses the arming button (the LED starts racing), then the same ready and throw.
  - **Throwing knife:** plucked straight off the chest into the over-the-shoulder ready, flicked on release.
  - **C4:** both hands bring the brick up and toss it on release. The gun comes straight back up in the right hand while the left pulls the remote and keeps it ready.
    - With the remote in hand the gun is one-handed but still fires.
    - Double-tap F (or G with no C4 left) flips the cover and clacks it.
    - The remote is put away when you reload, switch, climb or sprint, or once your charges are gone.
  - **Claymore:** unchanged.
- **Placement:** items are placed exactly by the animation and the hands are solved from the item. Rings sit on the fingertips, buttons under the finger, and the right fingers wrap the real shape of what they hold.
- **Throw origin:** throws leave from the hand that holds them (lethals right, tacticals left, C4 centre).

## Update 22: HVAL-47 assault rifle and KR-98k bolt carbine

Both guns and every one of their animations were built from scratch for this update. No animation is shared with another weapon; the code is in `src/weapons/RifleAnims.ts`.

**HVAL-47** (new primary, Assault Rifle): a 7.62 mm rifle in the AKM pattern.
- **Model:**
  - Stamped receiver with a ribbed dust cover and the tangent rear sight on the trunnion block.
  - Gas tube under a wooden upper guard, flared wooden lower handguard, slant muzzle brake, cleaning rod.
  - The big right-side safety lever, wood grip and stock.
  - A strongly curved steel thirty that locks on a front lug.
- **Handling:** 600 rpm and harder-hitting than the 5.56 rifles, with a heavier, kickier spray and a deep, chattering report.
- **Tactical reload** (2.25 s): the right hand never leaves the grip.
  1. The left hand fetches a fresh mag and brings it up behind the old one.
  2. It drives the new mag's nose into the old mag's spine. The old one rocks forward off its lug and drops away.
  3. In the same motion the new mag's lug is hooked and the mag rocked back until it clicks.
  4. The hand returns to the handguard.
- **Empty reload** (2.95 s):
  1. The same mag-on-mag move, but punched: the empty is smashed out and spins away, and the fresh mag is slammed home with a harder camera hit.
  2. The rifle rolls over to show its right side. The left hand reaches over the top, rips the carrier handle back and lets it fly.
  3. A short settling roll before it comes back up to fire.

**KR-98k** (new primary, Marksman): a 7.92 mm bolt-action in the Mauser pattern.
- **Model:**
  - Full-length walnut stock with a semi-pistol wrist, two barrel bands and a cleaning rod.
  - Tangent rear sight with a V-notch, hooded front post.
  - A controlled-feed bolt with a turned-down handle and pear knob.
  - Stripper-clip guides on the receiver bridge, and a 5-round internal magazine whose cartridges you can see through the open action.
- **Damage:** a chest shot kills inside about 60 m.
- **Its own bolt throw after every shot:** the right hand comes up under the knob, lifts it, rips it back (the case flies), drives it forward and slaps it down. The rifle is pushed out from the face so you can see the hand work.
- **The reload plans itself from what is left in the magazine and only loads what is missing:**
  - **1–2 rounds missing:** the bolt opens and the left hand thumbs single cartridges in through the action, one by one. It fetches each round, lines it up over the port, and presses it down and forward under the rail. The bolt then closes.
  - **3–4 missing:** stripper clip.
    1. A loaded clip drops into the guides.
    2. The thumb presses the stack down. Only as many rounds go in as there is room for; the rest stay in the clip.
    3. The empty clip is pulled out and tossed.
    4. The bolt closes.
  - **Empty:** the clip routine, done more deliberately: the five go in, then the bolt is driven home to chamber the first round, with a firmer lock and a shoulder settle.
- **Sounds:** its own bolt, cartridge and clip foley.
- **Ammo:** reserve ammo is only spent on the rounds actually loaded.
- Bots carry both guns.

## Update 21: Stille-9 suppressed SMG and MP-18 machine pistol

**Stille-9** (new primary, SMG): an integrally suppressed 9 mm roller-delayed SMG in the MP5SD pattern, modelled from scratch.
- **Model:**
  - Rounded-top stamped receiver with side ribs, claw-mount dimples and the brass deflector.
  - Cocking tube running forward over the suppressor, with the slot and locking notch on the left.
  - Polymer trigger group with an enclosed guard and a finger-grooved grip.
  - Strongly curved 30-round magazine with a paddle release.
  - Twin-rail sliding stock.
  - Ribbed handguard over an integral suppressor.
- **Sights:** the classic diopter picture. A hooded ring with a post sits on the end of the cocking tube. At the rear, the diopter drum sits low between two knurled wedge ears, so aiming puts the hooded post in the notch between the ears.
- **Suppressed:**
  - Quiet, choked "thwap" plus the bolt's metallic clack.
  - No minimap ping when you fire, bots only hear it close by, no tracers, tiny flash.
  - The subsonic rounds lose damage past ~30 m.
- **Tactical reload** (2.05 s):
  1. The fresh mag comes up held sideways in the support hand and clamps the old mag's base against it.
  2. The thumb works the paddle and the old mag is pulled out.
  3. The hand rolls a quarter turn so the new mag stands upright, hooks its front lip and rocks it home.
  4. The old mag is carried away and down out of view in the same hand.
- **Empty reload** (2.6 s), the HK slap:
  1. The cocking handle is pulled back and flicked up into its notch.
  2. Paddle, and the empty falls free.
  3. Fresh mag in.
  4. The open palm slaps the handle out of the notch and it slams forward, with a big jolt and camera punch.
- Some bots carry it.

**MP-18** (new sidearm, Pistol): a select-fire 9 mm machine pistol, 1100 rpm, 33-round extended magazine.
- **Model:** long ported slide with a selector on its rear left, accessory rail, flared magwell, extended mag with a grippy base pad.
- **Folding stock:**
  - Folded, the wire stock lies forward along the right flank.
  - When you aim it flicks out round to the right, drops toward the shoulder and locks with a click. The gun rocks a little as it locks.
  - It folds back at the hip.
  - Aimed recoil is much lower with it out.
- **Tactical reload** (1.7 s): the gun cants over toward the support hand. The hand pinches the base pad and strips the stick out, pockets it, brings the fresh one up by its base, starts it and heels it home. The gun snaps back upright.
- **Empty reload** (2.05 s):
  1. A hard wrist flick throws the empty mag clear.
  2. The support hand is already at the belt and puts the fresh stick in with a palm tap.
  3. The hand comes over the top, grabs the rear serrations of the locked slide and slingshots it.
- **Sound:** a tighter, quicker report than the P80.

The reload code is in `src/weapons/SmgAnims.ts`. The support hand is always attached to whatever it is holding or touching (a magazine, the cocking handle, the slide), so the hand and the parts never drift apart.

## Update 20: LMG, new equipment, Trophy System, leaning, battlefield audio, destruction

**Controls changed.**
- **Q / E** now lean.
- **F** is use / doors / zipline / spot (it was E).
- **T** throws your tactical (it was F).
- **H** deploys the field upgrade.
- Q no longer swaps weapons; use 1 / 2 or the mouse wheel.
- I is still inspect.

**KVL-7 "Bjørn" LMG** (new primary, class LMG).
- Belt-fed 5.56 mm with a 100-round box, 720 rpm.
- Feed cover hinged at the front with the red dot on it, heavy barrel under a perforated heat shield, carry handle, folding bipod.
- **Handling:**
  - Clearly heavier than the rifles: weight 1.75, 0.40 s aim-down-sights, 0.36 s sprint-to-fire, 86 % move speed.
  - Bigger hip bob, hangs lower at the hip.
  - Its own spray pattern: a hard first kick, a climb that walks right, then a heavy wander that settles.
- **Reload** (`src/weapons/LmgAnim.ts`, 5.4 s tactical / 6.3 s empty):
  1. The gun rolls over and the support thumb pops the latch.
  2. The feed cover swings up.
  3. The old belt is lifted out of the tray.
  4. The empty box is stripped down and away, and a fresh one comes up from the pouch, hooks and rocks in.
  5. The belt end is drawn up and laid across the tray, and the cover is palmed shut.
  6. Empty reloads also rip the charging handle back.
- **Bipod:**
  - The legs swing down by themselves when you go prone, or when you aim standing or crouched still with a ledge (wall, sill, car) right in front of you.
  - While it is down: about half the recoil, much tighter spread, and almost no sway or bob.
  - Moving off or standing up folds it.
- **Sound:** a deeper, chugging report built from the field recordings.
- Bots use it too.

**New lethals** (G):
- **Sticky grenade.**
  - The thumb arms it (the LED starts racing), then an over-the-shoulder throw.
  - Sticks to walls, floors and soldiers. Stuck to someone, it is a guaranteed kill. You get "STUCK", the victim gets a warning.
  - 2.3 s fuse.
- **Claymore.**
  - Two-handed: the gun drops away and the mine comes up off the vest. The thumbs flick its scissor legs out and the tripwire module wakes up.
  - It is held out while you keep G down. Release and you drop to a knee and set it down on its legs in front of you.
  - Two red laser beams fan out from it.
  - Anyone crossing in front (within 3.4 m, in its line of sight) gets a click and a directional blast: full damage forward, little behind.
  - Shooting it destroys it; a nearby explosion sets it off. Two out at most.
- **C4.**
  - The brick comes up face-up and is armed (beep), then tossed underhand, spinning flat. It sticks to whatever it hits.
  - Detonate with a double-tap of F, or with G when none are left in hand: the remote comes up, the thumb flips the cover and clacks the button.
  - The HUD shows how many charges are out.

**New tacticals** (T):
- **Snapshot grenade.**
  - A wrist twist turns the cap (detent clicks, the sensor band lights up), then a low underhand bowl.
  - Its pulse is an expanding blue scan sphere. Every enemy within 22 m is outlined in red through walls for ~3 s and marked on the minimap.
  - Thrown at you, it shows a blue tint and "REVEALED".
- **Decoy grenade.**
  - Three taps on the program button, then a flat side-arm flick.
  - For 12 s it plays bursts of real gunshot recordings from random guns, with irregular gaps.
  - Enemy bots go to investigate.
  - If an enemy throws one, your minimap shows fake red fire contacts around it.

**Field upgrade: Trophy System** (H).
- **Charge:** fills over 75 s, shown as a ring on the HUD that glows when ready.
- **Deploy:**
  1. The gun swings down and both hands haul the unit up by its side handles (it is heavy: a dip as it arrives).
  2. Its legs snap out.
  3. Both arms shove it forward onto the ground with a camera push.
- **In action:**
  - It thuds down, locks its legs and spins up.
  - Its head turns and its lamp blinks.
  - It shoots down up to three enemy grenades, sticky grenades, C4, snapshot / decoy grenades and throwing knives within 7.5 m: a blue zap beam, a pop in mid-air, and +50 for you.
- **Limits:** it can be shot (4 hits), explosions next to it wreck it, and it burns out after its charges or 60 s.

**Unique animations.** Every new item has its own first-person animation. Two-handed items put both palms on grip points on the model and both arms solve onto them. The fingers wrap the real shape of whatever they hold.

**Leaning (Q / E).**
- Hold to lean: the head swings out from the hips (sideways and slightly down) and the view rolls into it.
- The gun tips with you at the hip and stays on the sights when aiming, with a little lag-and-settle swing as your weight shifts (plus a cloth rustle).
- Two sideways rays (eye and shoulder height) stop the lean short of walls, so you can lean flat against cover.
- Bots see and shoot your leaned head and shoulders, not your body behind the corner.
- Not while sprinting, sliding, climbing or on a zipline.
- The door peek from Update 9 still works as before.

**Audio.**
- **Footstep occlusion.**
  - Each step from another soldier traces up to three layers between you and them.
  - A door or a thin wooden, glass or metal wall takes the top off.
  - Masonry, rock or earth leaves a dull thud. Two or more layers leave barely a knock.
  - If a path round a corner or through a gap next to them is open, the step comes through almost clearly.
- **Distant battle.**
  - Every few seconds, another fight 300–900 m away: rifle and LMG bursts (sometimes answered), a sniper shot, an explosion, or a roll of artillery.
  - Each comes from a real bearing, filtered by distance, and is quieter indoors and in the tunnel.
- **Tunnel draughts.**
  - Both emergency shafts and both portals have their own looping wind emitters.
  - Gain, filter and pitch gust together, and each shaft has its own voice.
  - The howl swells as you climb toward a hatch and fades down the gallery.

**Destruction** (`src/world/Destruction.ts`).
- **Barrels.**
  - Every standing drum is now its own object (instanced, one draw per paint).
  - Shot through, an ordinary drum is knocked over and rolls away.
  - Red fuel drums spring a burning leak and blow up a few seconds later, or at once in a blast, chaining into drums and cars nearby.
- **Fences.**
  - Picket and post-and-rail fences are built in ~1.6 m sections.
  - Bullets, a blast, or sprinting straight through snaps a section: pickets and planks fly, dust and splinters puff, and the gap is open for good.
- **Cars.**
  - Every intact parked car takes damage from bullets and explosions.
  - Past ~55 % damage the engine bay smokes. Past 80 % it catches fire: crackling fire loop, flickering firelight, flames, and a burn zone that hurts anyone next to it.
  - About 7 s later it explodes: a large blast credited to whoever did the damage, a deep second boom and a long camera shake.
  - The car is swapped for a burnt-out shell (still cover) that keeps burning, then smoulders.
- Everything resets between matches.

**Performance.** The new systems stay cheap:
- Barrels: one instanced draw per paint.
- Fences: one merged mesh per material. Broken sections are collapsed out of the mesh rather than re-merged.
- Cars stay in the static mesh until they blow up.
- One shared fire light.
- Claymore and trophy scans run at 20 Hz.
- Footstep occlusion only for steps within 40 m.

## Update 19: performance pass, blue hour, quieter guns, clearer night vision

**Performance.** I measured where every frame goes (draw calls, triangles and passes per frame, CPU per system) and cut the biggest costs:
- **Lights (biggest GPU win).** Three.js lights forward: every lit pixel loops over every light in the scene.
  - The tunnel (Update 17) had added 20 permanent point lights, so the whole map was paying for 22–24 lights at all times.
  - They now share the map's small light pool, which hands 4 real lights to the fixtures nearest you (2 on Low).
  - Lights in the scene: 24 → 7.
- **Bot guns.** Every soldier carried a full first-person-quality rifle (20–40k triangles each, ~550k in total).
  - Beyond ~12 m they now hold a ~200-triangle stand-in built from the same parts and colours.
  - Soldiers with the same weapon share one model in GPU memory.
- **Grass:** 827k → ~200k triangles.
  - Two segments per blade instead of three.
  - Far tiles draw an even, random subset of their clumps.
  - Range and blade count follow the preset (Low 18 m and 10 blades; Ultra 32 m and 16).
- **Terrain:**
  - The rock layer's six texture reads now only happen where there is rock, which skips them on most flat ground.
  - Low uses single-sample texturing without detail normal maps.
  - Level-of-detail distances follow the preset.
- **Post-processing:**
  - The separate output pass is folded into the colour grade.
  - Bloom is a new two-level quarter/eighth-resolution bloom (6 tiny passes instead of ~12 from half resolution), added straight in the grade.
  - SMAA runs last.
  - Low is now a single full-screen pass after the scene.
- **Shadows.** The sun's shadow map used to re-render every frame whenever the game ran below 75 fps, so the slower the machine, the more shadow work it did.
  - It now refreshes at a fixed rate: 12 Hz Low, 20 Medium, 30 High, every frame on Ultra.
  - Static shadows stay exact between refreshes; only moving soldiers' shadows step.
- **Bots (CPU):**
  - Hit tests now follow the body between pose updates, so distant soldiers can update their pose less often without costing any accuracy (on screen: full rate within 26 m, then 30 / 20 / 12 Hz).
  - Character-controller sweeps run every frame only within 14 m.
  - Your first-person legs are only posed when you look down.
- **Weather and effects:**
  - Rain, snow and fog-bank budgets follow the preset (Low: 35% of the particles, a third of the fog-bank sprites).
  - Particles are capped in on-screen size (smoke right at the camera was a screen-sized quad of overdraw).
  - Smoke grenades emit fewer, slightly larger puffs on Low / Medium.
  - The sky lighting probe is re-baked every 2.5° of sun travel instead of every 1° (a frame spike every ~12 s in dynamic time).
- **Presets:**
  - **Low:** 72% resolution, dynamic resolution aiming for 120 fps, no AO, bloom, SMAA, god rays or depth of field.
  - **Medium:** 85% resolution.
  - **High** and **Ultra:** full resolution, aiming for 60 fps.
  - The light pool, grass, terrain shader and weather budgets switch on the next page load.
- **Measured** (same view, High; per frame):
  - lights 24 → 7;
  - draw calls ~318 → ~191;
  - triangles ~1.37M → ~0.64M;
  - full-screen passes ~25 → 18 (Low: 1).
  - I can only test in a software renderer here, so I can't promise exact frame rates on your laptop. Tell me what you get (F3 shows the performance overlay).

**Blue hour** (Settings → Time of day → *Blue hour*, and about one match in seven in dynamic time):
- The sun has just gone. The sky, the snow and the far fjord walls are a deep, saturated blue.
- Every window, street lamp and fixture is lit warm, and a few stars are out. There's no aurora and no god rays.
- A cold, soft light comes from the whole sky, with a light blue haze in the distance.
- A dedicated grade (more saturation, a cold tint) keeps the blues from going grey.
- With the random map variant, blue-hour matches are almost always winter, mostly clear or with light snow.

**Guns look quieter:**
- **Muzzle flash:** smaller, shorter and only just above white, so it no longer flares into the bloom. The light it casts is about a third as strong.
- **Muzzle smoke:** one faint wisp (two for the big guns) instead of three dense puffs.
- **Tracers:** half as thick, half as long, dimmer and less orange.

**Night vision:**
- **Brighter:** more gain, and a faint starlight floor so unlit ground still shows structure.
- **Cleaner:** less contrast crush, and about half the noise and sparkle.
- **Wider:** larger eyepieces with less edge darkening.
- **Stronger IR illuminator:** wider and reaching further. It now also works on Low, where it used to need the AO depth buffer.

**Tests:**
- A 180 s 12 v 12 match runs clean, with kills per minute in line with earlier runs.
- The two-tab multiplayer test passes.
- The production build is clean.

## Update 18: multiplayer (bots fill the slots) and publishing

**Play with friends.** Main menu → **MULTIPLAYER**:
- **Host:** type your name, click **HOST GAME**. You get a 5-letter room code, and the chat shows an invite link (`…?join=CODE`; `/code` copies it).
- **Join:** type the code and click **JOIN GAME**, or just open the invite link.
- It is always 12 v 12. Every player takes over a bot's slot on the side with fewer humans, and bots fill whatever is left. When someone leaves, a bot takes their place again.

**How it works:**
- **Peer-to-peer.** It uses WebRTC data channels through PeerJS (MIT).
  - The host's browser runs the bots, the flags, the score and the clock.
  - Everyone connects straight to the host.
  - PeerJS's free public broker only introduces the browsers to each other; no game traffic goes through it. No server to run, no account, no cost.
- **Your hits count.** Your own movement is instant (no lag on yourself), and shots are judged on the shooter's screen.
  - A hit on another player or a bot is sent to whoever owns that soldier: the host owns the bots, each player owns themselves.
  - The owner applies the damage and decides the death; everyone then plays the same death and kill-feed line.
- **What everyone sees:**
  - Other players' shots are replayed as harmless "ghost" bullets: same tracer, muzzle flash, sound and impacts.
  - Grenades, mortar strikes and the helicopter are simulated on every machine, and each machine only damages what it owns, so nothing hits twice.
  - Doors, UAVs and the time of day / weather follow the host.
- **Traffic:** about 20 updates a second, a few KB/s per player.

**Chat and commands.** Press **Enter** to chat (or **/** to start a command); Esc cancels.

| Command | |
| --- | --- |
| `/help` | list the commands |
| `/code` | room code + invite link (copied to the clipboard) |
| `/players` | who is in the room |
| `/name <name>` | change your name (remembered) |
| `/team` | switch sides |
| `/ping` | round trip to the host, upload / download rate |
| `/leave` | leave the room |
| `/bots <0-23>` | *host:* how many bots fill the slots (teams kept even; also works offline) |
| `/kick <name>` | *host:* remove a player |
| `/restart` | *host:* new match for everyone |
| `/time <dawn\|day\|golden\|night>` | *host* |
| `/weather <clear\|overcast\|rain\|snow>` | *host* |
| `/diff <recruit\|regular\|veteran>` | *host:* bot skill |

**Limits, honestly:**
- The game runs in the host's tab. If the host switches tabs or minimises the browser, the browser pauses it and the match freezes for everyone. When the host leaves, the room closes.
- Opening your pause menu online doesn't stop the game: the world keeps going.
- A few strict networks (some school, office or hotel Wi-Fi) block peer-to-peer connections. PeerJS falls back to its public relay servers, but not every network allows that either.
- Only the host's weapon models are exact on other screens. A player's soldier carries the gun model of the bot slot they took, but their shots use the right weapon (sound, tracer, damage).
- Throwing-knife flights, glass and shot-out lights are not replicated. Everyone sees their own.

**Publishing (GitHub Pages).**
- The build now uses relative paths, so it runs from any sub-path. `.github/workflows/pages.yml` builds and deploys on every push to `main`.
- One-time setup in the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
- The game is then at `https://<user>.github.io/<repo>/`.

**Tests:**
- Two- and three-tab tests run on a local PeerJS broker (`tools/mptest.cjs`, `tools/mptest2.cjs`; run `node_modules/.bin/peerjs` or the `peer` package on port 9000, and use the URL option `?peer=127.0.0.1:9000`). They check:
  - joining and slots;
  - the pose and the bot positions match on both screens;
  - chat both ways;
  - a client killing a host bot;
  - host bots killing a client;
  - player-vs-player hits host → client, client → host and client → client (relayed by the host);
  - a client's grenade killing the host;
  - `/bots`, `/team`, `/restart`;
  - the host leaving.
- The single-player match regression is unchanged, and the production build loads cleanly from a sub-path.

## Update 17: Kvitviktunnelen and the tactical map

**The tunnel is rebuilt** at almost twice the size, and it now plays as its own point of interest instead of a corridor.
- **16 m wide, 8 m high**, with two 4 m lanes, a double yellow centre line, edge lines, hard shoulders and kerbed walkways.
  - Light wall cladding along the lower walls, two rows of sodium lights down the arch, and jet fans hanging under the crown.
  - New portals with an arched opening, a blue name board ("KVITVIKTUNNELEN") and jersey barriers out front.
  - The cuttings in front of the portals are flattened to the tunnel's width.
- **Lots of cover** down the bore:
  - a broken median of jersey barriers;
  - a burnt-out wreck across a lane with cones round it;
  - an abandoned car on the shoulder;
  - a jackknifed box van;
  - a second wreck, a stopped car, and roadworks blocks with a pallet and cable drum.
- **Two emergency exits on each side.**
  - Each exit is a steel door (a real door you can open, kick or peek, like the others) in a green frame.
  - A lit green **NØDUTGANG / EXIT** sign sits over every door, and a double-sided blade sign sticks out from the wall, so you can see the exits from either end of the bore.
- **Service galleries.** Behind each wall, the two doors on that side open into a 2.4 m concrete gallery running between them. It's a lit flanking route parallel to the bore, and the bots use it too.
- **Ladder shafts to the top of the mountain.** Halfway along each gallery, an "UT · EXIT" sign marks a shaft.
  - A ladder climbs it 26 m to a hatch platform on the crest of the ridge.
  - The platform has railings, an exit sign post and a green lamp, and overlooks the village and the harbour.
  - The shaft ladders climb faster than the others (about 5 s).
- **Climbing down from the top** works on every ladder in the game: walk over the edge towards the ladder and you swing onto it. Keep holding W to go down, or release it and use W/S as usual.
- The tunnel's reverb is retuned for the bigger bore, and props and grass no longer spawn inside it.

**Tactical map [M].** A full-screen map of the whole play area, inspired by the battle-royale tactical maps:
- **What it shows:**
  - hill shading and 5 m contours;
  - every road (the tunnel and its galleries dashed, since they run underground), every building, and every POI by name (the one you're in is highlighted);
  - a lettered A–H / 1–8 grid, the out-of-bounds line and a scale bar;
  - zipline routes, and when zoomed in, ladders and the tunnel exits and hatches;
  - the Domination flags with owner colour, capture progress and a contested flash;
  - your squad (with names when zoomed in), helicopters, pings and your waypoint.
- **Controls:**
  - scroll zooms at the cursor and dragging pans;
  - left click (or X) drops a location ping that the team sees in the world and on the minimap, and idle teammates may go and check it;
  - right click sets a waypoint (a marker in the world with its distance, cleared when you reach it or right click it again);
  - R re-centres on you.
  - The cursor readout gives grid square, place name and distance.
- **Intel rules:**
  - Enemies who fire an unsuppressed gun only show up if they are **within 100 m of you**, on the map *and* on the minimap. The dashed ring on the map shows that radius, so gunfire across the map no longer lights up.
  - Spotted / pinged enemies are team intel and show wherever they are.
  - An active **UAV** sweeps the **entire map**: every enemy, with a sweep effect and a countdown.
- While the map is open you can still walk, crouch and jump, but not shoot, aim or turn. It closes with M, or on Esc / pause.

**Fix: road markings.** The road ribbons were wound the wrong way and had always been back-face culled. The roads only looked right because the terrain texture paints them. They now render, so every asphalt road shows its edge lines and dashed centre line.

**Fix: shader mix-ups.** The snow patch gave every plain (untextured) material the same shader cache key as the terrain's custom shader. Some plain surfaces could get compiled with the terrain shader and show rock texture and cloud shadows instead of their own colour (first noticed on the new tunnel cladding). Each material's hook now gets its own program.

**Fix: weather in the tunnel.** Fog-bank puffs now follow the ridge top over the tunnel instead of drifting through the bore.

**Tests:**
- All 35 ladders on the map pass climbing up and climbing back down from the top.
- The doorway walk test passes all 132 links, including the new tunnel doors and galleries.
- In simulated matches, about 9% of all bot positions are in the bore, a few are in the galleries, and none are inside the rock.
- The 240 s 12 v 12 match runs clean (no errors; spawns never within 18 m of an enemy).
- On the map, enemies firing beyond 100 m stay hidden and the ones inside 100 m show.

## Update 16: the whole map is in play

The map is the same size, but matches no longer collapse into the village.

**Four new points of interest** in the empty quarters:
- **Fyret** (south-west point): a red-banded lighthouse with a climbable gallery 16 m up.
  - A ladder up the tower comes through a hatch in the deck; it's a sniper's nest over the plain and the sound.
  - Its lamp is a real light, and it can be shot out.
  - Also a keeper's house, a boathouse, and nets, buoys and fish crates on the rocks.
- **Leiren** (south-west plain): an army camp.
  - Two barracks, a two-storey HQ, a gun pit and a watchtower.
  - Sandbag positions facing out, plus ammo, crates and barrels.
- **Radaren** (south-east hills): a radar station.
  - A domed radar on a concrete equipment building with a walkable roof (ladder up).
  - Also a station office, a pillbox, a watchtower, cable drums and dug-in sandbags.
- **Hyttefeltet** (north-east hills): a holiday-cabin cluster of five cabins and a sauna, with firewood, garden furniture, sheds and benches. Close-quarters fighting between small buildings.

**Every existing outlying point of interest is built out:**
- **Skogen:** a logging camp in the eastern forest, with a sawmill barn, two cabins, a watchtower, felled-log piles, firewood stacks and trailers.
- **Skaret:** a lookout tower in the mountain pass, with dug-in positions and supply crates in the rocks.
- **Ryggen:** a pillbox dug into the ridge, with sandbags and cable drums.
- **Låven:** a second barn and a shed, more bales and a trailer.
- **Kystfortet:** an observation tower over the trenches.
- **Brygga:** a lookout tower on the waterfront.
- **Hjellene:** a third row of fish-drying racks.
- **Brua:** checkpoints at both ends of the bridge, with barriers and sandbags.
- Every landmark still gets its ring of hard cover around the centre.

**New structures:**
- **Watchtowers:** braced legs, a plank platform with chest-high walls for cover, and a roof. Ladders on all of them.
- **Lighthouse and radar station:** described above.
- All climbable spots are checked in the test suite.

**Flags across the whole map:**
- **Sites:** Domination now picks from 17 sites, all of them playable, with a random jitter per site, so the same team homes don't always produce the same flags.
- **Village core:** Sentrum, Kirka, Brua and Tunnelen are only in the running about one match in four, and even then they're less likely to be the middle flag. Over 40 test matches about 10 % of flags landed there; the rest went to the fort, farm, ridge, pass, harbour, waterfront, forest, cabins, lighthouse, camp and radar station.
- **Respawns:** respawns favour the flags your team holds, and the approaches to neutral ones, so the fighting happens on the objectives wherever they are that match.
- **Bots:** they patrol and clear the new places like any other landmark, and the location readout under the compass names them.

**Checked:**
- All 122 building entrances pass the walk test, including the new buildings.
- Every new ladder climbs.
- The ziplines re-validate against the new buildings.

## Update 15

**KS-17 irons: bigger, much thinner.**
- Tall, thin ear blades frame the view, with a thin aperture leaf between them.
- At the front, a thin blade tower carries a larger ring hood made of a fine wire.
- The post is fine, and the eye sits closer, so the whole sight picture reads bigger and cleaner.

**Recoil you can learn**
- Every automatic gun now has an authored, shot-by-shot spray path. It's the same every time, with only a little noise on top, so you can learn it and pull against it:
  - **K416:** straight up, a hook to the right, then a long S back left.
  - **KS-17:** a steady climb up-left, a sharp kick right on shot 8, then back left.
  - **MP7:** a fast, tight vertical zig-zag.
  - **UMS-45:** a heavy vertical bounce (big lift, small lift), drifting slightly right.
- Long sprays loop the tail of the pattern, so the climb settles into a steady wobble.

**Recoil that settles**
- During a sustained spray part of the built-up climb bleeds back continuously (SMGs most, rifles less, marksman and snipers barely). The climb plateaus instead of walking off target.
- After you let go there's a short hold, then the view glides back.

**Fire modes and stance**
- **3-round burst** on the K416 and KS-17 (B cycles AUTO → BURST → SEMI): a faster cyclic within the burst, less recoil and tighter spread.
- Semi on an automatic gun gives 15 % less recoil and 20 % tighter spread.
- Crouching now gives 22 % tighter spread and 20 % less recoil; prone gives 45 % and 40 %.

**Handling and inertia**
- **Inertia:** the gun hangs on springs whose stiffness comes from its weight. Heavy guns (DMR, shotguns, sniper) lag further behind a flick and settle later; light ones (pistols, PDW) snap after the view. Landings dip heavier guns deeper.
- **Swaps:** draw and holster times now scale with weight. A pistol comes out in ~0.35 s, the sniper in ~0.5 s.

**Layered, distance-banded gunshots**
- **Your own gun:** the report, a sub-bass thump, a light mechanical clack of the action, and the outdoor tail. Indoors the tail goes and the room takes over; suppressed guns lose the thump and tail.
- **Other guns, by distance:**
  - **Near (< 25 m):** full and punchy, with its own thump.
  - **Mid (25–90 m):** the crack softens and the valley tail grows.
  - **Far (90–260 m):** the distant recording with the highs gone.
  - **Very far:** a dull, low rumble.
- All of this sits on top of the speed-of-sound delay, the echoes and occlusion.

**Hit feedback**
- **Hitmarkers by what you hit:**
  - gold: head
  - small and thin: limb
  - grey: through cover
  - bright and bold: a hit that leaves them nearly dead
- **Hit sounds:** a lighter tick on limbs, a body thud under each hit, and a crunch on headshots.
- **Getting shot:** costs you a small real aim punch and knocks the gun in your hands, on top of the view flinch. Big hits add a heavy thud.

**Bullet impacts by material**
- Grass throws green-flecked clumps, sand a fine light cloud, dirt dark clods.
- Gravel scatters bouncing stones, rock chips with frequent sparks, asphalt dark chips.
- Fabric gives a soft fibre puff, and wooden floors splinter like wood.
- Metal now also throws a bright ricochet streak.

**Tracers: small and dim**
- About a third as thin, less than half as long, and far dimmer, so they barely bloom (including at night).
- Bots fire far fewer of them.
- All tracers are now one instanced draw (they were up to 96 separate ones).

**Movement polish**
- **Slide buffer:** press crouch slightly early (while still accelerating, in the air, or just out of a slide) and the slide fires as soon as it can.
- **Early slide-cancel:** a quick cancel keeps your sprint speed.
- **Mantles:** sprinting into a climb now carries you over the top with momentum.
- **Hard, fast landings:** you tuck and roll through them, with a camera dip and roll and less fall damage.

**Ziplines**
- Six motorised two-way cables:
  - a roof network linking the crane, warehouse, harbour office and fuel tank roofs
  - hillside runs down into the village
- Each line is checked at build time to be clear of buildings and terrain.
- **Riding:** press **E** at either end, or while looking at the cable within reach, to clip on. You keep both hands on the gun and can shoot while riding. **Space** lets go (you keep the momentum), and the end sets you down on the platform.

**Ambient life**
- A gull flock wheels over the harbour, gliding with lazy flaps.
- Crows feed in small groups on the fields and shore. Gunfire or an explosion nearby makes them burst up with fast wingbeats, scatter and circle, then settle somewhere else.
- Wood smoke curls from the nearest chimneys and leans with the wind.
- All the birds are one instanced draw, with the wings flapped in the vertex shader.

**Performance**
- New this round:
  - tracers, door leaves and birds are all instanced (one or two draws each)
  - the ziplines are one merged mesh
- Chimney smoke uses the existing particle pool, and the birds update at 30 Hz.

## Update 14

**KS-17 iron sights reworked** to match your reference: you now look *over* a low, wide rear block whose two chunky rounded ears frame the bottom of the view, at a slim front tower carrying a small ring hood. The hood sits on the crosshair and the post tip is level with the sight line. The eye also sits a little closer to the rear sight.

**New SMG: UMS-45** (.45, UMP-style, modelled on your reference)
- **The gun:**
  - long slab-sided polymer receiver with a full-length top rail and a short side rail up front
  - stubby barrel with a thread protector, straight 25-round box
  - paddle magazine release behind the well, a textured pistol grip and a side-folding skeleton stock
  - charging handle forward on the left
- **Feel:**
  - a slow, thumping 650 rpm; five to the body at close range
  - quick handling and a fatter, lower report
  - an IR laser on the right-side rail for night-vision canted aim
  - one bot per team carries it
- **New "Kestrel" box reflex** instead of irons: a squared, armoured housing with a full hood and a tall window.
  - Rubber buttons on the left, a battery tube on the right.
  - The reticle is a broken circle with four inner ticks and a centre dot.
  - It's truly collimated (projected at infinity), so it stays on target however the gun sways and is only visible through the window.
- **Reloads, in the style of the MW3 Striker.** I couldn't play the video here, so these are authored from how that animation is generally known to look. They are two separate animations, not one sped up:
  - **Tactical (2.15 s):** a calm, confident swap with the gun held up in front of you.
    1. The gun rolls in and the support hand takes the magazine and thumbs the paddle; the gun pops up off the release.
    2. The old magazine is stripped down with a slight forward tilt and stowed.
    3. The fresh one comes up, rocks in a touch and is pushed home; the push drives the gun down.
    4. A palm slap, then the gun settles back with a small undershoot.
  - **Empty (2.75 s):** more dramatic.
    1. A sharp roll flicks the empty magazine out.
    2. The fresh magazine is slammed home with a bigger jolt.
    3. The gun rolls to show its left side and the hand rises underneath to pinch the charging handle. It pulls it fully back and locks it up into its notch.
    4. The palm comes over the top and slaps it down: the handle snaps forward and the gun jolts down and forward.
  - **Camera:** the view reacts to every heavy beat (release, seat, tap, mag drop and a hard slap kick), and rolls slightly with the gun throughout. All of it is on springs: no snapping, and smooth blending in and out of the hip pose.

## Update 13

**New weapon: KS-17 Modular Carbine** (Assault Rifle, 5.56)
- **The gun:** modelled on your side reference, a modular battle carbine with:
  - a long, tall monolithic upper and a full-length top rail running out over the barrel
  - side rails with ribbed polymer covers, plus a bottom rail
  - a short polymer lower with an AR magwell and pistol grip
  - an exposed barrel with a birdcage flash hider
  - a side-hinged folding stock with a stepped cheek piece, adjustment ribs and a tall butt pad
  - a reciprocating charging handle on the **left**
- **Iron sights:** in the protected style of your second reference:
  - rear: a ring aperture between two thick, rounded ears on a tall base
  - front: a post standing inside a protective ring hood
  - the aperture centre and post tip are on the same line, so the irons line up exactly in ADS
- **Feel:**
  - a steadier 625 rpm with a bit more punch per round than the K416 (32 / 23 damage)
  - a slight left-hand drift in its spray
  - its own heavier report
  - an IR laser for night-vision canted aim, as on the K416
- **Tactical reload: mag-to-mag, in one continuous motion**
  1. The support hand fetches a fresh magazine and brings it **straight up beside the seated one**, parallel to it.
  2. The same hand grips both. The old magazine is released and **both are stripped out of the well together**, and the gun lifts off them.
  3. Without stopping, the hand slides across so the fresh magazine lines up, rocks it in front-lip first and seats it, then taps it.
  4. The old magazine rides out in the fingers and is stowed. There are no pauses, and the gun is never left without a magazine for longer than the swap.
- **Empty reload:** the empty magazine drops free, a fresh one goes in, and the support hand runs the **left-side charging handle**; the gun rolls a little to present it.
- **Magazine check** (hold I): the usual single-magazine check.
- **Bots:** two soldiers per side carry it.

## Update 12

**Crash on reload — the real cause, found and fixed**
- The fresh magazine used for reloads is a clone of the gun's magazine, and the clone lost the cached bounding box the hand grip reads (it became a plain object).
  - On some weapons that made the reload code throw on every frame. The game loop died, so it looked like a freeze or crash.
  - The box is now cached separately.
- The game also no longer dies on any error inside the frame:
  - The viewmodel and the frame loop catch it, and a stuck reload is finished for you.
  - The error is shown bottom-left once, so a screenshot is enough to fix it.
- I fuzzed every reload state on every gun (empty or partial × every action at two points in the reload): no errors and no stuck reloads.
  - The memory growth I chased last round turned out to be a test artifact (a fully synchronous test never lets the browser clean up). In a frame loop it stays flat.

**Performance**, targeting the 1277 draw calls and 4.3 M triangles from your overlay:
- **Terrain level of detail:**
  - Terrain tiles switch to half and quarter resolution with distance. Tile borders stay full-resolution and are fan-stitched, so there are no cracks.
  - ~1.1 M terrain triangles in view became ~0.24 M.
- **Trees:**
  - The whole forest is drawn with multi-draw batching: one draw per material, about 4, with per-tree culling.
  - It was ~250 instanced draws. Far trees skip their trunks.
  - There's an automatic fallback to the old path if the browser lacks `WEBGL_multi_draw`.
- **Soldiers:**
  - Each bot's gun is baked into **one** vertex-coloured mesh. It was 5–7 materials plus a lens shader.
  - Bodies are now frustum-culled. Before, all 24 were drawn even behind you.
  - Shadows only within 32 m (guns 22 m), armbands only within 60 m.
- **Props:**
  - All door knobs are one instanced draw.
  - All bullet holes and scorch marks are one instanced draw. They were up to 160 separate transparent meshes, each drawn in several passes.
- **CPU:**
  - The HUD no longer rewrites ~25 text nodes and styles every frame; only changed values are written.
  - Footsteps of soldiers more than 40 m away skip the ground probe and audio nodes.

**New weapon: AS-20 "Storm" auto shotgun**
- **The gun:**
  - Semi-auto 12 gauge with an 8-round box.
  - Long slab-sided receiver with a full-length top rail, ventilated barrel shroud, squared muzzle device, tall front-sight tower and carry-handle rear sight.
  - Box magazine ahead of the trigger guard, pistol grip, fixed skeleton stock.
- **Feel:** low recoil for a shotgun, so you can empty it as fast as you pull. It has its own designed report with the gas action's clack on top.
- **Reloads:**
  - Tactical: rock the fat box out, stow it, rock a fresh one in.
  - Empty: the box drops, a fresh one goes in, and the support hand runs the **left-side charging handle**; the gun rolls to present it.

**New weapon: "Tvilling" side-by-side double barrel**
- **The gun:** blued action and barrels with a matted rib, brass bead, fences and engraving lines, a walnut semi-pistol-grip stock, beavertail forend, top lever and two triggers.
- **Firing:** right barrel first, then left; the flash comes from the barrel that fired. It hits like a truck: one shot clears a room.
- **Reloads:** a real break action, picked from how many barrels you fired.
  - The top lever is thumbed over and the barrels drop open on the hinge (with the forend and the hand riding them).
  - Ejectors **throw out only the fired hulls** (they arc away over your shoulder and land as shells); unfired shells just lift on the extractor.
  - **One fired:** feed one shell into that chamber.
  - **Both fired, "dual":** snap it open with a downward flick so both hulls fly, push in a pair of shells pinched together, then flick the stock up to slam it shut.
  - **Both fired, "flip":** tip the muzzle up so the hulls pop out over the shoulder, feed the shells one after the other, then palm the barrels shut.
  - Closing is either the stock flicked up to meet the barrels or the support hand lifting them; both slam with a jolt and the lever snaps back.

**Combat knife** (dedicated melee)
- **Drawing it:** tap V for a quick melee with your gun, **hold V** to draw the combat knife (clip-point blade, steel guard, ribbed grip, guard fist).
- **Attacks:** left mouse slashes (alternating swipes), right mouse stabs. Any hit is a kill.
- **Takedowns:** reaching an enemy plays a takedown chosen by how and where you got them. The victim is held and your view is drawn onto them.
  - **From behind:** the left hand clamps the shoulder or mouth, and the knife goes up into the neck with a twist.
  - **Face to face:** a backhand slash across the throat, then the point under the ribs while the off hand shoves.
  - **From the air** (falling or jumping down on them): the knife is raised overhead and driven down as you land.
  - **On a low target** (crouched, prone, below you): tilt and stab downward.
  - **Sliding in:** a low, fast hook as you slide through.
  - **From the flank:** a short hook into the ribs.

**Throwing knife** (new lethal, choose it in Equipment)
- A fast, flat throw with very little drop, spinning end over end. It's a one-hit kill on a soldier.
- A miss sticks into whatever it hits (walls, floors, trees). Walk over a stuck knife, or the one beside a body, to pick it up. You get 2 per life.

**Lights you can shoot out**
- Every interior fixture (pendant, strip, high-bay, bare bulb) and every street lamp can be shot out, by you or by bots.
- When one breaks: a pop of sparks and glass, the light really goes out, and the glowing part goes dark. At night you can kill the lights before a push.
- Everything is repaired at the next match.

**Weather that changes mid-match**
- Most matches, 1.5–4 minutes in, the weather turns:
  - **Fog rolling in off the fjord** (very short visibility).
  - **A snowstorm** (heavy snow that settles, gale-force wind, whiteout fog).
- It builds over ~40 s, holds for about two minutes, then clears.
- **HQ calls it out** on the way in ("Heads up, fog is rolling in off the fjord…", "Snowstorm moving in…") and when it clears.
- Bots' sight shrinks with visibility: in fog they lose you at ~40–50 m.

**Pinging** (X or middle mouse)
- **An enemy under the crosshair:** marked on the minimap and in the world for 8 s, teammates react, and your character calls it out ("Enemy spotted!", "Contact, right there!").
- **Anything else:** a yellow location diamond with its distance ("Over here.", "Check that spot."). Idle teammates nearby drift over to look.

**Indoor / outdoor gunshot echo**
- The space around you is probed continuously: eight rays out to 450 m hit walls, houses, hillsides and the mountain walls of the fjord.
- **Outdoors:** every shot (yours, and nearby bots') sends back its strongest reflections from those surfaces:
  - delayed by the real round trip and panned from the surface
  - darker with distance
  - the far mountains answer a second or more later
- **Indoors:** the room reverb plus a tight slap off the nearest walls.

**FJ-14 tuning:** far less recoil (vertical kick 2.5 → 0.95, much less horizontal), a lighter visual kick, and **2.5×** instead of 4×.

**New voice lines** (ElevenLabs, same voices as before): player ping callouts, knife lines, and HQ fog / snowstorm / clearing calls.

**Still to know**
- The knife takedown animations are procedural and keyframed (no motion capture); the victim is posed and held, not animated per takedown.
- I couldn't measure the frame rate on your GPU here; the draw-call and triangle cuts above are what I measured.

## Update 11

**New weapon: FJ-14 Marksman Rifle** (new *Marksman* class)
- **The rifle:** a 7.62 mm semi-auto with a classic long-rifle silhouette.
  - Black synthetic stock with a straight wrist, steel receiver and ventilated upper handguard.
  - Gas cylinder, front band, prong flash suppressor and front sight.
  - 20-round box magazine.
  - A 1–4× scope on a side mount (set to 2.5× since Update 12).
- **Scope:** a picture-in-picture view at 4× with a **clean, thin cross from edge to edge**, and no dots or posts.
- **Handling:**
  - The right-side op-rod and charging handle visibly snap back on every shot, and lock back on an empty magazine.
  - Heavier camera and gun kick than the carbine, a 4× scope sway and hold-breath.
  - Two to the chest, or one to the head up close.
- **Sound:** a designed report built from the CC0 recordings: the .30-cal bolt-rifle shot tightened up, an AR-style mechanical crack, a driven low body, the distant roll and the op-rod clack.
- **Reloads:** its own choreography.
  - **Tactical:** the box mag is rocked out and the fresh one rocked in front-first.
  - **Empty:** the left hand reaches over the top, pulls the locked-back op-rod handle and lets it slam home.
- Bots carry it too, two per side.

**Loadout screen rebuilt**
- **Slot tabs:** primary, sidearm, equipment.
- **Class tabs:** assault rifles, SMGs, shotguns, marksman rifles, sniper rifles, handguns.
- **Weapon carousel:** cards with rendered white silhouette thumbnails, a gold top bar and an EQUIPPED tag on the one you carry.
- **Studio preview:** the selected gun turns slowly in a real-time 3D view, with its name, description, seven stat bars (damage, fire rate, range, accuracy, recoil control, mobility, handling) and rounds / reserve / RPM.
- **Equipment page:** lethal and tactical cards with icons.
- Adding a weapon is now a one-line change: it appears in its class tab.

**Windows**
- **Vault through any window, from inside or outside:** Space when facing it close by, sill at climbable height, room on the far side.
- **The whole window goes:** the glass shatters, and the cross frame snaps into tumbling wooden pieces and splinters that land on the floor. There's a wood-crack sound and bots hear it.
- Windows reset each match.

**Doors:** kicking a door in now plays a real breach impact (one of three ElevenLabs-generated kick-ins: boot impact, splintering frame, slam) over the designed thump. There's a short sharp screen shake and a kick of the view and the gun, and a wall slam when the door hits its stop.

**Night**
- **Pitch-dark nights:** almost no moonlight, ambient or sky light, and no night exposure boost. Streetlights and lit windows are the only pools of light.
- **Night vision:** stronger gain to suit, and the goggle IR illuminator is now done in the shader (see performance).
- **HQ tells you to put your goggles on** at the start of a night match, and reminds you if you play blind for a while (new ElevenLabs lines).
- **On-screen prompt:** a pulsing "[N] NIGHT VISION" with a goggles icon, shown whenever it's dark and the goggles are up.

**Empty magazines:** spent magazines and the empty speedloader now simply vanish as they leave the hand. No world debris is spawned any more.

**Performance**
- **Scene matrices** are updated once per frame. three.js used to walk the whole scene graph again inside every render call (scope, AO pass and its two transparency passes, water reflection).
- **The goggle IR illuminator** is a screen-space effect in the night-vision shader instead of a real spotlight. That's one fewer light in every lit pixel's lighting loop, day and night.
- **Interior light pool:** 6 → 4 forward lights.
- **Water reflection** refreshes every third frame.
- **HiDPI:** by default the game now renders at one pixel per screen pixel, not the device pixel ratio (up to 2× in each direction on HiDPI / 4K laptop screens). Settings → Graphics → *Full HiDPI resolution* turns it back on.
- **Draw calls:** about 770 per frame in the reference view, against about 1,100 before (and about 2,160 before Update 10).
- **F3 performance overlay** (also in Settings → Graphics): FPS, frame time (average / worst), simulation CPU, render CPU, **GPU time** (where the browser exposes timer queries), draw calls, triangles and render resolution. If it's still slow, an F3 screenshot shows exactly where the time goes.

## Update 10

**Performance** (no visual changes)
- **Shadows once per frame.** Shadow maps were set to auto-update, so three.js re-rendered every shadow map inside *every* `renderer.render()` call: the main view, the AO pass's two transparency passes, the water reflection and the sniper scope. They now render once per frame and every other pass reuses them. Above 75 fps they refresh on alternate frames, and the light matrices update together with the map, so nothing drifts.
- **Fewer draw calls**, measured at the same view: about 2,160 → about 1,100 per frame (main pass 1,595 → 709, shadow pass 520 → 349).
  - **Bot weapons:** each third-person gun was built from about 25 meshes; they are now baked into one mesh per material.
  - **Supply pouches:** baked the same way.
  - **Doors:** the panels are merged into the leaf.
  - **Far forest:** grouped in 300 m tiles instead of 90 m; nearby trees in 150 m tiles.
- **Water reflection:** no longer draws soldiers, doors or pouches. They were imperceptible in the reflection.
- **Sniper scope:** the second full scene render now runs only while aiming, plus a refresh every 4th frame at the hip.
- **Grass:**
  - The old ring rebuilt about 10,000 clumps in a single frame every 7 m you moved, a periodic hitch while running. Grass now streams in 12 m tiles on the same grid with the same per-cell hash, so it looks identical.
  - Tiles are built a few per frame, nearest first, and frustum-culled, so grass behind you is no longer drawn.
  - The distance fade moved into the shader and follows the camera smoothly.
- **Bot AI:** cheaper bone updates for aiming, a back-off on the character controller's step-up retries, and tighter animation detail levels.

**Empty-magazine reload freeze/crash**
- Only an *empty* reload drops the old magazine into the world. Its materials under world lighting, fog and shadows were shader programs nobody had compiled yet, so they compiled on the spot: up to a few seconds' freeze on Windows / ANGLE the first time, or a lost GPU context.
- At boot the game now compiles every shader the match can need:
  - every weapon model in the world scene and in first person
  - all pooled and hidden objects (casings, debris, decals, held items, goggles)
  - the pouch, the helicopter, the grenades, and one of every impact and explosion effect
- Reloads trigger no new shader compiles any more (checked for every weapon).
- A lost GPU context is now recovered instead of killing the tab.

**Smoother motion**
- Far and off-screen soldiers, whose physics is stepped at 20–30 Hz, are drawn dead-reckoned along their velocity between steps, so they glide instead of stepping.
- The camera eases over stairs, kerbs and door sills instead of popping up and down.
- No more grass-rebuild hitch while running (see above).

**Stim and UAV**
- Both are now **one-handed**. The right hand keeps the gun up and can fire throughout. A pump or bolt cycle waits for the left hand instead of cutting the animation off.
- **Stim:** a new olive autoinjector with a window showing the drive spring, held upright in a closed left fist low on the left. Thumb flicks the cap, then a jab down into the thigh.
- **UAV:** a new rugged tablet with an olive bumper frame, a dark-green tactical map screen, ADVANCED UAV and a big green LAUNCH button that reads LAUNCHED when pressed. It is cradled from behind in the left hand, fingers wrapping round the right edge, thumb by the button.

**Audio**
- **Hitmarker and elimination sounds** are the supplied files (`public/assets/sounds/ui`).
- **Hitmarkers overlap:** every hit plays its own tick (no voice stealing) and draws its own marker, so rapid hits stack instead of restarting one.
- **Death screams:** ten different death cries, generated with ElevenLabs sound generation.
  - None of the last few is repeated, and each soldier gets their own pitch.
  - They are positional with occlusion; your own plays when you die.
  - Headshots are mostly silent or a short grunt.

## Update 9

**12v12**
- Twelve a side: eleven bots alongside you, twelve against. Both teams use the same class mix: rifles, SMGs, shotguns and two marksmen each.
- **Spawns:**
  - Opening spawns spread each squad at least 7 m apart around its anchor, fanning out instead of stacking.
  - Respawns search much deeper for a spot no enemy can see. In the spawn test, spawns seen by an enemy dropped from 28 of 48 to 3 of 60, and none landed within 30 m of an enemy.
- **Balance:**
  - The team behind on flags commits more of its squad to the objectives, and up to five bots can go for one capture (seven when it is the last flag left).
  - Neutral flags pull both teams.
  - In a test match, B changed hands several times instead of the match locking into one 2-1 split.
- **Performance:**
  - Tighter animation and movement detail levels by distance and visibility, a back-off on the character controller's step-up retries, and a narrower bone update for bot aiming.
  - Simulation for 24 players: about 3.3–3.9 ms per frame in a whole-match test, against about 4.5 ms for 12 players before.
- **Voices:** 12 soldiers per side share two recorded voices, so each soldier gets a stable pitch of their own.

**Night vision (N)**
- **Putting them on:** the support hand leaves the gun, reaches up to the goggle mount and swings the dual tubes down from the brow onto the face. There is a beat of black, the tubes flare up bright green and settle, and a power-up whine plays.
- **Taking them off:** the hand pushes them back up, the image collapses to black and the normal view fades back in.
- **The image:**
  - Intensifier response weighted toward red and near infrared, with automatic gain: bright at night, compressed in daylight.
  - Phosphor green with the sparkling scintillation noise of a working tube, halos around lights, slight flicker and a binocular eyepiece mask.
- **IR:**
  - A goggle-mounted IR illuminator lights what you look at.
  - Soldiers glow (body heat and IR-reflective kit).
  - The IR aiming lasers are only visible through the goggles.
- **Night matches:** one dynamic-time match in five now starts at night. `?time=night` forces it.

**Canted laser aim (night vision on, K416 / MP7 / pump shotgun)**
- All three guns carry a new IR aiming laser module at 3 o'clock.
- With goggles on, aiming down sights no longer uses the optic. The gun rolls over about 35° with a little overshoot, drops below the eye and pulls in, and the laser does the aiming. Zoom drops to almost none.
- The beam runs from the laser module's aperture to a dot on whatever it touches. From the hip it follows the barrel; when aimed it is zeroed on the crosshair.

**Music** (original tracks, `tools/music_build.py`)
- **Main menu:** a slow-building Nordic orchestral and hybrid theme, made seamlessly loopable.
- **Match end:** a victory sting (brass fanfare) and a defeat sting (horn and cello).
- **Tension:** a ticking, pulsing underscore fades in when either team reaches 80 % of the score limit (about one flag's worth of holding from the win) or in the last minute of a close game.
- The music has its own volume slider (Settings → Audio), bypasses the low-health and explosion muffle, and ducks under radio calls.

**Radio net: HQ, the gunship pilot and the recon / fire-support operator**
- All radio lines go through one queue, so they never talk over each other: higher-priority calls jump the queue and lines that are no longer true expire.
- **Pilot (VALKYRIE 1-1):** on station, engaging, target down, taking fire, mayday, leaving the area.
- **Operator (OVERWATCH):** UAV online / offline, enemy drone overhead, fire mission received, shot out, fire mission complete.
- **Context-aware HQ:**
  - close to winning and close to losing
  - a held flag being contested, plus the existing losing / lost / secured calls
  - lead taken and lead lost
  - a comeback after being well behind
  - tied score
  - all three flags held by us or by them
  - the last minute and the last thirty seconds
  - Each call has its own cooldown.
- New ElevenLabs lines cost about 1,225 characters.

**A world you can break and use**
- **Windows:**
  - The first ordinary round stars the pane with a spider-web crack where it hit.
  - The next round shatters it: a shotgun, the .338 or a nearby explosion shatters it straight away, and big panes go sooner.
  - Shards tumble out, mostly in the bullet's direction, and settle flat on the floor on either side. Jagged pieces stay in the frame corners.
  - It comes with recorded-style crack and shatter sounds, and nearby bots hear it.
  - Windows are restored at the start of every match.
- **Doors:**
  - E opens or closes the door you are looking at. A closing door never drops its collider onto someone standing in its way.
  - **Door peek:** aim down sights near a closed door and you ease it open with the muzzle while leaning out about 16 cm toward the gap. The camera rolls, and the gun tucks in and cants with the lean, without leaning into walls. Push forward to open it further. Let go and it stays cracked; walk on and it swings open.

**Reload from empty:** every weapon was tested firing to empty and reloading, with no errors. The crash seen in automated testing turned out to come from the test environment's software renderer, which dies after a long run of back-to-back frames on any weapon (Update 7 does the same). It was not a game bug.

## Update 8

**Hands and fingers**
- **Fingers wrap what they hold.** Every finger joint now curls until it actually touches the surface it is holding, instead of using a fixed curl preset. The surfaces are:
  - pistol grips and handguards
  - magazines during reloads
  - the revolver speedloader
  - grenades and tactical canisters, the stim injector, the UAV phone and the laser designator

  If a finger can't reach anything it rests in a relaxed curl. The trigger finger keeps its own position. The on-gun wrap is worked out once per grip and cached, so it costs nothing per frame.
- **Wrists:** the forearm now takes most of the hand's roll, so the skin no longer twists into a thin "candy-wrapper" wrist.

**Voices**
- **Bots really talk in the world:** voices come from the bot's position, are only heard within about 30 m, are muffled behind walls and pick up the room's reverb.
- **Subtitles:** every callout shows a subtitle with who said it, coloured by side, with an ENEMY tag and the distance.
- **Your own voice:** a separate ElevenLabs voice for your callouts.
  - **Combat:** reloading, frag / flash / smoke / stun out, stim.
  - **Kills:** kills, headshots and multi-kills.
  - **Killstreaks:** UAV, mortar and helicopter call-ins.
  - **Other:** capturing a flag, getting hit, low ammo, breaching a door, grabbing supplies.

**Gameplay**
- **Supply drops:** killed enemies drop a supply pouch. Walk over it to get +40 health, one magazine of ammo for both weapons, +1 frag and +1 tactical (each capped). The pouch is marked by a floating icon and blinks before it disappears after 30 s.
- **Sniper scope:** much larger on screen (the eye sits closer), with its own lower sensitivity. Change it under Settings → Gameplay → Sniper scope sensitivity (default 0.2).
- **Roof ladders:** every house has a steel ladder on its back wall up to the eave, and it lets you out onto the roof.

**Map**
- **Props and cover** are scattered across the whole map, and all of them are solid:
  - **House yards:** firewood stacks, bins, mailboxes, benches, garden sets, planters, garden sheds, laundry lines.
  - **Roadsides:** snow poles, road signs, bus shelters, grit bins, trailers.
  - **Harbour:** fish crates, rope coils, buoys, oil drums, cable drums, nets, tarps.
  - **Farmland:** silage bales, fences, trailers.
  - **Combat areas:** a ring of crates, sandbags, concrete pipes, jersey barriers, ammo crates and wrecks around every landmark, where the flags are.

## Update 7

**Weapons**
- **R357 revolver** (new sidearm). It has its own animation set:
  - **Firing:** the hammer falls, then thumbs back while the cylinder indexes 60°.
  - **Tactical reload:**
    1. Roll the gun and push the cylinder out.
    2. Point the muzzle up and palm the ejector rod. Six cases drop into the world.
    3. Take a speedloader from the belt and line it up with the chambers.
    4. Push it in, twist the knob, then pull away and drop the empty loader.
    5. The support hand closes the cylinder.
  - **Empty reload:** faster, and ends with a wrist flick that snaps the cylinder shut.
  - **Inspect:** two twirls on the trigger finger, flick the cylinder open, spin it, flick it closed.
  - **Hold-inspect:** cylinder check.
  - **Draw:** twirls the gun up into the hand.
  - **Sounds:** real revolver recordings, with a heavier .357 report designed from them.
- **K416 optic:** back to the compact tube red dot, now with clear coated glass (almost invisible in the middle, a faint coating sheen at the rim). The dot is a collimated, crisp, blooming dot that only shows when you look through the sight and stays on the point of aim. Nothing inside the tube blocks the view.

**Equipment and killstreaks**
- **Tacticals (F),** one type per loadout:
  - **Flashbang:** blinds and deafens, and works on bots too.
  - **Stun grenade:** slows movement and aim.
  - **Smoke grenade:** a 20 s screen that blocks bot vision.
  - **Stim:** an auto-injector that heals fast and gives +18 % movement speed for 10 s.
  - **Animations:** each throwable has its own grenade model in the hand. The stim has a cap-flick and jab animation.
  - **HUD:** a frag and tactical slot with icons, counts and keys, a cook bar, and STIM / STUNNED / BLINDED status.
  - **Bots** use flashes, stuns and smokes too.
- **Killstreak animations:**
  - **UAV:** the left hand raises a rugged phone and thumbs the UAV button on its screen.
  - **Mortar Strike:** the left hand raises a laser designator. A red beam and dot show the target with its distance. Left click calls it in, right click or 4 cancels.

**Loadout**
- **Loadout screen:** primary, sidearm (P80 or R357), lethal (frag) and tactical.
- **In a match:** reachable from the pause menu. Changes apply on your next spawn, or immediately if you only just spawned and haven't fired.

**Movement and animation**
- **Dolphin dive:** Z while sprinting launches you forward and lands you prone.
- **Ladder animation:** the gun drops away and both hands climb rung over rung.
- **Mantle and vault animation:** the support hand plants on the ledge.
- **Visible legs:** look down to see your legs and feet walking and running, and your legs cast a shadow.
- **Tactical sprint:** a new carry for all guns, held upright on the right side with the hand on the grip.
- **Ragdoll deaths:** a verlet ragdoll swept against the world. Bodies crumple, slump against walls and tumble down stairs and slopes.

**Voice and AI**
- **Voice callouts** (ElevenLabs):
  - **Bots:** two voices per team. They call reloading, frag / flash / smoke / stun out, grenade warnings, contact, taking fire, man down, kills, capturing A / B / C, and "I'm blind".
  - **Announcer:** match start, flags secured / lost / losing, UAV, mortar and helicopter (friendly and enemy), last minute, and win / lose.
- **Doors:** bots push doors open earlier and faster, so they no longer stall at them.

**Performance**
- **Movement LOD:** distant, off-screen bots run their character-controller sweep at half rate.
- **Result:** simulation per frame dropped from about 7.5 ms to about 3.2 ms in a full bot fight.

## Architecture

```
src/
  core/      math, input, Rapier wrapper
  render/    GPU texture baker, surface library, materials, sky, height fog, post pipeline
  world/     map layout & terrain function, terrain, buildings, infrastructure, vegetation, environment
  player/    character body (Rapier KCC), player controller, camera rig
  weapons/   modelling kit, weapon models, arms + IK, viewmodel animation, weapon system, weapon stats
  fx/        particles, tracers, decals, casings, muzzle flash, weather
  audio/     procedural audio engine
  ai/        nav graph, bots
  game/      Game orchestrator, combat, ballistics, Domination, explosives, killstreaks, killcam, spawns, settings
  ui/        HUD and menus
```

`Combatant` (`src/game/Combatant.ts`) is the single interface used for damage, hit tests, scoring and spawning. A future networked player implements the same interface. `Match` holds plain, serializable game state (`snapshot()`), and `Combat.fire()` is deterministic hit resolution that can move server-side. These are the intended seams for real multiplayer.

## Assets and licensing

The environment this was built in could only reach GitHub and npm. Sketchfab, Poly Haven, Quaternius, Mixamo, BlenderKit and Freesound were blocked by the network policy. So:

- **Weapons, buildings, vegetation, props and all textures** are original, procedurally generated in code. Nothing proprietary is used.
- **Gunshots and weapon handling** are field recordings from the **Free Firearm Sound Library** by B. Jaszczak (**CC0**), via the GitHub mirror `buddingmonkey/freefirearmssfxlibrary`, trimmed by `tools/sfx_build.py`. The heavier sniper report, the explosions, the hit-marker tick, the kill confirm, the knife hit and the door sounds are designed offline in the browser by layering and processing those CC0 recordings and the Kenney CC0 impacts. No weapon sound is synthesized any more.
- **Revolver sounds** come from the Smith & Wesson 642 recordings in the same CC0 library: shots, cylinder open/close/flip, ejecting and loading shells, spinning, hammer and dry fire.
- **Voice callouts** (bot chatter, your own callouts, HQ, the helicopter pilot and the fire-support operator) were generated with **ElevenLabs** text-to-speech (`tools/voice_build.py`, premade voices). They were made on a free ElevenLabs plan, which requires attribution and allows only non-commercial use. To use the voices commercially, regenerate them on a paid plan with the same script.
- **Music:** the menu theme, the tension underscore and the victory sting were generated for this game with **Stable Audio 2.5** through the Stability AI API (original text prompts, no reference material; see `tools/music_build.py`). Use them under Stability AI's terms for API outputs. The defeat sting, the night-vision power-up / power-down, the glass crack / shatter sounds, the three door-breach impacts and the ten death screams were made with **ElevenLabs sound generation**, under the same free-plan terms as the voices (attribution, non-commercial).
- **Hitmarker and elimination sounds** (`public/assets/sounds/ui/hitmarker.ogg`, `killsound.ogg`) were supplied by the project owner.
- **Interface stings, ambience loops and the helicopter rotor** (flag captured/lost, killstreak ready, radio, UAV ping, heartbeat, mortar whistle, wind, waves, rain) are synthesized in code.
- **fps_arms.glb**: "fps arms" by DJMaesen (https://sketchfab.com/bumstrum), licensed **CC BY 4.0**. Changes: its material was rebuilt for three.js, and its textures were re-encoded from PNG to JPEG (the unused specular-glossiness map was replaced by a stub) to cut the download (`tools/glb_compress.py`).
- **Footstep and impact recordings**: Kenney "Impact Sounds" (CC0), via the GitHub mirror `Boyquotes/kenney-impact-sounds-for-godot`.
- **waternormals.jpg** comes from the three.js examples (MIT-licensed repository).
- Fonts are Barlow Condensed and Inter, via @fontsource (SIL Open Font License).

To swap in higher-fidelity licensed assets later (for example CC0 weapon GLBs or recorded audio), use these points:
- `WEAPON_BUILDERS` in `src/weapons/WeaponModels.ts`: a GLB only needs the same sockets (`muzzle`, `eject`, `sight`, `rightHand`, `leftHand`, `magWell`) and named parts (`mag`, `bolt`, ...).
- `AudioEngine.bank` in `src/audio/AudioEngine.ts`.

## Testing hooks

`?test` pauses the render loop and exposes `window.game` for automation. Use `game.step(n)` to advance frames, `game.view(x, z, yaw, pitch)` to teleport, and `game.inspectModel(id)` / `game.debugVM()` for studio renders. The Playwright scripts in `tools/` (`shot.cjs`, `grid.cjs`, `seq.cjs`) use these to capture screenshots headlessly. `vmgrid.cjs` renders viewmodel poses and reload frames (`game.weapons.vmForce` forces sprint, tactical, slide and ADS states). `walktest.cjs` walks every doorway, stair and bridge link. `walkpath.cjs` traces a single path and reports what blocks it. `spawntest.cjs` simulates a bot match and measures how safe the spawns were.
