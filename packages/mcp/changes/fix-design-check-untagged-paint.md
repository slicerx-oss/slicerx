### Changed

- `slicerx_design_check` hints the edit for an untagged paint step, as it does for an untagged shaping step: `step "<id>" ("<name>") is untagged: set its feature to "<feature>" with slicerx_design_edit_step`. It names the planned features with no paint band yet, or those that share a word with the step's name. Its `body` gives the untagged paint steps as `paintUntagged`.
