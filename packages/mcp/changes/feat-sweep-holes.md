### Changed

- `slicerx_geom_sweep` 1.5.0 (from 1.4.0) sweeps a profile with holes: a loop inside another is a hole, and its wall runs the whole length of the path, so a tube, a spout with its bore or a hollow handle is one sweep. The holes taper and turn with the profile when `scale` and `twist_deg` are given. A hole that touches or crosses the outer loop is refused naming the two loops, and `thicken` with a holed profile is refused, since the holes already make the walls. Before, a profile with a hole was refused with "a sweep profile has no holes yet".
