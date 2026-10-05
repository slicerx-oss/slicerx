# Printer maker marks

On 2026-09-30 the SlicerX maintainers reported permission from the printer makers to use their official brand kits. Marks are used only where a maker's own press kit or media page provides a file, unaltered, in the colors its guidelines allow. Every other maker keeps the neutral `MakerTile`. The apps pick `OfficialMark` (packages/brand-icons/src/marks.ts) when one exists and `MakerTile` otherwise.

| Maker | File | Source | Retrieved | Permission |
| --- | --- | --- | --- | --- |
| Prusa Research | assets/prusa-white.png, prusa-black.png (2495 by 1550, kit RGB PNGs) | https://prusa3d.com/downloads/press/prusaresearch.zip, kit page https://www.prusa3d.com/page/media-assets_987/ | 2026-09-30 | Permission reported by the maintainers, 2026-09-30 |
| Flashforge | assets/flashforge-white.png, flashforge-black.png (1000 by 200) | https://cdn.shopify.com/s/files/1/0591/8641/3646/files/Logo.zip?v=1770363731, kit page https://www.flashforge.com/pages/press | 2026-09-30 | Permission reported by the maintainers, 2026-09-30 |

Makers with no downloadable official file found (public search, 2026-09-30): Bambu Lab, Creality, Elegoo, Anycubic, Voron, Sovol, Qidi, AnkerMake, Rat Rig, FLSUN. Snapmaker has a press page (https://press.snapmaker.com/) that renders in JavaScript and exposed no file link. For these, ask the maker to send its kit, drop the files in assets/, and add a record to OFFICIAL_MARKS. The research from before that permission follows.

Without an official mark, SlicerX shows no printer maker logo artwork in the printer picker. Each maker is shown by its plain name next to a neutral lettermark tile (`MakerTile` in `@slicerx/ui`), drawn in the SlicerX icon language. We do not redraw, vectorize or recolor any maker mark. Official marks replace the tiles only after the maker's terms or written permission allow it.

| Maker | Terms found | Official SVG | Ask for permission |
| --- | --- | --- | --- |
| Prusa Research | Press kit at https://www.prusa3d.com/page/media-assets_987/ ("All photos and logos in the package are ready for immediate release worldwide"). The brand manual allows black or white only, no alterations, and says nothing on third-party identification use. | No (ai, eps, pdf, png) | michal.fanta@prusa3d.cz |
| Flashforge | Brand guidelines: use only the official files from the media kit, do not stretch, rotate, redraw or recolor. Written for press and affiliates, not an explicit third-party grant. | No (PNG only) | pr@flashforge.com |
| Snapmaker | Terms of use (https://www.snapmaker.com/terms-of-use): "You are not allowed to use our name or logo for commercial promotion without authorization." | No | Snapmaker via press.snapmaker.com |
| Bambu Lab | No press terms verified. | Not obtained | Not yet asked |
| Creality | No press terms verified. | Not obtained | Not yet asked |
| Elegoo | No press terms verified. | Not obtained | Not yet asked |
| Anycubic | No press kit or terms found. | No | Not yet asked |
| Voron | Open hardware project, no brand terms verified. | Not obtained | Not yet asked |
| Sovol | Terms only forbid infringing IP. | No | info@sovol3d.com |
| Qidi | IP page did not load when checked. | No | Not yet asked |
| AnkerMake | Site now redirects to eufyMake; no press kit found. | No | Not yet asked |
| Rat Rig | Terms only forbid infringing IP. | No | sales@ratrig.com |

Simple Icons carries marks for some of these makers under CC0. That license covers the drawing data only. It is not an official file and does not grant trademark rights, so those marks are not used for makers in the printer picker.

The Simple Icons marks for Bambu Lab, Creality, Elegoo and Voron were removed from this package on 2026-09-30, and their consumers (apps/web, apps/desktop, the connect catalog) now use `MakerTile`. This package keeps only tool and service marks (Klipper, OctoPrint, Mainsail, Fluidd, Spoolman, Home Assistant and the AI clients), recorded in README.md.
