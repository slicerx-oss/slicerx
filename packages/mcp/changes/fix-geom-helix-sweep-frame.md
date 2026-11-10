### Fixed

- `slicerx_geom_sweep` keeps the profile at the same angle to the axis on every turn of a path of `points` that winds about one axis (a helix, a spring or a conical spring), so a swept thread or coil has the same section on its last turn as on its first. Before, the profile turned a little more with each turn (about 6.5 degrees a turn for a 4 mm pitch at 35 mm radius). Other paths sweep as before.
