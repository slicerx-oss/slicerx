### Changed

- `slicerx_design_plan` 1.13.0 (from 1.12.0), in the mimir tab, refuses a print-in-place planetary set whose evenly spaced planets cannot all mesh: the ring's teeth are the sun's plus twice a planet's, and the sun's and ring's teeth together do not divide by the planet count. The refusal names two sun and ring tooth counts that do mesh with the same planets. The planet count is a count size on the planet feature, else the print-in-place pieces named like it. A plan whose gears do not print in place, or whose tooth counts are no planetary set, is not refused.
