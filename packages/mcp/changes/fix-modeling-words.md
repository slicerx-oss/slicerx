### Changed

- `slicerx_geom_build` 1.7.2 (from 1.7.1) says it is never for an opening in a part (a window, vent or slot), which is a cut with `slicerx_geom_extrude` or `slicerx_geom_hole`. Its `slot` says it defaults to 1 and that a slot past the project's last filament adds a filament, so it is only for a color the person asked for.
- `slicerx_geom_extrude` 1.12.5 (from 1.12.4), `slicerx_geom_revolve` 1.10.3 (from 1.10.2), `slicerx_geom_loft` 1.13.2 (from 1.13.1) and `slicerx_geom_sweep` 1.11.3 (from 1.11.2): `slot` says one past the project's last filament adds a filament, only for a color the person asked for.
