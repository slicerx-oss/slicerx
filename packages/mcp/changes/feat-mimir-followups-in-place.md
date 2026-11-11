### Added

- `slicerx_design_edit_step` 1.4.0 (from 1.3.0) takes `size` and `move`. `size` sets what a step made to a length along one axis, from its low end: an extrude's height or outline, a revolve along or across its axis, a loft along its run or across its sections. `move` shifts what the step made by [x, y, z] mm. Copies a pattern made of the step follow either one, a pattern of a pattern included, and paint laid on the part after the step follows what it painted. A step number sent as text ("2") is that step unless a step has that id or name.
- `slicerx_paint_preview` 1.3.0 (from 1.2.0) takes `whole`. In the mimir tab, a color asked for on a whole part already painted in height bands asks which band, the rest of the part, or all of it, as a one-tap question, and `whole` true skips it. A client with no way to ask is refused with the bands listed in words.

### Changed

- `slicerx_design_plan` 1.7.0 (from 1.6.0), in the mimir tab, takes `asked` with `amends`: the person's own words for a change they asked for in their latest message. It goes in with no card, since their message is the go, may add features, and may change how a feature is made. Without `asked`, an amend still needs a `reason` and a card.
- `slicerx_geom_extrude` 1.11.0 (from 1.10.0): a join that raises a body (a level or a story added on top) lifts the parts that stood on it onto its new top in the same call, at the steps that made them, with their paint, and the answer names each one and how far it moved. A part no step made is named with how deep it now sits, for the client to move it.
