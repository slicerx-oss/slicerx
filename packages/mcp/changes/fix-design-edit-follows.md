### Fixed

- `slicerx_design_edit_step` 1.3.0 (from 1.2.0): changing the height of a design's first body moves the later steps placed on its top with it. A fillet or chamfer on its edges, a hole in its top and the round on that hole's rim go through again at the new height, up or down. Before, those steps broke with "edges: edge 1: no sharp edge between two flat faces there" or "edge 1 has a missing face reference", because a body extruded on the bed was not counted as a face later steps follow.
