### Fixed

- `slicerx_geom_loft` 1.13.4 (from 1.13.3): a design whose lofted body the engine made as an exact solid answers `exact: true`. Before, `exact` was true only on a design that must stay exact, so a loft in the app on the native engine answered `exact: false` on an exact body. A loft the engine made on the mesh still answers `exact: false`, with the same note as before. Every design answer reads `exact` this way: true on a design that must stay exact or when every part is an exact solid. Beside an exact part, each mesh part has `mesh: true`.
