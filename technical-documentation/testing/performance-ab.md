# Performance A/B between two packaged builds

How to compare the smoothness and speed of two OpenScreen builds on one Windows machine, and the
log of every comparison run so far. The scripts live in [`scripts/perf-ab/`](../../scripts/perf-ab/).

## Results log

### 2.0.0 against main `9dc48b5c7`, Windows, 15/10/2026

**Verdict: main is as smooth and as fast as 2.0.0 at 279 Hz, with one small slowdown to fix.**

- **One regression over 5%**: the editor takes 53 ms longer (+5.2%) to show its first frame on
  the heavy project. Starting the app to the HUD takes 31 ms longer (+4.9%). Both are
  significant over 12 and 15 sessions.
- **No preview regression established.** The light project is identical. On the heavy project,
  late paints are 17% higher at the median but not significantly so (see below).
- **Two improvements.** GIF export is 30 times faster. A recorded screen video keeps a regular
  60 fps clock, where 2.0.0's timestamps wander.
- **Two defects both versions share.** The heavy preview alternates between a smooth and a
  stuttering mode from one session to the next. The GPU process's dedicated GPU memory grows by
  80 to 105 MB per second of playback, past the card's 12 GB.

**Setup**

- Machine: Ryzen 7 5800X, RTX 4070 Ti 12 GB, 32 GB RAM, one 1920×1080 display at 279 Hz,
  Windows 11 build 26200, 100% scaling.
- 2.0.0: the release's `Openscreen.Setup.2.0.0.exe`. main: `9dc48b5c7`, built by `build.yml` run
  38758703830. Both extracted and run side by side, never installed.
- Sessions interleaved between the two builds. Light project: 3 per build. Heavy: 12 per build,
  memory read on 3 of them. Exports: 3 per case, 2 for the 2.0.0 GIF (8 min each). Takes: 3.
- Background load: other sessions' Electron processes (an `openscreen mcp` set and a dev build of
  #1189) stayed open and idle. Early runs where another window covered the editor were discarded
  and run again with the editor pinned on top.
- Not covered: a 60 Hz display, macOS and Linux.

**Flags**

| # | Finding | Status | Likely cause | Next step |
|---|---|---|---|---|
| 1 | Editor open +53 ms (1025 → 1078 ms), startup to HUD +31 ms (620 → 651 ms) | Regression, p < 0.05 | More work at launch since 2.0.0: the in-app MCP server (`b81cd3760`, `65444df3e`), the shader effects in the document and the Effects lane (`1b704ff6e`, `74c89035e`), the daily usage ping (`b5ff5a348`). Not bisected. | Bisect editor open on the heavy project |
| 2 | Heavy preview: 87 → 102 paints later than 25 ms per 30 s (+17%) | Within noise, p ≈ 0.2 | Both builds land in a slow mode (paint p95 28.5 ms instead of 22 ms) in about half the sessions: 2.0.0 6 of 12, main 7 of 12. The mode follows the session, not the build. | Find what sets the mode |
| 3 | GPU process dedicated memory, one traced session each: 0.8 GB (2.0.0) and 1.4 GB (main) at 11 s of playback, 9.8 GB and 12.8 GB at 2 min | Pre-existing, both builds | Grows linearly with playback, so something per frame is kept: the shared-texture preview path is the first suspect | Trace the shared frames' lifetime |

#### Preview, light project (3 sessions each)

