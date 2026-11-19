# Client structure

The client is split into parts with one owner each. They only meet through
`packages/client/src/contracts.ts` (frame view, renderer and API interfaces) and
`packages/client/src/state/store.ts` (reactive application state).

| Part | Directory | Role |
|---|---|---|
| Game core | `src/game`, `src/net`, `src/input` | Network, prediction, interpolation, input; builds one `FrameView` per frame; implements `GameApi`. |
| Space renderer | `src/render/Renderer.ts`, `src/render/space`, `src/render/post` | Owns the canvas and the frame: sky, stars, planets, black holes, belts, post-processing. |
| Local layer | `src/render/local` | Ships, stations, gates, asteroids, cargo, effects and the cockpit. Implements `LocalLayer`. |
| Interface | `src/ui`, `src/styles`, `src/i18n/en.ts`, `src/i18n/de.ts` | Start screen, HUD, station screens, maps. Talks to the game only through `GameApi` and the store. |
| Audio | `src/audio` | Plays the approved sounds of the sound library, from the frame view and its events, on the stage of the audition page. See "Sound". |

`src/main.ts` wires them together and is the only place that knows all of them.

## Frame flow

1. The game core advances prediction in fixed ticks, interpolates other entities and fills a `FrameView`.
2. `GameRenderer.render(view)` draws the sky and celestial bodies, calls `LocalLayer.update(view, lighting)`,
   draws the local scene and the cockpit scene, then post-processing.
3. `GameAudio.update(view)` runs, and `store.frame` is incremented so HUD components re-read `GameApi.view`.

## Coordinates

Every position in a `FrameView` is relative to the camera, in metres, in non-rotating system axes,
computed in float64 by the game core. Renderers keep the camera at the origin. Celestial bodies are
drawn far-to-near with their distance compressed toward the camera (the image is unchanged because
the scaling is centred on the camera), so no depth buffer has to span metres to light-hours.

## Controls

Shooter-style by default: W/S forward and back, A/D strafe, Space up, Ctrl (or C) down, Q/E roll,
Shift boost, mouse to turn. The mouse wheel sets a persistent throttle. All bindings are editable and
live in `Settings.bindings`. Browsers reserve Ctrl+W outside fullscreen, so the client requests the
Keyboard Lock API in fullscreen and asks before the tab closes while a pilot is in space.

Targets have keys of their own: T and G step through the ships in sensor range, O and L (and the
forward side button of the mouse) through the places of the system, Y or the back side button
takes what lies ahead of the nose, and U lets go, first of the locked ship and then of the chosen
place. See "Targets and direction indicators" below.

### Controllers

Gamepads, joysticks and HOTAS sets work through the browser's Gamepad API and feed the same input
values as keyboard and mouse; nothing in `shared` or `server` knows about them. This is also the only
way to play on a phone or tablet for now: there are no touch controls. Flight is live without pointer
lock while the last device used is a pad; moving the mouse, a click, a turn of the wheel or a key
switches back.
`input/gamepad.ts` holds the logic without any DOM access, `input/Input.ts` polls once per animation
frame, `ui/padnav.ts` moves the focus through menus, and `ui/Bindings.tsx` is the binding screen
(settings on the start screen and in the pause menu).

Default layout of a standard pad (Xbox names; on a PlayStation pad A is Cross, B Circle, X Square,
Y Triangle, LB/RB are L1/R1, LT/RT are L2/R2, View is Create, Menu is Options). Y is the modifier:
hold it and press a second button for the combinations.

| Control | Action | Control | Action |
|---|---|---|---|
| Left stick | strafe and forward/back (cruise: throttle) | Right stick | yaw and pitch |
| RT / LT | fire primary / secondary | RB / LB | roll right / left |
| A / B | thrust up / down | X | tool (mining laser, salvage) |
| L3 / R3 | boost / brake | View / Menu | cruise / pause menu |
| D-pad up / down | target ahead, else the next ship / clear target | D-pad right / left | next / previous place |
| Y + A | dock or undock | Y + B | flight assist |
| Y + X | fold jump | Y + View | galaxy map |
| Y + Menu | system map | Y + D-pad | power: left shields, up engines, right weapons, down reset |
| Y + LB | contacts | Y + RB | camera |
| Y + L3 | silent running | Y + R3 / RT / LT | throttle zero / up / down |

