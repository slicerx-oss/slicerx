### Changed

- `slicerx_design_plan` 1.13.0 (from 1.12.0), in the mimir tab: the description tells a print-in-place plan to settle where its pieces join before building any piece. Any choice that moves a joint is asked before the plan, an assumption says which piece joins which, and each piece is built at its joint with its planned gap, never laid loose to join later. The check that a piece 2 mm or more from every other piece fails is unchanged.