| Metric | 2.0.0 | main | Delta | Verdict |
|---|---|---|---|---|
| Preview paints per second | 60.0 [60.0–60.0] | 60.0 [60.0–60.0] | +0.0% | same |
| Paint interval p95 (ms) | 21.9 [21.8–21.9] | 21.8 [21.8–22.0] | -0.5% | same |
| Paint interval p99 (ms) | 22.7 [22.7–22.8] | 22.7 [22.4–22.9] | -0.0% | same |
| Paints later than 25 ms, per 30 s | 2 [0–2] | 1 [0–1] | -50.0% | within noise |
| UI rAF interval p99 (ms) | 3.70 [3.70–3.70] | 3.70 [3.70–3.70] | +0.0% | same |
| UI rAF over 1.5 vsync (%) | 0.02 [0.01–0.33] | 0.06 [0.02–0.10] | +150.2% | within noise |
| CPU, all processes (% of one core) | 148.8 [148.4–151.6] | 145.8 [140.2–155.2] | -2.0% | same |
| CPU, main process (%) | 18.2 [17.7–19.1] | 16.9 [16.4–18.1] | -7.0% | within noise |
| GPU, all engines of the app (%) | 9.6 [9.1–9.7] | 9.6 [9.5–9.8] | +0.3% | same |
| On screen: preview updates per second | 57.5 [46.6–60.0] | 58.4 [51.6–59.9] | +1.5% | same |
| On screen: update interval p99 (ms) | 30.0 [25.0–39.6] | 29.5 [24.3–37.0] | -1.6% | same |
| On screen: updates skipping a video frame (%) | 4.36 [0.09–17.88] | 2.86 [0.28–16.27] | -34.4% | within noise |
| On screen: cursor off its path, RMS (source px) | 5.83 [5.71–31.12] | 5.86 [5.57–7.43] | +0.6% | same |
| On screen: cursor off its path, p99 (source px) | 20.34 [20.12–128.20] | 20.54 [20.32–22.92] | +1.0% | same |
| On screen: cursor steps backwards | 0 [0–52] | 0 [0–0] | +0.0% | same |

The cursor follows its recorded path equally closely in both builds: no fidget on Windows. The
residual of about 6 px RMS is the cursor smoothing's lag, the same in both. The ranges of the
on-screen rows are wide because the desktop capture itself misses frames now and then (one
2.0.0 session and one main session).

#### Preview, heavy project (12 sessions each; memory on 3)

| Metric | 2.0.0 | main | Delta | Verdict |
|---|---|---|---|---|
| Preview paints per second | 60.0 [59.8–60.0] | 60.0 [59.7–60.0] | +0.0% | same |
| Paint interval p95 (ms) | 24.7 [22.1–28.5] | 27.9 [22.1–28.5] | +13.0% | within noise (p ≥ 0.05) |
| Paint interval p99 (ms) | 35.5 [28.8–35.8] | 35.4 [29.0–35.7] | -0.1% | same |
| Paints later than 25 ms, per 30 s | 87 [53–113] | 102 [54–119] | +16.7% | within noise (p ≥ 0.05) |
| UI rAF interval p99 (ms) | 3.70 [3.70–3.70] | 3.70 [3.70–3.70] | +0.0% | same |
| Long tasks over 50 ms, per 30 s | 0 [0–0] | 0 [0–0] | +0.0% | same |
| CPU, all processes (% of one core) | 141.6 [130.6–162.2] | 144.2 [131.0–161.5] | +1.8% | same |
| CPU, main process (%) | 19.7 [15.4–23.7] | 18.2 [15.7–20.0] | -7.7% | within noise (p ≥ 0.05) |
| CPU, GPU process (%) | 45.0 [41.7–51.6] | 47.0 [42.9–50.1] | +4.5% | same |
| CPU, renderer (%) | 77.2 [72.4–89.5] | 78.9 [72.2–92.4] | +2.2% | same |
| GPU 3D, main process / compositor (%) | 3.0 [2.4–4.0] | 3.5 [2.6–4.2] | +16.4% | within noise (p ≥ 0.05) |
| GPU video decode (%) | 10.8 [10.6–10.9] | 10.8 [10.6–20.6] | +0.8% | same |
| GPU, all engines of the app (%) | 15.8 [14.7–17.4] | 16.7 [15.1–26.8] | +5.7% | within noise (p ≥ 0.05) |
| Private memory after 2 min (MB) | 1202 [1201–1213] | 1199 [1168–1218] | -0.3% | same |
| Private memory, main process (MB) | 634 [633–641] | 624 [623–639] | -1.6% | same |
| Private memory, renderer (MB) | 337 [337–344] | 329 [305–343] | -2.4% | same |
| GPU dedicated memory, GPU process, after 2 min (MB) | 9252 [8989–12847] | 8567 [8009–11063] | -7.4% | within noise |
| Editor open to first preview frame (ms) | 1025 [991–1101] | 1078 [1025–1244] | +5.2% | **regression** (p < 0.05) |

