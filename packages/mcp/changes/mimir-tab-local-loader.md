### Changed

- `slicerx_mimir_tab` 1.3.1: `capped.loader` is `null` when the capped request carried no loader, as on a local model over the tool limit, so a client no longer asks mimir to load a toolset with a tool the request did not have.
