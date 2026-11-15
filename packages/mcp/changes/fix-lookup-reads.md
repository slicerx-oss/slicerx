### Fixed

- `slicerx_design_lookup_sizes` 1.1.2 (from 1.1.1), in the mimir tab: a line of the web answer that says its size was not found counts as not found, whatever figures it also gives. Before, a line such as "Gate height: 9 m (timber gates, 1 m deep), not found as a height figure" kept 9 m as the gate's height, and design.plan held the plan to it. A source page whose title is under 8 characters or all capitals now shows with its site, such as "STR (example.org)", in the result's `sources`, on the lookup card and in design.check's reply.
