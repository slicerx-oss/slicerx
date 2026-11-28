### Fixed

- `slicerx_geom_extrude` 1.15.2 (from 1.15.1) joins a shape drawn on a face of a part whatever way the face's stored position rounds. Before, a join started exactly on a face whose coordinate is stored a little low in f32 (such as 54.8 mm, kept as 54.79999924) was refused with "boolean: the result is unsafe at mesh storage precision (intersecting faces); change the cut or placement", while the same join on a face at 39.4 or 24 mm went through.
