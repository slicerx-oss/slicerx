### Fixed

- `slicerx_paint_preview` 1.6.1 (from 1.6.0) and `slicerx_paint_regions` 1.2.1 (from 1.2.0): the picture (with `image: true`) draws each painted state and each part's own filament in the project's filament colors, the ones the slice prints, so paint in filament 3 shows in filament 3's color. Before, the picture used a fixed set of colors whatever the project's filaments were, and filament 3 always came out red. In the mimir tab the colors are the filament rail's; on the server, the open project's. A filament past the project's last still draws in a stand-in color.