A button pressed while Y is held belongs to the chord: it does nothing of its own until it is let
go, whichever of the two is released first. A button held from before Y pauses during the chord
and goes on afterwards, without counting as pressed again.

In menus and station screens the D-pad or left stick moves the focus mark (it repeats while held),
A presses, B closes or goes back, LB and RB switch tabs, and left and right change a slider or
select. A number field is edited after A: left and right count, by one at first, then in tens and
in hundreds while the direction is held, and B ends the editing. A link that opens another tab is
no target. The galaxy map lists the systems so one can be chosen without the mouse. The start
screen comes with a made-up pilot name (a word and four digits) while none is saved, so that Launch
works without a keyboard; every other text field still needs one.

B closes the station screen as Escape does, and so do the Menu button and opening a map. While the
ship is docked the pause menu has a "Station services" button that brings the screen back.

What is still held when a menu or panel closes does not fly the ship: a button stays without
effect until it has been let go, a stick until it has been at rest. A on "Resume" does not thrust
up. Buttons held through a fold jump between two servers stay held.

On the binding screen a pad ends an assignment by itself: any button while an axis is wanted, and
the button of the pause menu while a button is wanted. That button is never taken from the pause
menu: it cannot be given to another action, become the modifier of a chord, or be cleared; the
menu action can be moved to another button, as long as that one is not the modifier of a chord
(a modifier has no action of its own). An axis given to an action is taken from the action that
had it, as a button is.

Binding codes in `Settings.bindings` are `Pad:<dev>:b<n>` for a button, `Pad:<dev>:b<m>+b<n>` for a
chord and `Pad:<dev>:a<n>+` or `a<n>-` for half an axis used as a button; `<dev>` is `std` for every
standard-mapping device or a short key made from the device id. Analog axes live in `Settings.pad`
(dead zone, curve, invert, a throttle lever). A lever sets the throttle when it moves; the last
two hundredths of its travel before either stop count as the stop; a move made while a panel is
open is applied when the panel closes; and of two levers that match one binding the one that moved
last counts. Saved pad settings are repaired when they are loaded (an entry that is no axis binding
is dropped, a missing field is filled in), and a frame in which the pads cannot be read does not
end the polling.

Labels made of words ("D-pad left", "Button 14", "Axis 3") are in the language of the interface:
`ui/format.ts` passes the words to `input/gamepad.ts`, which knows no languages. The short form of
the D-pad on the key caps of the HUD (D←) and the names printed on a pad (View, Cross) are the same
in every language. The pad help block in the pause menu shows the default layout, not the pilot's
own assignments, and says so.

What is checked, and how:

- `node scripts/pad-check.mjs` plays the built game in Chromium with a fake
  `navigator.getGamepads` (one standard-mapping pad, English interface). Where this list says
  "the mark", the script looks at which control carries the mark (the class `padfocus`), not at
  whether the mark can be seen:
  - start screen: D-pad from the name field over the server field to Launch, and A connects; in a
    second pass nothing is typed, the name is the made-up one, and the mark passes the link to the
    source code by;
  - station screen: the mark on a tab when it opens, RB and LB with the mark still on a tab after
    the change, a quantity held right for three seconds (past 100) and one press back, B closing
    the screen, the way back through the pause menu, undock;
  - flight: stick thrust, stick turn and its stop, boost, fire, the D-pad choosing places, Y + RB
    for the camera with either button let go first (RB does not roll the ship afterwards);
  - pause menu: a slider, a select, a held direction, and no "Station services" button in space;
  - binding screen from the pause menu: the mark on Back when it opens, a new button for an action
    and the hint changing with it, the mark on the button that listens, the Menu button ending a
    button assignment and B an axis assignment with nothing changed and the screen still open, a
    mark at once on the way back to the pause menu;
  - A and a deflected stick held through "Resume": no thrust and no turn until both were let go;
  - galaxy map by Y + View: the mark in the list, D-pad down, A selects;
  - PlayStation names in a hint;
  - at 844 x 390: the station screen (two tabs) and the pause menu lie inside the viewport, and the
    D-pad reaches the last button of the pause menu, scrolled into view.
