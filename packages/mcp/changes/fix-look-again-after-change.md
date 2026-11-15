### Fixed

- `slicerx_design_look` 1.2.1 (from 1.2.0), in the mimir tab: the description says that on a follow-up the app has already looked at the start of the turn, so a second look without `compare` returns no picture, and a change is seen with one look with `compare: true` after the last change. A second look on a follow-up was answered that the model had not changed since the first, even after a step had changed it; it now says the first picture shows the model before the turn's changes and points to that one compare.
