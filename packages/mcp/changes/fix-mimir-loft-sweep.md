### Changed

- `slicerx_geom_loft` 1.1.1: the description says `thicken` makes the loft hollow with open ends (a tapered stem, a vase wall), and a profile's description points at the revolve tool's loops and frame without naming the tool by its MCP name.
- `slicerx_geom_sweep` 1.1.1: the description names what a sweep is for (a hook, a handle, a bent rod or pipe) and says a join or cut must overlap the part. The profile's description says its plane crosses the path's start and that it is carried as it sits there.
- Every tool that takes `design`: a design's name given where its id goes is taken when exactly one design has that name (case and spacing aside). A design that is not there is refused with the ids of the designs there are, each with its name, or with how to start one when there are none.
- `slicerx_geom_extrude`, `slicerx_geom_revolve`, `slicerx_geom_loft` and `slicerx_geom_sweep` with `design`: a `target` that is the design itself (its id or name) or one of its parts by name stands for that part. Any other `target` is refused with the design's parts by number and name.
- `slicerx_geom_hole`: a pick that finds no hole is refused with a note that the tool changes a hole that is already there and that a new hole is a circle loop cut with the extrude tool.

### Fixed

- `slicerx_geom_extrude`, `slicerx_geom_revolve`, `slicerx_geom_loft` and `slicerx_geom_sweep` with `operation` `join`: a join that closes a hollow (a rod over an open tube, a lid on a cup) joins. Before, the sealed hollow added an inner shell and the join was refused as not reaching the part.
