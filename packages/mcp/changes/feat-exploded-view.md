### Added

- `slicerx_design_render` 1.0.0 draws a design's parts, whole or as an exploded view: `spread` (0 to 100 percent) moves them apart radially (`axis` `radial`, the default) or along a bed axis (`x`, `y`, `z`, where the lowest part stays), with the same offsets as the app's Spread control. It answers `offsetsMm` per part and the PNG with `image: true`; the design is not changed.
- `slicerx_app_explode` 1.0.0 and `slicerx_app_explode_set` 1.0.0 read and set the open app's exploded view through the app link (new methods `explode.get` and `explode.set`, read class): `spread`, `axis`, the selected objects of 2 parts or more it spreads (`targets`) and the offsets the view draws their parts at (`drawn`). Display only: the project, the slice and the undo history never see it.
