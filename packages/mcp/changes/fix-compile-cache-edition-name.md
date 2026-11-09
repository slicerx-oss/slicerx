### Fixed

- The start-up compile cache folder is named after the edition. A white-label edition's server keeps its cache in `<user cache folder>/<edition id>/node-compile-cache` (the `id` of the resolved edition config `SLICERX_CONFIG` names), not under `slicerx`. A stock start, or a config with no valid id, still uses `slicerx`. `NODE_COMPILE_CACHE` still chooses the folder and `NODE_DISABLE_COMPILE_CACHE` still turns the cache off.
