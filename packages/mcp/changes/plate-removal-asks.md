### Changed

- Taking objects off the plate has its own permission class, `remove`, which asks first by default. Before, it was part of `slice`, which is Allow by default. `slicerx_project_remove_object` 1.1.0 is in the `remove` class, and `slicerx_app_plate_remove` 1.2.0 is when it deletes a plate's objects (`deleteObjects: true`); removing an empty plate stays `slice`. A policy file sets it as `"remove": "allow"`, `"ask"` or `"off"`, and a policy that does not name it asks. `slicerx_get_policy` lists the class.
- `slicerx_app_undo` and `slicerx_app_redo` 1.1.0 are in the `remove` class: a step can take objects off the plate (undoing an add, redoing a delete or a Cut), and the app cannot say beforehand what a step will do, so every Undo and Redo asks first by default.
- `slicerx_project_open` 1.1.0 asks first, in the `remove` class, when it would replace a working project that has objects; opening the first project, or over an empty one, still runs as a read.
- `slicerx_design_undo` 1.2.0 is in the `remove` class when it undoes a design's only step, which takes the body off the plate, or when the design is not found; undoing a later step stays `slice`.
