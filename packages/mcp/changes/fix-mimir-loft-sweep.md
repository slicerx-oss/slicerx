### Changed

- `slicerx_geom_loft` 1.1.1: the description says `thicken` makes the loft hollow with open ends (a tapered stem, a vase wall), and a profile's description points at the revolve tool's loops and frame without naming the tool by its MCP name.
- `slicerx_geom_sweep` 1.1.1: the description names what a sweep is for (a hook, a handle, a bent rod or pipe), says a join or cut must overlap the part, and says a hook starts inside a side wall below its top, not on an open top, with its path ending bent up into a lip. The profile's description says its plane crosses the path's start and that it is carried as it sits there.
- Every tool that takes `design`: a design's name given where its id goes is taken when exactly one design has that name (case and spacing aside). A design that is not there is refused with the ids of the designs there are, each with its name, or with how to start one when there are none. A name two or more designs share is refused with the ids of those designs, not as a missing design.
- `slicerx_geom_extrude`, `slicerx_geom_revolve`, `slicerx_geom_loft` and `slicerx_geom_sweep` with `design`: a `target` that names one of the design's parts stands for that part, and one that is the design itself (its id or name) leaves `part` as given. A part name wins over the design's own name. Refused with the design's parts by number and name: a `target` naming another part than the `part` given, a name two parts share, and any other `target`.
- `slicerx_geom_hole` 1.1.1: the description says it changes a hole that is already there and never makes a new one, which is a circle loop cut with the extrude tool. A pick that finds no hole is refused with the same note.
- `slicerx_design_check` with `design` given by its name: the plan is compared and tied by the design's id, so a plan tied to a design is checked when the design is named either way.
- `slicerx_geom_hole` and `slicerx_geom_push_pull` refusals on a topology reference report `bodyId` as the design's id when the design was given by its name.

### Fixed

- `slicerx_geom_extrude`, `slicerx_geom_revolve`, `slicerx_geom_loft` and `slicerx_geom_sweep` with `operation` `join`: a join that closes a hollow (a rod over an open tube, a lid on a cup) joins. Before, the sealed hollow added an inner shell and the join was refused as not reaching the part.
- A join or cut step the engine reports as leaving the part not closed still lands, and its step now carries a note saying the part is not closed and to look where the shapes meet before printing.
