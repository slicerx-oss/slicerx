### Fixed

- `slicerx_design_put_plan` no longer gives `unstated` (say one way the lid prints) for a plan whose `printInPlace` names its pieces and lays them out apart to print open, such as a box with its lid opened flat 10 mm beside it on its hinge. With the pieces named in `printInPlace`, beside, laid apart or out, printed apart and 2 mm or more apart describe the layout. A plan that also says a piece prints separately, to put together after, still gets `unstated`. Its input and result are unchanged.
