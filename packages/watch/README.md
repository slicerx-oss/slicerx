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

## Tests

`cargo test -p sx-watch`: the policy, mask and quality rules, the session from JSON in to reports out, and the client against a scripted hub that signs its hello with a real Ed25519 key and checks the pairing proof.
