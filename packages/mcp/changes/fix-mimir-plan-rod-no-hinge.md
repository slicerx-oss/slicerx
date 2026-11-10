### Fixed

- `slicerx_design_put_plan` no longer gives `unstated` (say whether the lid prints assembled on its hinge or laid apart) for a plan with a rod, shaft, axle, dowel or pin feature but no hinge and no lid, such as a cable hook bent from a 10 mm rod. A pin feature asks how the lid prints only when the part or a feature names a hinge or a lid. Its input and result are unchanged.
