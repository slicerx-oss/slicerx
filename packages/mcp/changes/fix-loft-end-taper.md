### Changed

- `slicerx_geom_loft` 1.12.0 (from 1.11.0) and `slicerx_design_edit_step` 1.8.0 (from 1.7.0) no longer name a first or last section that is only the taper of the body's end. Such a section is under two nozzle lines across, but the width one nozzle width inboard is at least two nozzle lines, read straight between it and the section next to it over the distance between their planes. The slicer prints that last fraction of a millimeter thin or drops it. The note's sentence and `thinSections` are unchanged otherwise, and a thin section anywhere else is named as before.
