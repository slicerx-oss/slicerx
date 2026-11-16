### Added

- `slicerx_paint_preview` 1.6.0 (from 1.5.0) takes the target `{ "kind": "feature", "feature": "<name>" }`: every face the steps of that plan feature made, on a body built from many steps. The feature's steps are the steps tagged with it, every row or mirror of them (`slicerx_geom_array` or `slicerx_geom_mirror` with `steps`), and the steps a row tagged with it repeats. The walls and floor a cut makes belong to the cut's feature, and a face it cuts through stays its own feature's. The name matches case and spacing aside. A name the design has no step for is refused with `invalid_input`, listing the feature names it has. `slicerx_paint_apply` adds it as a paint step that finds the feature's faces again on every replay. On exact solids, a face that a join clears the key of (one a joined shape sits flat on, or one a mirror image lands flush with) goes by the key it came from, so it paints with the feature that made it: the top of a tower around a pole joined on it paints with the tower, and a mirrored boss paints whole on both sides. A part built as a mesh, in a design that is not exact or from the step where a part grew too detailed to stay exact, is refused with `invalid_input`: "target: painting by feature needs a part built as an exact solid, and part N is not one; paint it by height, by direction or from a seed point instead".
- `slicerx_app_paint_preview` 1.2.0 (from 1.1.0) takes the same feature target on an object in the app, by the steps of its history.

### Changed

- `slicerx_design_plan` 1.23.0 (from 1.22.0) has a feature that is its own color (a roof, a handle, a pole, a chimney top, a trim) painted by feature, and only a band that crosses features (a stripe, a trim line) painted on by height, in its `colors` field and in its display rule.

### Fixed

- `slicerx_geom_faces` 1.6.0 (from 1.5.0) names the mirror for the faces of a mirror image that land flush with the faces they mirror, such as the tops of a boss and its image. The union in the mirror step clears their keys, and the keys they came from were made inside that step, so their `madeBy` read `base`.
