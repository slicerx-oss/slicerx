### Changed

- `slicerx_design_check` 1.19.0 (from 1.18.0): a failed minimum wall says where the thin wall is and how to fix it. The item gives `where` ("The thinnest wall is in Hull, near (104.2, 3.1, 12.9) mm.", with the part named only in a design of several parts and never by the name a new body gets) and `fix` (how thick to make it, for the nozzle), and the summary ends on both. `got` is the reading as before. The check's `body` gives the place as `minWallAt`: a point in the middle of the wall, and its part when named.
