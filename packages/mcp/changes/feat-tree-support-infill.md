### Changed

- `slicerx_slice_file` and `slicerx_estimate_file` read `tree_support_with_infill` (off by default). With the default `support_base_pattern`, tree branches and trunks wide enough to hold two lines of the base pattern get those lines inside their walls on every tree style; branches at their own size, walls, interfaces and the first layer are unchanged. Before, the key was accepted and did nothing. In `slicerx://settings/schema` the key now also needs `support_base_pattern` `default`, and its help says what it does.