- The logic that needs no page (chords and their mutes, held buttons and sticks after a menu, the
  lever, capture on the binding screen, binding edits, loading saved pad settings, label words,
  number steps) has unit tests in `input/gamepad.test.ts`, `input/input.test.ts`,
  `input/padui.test.ts` and `ui/padnav.test.ts`. `python tools/dev/guards.py
  tools/dev/guards/pad-core.json` switches one rule off at a time and names the test that has to
  fail. The page side of `ui/padnav.ts` (the `PadNav` class) has no unit test; the browser check
  is what covers it.

Known gap, measured on 2026-11-14 on the screenshots of that script and on a page with the built
stylesheet: the mark cannot be seen on a button. `#ui button` in `styles/ui.css` has a `clip-path`
for its cut corners, and the mark is an outline and a glow outside the box, so both are cut off
(no amber pixel around a marked Launch, Resume or tab; on a field, slider, select or a row of a
list, which are not clipped, the mark shows). Until the stylesheet lifts the clip on a marked
button or draws the mark inside it, a pilot with a pad sees the focus on fields, sliders, selects
and list rows only.

Not checked: anything on real hardware (how the sticks feel, drift and dead zones of a real pad,
the joystick preset and other non-standard devices with their axis numbering, hat switches and
throttle units, a throttle lever, two devices at once, browser differences in `Gamepad.id` and
`mapping`); phones and tablets themselves; the German interface in a browser (its pad labels have
unit tests only); the binding screen opened from the start screen; the system map and the contacts
list by pad; the binding screen and the maps at 844 x 390. The flight HUD has no layout of its
own for that size, and its bottom row (status bars, power, compass, speed) still overlaps. The
radar is left out below a width of 900 px until that layout exists.

Stepping through ships (`targetNext`, `targetPrev`) has no button on a standard pad: every button
and every Y chord is taken. "Target ahead" covers it: with nothing new ahead of the nose it steps
on to the next ship in range. Both actions can be given a button on the binding screen.

## Targets and direction indicators

The pilot has two targets side by side. The chosen place (`store.navAnchor`, a site or body id,
known to the client only) is where cruise drops out, and what the amber marker, arrow and panel
show. The locked ship (`store.targetId`, sent to the server) is what the white or red marker and
its panel show. Choosing one never drops the other.

- `state/places.ts`: the order of the places (places to dock, gates, other sites, bodies; nearest
  first within each group), stepping through it, and the place ahead of the nose. The game core
  (`cycleNav`, `targetAhead` in `game/Game.ts`) and the interface both use it. While the HUD shows
  its list the order is kept in `store.navList`, so rows do not change places during stepping.
- `ui/orient.ts`: the geometry, without any DOM access: where the arrow for something off screen
  stands (on an ellipse around the middle of the view, 0.42 of its width and 0.27 of its height)
  and which way it points, the dot on the compass, where contacts and places stand on the radar,
  the closing speed, how an arrow moves inward until it is clear of the HUD blocks, and how labels
  give way to each other.
- `ui/Orient.tsx`: the components. A small arrow for every place to dock and every gate that is
  off screen, a large one for the chosen place and for the locked ship, with a second chevron and
  the word "behind" while the target lies behind the camera. The compass beside the speed readout,
  in the ship's own axes: one dot per target, filled ahead and hollow behind. The panel of the
  chosen place with closing speed and time of arrival. Two lines under the system name that count
  the places and the contacts in sensor range and name the controls. The list of places, open for
  six seconds after a step. The radar, see below.
