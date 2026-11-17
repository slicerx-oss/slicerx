### Changed

- `slicerx_geom_shell` 1.6.0 (from 1.5.0): on a design with exact solids, a taper or a cone shelled with an end open stays an exact solid at either end, and so does a lofted body with flat sides. The wall is the thickness asked at every point, the rim included. Before, a shell open at its narrow end ran on the mesh, and any lofted body with a face open was refused before the exact kernel was asked. A body with other curved sides and a face open, such as a smooth loft open at its top, still runs on the mesh, and its step says so. Input and answer fields are unchanged.
