### Fixed

- `slicerx_geom_subtract` 1.1.1 splits only the faces a cutter reaches. A bore down a turned or lofted part used to split long faces right across the part: a flared stem went from 14776 to 64180 triangles, and a rod joined to it afterward was refused with "collapsed triangles" or "intersecting faces". The same bore now leaves 15234 triangles, and joins after it go through. Faces the cut never reached keep their triangles, and the removed volume is the same.
