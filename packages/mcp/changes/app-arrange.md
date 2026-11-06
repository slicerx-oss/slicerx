### Changed

- `slicerx_cloud_slice` 1.2.0 names the arguments it does not take instead of dropping them without a word, as `slicerx_slice_file` and `slicerx_estimate_file` do: the job is still queued without them, and the result's `warnings`, `notices` (code `ignored_arguments`) and text list each one, pointing `printer`, `process`, `filament` and `machine` to `profiles`. A later release may refuse unknown arguments.
