### Fixed

- `slicerx_design_open` 1.3.2 (from 1.3.1) and `slicerx_design_edit_step` 1.8.3 (from 1.8.2) replay a paint step grown from a picked point on the face under that point. Before, the step went by the saved key of the picked face alone. On a design replayed on exact solids, where that face has another key, the step painted a face the key named far from the point, or was broken with "Missing face; pick the face again to repair this step." The key's face is still used when it lies within 0.4 mm of the point, and the step is still broken that way when no face lies within 0.4 mm of it.
