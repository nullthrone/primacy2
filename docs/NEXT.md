# Brief for the next work session

Written on 2026-11-13 by the session that built trade between servers and the moon landing. It
hands over because its history became so long that every step was expensive. Delete or replace
this file when the step is done; `docs/ROADMAP.md` stays the lasting record.

## Where and how

- Work in this checkout: the git worktree
  `C:\Claude Code\LOCAL\primacy2\.claude\worktrees\primacy2-space-simulator-b9a0b8`, branch
  `claude/primacy2-space-simulator-b9a0b8`. It has `node_modules`, the audio environment
  `.venv-audio` and the screenshots. Push only to this branch, never to `main`, and open no pull
  request.
- Read `docs/ROADMAP.md` in full first: the state, the owner's decisions, the open items and, in
  section 5, how the work is done here (tools, fixed test universe, port check, the models already
  downloaded).
- How Thomas wants to work is in the project's memory files, which load by themselves. Answer him
  in German.
- Limits: a 5-hour usage window and a weekly allowance per model. Start large agents at the
  beginning of a window, run at most two large agents on the strongest model at once, and never
  send a message to an agent that is running inside a workflow (it starts a second copy). At 95 %
  send Thomas a push notification as information and wait for the window to reset by itself; his
  one remaining manual reset is kept for the weekly allowance.
- The core, everything graphical and the look of the UI stay on the strongest model; well-specified
  side work goes to the cheaper one. Ultracode is on: use workflows for substantive work.
- Before anything else: start `bash tools/dev/checkpoint.sh` in the background (one loop only; the
  previous session has stopped its own) and read the usage figures before any fan-out.

## The step: sound library and controller support

This is step 1 of section 3 of the roadmap.

### Task A, sound (cheaper model, in workflows)

1. `tools/audio/`: command-line listening tools that any agent can call with
   `.venv-audio/Scripts/python.exe`.
   - Measure: loudness, peak, spectrum bands, envelope, clipping, and a spectrogram PNG to look at.
   - Compare: the CLAP score of a clip against descriptions, positive and negative ("deep engine
     rumble felt through a hull" against "cheap beep").
   - Transcribe: Whisper, to check that a radio line stays intelligible after distortion.
   - Describe: Qwen2-Audio answering a question about a clip. First prove that it runs on the
     RTX 5080 (4-bit if needed) and say so if it does not.
   - Tests on synthetic signals.
2. A synthesis library whose scripts render sounds to files, offline, so cost does not matter:
   hull rumble of the main engines by thrust, thruster thumps, impacts on hull and shield as
   structure-borne sound, touchdown and ground scrape, relays and switches, alarms (heat, missile,
   shields down, low fuel), drive charge and fold, cabin reverb. Follow the sound concept in the
   roadmap ("you hear your ship, not space"). Every sound is checked with the listening tools and
   improved until it scores as what it is meant to be.
3. Downloads with a licence list (`assets/audio/CREDITS.md`: file, source, licence, size): only CC0
   packs from kenney.nl and public-domain NASA recordings (radio traffic, station interior,
   sonified plasma waves). Thomas approved these downloads. Read the licence of every file before
   taking it; nothing with non-commercial or no-derivatives terms; each archive goes into its own
   directory; nothing downloaded is executed. At least 10 % of the disk stays free.
4. An audition page (a dev page of the client) on which Thomas plays every sound alone and in
   scenes (docking approach, combat, landing), with sliders for thrust, heat and distance, a switch
   for the radio filter, and a rating per sound that he can export as a file for you to read.

Do not change the game's runtime audio (`packages/client/src/audio`) in this step; that follows
after Thomas has listened. Voices and music also wait for his first listening; their models are
downloaded but have never been run. He offered to record household sounds with his phone as raw
material; give him a list of about 20 sounds when the first set is up for listening.

### Task B, controller (cheaper model)

Gamepads and joysticks/HOTAS through the Gamepad API, feeding the same input values as keyboard and
mouse (`packages/client/src/input`); several devices at once; a binding screen in the settings
(move an axis or press a button to assign; dead zone, curve and invert per axis); defaults for
Xbox and PlayStation pads; menus and station screens usable by controller; hints that show the
bound control; English and German. Tests for the mapping, and a browser check with a simulated
gamepad. It is the only way to play on mobile devices for now; build no touch controls.

### Your part

You are the orchestrator: write the briefs, read the reports, look at spectrograms and screenshots
yourself, and tell Thomas plainly what is verified and what is not. You cannot hear; he judges the
sound. When both tasks are done, tell him how to open the audition page and what to listen for.

Done means: both tasks are in this branch with
`npx tsc -p packages/shared && npx tsc -p packages/server && npx tsc -p packages/client`,
`npx vitest run`, `npm run build` and `node scripts/e2e.mjs` green, `docs/ROADMAP.md` is updated,
and Thomas has the audition page in front of him.

## After this step

Docking, as specified in the roadmap. It starts with two graphics repairs that landing on a pad by
eye depends on (the soft ground near the ship, the streaks after a hard landing). One request to
Thomas before that work: nobody has seen the terrain in motion; ask him to fly one descent himself
and say what he sees.
