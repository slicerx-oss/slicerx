### Changed

- `slicerx_design_check` 1.19.0: a failed overall size says where the body ends along each axis that is off. The item gives `where` ("Along z it is 30 mm against the plan's 20 mm, from (0, 20, 0) mm to (20.26, 10.15, 30) mm on Mast.", with the part named only in a design of several parts and never by the name a new body gets), and the summary ends on it. `got` is the reading as before. A body that is only turned on the bed, or a display model within its tolerance, gets none. The check's `body` gives each axis's two ends as `reach`.
