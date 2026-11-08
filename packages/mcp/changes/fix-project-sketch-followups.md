### Fixed

- `slicerx_geom_extrude`, `slicerx_geom_revolve`, `slicerx_geom_loft` and `slicerx_geom_sweep` with `design` say "The shape is already inside the part, so it adds nothing." for a join that sits entirely inside the part (on meshes; the developer exact-solids replay is unchanged). Before, they said the shape no longer reaches the part. A cut that misses still says it no longer reaches the part.
- A design step from a client that lands while the person has the body's first step open for editing in the app keeps the body, with the new step. Before, the body was lost and the call failed with "Canceled".
