### Changed

- `slicerx_design_plan` 1.18.0, in the mimir tab: `assumptions` and `questions` may be left out of a first plan, which then has none of either; before, a plan without them was refused as invalid arguments. An amend left them out already (`changes`). Each assumption takes up to 300 characters (was 200) and a plan up to 20 of them (was 12), and `proportions` takes up to 400 characters (was 200), so a plan that says what it assumed in full is no longer refused for its length. The lines the card adds for raised sizes fit beside up to 20 of the plan's own.
- `slicerx_design_put_plan` 1.10.0 (from 1.9.0) takes the same assumptions: up to 20, each up to 300 characters.
