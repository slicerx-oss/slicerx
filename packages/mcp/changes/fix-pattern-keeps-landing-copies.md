### Changed

- `slicerx_geom_array` 1.8.0 (from 1.7.0) with `steps`: a copy that misses the part no longer refuses the call. The copies that land are kept, the ones that miss are left out, and the step's note names them ("Copies 2 and 4 did not reach the part and were left out."), which the reply's summary repeats. The call is refused only when none of the copies reach the part. A copy that fails for another reason still refuses the call with `Copy N:` and the reason, and the design is unchanged.
- `slicerx_geom_mirror` 1.5.0 (from 1.4.0) with `steps`: the same, for a mirrored pattern of steps whose copies miss the part in the mirror image ("In copy 2, copies 4 and 9 did not reach the part and were left out.").
