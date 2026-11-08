### Changed

- `slicerx_mimir_session` 1.3.1 gives each size of a waiting size sheet the unit the sheet shows it in. `unit` gains a new value, `count`, for a count given in mm (such as `teeth`), and an angle given in mm (such as `draft_angle`) reads `deg`; every other row keeps its own `mm`, `deg` or `%`. Before, a count or an angle given in mm read `mm`, while the app showed it with no unit or in degrees.
