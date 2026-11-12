### Fixed

- `slicerx_design_look` 1.1.2 (from 1.1.1), in the mimir tab: a look with `compare: true` measures a change that moves the model's extent, such as a step raised past the top, a step lowered or a part added beside the model. Before, the before and after pictures could come out one pixel apart in height, and the compare answered "The change could not be measured". Both pictures now share one frame that the drawn edges never reach past, so they are always the same size.
