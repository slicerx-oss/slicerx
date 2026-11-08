### Fixed

- `slicerx_design_open` with `texture` names the right reason in `texture.notes` when a JPEG texture is left out: one over 4096 px a side "is too large to read" and an arithmetic coded or lossless one "is a kind of JPEG that is not read". Before, both said "is damaged". A progressive JPEG whose header asks for far more blocks than the file holds is now left out as damaged before it decodes; before, it was decoded as a blank gray texture after setting aside about 150 MB.
