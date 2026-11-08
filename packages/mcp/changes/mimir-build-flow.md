### Added

- Every modeling tool that makes or changes a body takes `feature`, the plan feature the step builds, by its name in the plan: `slicerx_geom_extrude` and `slicerx_geom_revolve` 1.4.0, `slicerx_geom_push_pull` 1.3.0, `slicerx_geom_loft`, `slicerx_geom_sweep`, `slicerx_geom_boolean`, `slicerx_geom_fillet`, `slicerx_geom_chamfer`, `slicerx_geom_shell`, `slicerx_geom_hole`, `slicerx_geom_cut` and `slicerx_geom_split` 1.2.0, `slicerx_geom_array` 1.2.1, and `slicerx_geom_repair`, `slicerx_geom_hollow`, `slicerx_geom_emboss`, `slicerx_geom_build`, `slicerx_geom_subtract` and `slicerx_geom_mirror` 1.1.0. With `design` it is recorded on the step and kept when the design is saved and opened again. `slicerx_design_steps` 1.1.0 reads it back on each step that has one, and `slicerx_design_edit_step` 1.1.0 sets it (empty clears it).

### Changed

- `slicerx_design_check` 1.1.0 ties each planned feature to the steps tagged with its name, ignoring case, punctuation and plurals. A feature may take several steps (four standoffs, five port cutouts), so more steps than planned features pass as long as every feature has a tagged step, and the item says how the steps group. A feature with no tagged step fails by name, and a step with no tag is finishing work that never stands in for one; an untagged step named like the missing feature is named, with a note to set its feature with `slicerx_design_edit_step`. A tag the plan does not have is named in the item. A design with no tagged step at all is matched by step names instead: a step goes to the feature its name shares the most words with, and a step whose name matches no feature stands for none, whatever tool made it. The item then says to pass `feature` on each step.
- A design of several parts laid out side by side (a lid lying flat beside its base) has its overall size held to the largest part instead of the bounds of every part together.
- The answer's `body` adds `steps`, the shaping steps' names, and `tags`, the planned feature each of those steps was tagged with, or null. It also adds `parts`, each part's size, when there are several.

### Fixed

- `slicerx_design_check` no longer reads a wall of almost nothing from the slivers a boolean leaves where faces meet: a facet folded under the neighbor it shares an edge with, a needle facet and a speck under 0.01 mm across are left out of the minimum wall. Before, parts with 1 mm walls and more failed "minimum wall" at 0 mm.
