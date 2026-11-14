### Changed

- `slicerx_paint_apply` 1.5.0 (from 1.4.0): when no preview has the id because the last paint preview was refused, the refusal names that preview's step, says why it was refused and what to try next, such as "preview: p1 was never made. The last paint preview, Paint below 4 mm filament 2, was refused: Exact replay does not support paint for this part. Preview again on a part that supports paint, or with a different target, then apply." A preview or an apply that goes through after the refusal brings back the old text for an unknown id.
- `slicerx_app_paint_apply` 1.1.0 (from 1.0.0) says the same for this client, when its last paint preview in the app was refused.
