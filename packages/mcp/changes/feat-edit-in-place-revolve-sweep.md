### Changed

- `slicerx_design_edit_step` 1.11.0 leans what a revolve or a sweep made with `tilt`, as it leans an extrude, a loft or an added part: about its foot, as the same step. A revolve whose axis lies over has no foot and is refused.
- `slicerx_design_check` 1.30.0 counts a planned feature as built only by a step that built: a tagged step that is broken, or skipped after a broken step, no longer counts, and the feature count names that step.
