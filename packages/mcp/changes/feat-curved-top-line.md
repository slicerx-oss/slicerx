### Changed

- `slicerx_design_plan` 1.24.0 (from 1.23.0): its display build rule asks for a curved body's top line to follow the real body from end to end, as its bottom does, with the top height at both ends and in the middle given as the sizes topStart, topMiddle and topEnd, and the sections built to them. Before, a plan could give a curved body one height, and its loft kept a flat top along most of its length while only the bottom changed, which the check passed.
