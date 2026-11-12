### Changed

- `slicerx_design_edit_step` 1.6.0 takes `tilt` (`toward` x, -x, y or -y, with `degrees` or `by`): what an extrude, a loft or an added part made leans about its foot as the same step (each added part about its own), the steps built on it lean with it, a pattern made of it leans with it, and a later size or move of the step keeps the lean. A lean that would run it or a step it carries into another step's shape, or lift it off what it stands on, is refused with that step by name, and so is one that a cut, a band of paint or a rounded edge on its top cannot follow.
- `slicerx_design_steps` 1.4.0 gives `leans` (degrees and the way) on a step that leans.
