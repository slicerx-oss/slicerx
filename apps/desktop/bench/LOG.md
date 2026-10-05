# Viewport frame-time hill-climb

One row per iteration of `viewport-orbit.mjs`. Metric: p95 frame cost in Preview during a 10 s scripted orbit of the reference plate at 1280x800 CSS and 2x (2560x1600 pixels). Frame cost is render() plus GPU completion, measured with a one-pixel readback after each frame. Baseline and candidate builds run interleaved in the same session. A change is kept when it improves p95 by at least 2 percent and the still frame is unchanged.

| Time (UTC) | Change | Baseline p95 | Candidate p95 | Candidate p50 | Prepare p95 | Stress p95 | Gates | Kept |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-30T07:38:14Z | baseline: MSAA 4x HDR pass, half-res depth AO every frame, grade, FXAA; 10-vertex beads | 24.6 | 24.6 | 16.7 | 10.2 | 86 | first 94.0 ms, still diff n/a | yes |
| 2026-09-30T07:42:32Z | skip AO while the camera moves; fade it in over 3 frames when it stops | 25.1 | 24.4 | 17 | 10.2 | 89.6 | first 78.3 ms, still diff 0.04 | yes |
| 2026-09-30T07:45:54Z | harness: time frames with a read from an offscreen target (a canvas read also waits for the display present); new baseline with the AO change | 20.5 | 20.5 | 15.6 | 11.7 | 72.4 | first 76.8 ms, still diff n/a | yes |
| 2026-09-30T07:50:08Z | render moving frames into a single-sample target (FXAA only); MSAA 4x returns when the camera stops | 18.7 | 18.3 | 14.5 | 10.4 | 89.3 | first 59.7 ms, still diff 0.00 | yes |
| 2026-09-30T07:52:52Z | confirmation of the single-sample moving frames (6 runs, Preview only) | 24.1 | 24.8 | 16.6 | 0 | 0 | first 57.5 ms, still diff 0.04 | no |
| 2026-09-30T08:02:31Z | quality batch: bead normal level of detail against moire, glowing wall ring on the live layer, crisper selection outline, background shader warm-up (first preview frame now includes GPU completion) | 24.9 | 24.9 | 15.6 | 10.6 | 81.7 | first 154.8 ms, still diff 0.27 | yes |
| 2026-09-30T08:06:47Z | one pointed cap per bead (end only): 9 vertices and 12 triangles instead of 10 and 16 | 23.8 | 23.4 | 15 | 9.9 | 79.3 | first 38.7 ms, still diff 0.04 | no |
| 2026-09-30T08:15:44Z | render moving frames at 0.75 resolution on 2x screens, upscaled by the FXAA pass | 23.5 | 22.6 | 15.5 | 9 | 79.7 | first 37.6 ms, still diff 0.03 | yes |
| correction | The previous row is not valid: its candidate build also moved the timing read before the canvas pass, so the two builds timed different spans. It is rerun below with both builds on the new timing. | | | | | | | no |
| 2026-09-30T08:20:44Z | rerun: render moving frames at 0.75 resolution on 2x screens, upscaled by the FXAA pass | 23.4 | 24 | 15.9 | 8.8 | 78.5 | first 39.2 ms, still diff 0.04 | no |
| 2026-09-30T08:24:56Z | preview beads: Blinn-Phong with the room irradiance as spherical harmonics instead of MeshStandardMaterial's prefiltered environment lookups | 17.6 | 13.3 | 11.4 | 9.1 | 56.9 | first 41.6 ms, still diff 0.74 | yes |
| 2026-09-30T08:28:24Z | harness: time the whole frame including the canvas pass, synced by clearing and reading a 1x1 target queued after it; new baseline (Phong beads) | 15.5 | 15.5 | 12.5 | 10.4 | 54.7 | first 35.7 ms, still diff n/a | yes |
| 2026-09-30T08:33:40Z | retest with whole-frame timing: moving frames draw into a single-sample target (FXAA only); MSAA 4x returns when the camera stops | 15.5 | 15.2 | 12.3 | 7.7 | 58.1 | first 35.7 ms, still diff 0.03 | no |
| 2026-09-30T08:38:04Z | fix: camera motion from setCamera and OrbitControls pointer handlers now counts as moving, so the no-AO-while-moving rule from the first iteration takes effect (earlier orbit runs rendered AO every frame) | 15.6 | 15 | 12 | 7.6 | 60 | first 35.9 ms, still diff 0.40 | yes |
| 2026-09-30T08:42:14Z | moving frames draw into a single-sample target (FXAA only); MSAA 4x returns when the camera stops (motion detection fixed) | 16.3 | 11.1 | 9.3 | 7.6 | 37.8 | first 37.6 ms, still diff 0.01 | yes |
| 2026-09-30T08:47:26Z | retest: one pointed cap per bead (end only), 9 vertices and 12 triangles instead of 10 and 16 | 9.6 | 9.2 | 8 | 7.9 | 33.8 | first 37.3 ms, still diff 0.01 | yes |
| 2026-09-30T08:51:31Z | moving frames also skip FXAA (grade pass writes the canvas directly) | 9.7 | 10.8 | 9.2 | 7.2 | 34.2 | first 34.9 ms, still diff 0.01 | no |
| 2026-09-30T09:00:42Z | preview beads lit per vertex (Blinn-Phong, SH ambient, one hardware PCF shadow tap, live glow); the fragment shader only writes the interpolated color | 10.8 | 11.2 | 10.7 | 7.9 | 35.7 | first 30.8 ms, still diff 0.75 | no |
| 2026-09-30T09:06:06Z | confirmation of per-vertex bead lighting (6 runs; previous run had one 7.7 ms outlier under load) | 13.6 | 8.8 | 5.4 | 0 | 34.5 | first 26.1 ms, still diff 0.75 | yes |
| 2026-09-30T09:13:39Z | beads without caps: the far end reaches half a line width past the segment end so joints overlap; 8 vertices and 8 triangles per segment | 9.2 | 7.2 | 3.7 | 6.8 | 17.6 | first 20.6 ms, still diff 0.04 | yes |
| 2026-09-30T09:19:01Z | bead glossy environment term from the SH constant band instead of a second SH evaluation per vertex | 7.3 | 7.4 | 4.2 | 6.9 | 17.7 | first 20.4 ms, still diff 0.06 | no |
