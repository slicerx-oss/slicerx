### Changed

- `slicerx_geom_extrude` 1.6.0 (from 1.5.0), `slicerx_geom_revolve` 1.6.0 (from 1.5.0), `slicerx_geom_loft` 1.4.0 (from 1.3.0) and `slicerx_geom_sweep` 1.5.0 (from 1.4.0) say why a join or cut that does not touch the part was refused. "The shape no longer reaches the part" is now "The shape stops 1.2 mm short of the part" when the shape is clear of it (the smallest distance between them), "Part of the shape would float off the part, so nothing changed" when only some of a join floats off, "The shape is already inside the part, so nothing changed" for a join inside it, and "The shape only touches the part, so nothing changed" for a cut that meets it and removes nothing. With a model, `report` has `miss` beside `touches`: `{ "reason": "apart", "gapMm": 1.2 }`, `{ "reason": "inside" }` or `{ "reason": "unchanged" }`.
- `slicerx_geom_loft` 1.4.0 refuses a result that is unsafe at mesh storage precision with "change the loft's profiles or the spacing between them". Before, it asked to change the cut or placement, which a loft does not have.

### Fixed

- A refused design step ends "... of the part. The design is unchanged." with one full stop. Before, a reason that ended in a full stop got a second one.
