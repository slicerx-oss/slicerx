### Fixed

- `slicerx_app_sheet_ask` now shows a looked-up size that says where it came from only in its `note` (for example "269 m real at 1:1250"), with the note as the size's source title, cut to 80 characters. Before, the sheet was refused with "a looked-up value needs its sourceTitle, or its sourceUrl". A looked-up size with no `sourceTitle`, `sourceUrl` or note (or a note of only spaces) is still refused in those words. The tool's input and reply are unchanged.
