### Changed

- `slicerx_app_preview_set` with `camera: 'iso'` (or `fit`) on an empty plate frames the whole plate, its outline with room around it, instead of a fixed 120 mm box in its middle that a larger bed overfilled. A plate with a part frames as before. No tool's input or answer shape changes, so no tool version moves.
