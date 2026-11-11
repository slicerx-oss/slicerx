### Fixed

- `slicerx_design_check` 1.14.0 (from 1.13.0) no longer adds a `floor` item for blind cuts into a side, such as a row of 1 mm deep window slits or round recesses. A cut, pocket or shell sets a floor only when its depth is at least half the part's height and less than all of it, and a cut that gives its own height runs into a side, so it sets none. Before, any such cut with a depth under the part's height set one, and the check could fail the part's floor.
- `slicerx_design_check` 1.14.0 no longer reads the gap between separate bodies in one part, such as a row of uprights, as an opening in its `floor`. Air just above the bottom counts as an opening only when the part walls it in across the ray as well as along it. A cup whose cavity runs out through its bottom still fails.