Late paints per session, sorted: 2.0.0 `53 61 67 71 76 84 90 105 106 107 111 113`, main
`54 75 76 83 88 92 111 111 111 112 114 119`. Sessions in the slow mode also use more GPU 3D in
the main process (about 4% against 2.5 to 3%), in both builds.

#### Startup (15 sessions each)

| Metric | 2.0.0 | main | Delta | Verdict |
|---|---|---|---|---|
| Process start to HUD ready (ms) | 620 [595–678] | 651 [635–684] | +4.9% | under 5%, but significant |

#### Recording, 60 s full screen with the webcam (3 takes each)

| Metric | 2.0.0 | main | Delta | Verdict |
|---|---|---|---|---|
| Screen video, frames per second | 60.05 [60.04–60.06] | 60.00 [60.00–60.00] | -0.1% | info |
| Screen video, longest gap between frames (ms) | 25.0 [22.7–26.2] | 18.6 [18.3–18.6] | -25.8% | improvement |
| Screen video, frames repeating the previous picture | 660 [626–674] | 648 [645–664] | -1.8% | same |
| Webcam video, frames per second | 29.99 [29.99–30.01] | 30.00 [30.00–30.00] | +0.0% | info |
| Webcam video, longest gap (ms) | 37.3 [36.9–37.8] | 35.1 [35.0–35.3] | -6.1% | improvement |
| Webcam video, byte-identical consecutive frames | 2 [2–3] | 2 [1–3] | +0.0% | same |
| CPU, wgc-capture.exe (% of one core) | 46.8 [46.2–49.8] | 48.5 [47.6–48.6] | +3.8% | same |
| CPU, main process (%) | 3.0 [2.9–3.5] | 3.4 [2.8–3.5] | +13.8% | within noise |
| CPU, all processes (%) | 51.3 [50.7–55.4] | 53.2 [52.6–53.6] | +3.8% | same |

No take lost a frame: no gap reaches twice the frame interval. 2.0.0's screen timestamps are
irregular enough that `ffprobe` guesses its rate as 56 or 120 fps, where main's read a clean 60
(`13366ebad`, `e8b85444f`, `4ebe3ce7b`). The repeated pictures come from the pattern player, which
does not present every one of its 120 frames per second; it is the same in both builds. The
camera, a Logitech StreamCam, delivers 1080p at 30 fps under the default 2160p request.

#### Export, heavy project (60 s)

| Metric | 2.0.0 | main | Delta | Verdict |
|---|---|---|---|---|
| MP4 1080p 60 fps: wall time (s) | 12.9 [12.8–13.0] | 12.9 [12.8–13.0] | +0.1% | same |
| MP4 1080p 60 fps: frames written | 3600 [3600–3600] | 3600 [3600–3600] | +0.0% | info |
| MP4 1080p 30 fps: wall time (s) | n/a | 11.6 [11.6–12.2] | n/a | n/a |
| MP4 1080p 30 fps: frames written | n/a | 1800 [1800–1800] | n/a | n/a |
| GIF 720p 15 fps: wall time (s) | 488.7 [484.3–493.0] | 16.2 [15.9–16.3] | -96.7% | improvement |
| GIF 720p 15 fps: frames written | 900 [900–900] | 900 [900–900] | +0.0% | info |

