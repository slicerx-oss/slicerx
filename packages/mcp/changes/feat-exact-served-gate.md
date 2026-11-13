### Changed

- `slicerx_design_new` 1.3.0 (from 1.2.0): exact designs (`exact: true`) open without the developer opt-in when the server's sx-geom runs served and has the exact kernel, and `SLICERX_EXACT=1` is set. Their bodies then stay in the engine by number. On an sx-geom that runs once per call, exact designs still need `SX_BREP_DEV=1`. An sx-geom without the exact kernel is refused, with what it answered. A design not given `exact` is a mesh design, as before.
