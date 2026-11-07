### Fixed

- `prime_tower_line_width` and `initial_layer_infill_line_width` are settings now, so `slicerx_explain_setting` explains them, a project's or profile's values reach the slice instead of being dropped, and `slicerx_slice_file` prints a Bambu Lab tower's purge rows and the first layer's infill at those widths. The stock H3C settings carry the maker's values. Neither has a default, so a slice that leaves them out is unchanged.
