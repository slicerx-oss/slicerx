### Fixed

- `slicerx_app_ui` 1.1.1 and `slicerx_app_collision_show` 1.0.1 report `collisions.stale` as true after an object is renamed or a layer mark changes, not only after an edit that moves the plate's layers, as the app's plate list and Export do. The summary then says the last slice, before the plate changed, has the collisions.