- The radar (`Radar` in `ui/Orient.tsx`, `radarBlip`, `radarRim` and `radarRadius` in
  `ui/orient.ts`) stands to the right of the speed readout, as a child of the centre block, so it
  moves when that block grows wider over the ground. It shows the ship's own axes, never the
  camera's: the ship's plane is a disc seen from behind and above (ahead is up, drawn 0.56 as high
  as wide), inside a circle that holds everything a mark can reach. Ships, wrecks and cargo pods
  from `view.ents` are points on stalks that stand on the plane: a square for a ship (white, red
  for a hostile one, green for another pilot), a hollow amber square for a wreck, an amber dot for
  a pod, a white ring around the locked one. The direction is kept and the distance is
  logarithmic: rings at 100 m, 1 km, 10 km and the rim at 100 km, written under the instrument.
  What is nearer than 100 m stands on the innermost ring; what is farther than 100 km (a ship in
  cruise is seen across the system) stands at the rim's distance and is drawn hollow. Every place
  to dock (a diamond), every gate (a square) and the chosen place (amber, whatever it is) are
  marks on the rim, at the bearing in the ship's plane; from each a stalk with an arrowhead points
  up or down by how far the place lies above or below the plane, at most 0.4 of the radius.
  Straight above or below, where there is no bearing, a mark keeps the one it had. It only shows;
  nothing on it can be chosen.
- "Target ahead" (`targetAhead` in `game/Game.ts`, its rule is `aheadChoice` in `state/places.ts`)
  looks in a cone of about 26 degrees around the nose. A ship, wreck or pod in it is locked. A place is taken only while none of those is in the
  cone, so that a press in a fight never replaces the chosen place. With nothing new ahead the
  lock steps on to the next ship in range.
- The closing speed is the part of the ship's own velocity that points at the target (minus that
  of a target ship), not the rate at which the distance changes: between two places on different
  orbits that rate is tens of kilometres per second while the ship lies still.
- Key caps on the HUD use `bindKeyShort` (the D-pad is "D←", a chord "Y+A"); sentences use
  `bindKey`.
- The station screen (`.panel.station`) has one size on every tab; what a tab holds scrolls inside.
- `node tools/dev/orient-check.mjs` plays this on the development page and measures it: stepping,
  the list, a place behind the ship, clearing, controller hints, the radar (every contact and
  every mark against positions worked out from the frame view, to 1.5 px; colours; the ring of the
  locked ship; the camera turned away from the nose), that no block of the HUD lies over another
  at 1280 x 720 (German and English, a system with 19 places, over the ground also with controller
  hints), and the rectangle of the station screen on every tab at four sizes. `--only=radar` plays
  one part alone. It starts its own Vite server and needs no game server. The page is
  `/dev/local.html?scene=orient&hud=1&cam=cockpit`; `dev/hud.ts` lists the options of the HUD on
  it (chosen targets, controller hints, a made-up station), and `more=1` puts another pilot, a
  wreck, far contacts and a gate into the scene.

## Sound

The game plays files, not oscillators: the sounds of the sound library that the owner has approved
(`tools/audio/SOUND_DESIGN.md` is the concept, "you hear your ship, not space"). They are shipped
as lossless FLAC under `packages/client/public/audio` by `tools/audio/ship.py`, which derives what
may go in from the library's manifest and his ratings (`tools/audio/README.md`, "Shipping to the
game"); `public/audio/manifest.json` is what the game loads and `public/audio/CREDITS.md` gives the
licence of every shipped file. An event of the game without an approved sound makes no sound: the
manifest lists those under `silent`, with the reason.

