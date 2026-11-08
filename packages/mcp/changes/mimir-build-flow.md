### Changed

- `slicerx_design_check` 1.1.0 matches each planned feature to the steps that build it. A feature may take several steps (four standoffs, five port cutouts), so more steps than planned features pass as long as every feature has a step, and the item says how the steps group. A step goes to the feature its name shares the most words with. A feature no step matches by name can take one step that builds shape under the tool's own default name (an extrude, cut, hole, pull, revolve, loft, sweep, join, array, mirror, shell or hollow, or a solid added or subtracted). A step named for something the plan lacks, or a fillet or chamfer, never stands in for a missing feature. A feature with no step still fails and is named, even when there are as many steps as features.
- A design of several parts laid out side by side (a lid lying flat beside its base) has its overall size held to the largest part instead of the bounds of every part together.
- The answer's `body` adds `steps`, the shaping steps' names, and `free`, which of those steps may stand for any planned feature. It also adds `parts`, each part's size, when there are several.

### Fixed

- `slicerx_design_check` no longer reads a wall of almost nothing from the slivers a boolean leaves where faces meet: a facet folded under the neighbor it shares an edge with, a needle facet and a speck under 0.01 mm across are left out of the minimum wall. Before, parts with 1 mm walls and more failed "minimum wall" at 0 mm.
