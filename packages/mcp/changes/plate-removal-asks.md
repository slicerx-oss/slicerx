### Changed

- Taking objects off the plate has its own permission class, `remove`, which asks first by default. Before, it was part of `slice`, which is Allow by default. `slicerx_project_remove_object` 1.1.0 is in the `remove` class, and `slicerx_app_plate_remove` 1.2.0 is when it deletes a plate's objects (`deleteObjects: true`); removing an empty plate stays `slice`. A policy file sets it as `"remove": "allow"`, `"ask"` or `"off"`, and a policy that does not name it asks. `slicerx_get_policy` lists the class.
