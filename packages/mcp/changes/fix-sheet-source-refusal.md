### Fixed

- `slicerx_app_sheet_ask` 1.3.1 (from 1.3.0) refuses a looked-up size with no `sourceTitle`, `sourceUrl` or note in words that name all three: "a looked-up value names where it came from: its sourceTitle, its sourceUrl, or a note such as "269 m real at 1:1250"". Before, it said "a looked-up value needs its sourceTitle, or its sourceUrl", which left out the note it also takes. The tool's input and reply are unchanged.
