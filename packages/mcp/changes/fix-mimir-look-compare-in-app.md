### Fixed

- `slicerx_design_look` 1.1.1 (from 1.1.0), in the mimir tab: a look with `compare: true` measures the change in the app as it does in node. It threw before measuring in the app, since its picture decoder used node's Buffer and zlib, which the app's page does not have; it now decodes with the platform's own base64 and DecompressionStream.
