# @slicerx/brand-icons

Third-party printer, firmware, and tool logos for "works with" sections, such as a list of supported printers or the AI clients that can connect over MCP.

The package is optional. Nothing else in the repository imports it, and you can delete the folder without touching any other package. The marks are unaltered official artwork. Only the width and height attributes were removed and the viewBox normalized. The artwork is not covered by the Apache-2.0 license that covers the package code. Each mark keeps the license recorded in the table below. See [TRADEMARKS.md](./TRADEMARKS.md) for the trademark notice.

## API

```tsx
import { BrandLogo, BRAND_LOGOS, BRAND_SLUGS, type BrandSlug, type BrandLogoRecord } from '@slicerx/brand-icons'

<BrandLogo slug="klipper" />                                  // mono, 20px, follows currentColor
<BrandLogo slug="klipper" variant="color" size={32} />        // official color
<BrandLogo slug="claude" title="Claude" />                    // role="img" with an aria-label
```

- `BrandLogo` props: `slug`, `size` (default 20), `variant` (`'mono'` or `'color'`, default `'mono'`), `title`, `className`. Without a `title` the SVG is `aria-hidden`. It uses no hooks, so it renders on the server.
- `BRAND_LOGOS` is a record of `BrandLogoRecord` by slug. `BRAND_SLUGS` lists the slugs. `BrandSlug` is their union type.
- A record holds `slug`, `title`, `viewBox`, `svg` (mono inner markup), `color` (official hex), optional `colorSvg` (official full-color inner markup), `source`, `license`, and `retrieved`.
- The color variant uses `colorSvg` when a record has one and otherwise fills the mono mark with the brand hex. Some brand hex values are black, so place those on a light background.

`node scripts/sheet.mjs <output.html>` writes a contact sheet of every logo.

## Official maker marks

`<OfficialMark slug="prusa" size={24} on="dark" />` renders a printer maker's official press kit file unaltered, fitted into a square box. `on` picks the white file (`dark`, default) or the black file (`light`). `hasOfficialMark(slug)` tells an app whether to use it or fall back to `MakerTile` from `@slicerx/ui`. Files, sources and permission notes: [LOGOS.md](./LOGOS.md).

## Logos

| Logo | Source | License | Retrieved |
| --- | --- | --- | --- |
| Klipper | https://github.com/Klipper3d/klipper/blob/master/docs/img/klipper.svg | GPL-3.0-only (Klipper repository) | 2026-09-30 |
| OctoPrint | https://github.com/simple-icons/simple-icons/blob/16.33.0/icons/octoprint.svg | CC0-1.0 | 2026-09-30 |
| Mainsail | https://github.com/mainsail-crew/mainsail/blob/develop/public/img/logo.svg | GPL-3.0-only (Mainsail repository) | 2026-09-30 |
| Fluidd | https://github.com/fluidd-core/fluidd/blob/develop/docs/docs/assets/images/logo.svg | GPL-3.0-only (Fluidd repository) | 2026-09-30 |
| Spoolman | https://github.com/Donkie/Spoolman/blob/master/client/public/favicon.svg | MIT (Spoolman repository) | 2026-09-30 |
| Home Assistant | https://github.com/simple-icons/simple-icons/blob/16.33.0/icons/homeassistant.svg | CC0-1.0 | 2026-09-30 |
| Claude | https://github.com/simple-icons/simple-icons/blob/16.33.0/icons/claude.svg | CC0-1.0 | 2026-09-30 |
| Cursor | https://github.com/simple-icons/simple-icons/blob/16.33.0/icons/cursor.svg | CC0-1.0 | 2026-09-30 |
| GitHub Copilot | https://github.com/simple-icons/simple-icons/blob/16.33.0/icons/githubcopilot.svg | MIT | 2026-09-30 |
| Zed | https://github.com/simple-icons/simple-icons/blob/16.33.0/icons/zedindustries.svg | CC0-1.0 | 2026-09-30 |
| Windsurf | https://github.com/simple-icons/simple-icons/blob/16.33.0/icons/windsurf.svg | CC0-1.0 | 2026-09-30 |

Marks from Simple Icons (version 16.33.0) are taken from its CC0 1.0 icon data. GitHub Copilot is recorded as MIT, the license Simple Icons lists for it. Klipper, Mainsail, Fluidd, and Spoolman come from each project's own repository and carry that repository's license. A license on the artwork does not grant trademark rights.

## Not included

- Printer makers other than Prusa and Flashforge: no official file was found. `MakerTile` in `@slicerx/ui` stands in. See [LOGOS.md](./LOGOS.md).
These logos were not found under a clear license, so they are left out rather than redrawn.

- Prusa: the only artwork in the public PrusaSlicer repository is the slicer's application icon, not the Prusa Research mark.
- Snapmaker: no official mark with a stated license or brand color was found.
- Moonraker: the project repository has no logo file.
- Duet3D: no logo is published in the project repositories or in Simple Icons.
- ChatGPT and OpenAI: not in Simple Icons, and no license for the mark was found.
- Visual Studio Code: not in Simple Icons, and Microsoft does not license the mark for reuse.
