### Fixed

- `slicerx_mimir_session` 1.3.1 gives each size of a waiting size sheet the unit the sheet shows it in: `count` for a count given in mm (such as `teeth`), `deg` for an angle given in mm (such as `draft_angle`), else the row's own `mm`, `deg` or `%`. Before, a count or an angle given in mm read `mm`, while the app showed it with no unit or in degrees.
