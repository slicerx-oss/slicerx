### Changed

- `slicerx_paint_apply` 1.2.0 (from 1.1.0) takes `feature`, the plan feature the paint builds, as the modeling tools do. The paint step carries it, and `slicerx_design_steps` lists it.
- `slicerx_design_check` counts a planned feature that a paint step was tagged for as painted by that step, and names the step ("Hull paint painted by \"Paint the top filament 2\""), as a shaping step tagged for a feature counts as built. Its `body` gives the tagged paint steps as `paintTags`.
