# Changelog

## 0.1.0

- First release: STEP AP203, AP214 and AP242 files to meshes in millimeters, in browsers, workers and Node. Objects and bodies with their names, touching bodies grouped, units converted, body colors as data. OBJ and binary STL output. `@slicerx/step-reader/node` reads each file in a worker thread with a deadline, an input size cap and a memory cap. Errors are `StepError` with a stable `code`.
