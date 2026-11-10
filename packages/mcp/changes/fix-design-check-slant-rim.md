### Fixed

- `slicerx_design_check` 1.7.0 (past 1.6.0, the plan revision in its result) reads a whole wall at the rim of a tube cut at a slant, such as the tip of a swept spout. Before, the facets next to the rim read how near they sit to the bore's edge, 0.07 to 0.3 mm, so a spout with a 1.6 mm wall failed "minimum wall". A wall now counts only where the ray in from a facet leaves the far side at under about 73 degrees to that face's normal (a cosine over 0.3, from 0.1). A thin floor is still read as before: a 0.41 mm floor between a countersink and a bore fails.
