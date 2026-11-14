### Fixed

- `slicerx_design_edit_step` 1.8.1 (from 1.8.0): one edit that sets a step's value together with a move now keeps both. Before, the value was set on the step as it was before the edit, so the move was dropped while the reply still said "moved by". A mast built 0.41 mm into a deck, edited to 19.35 mm with a move of [0, 0, 0.35], stayed 0.41 mm into the deck with its top 0.35 mm lower. It now rises off the deck and keeps its top where it was. A size given with a section edit of a loft was dropped the same way and is now kept.
