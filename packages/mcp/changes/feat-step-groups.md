### Changed

- `slicerx_design_undo` 1.2.0 (from 1.1.0) takes off together the steps one call made together: the posts and the bar of `slicerx_geom_rail`. A hole and its counterbore or countersink from `slicerx_geom_hole` still undo one step at a time, so the head alone can be taken off and made again. The summary names every step it removed. Other steps undo one at a time as before, and so do the steps of a file saved before this.
- `slicerx_design_redo` 1.2.0 (from 1.1.0) puts such steps back together, in their order.
- `slicerx_design_steps` 1.5.0 (from 1.4.0) gives each step that one call made with others a `group`, the same for every step of that call. The group is saved in the project file and read back when it is opened.