| File in `src/audio` | Role |
|---|---|
| `library.ts` | The shipped manifest and the decoded files. Fetching and decoding start with the page and need no click (an offline context decodes); the room, the cabin, the engine and the thrusters come first. |
| `stage.ts` | The audio graph, the one of the audition page: a one-channel sound at its place by a balance law (straight ahead it plays at the file's level on both sides; behind it is duller), a two-channel file as it is, everything through the cabin's impulse response, a limiter that leaves everything below -2 dBFS as it is. |
| `cues.ts` | The mapping from a `FrameView` to what should sound, as a pure function with its state and its random numbers handed in. It names events of the sound list (`assets/audio/game.json`), never files. |
| `mixer.ts` | Makes the stage sound like the mapping says: the engine group, the loops, the sounds held by their event, the one-shots, a transmission on the radio; picks among an event's sounds, never the same twice in a row. |
| `index.ts` | `createAudio()`, the `GameAudio` the game core and the interface use. |

Rules that hold across these files:

- The levels are in the files. Sounds are mixed by adding them at gain 1; a gain in `cues.ts` is
  there only where the game has something to say with it.
- The audio context is created by `GameAudio.unlock()`, which the game core calls from the first
  click or key. Before that, and while the page is hidden (the context is suspended then), a mix is
  dropped: loops start with the first mix once the context runs, and a one-shot whose moment has
  passed is not played late.
- The volume setting is one gain ahead of the limiter.
- `window.__audio` holds the library, the stage with its play log, the mixer and the last mix, for
  the console and for `tools/dev/audio-check.mjs`, which plays the real game in a headless browser
  on ports of its own and reads what was scheduled and what level leaves the output.

What sounds when (`cues.ts`; the numbers are `TUNING` there):

| What | When |
|---|---|
| Cabin (`cabin_ambience_loop`) | Whenever the pilot sits in the ship, docked and in the fold tunnel included; `silent_running_loop` instead while silent running is on. Nothing once the ship is destroyed. |
| Main engines (`engine_main_*`, six levels) | In flight and on the ground. The levels are crossfaded with equal power by what the pilot asks for: the forward axis or the throttle setpoint, whichever is more; the boost level while the boost runs; half thrust while the brake is held and the ship moves. The sound follows a change with a spool time (0.25 s up, 0.45 s down). In cruise and on the ground the engines idle. |
| Thruster pulse (the sounds of `thruster_pulse_c`) | When sideways or vertical thrust sets in or turns round. No sooner than 1.2 s after the pulse before it, at most two at once. |
| Thruster burn (`thruster_burn_loop`) | While sideways or vertical thrust is held, as loud as the stick is pushed. |
| Cruise | `cruise_charge` while the drive charges (cut short when the charge is cancelled), `cruise_engage` when it takes hold, `cruise_loop` in cruise, `cruise_disengage` when it lets go. The chain follows what the ship does, frame by frame, not a plan made at the start: a charge can be cancelled and time can run slow. |
| Fold | `fold_charge` while the drive charges, `fold_jump` when the ship enters the tunnel (a jump out of cruise has no disengage sound), `fold_tunnel_loop` in the tunnel, also while another server takes the ship over, `fold_exit` on arrival. |
| Hits on the own ship | From the `hit` events of the own ship, several in one frame as one: light, medium or heavy by the share of the hull or shield the hit took (a tenth, a fifth), from the side the impact point lies on. A heavy hull hit is followed by `hull_stress_groan`. A hit of the ground is a hull hit like any other. |
| Alarms | One at a time, the most urgent: `alarm_missile` while a missile closes on the ship, `alarm_hull_critical` for 6 s after the hull fell below a quarter and after every further hit there, `alarm_heat` above nine tenths of the heat capacity, `alarm_fuel_low` for 12 s when the fuel falls below a tenth and again below a twentieth. `alarm_shields_down` when the shield collapses. |
| Own weapons | A `shot` event of the own ship by the kind of its mount: `weapon_pulse_fire`, `weapon_cannon_fire`, `missile_launch` from the side its rack sits on; `weapon_beam_loop` while a beam reports itself, `mining_laser_loop` while the mining laser or the salvage beam works. |
| Outside | What happens outside is a sensor signal, from the direction it lies in: `sensor_fire_outside` when another ship within 12 km fires (at most once a second), `sensor_explosion_outside` when one is destroyed, `debris_patter` a moment later within 1.5 km. `sensor_contact_ping` for a new contact (not for what is there on arrival), `sensor_lock_tone` for a new target. |
| Landing | `gear_deploy` below 150 m above the ground while sinking, `gear_retract` above 300 m; `sensor_proximity_tick` below 600 m while sinking, every 1.6 s there and every 0.12 s at the ground; `dust_patter_loop` below 60 m; on touchdown `touchdown_soft`, or `touchdown_hard` and the hull's groan at 3 m/s and more, then `settle_creak`. Docking at a station plays the soft touchdown as well. |
| Radio | A chat message of somebody else arrives as `radio_tone` on the radio loudspeaker: the squelch opens, the tone plays in the narrow band with a little hiss, the squelch closes. |
| Interface | A press on any button plays `ui_click`; an information notice `ui_notice`, a warning `alarm_master_caution`. |

The mapping asks for every event, also for those that have no approved sound (the cannon, the pulse
laser, the gear retracting, the shields-down alarm, the debris, the dust and the scraping on the
ground): they are silent until a sound for them is approved and shipped, and need no change of the
code then. Where an event plays the sounds of a stand-in, a gain can say what the borrowed sound
cannot: a medium and a heavy shield hit play the approved shield sound 3 and 6 dB louder.

## Models

`packages/client/public/models/<key>.glb`, generated by the scripts in `assets/blender`.
Nose toward -Z, top toward +Y, metres, origin at the centre of mass. Empties named `engine_*`,
`hardpoint_*`, `dock_*` and `light_*` mark where effects attach. Until a model exists the local layer
shows a procedural stand-in, so the game runs without any binary assets.

## Effects

What lights up near the camera is drawn by the effects part of the local layer
(`src/render/local/fx`: weapon fire, hits, blasts, missile trails, dust), the engine plumes by
`src/render/local/objects/exhaust.ts`, and what lies over the whole picture (fold, charge, heat,
hit flash) by the final pass `src/render/post/Composite.ts`; the look of cruise flight is
`src/render/post/Cruise.ts`.

- The effect stage, `/dev/local.html?scene=fx`, shows one effect at a time close to the camera and
  repeating: `show=<act>` picks it, `range=<m>` its distance, `hull=<id>` the ship it is about,
  `every=<s>` a shorter period (a steady load for a frame time), `own=1` or `cam=cockpit` puts the
  pilot's own ship there too, and `slow=<factor>` runs any scene of the page in slow motion. The
  acts are small scripts in `src/dev/stage`, one file per effect family (`weapons.ts`, `hits.ts`,
  `blasts.ts`, `transits.ts`, `engines.ts`); `stage/index.ts` lists the options and where the
  effects are that the stage does not show (mining in `scene=belt`, the pilot's own engines in
  `scene=chase`, the ground in `scene=surface`, the overlays as options of any scene).
- Effects throw light on what is near them. `fx/lights.ts` holds a fixed few point lights: three
  in the local scene and one in the cockpit scene, made once and never hidden (a light without a
  source has intensity 0), because three compiles a material for the number of lights in its
  scene. Each frame the strongest sources as seen from the camera get them; a light stays with
  its source and fades over a few frames when it loses it. An effect names a source with
  `effectLights.add(x, y, z, r, g, b, intensity, reach)` in every frame it glows (relative to the
  camera, zone axes, metres, linear colour; the light at distance d is intensity/d², where the sun
  is about 3), or once with `effectLights.pulse(x, y, z, r, g, b, intensity, reach, life, follow)`
  for an event (relative to the zone anchor or to the entity `follow`; it fades by itself). A
  blast gives 600 times its squared ship radius for 0.22 s, a muzzle flash 30 (pulse) to 380 (rail
  gun), the ends of a beam 15 and 40 with a reach of 7 and 10 m. The cockpit's light stands for the
  strongest source outside, in its direction, with 0.45 of its strength. At quality 0 the lights
  stay dark. Sources are kept until the effects part ends its frame, so another part may add its
  own before.
- A destroyed ship (`fx/blasts.ts`, `destroyed`) gives a short flash with a falloff and rays in
  the lens, a fireball of under half a second and a soft shell of gas that is gone in 0.4 s. What
  remains is a cloud of splinters (`fx/splinters.ts`; 50 for a pod, 300 for a ship, 520 for a
  large one) and chunks (`fx/debris.ts`) that fly apart on straight lines for 6 to 12 s, cool from
  white to dull red and glint in the sun, inside a thin veil of gas (`fx/blastlight.ts`). Hot
  splinters keep a smallest size of 2.5 pixels. Two to four smaller blasts follow on the wreck
  within 1.5 s. Near the ground (`fx/ground.ts`) there is no shell and the discs are lifted and
  faded toward the ground. A missile that vanishes beside a hull or the ground goes off
  (`fx/detonations.ts`, derived in the client: the server sends only a plain hit): a flash, a cone
  of streaks along its flight, light; its trail lasts 0.9 s.
- A shot on a shield is swallowed (`fx/shell.ts`, `fx/impacts.ts`): the shell, a smooth sphere
  of 1.15 ship radii, gives way at the place, the shot's colour sinks into the dent, and a soft
  dome of light drains toward its rim in tongues; a held beam ends in a spot that tints the shell
  for as long as it is held; a hit on the far side shows dimmer behind the hull. Below 40 % a
  shield answers paler, patchy and stuttering, and when it falls a band of light runs once over
  the whole shell and leaves shreds. A hull hit leaves a scar that cools from white to dull red
  over 2 to 3 s and turns with the ship (`fx/scars.ts`; it sits on a stand-in ellipsoid, because
  the server reports hits on the bounding sphere), a cone of sparks scaled by the damage, and
  from a damage of 100 a puff of venting gas (`fx/vents.ts`). Ships below 40 % hull throw sparks
  now and then and below 20 % vent a thin jet (`fx/wounds.ts`, without state per ship). Hits give
  a pulse to the effect lights: warm on a hull, blue under a shield.
- Light in the lens from the local scene: any part of the local layer can add a lens light for a
  frame through `localLens` (`post/lens.ts`); the flash of a blast is one. It is hidden by the
  depth buffer like the glare of a star, within the four lights the lens pass takes.
- The overlays of the final pass that belong to the pilot's own ship (charge glow, heat haze, hit
  flash) act only on what is seen outside: not on the pixels of the cockpit, and in the chase view
  not on what stands within about a hull radius of the pilot's ship. `Renderer.ts` hands the pass
  what it needs to rebuild a pixel's place from the depth buffer. The fold tunnel and time
  dilation still lie over the whole frame.
- Each family of effects (`Weapons`, `Impacts`, `Blasts`, `Missiles`) has a `group` for what it
  draws beyond the shared streaks and discs, and `update`, `clear` and `dispose` of its own; a new
  primitive of a family is a new file under `fx/` and needs no change in `fx/index.ts`.
- `node tools/dev/fx-shots.mjs --port=<dev server>` takes picture sequences of the dev pages at
  exact moments and lays each out as one sheet under `screenshots/fx/` (ignored by git). It stops
  the page's clock at every moment asked for and seeds `Math.random`, so two runs of the same code
  give the same pictures. With `--old=<port of a second dev server>` each sheet shows old above
  new. The jobs are in `tools/dev/fx-shots.json`, one or more per effect; `--only=<names>` picks.
