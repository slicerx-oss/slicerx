### Changed

- `slicerx_paint_preview` 1.5.0 (from 1.4.0): a height band on an exact design goes on whole faces. A face the band's edge crosses is split there first, and its shape stays the same. The preview is the step's own replay, and each part's row gains `faces`: the faces the band paints, each with its key, state and area. The band then lasts through the design's later exact steps. An engine that cannot split faces refuses the band on an exact design, as before.
- `slicerx_paint_apply` 1.4.0 (from 1.3.0) and `slicerx_paint_regions` 1.2.0 (from 1.1.0): on an exact design, each part's read-back gains `faces`, every face painted whole with its key, state and area in mm2.
