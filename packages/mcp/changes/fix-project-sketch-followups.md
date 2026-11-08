### Fixed

- `slicerx_geom_extrude` 1.3.1, `slicerx_geom_revolve` 1.3.1, `slicerx_geom_loft` 1.1.1 and `slicerx_geom_sweep` 1.1.1 with `design` say "The shape is already inside the part, so nothing changed." for a join that sits entirely inside the part. Before, they said the shape no longer reaches the part. A cut that misses still says it no longer reaches the part, and the developer exact-solids replay keeps its wording.
- A design step from a client that lands while the person has the body's first step open for editing in the app keeps the body, with the new step. Before, the body was lost and the call failed with "Canceled".
