### Fixed

- `slicerx_geom_cut` keeps both pieces closed when the part was itself cut before. A piece cut again could come back with open edges on the earlier cut face, and a boolean on it was refused as not closed until it was repaired.
