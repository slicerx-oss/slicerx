### Changed

- `slicerx_design_plan` 1.11.0 (from 1.10.0), in the mimir tab: a display or fine plan no longer needs `colors`. Color is planned only when the person asks for it, in the request or a follow-up; without it the plan gives no colors and the part prints in one default filament. Colors that are given are held to the same rules as before (a color for each main body, one color per feature, each darker band its own feature). The tool's description, the `colors` field and the build method say the same.
- A local model's display or fine plan is held only to what its form can say (the feature count for its level). Its form keeps `detail` and leaves out curved, flat, proportions, repeats, colors, scale, real and tiers, so those rules no longer refuse it.
