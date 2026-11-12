### Changed

- `slicerx_design_plan` 1.8.0 (from 1.7.0), in the mimir tab, takes `personSize`. A display or fine plan without it is planned to fill about 85% of the printer's usable bed: its longest side, held to the other side and the height, from the printer profile's printable area and height, or 256 mm when no printer is chosen. A plan sized otherwise is refused with the size to plan. Each level of a stepped body is at least 3 mm tall. The description says up front that bodies are named by feature, that a loft's section count is a size named sections, and that an amend comes only once the part is built.
- `slicerx_design_check` 1.17.0 (from 1.16.0): a display or fine part that passes says to give its size in the reply and offer a resize as a follow-up.
