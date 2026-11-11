### Fixed

- `slicerx_design_check` 1.14.0 (from 1.13.0) no longer adds a `floor` item for blind cuts into a side, such as a row of 1 mm deep window slits or round recesses. A cut, pocket or shell sets a floor only when its depth is at least half the part's height and less than all of it, and a cut that gives its own height runs into a side, so it sets none. Before, any such cut with a depth under the part's height set one, and the check could fail the part's floor.
