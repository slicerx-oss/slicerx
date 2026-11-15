### Fixed

- `slicerx_geom_mirror` 1.6.3 (from 1.6.2) with `steps` mirrors a cut by a box on the exact kernel when the plane is square to an axis (`{"axis":"x","at":15}`, or a normal along x, y or z), on one part or on every part: the mirror image is the same box at its mirror place, and the parts stay exact. Before, the mirrored cut ran on the mesh, so in a design that must stay exact it was refused, and elsewhere the part was no longer exact from that step on. A box mirrored through a slanted plane still runs on the mesh.