2.0.0 exports MP4 at 60 fps only (its CLI has no `--fps`, its dialog no frame rate), so 1080p30 has
no baseline. Both builds write the same frames at nearly the same size (MP4 144.9 MB each, GIF 475.2
against 475.5 MB). 2.0.0's GIF runs on one core (492 CPU
seconds in 493 s); main spreads it over about ten (#952: `0a814fbe7`, `528ce5d9f`).

## What is measured

| Area | Metric | Source |
|---|---|---|
| Editor preview | Interval between two paints of the preview canvas: p50, p95, p99, count over 25 ms | `drawImage` on the canvas `useNativeCompositorView` marks `data-painted`, hooked over CDP |
| Editor UI | rAF interval: p50, p99, share over 1.5 vsync | rAF loop injected over CDP |
| What the screen showed | Preview updates per second, screen frames skipped or repeated, cursor deviation from its straight path | Desktop capture of the preview (`ddagrab`), analysed by `analyze_capture.py` |
| Resources | CPU % per process role (main, GPU process, renderer), GPU engine % per process | `Win32_Process` CPU times; `\GPU Engine(*)\Utilization Percentage` |
| Memory | Private bytes per role and GPU memory after 2 min of playback | `Win32_Process`; `\GPU Process Memory(*)` |
| Startup | Process start to HUD ready; editor open to first preview frame | CDP polling |
| Export | Wall time, frames written | `Openscreen.exe export`, `ffprobe` |
| Recording | Frame cadence and gaps of both videos, CPU of `wgc-capture.exe` and the app | 60 s take over a 120 fps pattern, `analyze_recording.py` |

`window.__uiProbe` is not used: a production build strips `console.*` (`drop_console` in
`vite.config.ts`), so its reports never reach the console. The injected rAF loop records the same
intervals as raw data.

A change over 5% in the bad direction is a regression when it is real: a Mann-Whitney test at
p < 0.05 with 6 sessions or more per build, non-overlapping [min–max] ranges with fewer.

## Inputs

Both builds read the same two projects (schema 8), generated by `gen-projects.mjs` from synthetic
media, so neither build's recorder decides the input:

- **screen.mp4**: 1920×1080, 60 fps, H.264 High, 14 Mb/s like a real Windows take. Grey noise, and a
  white bar that moves 16 px per frame in the top band.
- **screen.mp4.cursor.json**: a horizontal sweep at constant speed, 0.15 → 0.85 → 0.15 of the width
  every 4 s, sampled every 8 ms.
- **webcam.mp4**: 1920×1080, 30 fps, 16 Mb/s.
- **Light project**: the take, one 2× zoom, plain wallpaper, no cursor motion blur.
- **Heavy project**: webcam picture-in-picture, five zooms of which three are 3D (orbit, left,
  right), a text, an arrow and a blur annotation, captions on (a word every 0.5 s), a music bed,
  the wallpaper, shadow, motion blur and depth of field of a real project.

## How to run

1. Extract each build instead of installing it: `7z e <installer> $PLUGINSDIR/app-64.7z`, then
   `7z x app-64.7z -o<scratch>/app-<label>`. The installed OpenScreen stays untouched, and each
   build runs with its own `--user-data-dir`, so they never share a profile or the
   single-instance lock.
2. Generate the media (commands in the header of `gen-projects.mjs`), then
   `node gen-projects.mjs <mediaDir> <scratch>/projects`.
3. Preview sessions: `run-gui.sh <scratch> <outDir> <hz> light heavy`. Each session launches the
   build with `--remote-debugging-port`, opens the editor through `electronAPI.switchToEditor()`
   (the editor reopens the profile's only project), pins its window on top, plays with Space and
   kills the process tree.
4. `node export-bench.mjs <scratch> 3`, then `run-record.sh <scratch> record 1 2 3`. Each take is
   analysed and deleted at once: it holds the webcam picture.
5. `node summarize-gui.mjs <outDir>`, `node summarize-record.mjs <scratch>/out/record`, then
   `node doc-tables.mjs` on the three summaries prints these tables.

Keep the desktop to the bench while it runs. A window a background process opens lands behind
the foreground one, which is why `topmost.ps1` pins the editor and the pattern player. A covered
editor still renders, but the capture films the cover. A fully covered one is throttled to one
rAF per second, and its session is discarded.
