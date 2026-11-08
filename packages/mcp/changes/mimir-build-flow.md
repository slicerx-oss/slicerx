### Changed

- `slicerx_design_check` 1.1.0 matches each planned feature to the steps that build it: a feature may take several steps (four standoffs, five port cutouts), so more steps than planned features passes as long as every feature has a step, and the item says how the steps group. A feature with no step, or fewer steps than features, still fails and names the feature. A design of several parts laid out side by side (a lid lying flat beside its base) has its overall size held to the largest part instead of the bounds of every part together. The answer's `body` adds `steps`, the shaping steps' names, and `parts`, each part's size, when there are several.

### Fixed

- `slicerx_design_check` no longer reads a wall of almost nothing from the slivers a boolean leaves where faces meet: a facet folded under the neighbor it shares an edge with, a needle facet and a speck under 0.01 mm across are left out of the minimum wall. Before, parts with 1 mm walls and more failed "minimum wall" at 0 mm.
