### Fixed

- `slicerx_project_move` 1.1.0 (from 1.0.0), on the app's plate: a design whose body would sit more than 0.01 mm under the bed where the move puts it is lifted onto it, with `x` and `y` and with `auto: true`, the same way a design's landing and Arrange lift one. The reply's `transform` and `minMm` show it standing on the bed. The lift joins the design's landing moves, so its own coordinates and its next edit keep its height. An object with no design history keeps its height, and a locked part is still refused. Before, the design kept its height and stayed under the bed.
