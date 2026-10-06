# sx-watch

The print watch's failure detector. It runs beside sx-link on the user's own machine. It pairs with the hub's `watch` role, takes a still of every printing printer every 10 seconds, and reports failures with `watch.report`. Frames never leave the machine.

```
sx-watch [--url ws://127.0.0.1:47615] [--state-dir <sx-link state dir>]
```

The watch code comes from `SX_WATCH_CODE` or the hub's `watch-code` file (mode 0600), never from the command line. The hub's `hub-key.pub` is pinned. A hub that cannot prove that key gets nothing but the hello, and sx-watch stops instead of retrying.

## What happens to a frame

1. Decoded (PNG now; JPEG and WebP need a decoder dependency, so until then they are counted as undecodable and skipped).
2. Skipped and counted when too dark, too bright or blurred (`quality.rs`).
3. Scored by the detector (`detector.rs`). Until the model ships, `Stub` finds nothing.
4. Detections whose box center falls outside the printer's bed mask (`watch.masks`, read again every 5 minutes) are dropped.
5. `policy.rs` decides. No scoring on the first layer or for 30 seconds after a print starts or resumes (a gap of over 35 s between frames means the printer paused). A kind is reported only when it clears its threshold in 3 of the last 5 usable frames, with the mean score as the confidence. A person's "this is fine" (`watch.dismissed`) raises that printer's threshold for that kind by 0.15 until the next print.

The hub sends the content-free alert, and pauses only when the person turned auto-pause on and the confidence is 0.8 or more.

## The camera guard

The same model also answers two questions apart from the failure prompts (`model/export_siglip2.py`, outputs `hand` and `debris`).

- A hand inside a printing printer counts from the first frame, quiet time or not, when 2 of the last 3 usable frames score 0.6 or more. One sighting asks the hub for a second frame right away (`watch.grab`), so the second look comes within a couple of seconds. The hub pauses on a hand without huginn's confirmation and without the auto-pause permission (reasons in `src/policy.rs`); the person can turn the guard off per printer.
- Before a print, the hub sends a still of the plate and the person's empty-plate picture (`watch.plate`). The watch looks for the largest patch that differs, at about 1 mm per pixel, outside the spots the person marked as fine, and answers with `watch.plateResult`. Without an empty-plate picture only the model's debris score counts, and only at 0.9 or more, since a clean plate already scores about 0.7.

## Tests

`cargo test -p sx-watch`: the policy, mask and quality rules, the frame difference on drawn plates, the session from JSON in to reports and plate results out, and the client against a scripted hub that signs its hello with a real Ed25519 key and checks the pairing proof. `tests/model.rs` runs the real model when `SX_WATCH_MODEL` and the frame directories are set.
