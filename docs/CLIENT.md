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
| Audio | `src/audio` | Procedural sound from the frame view and its events. |

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

### Controllers

Gamepads, joysticks and HOTAS sets work through the browser's Gamepad API and feed the same input
values as keyboard and mouse; nothing in `shared` or `server` knows about them. This is also the only
way to play on a phone or tablet for now: there are no touch controls. Flight is live without pointer
lock while the last device used is a pad; moving the mouse or pressing a key switches back.
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
| D-pad up / down | target ahead / clear target | D-pad right / left | next / previous target |
| Y + A | dock or undock | Y + B | flight assist |
| Y + X | fold jump | Y + View | galaxy map |
| Y + Menu | system map | Y + D-pad | power: left shields, up engines, right weapons, down reset |
| Y + LB | contacts | Y + RB | camera |
| Y + L3 | silent running | Y + R3 / RT / LT | throttle zero / up / down |

In menus and station screens the D-pad or left stick moves the focus mark (it repeats while held),
A presses, B closes or goes back, LB and RB switch tabs, and left and right change a slider or
select. The galaxy map lists the systems so one can be chosen without the mouse.

Binding codes in `Settings.bindings` are `Pad:<dev>:b<n>` for a button, `Pad:<dev>:b<m>+b<n>` for a
chord and `Pad:<dev>:a<n>+` or `a<n>-` for half an axis used as a button; `<dev>` is `std` for every
standard-mapping device or a short key made from the device id. Analog axes live in `Settings.pad`
(dead zone, curve, invert, a throttle lever).

Checked with a simulated pad (`node scripts/pad-check.mjs`, a fake `navigator.getGamepads` in
Chromium): start screen, station screen and undock by D-pad and A; stick thrust, stick turn and its
stop, boost, fire, the Y chord for the camera, the pause menu, assigning a new button on the binding
screen and the hint changing with it, PlayStation names in a hint. Not checked and needing real
hardware: how the sticks feel, drift and dead zones of a real pad, the joystick preset and other
non-standard devices (axis numbering, hat switches, throttle units), browser differences in `Gamepad.id`
and `mapping`, and phones and tablets (the layout at 844 x 390 has known overlaps).

## Models

`packages/client/public/models/<key>.glb`, generated by the scripts in `assets/blender`.
Nose toward -Z, top toward +Y, metres, origin at the centre of mass. Empties named `engine_*`,
`hardpoint_*`, `dock_*` and `light_*` mark where effects attach. Until a model exists the local layer
shows a procedural stand-in, so the game runs without any binary assets.
