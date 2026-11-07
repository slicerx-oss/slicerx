### Fixed

- `slicerx_slice_file` and `slicerx_estimate_file` hold a 3MF project's machine limits (`machine_max_*`: acceleration, speed, jerk and the like, normal and silent mode) to the printer profile's on the printer the project was made for. A file may lower a limit but not raise it, and a limit at or below 0 takes the profile's. Before, a file's limit above the profile's was taken as it was.
- The same tools keep the printer profile's nozzle height (`nozzle_height`, which the travel collision check reads) for a 3MF project on the printer it was made for. Before, the file's value was taken.
