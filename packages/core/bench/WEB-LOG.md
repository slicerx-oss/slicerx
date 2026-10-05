# Browser slice hill-climb

These rows ran on an earlier reference plate that is not part of the repository (508 layers); later rows use `models/x-mark.stl`.

Reference plate in Chrome on this Mac through the WASM worker pool, fresh page per run (`web-slice.mjs`). Metric: median first slice, request to result, ms. A/B rows interleave the two variants page by page.

| Time (UTC) | Change | Baseline | Candidate | Gain % | Warm (candidate) | Workers | Same G-code | Kept |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-30T08:16:01Z | two layer ranges per worker from a shared queue instead of one | 192.2 | 169 | 12.1 | 117.1 | 10 | yes | yes |
| 2026-09-30T08:16:37Z | three layer ranges per worker instead of two | 153.6 | 126.9 | 17.4 | 93.1 | 10 | yes | yes |
| 2026-09-30T08:17:05Z | four layer ranges per worker instead of three | 115 | 108.6 | 5.6 | 66.1 | 10 | yes | yes |
| 2026-09-30T08:17:31Z | six layer ranges per worker instead of four | 110.5 | 104.1 | 5.8 | 62.3 | 10 | yes | yes |
| 2026-09-30T08:17:56Z | eight layer ranges per worker instead of six | 105.5 | 102.5 | 2.8 | 61.9 | 10 | yes | yes |
| 2026-09-30T08:23:27Z | warm up each worker with a 20 mm cube slice at pool start | 80.7 | 70.7 | 12.4 | 49.7 | 10 | yes | yes |
| 2026-09-30T08:44:08Z | module rebuilt with the current native core (contour simplification, i64 scanlines, 3MF); not an A/B |  | 55.3 |  | 30.2 | 10 | yes |  |
