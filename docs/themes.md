# Themes

SlicerX colors come from theme files. A theme is one small JSON file with the base colors. The app derives everything else (panels, hairlines, chips, secondary text, status colors) by fixed rules, so a theme only needs about a dozen colors and still reads well.

Thirteen themes ship with the app, each with a light and a dark mode:

| Theme | Dark | Light |
| --- | --- | --- |
| Subban (default) | Subban | Subban light |
| Dracula | Dracula | Alucard |
| Catppuccin | Mocha, Macchiato, Frappe | Latte |
| Nord | Nord | Nord light (designed) |
| One | One Dark | One Light |
| Tokyo Night | Tokyo Night | Tokyo Night Day |
| GitHub | GitHub Dark | GitHub Light |
| Solarized | Solarized Dark | Solarized Light |
| Night | Night | Night light (designed) |
| Gothic | Gothic dark (designed) | Gothic |
| Newsprint | Newsprint dark (designed) | Newsprint |
| Pixyll | Pixyll dark (designed) | Pixyll |
| Whitey | Whitey dark (designed) | Whitey |

Where a theme has an official mode of the other brightness, that is the one used. Where it has none, the missing mode is designed from the same hues and checked for contrast; the table marks those. Night, Gothic, Newsprint, Pixyll and Whitey follow the Typora themes of those names. The themes bring colors only; fonts stay a separate choice. The files are in `packages/ui/themes/`.

Subban is the default. Its dark mode is the Dracula palette one step deeper, and its light mode is the Nocturne Bright palette. It was called SlicerX dark and light, and Nocturne, before: stored choices with those ids move to Subban without a step from the person, and `nocturne` still works in code and edition configs. The Dracula license notice is in `packages/ui/themes/LICENSES.md`.

## Using a theme

Open Settings, then Look and feel, then Theme, or pick one on the first setup screen.

- **Mode**: System follows the operating system, Light and Dark show one mode.
- **Cards**: one card per theme, its light and dark modes side by side. Picking a card sets both modes, so switching mode keeps the theme. A theme with more than one dark variant (Catppuccin) shows a Dark flavor choice under the cards. A theme of one brightness only (your own file, say) says Light only or Dark only, and picking it while the other mode shows switches the mode.
- **Import theme** reads a `.json` file and adds it to the list. The file is checked first; if something is wrong, the dialog says what.
- **Export theme** saves the current theme as a file you can share.
- **Open themes folder** (desktop app) opens a folder in the app data directory. Any `.json` file placed there appears in the list the next time the window gains focus.
  - macOS: `~/Library/Application Support/app.slicerx.desktop/themes`
  - Windows: `%APPDATA%\app.slicerx.desktop\themes`
  - Linux: `~/.local/share/app.slicerx.desktop/themes`

A theme with the same `id` as a bundled one never replaces it when imported through Settings: it gets a new id, and a copy of a bundled theme gets its own card instead of joining that theme's. Files in the themes folder with a bundled id do replace it, which is how you tweak a bundled theme.

## Text and accessibility

Settings, Look and feel also has:

- **Accent**: the theme's own accent, or blue, cyan, green, pink or orange from the theme's palette, for selection, focus and the main button.
- **Text size**: Small, Default, Large, Larger (13, 14, 16 and 18 px body text). Every type size scales with it through `--text-scale`.
- **Font weight**: Light, Regular, Medium, Bold for body text. Labels and titles step up from it through the `--fw-regular`, `--fw-medium`, `--fw-semibold` and `--fw-bold` tokens.
- **Contrast**: Higher lifts secondary and dim text to 7:1, status colors and the accent to 4.5:1, and draws borders stronger, in any theme.
- **Color vision**: Red-green or Blue-yellow moves the status and meaning colors that collide for that kind of color vision to ones that stay apart (after the Okabe and Ito palette), and draws toolpaths and the legend in the color vision palette. Every status also carries an icon. It replaces the earlier toolpath color switch, which moves over as Red-green.
- **Motion**: Follow system, On or Reduced.
- **Density**: Compact, Comfortable or Roomy spacing in panels and lists.

The first setup screen offers text size, color vision and reduce motion; the rest is in Settings.

## Fonts

Fonts are a separate choice, because a font is a taste and a theme is a palette. Settings, Look and feel, Fonts has two pickers: Interface and Numbers and code. Each lists the bundled fonts, the system font, and Theme default. Theme default uses the font the theme suggests, or Hanken Grotesk and JetBrains Mono when it suggests none. Your choice always wins over a theme.

Bundled fonts (all SIL Open Font License 1.1, stored in the app, nothing loads from the network):

| Picker | Ids |
| --- | --- |
| Interface | `hanken-grotesk`, `inter`, `ibm-plex-sans`, `system` |
| Numbers and code | `jetbrains-mono`, `ibm-plex-mono`, `system` |

Titles use Unbounded unless the interface font is `system`.

## File format

Version 1. A JSON Schema is at `packages/ui/themes/schema.json`; add `"$schema": "./schema.json"` (or the published URL) to a file and most editors will autocomplete and flag mistakes. The same checks run in the app.

| Key | Type | Required | What it is |
| --- | --- | --- | --- |
| `version` | `1` | yes | Schema version. |
| `id` | string | yes | Lowercase slug: letters, digits and hyphens, up to 40 characters. |
| `name` | string | yes | Shown in the picker, 1 to 40 characters. |
| `family` | string | no | Slug that groups the light and dark modes of one theme into one card. |
| `familyName` | string | no | The card's name, 1 to 40 characters. Defaults to `name`. |
| `flavor` | string | no | The variant's name when a family has more than one theme of the same brightness, such as Mocha. |
| `isDark` | boolean | yes | Dark themes fill the dark slot of Follow system, light themes the light slot. The app warns when it disagrees with the background. |
| `background` | color | yes | Page and window background. |
| `surface` | color | yes | Panels, cards and dialogs. |
| `surfaceAlt` | color | yes | Raised controls, inputs and hovered rows. |
| `border` | color | yes | Control borders and dividers. |
| `text` | color | yes | Main text. Should reach 4.5:1 on `background` and `surface`; the app warns when it does not. |
| `muted` | color | yes | Secondary text. The app lifts it to 4.5:1 if it is too dim. |
| `accent` | color | yes | Selection, focus, links and the primary action. |
| `selection` | color | no | Selected text and rows. Defaults to `border`. |
| `ansi` | 16 colors | yes | The terminal palette. Slot 1 is red, 2 green, 3 yellow, 4 blue, 5 magenta, 6 cyan. Other slots are kept for sharing with terminal themes. |
| `working` | color | no | The ok color. Defaults to `ansi[2]`. |
| `waiting` | color | no | The attention color. Defaults to `ansi[3]` turned to orange (hue 30 degrees, saturation at least 0.55). |
| `failed` | color | no | The error color. Defaults to `ansi[1]`. |
| `fonts` | object | no | `{ "ui": id, "mono": id }`, suggestions only. |
| `scene` | object | no | Colors of the 3D studio. Any key left out is derived. See below. |
| `credit` | string | no | Where the palette comes from, up to 200 characters. |

A color is `#rrggbb`, or `#rrggbbaa` (the alpha is ignored). Unknown keys are ignored. A file is at most 16 KB.

## How the other colors are derived

Let `mix(a, b, t)` mean `a` moved the fraction `t` of the way to `b`, per channel in sRGB. The app computes these from your base colors:

| Derived color | Rule |
| --- | --- |
| Pane (side panels) | `mix(background, surface, 0.5)` |
| Hairline | `mix(background, border, 0.7)` |
| Chip | `mix(background, border, 0.62)` |
| Strong chip (raised fills) | `mix(surface, border, 0.6)` |
| Secondary text | `mix(muted, text, 0.37)`, lifted to 4.5:1 |
| Dim text (captions, placeholders) | `muted`, lifted to 4.5:1 |
| Accent | as written on a dark theme; on a light theme lifted to 3:1 |
| Ink on the accent | `mix(background, black, 0.25)` on a dark theme, white on a light theme, whichever of that and the opposite end reads better on the accent |
| Red, green, yellow, blue, magenta, cyan | ANSI slots 1, 2, 3, 4, 5, 6 (or `failed`, `working` for red and green), lifted to 3:1 |
| Orange | `waiting`, or ANSI 3 turned to orange, lifted to 3:1 |

"Lifted to N:1" means: if the color already reaches contrast N on both `background` and `surface`, it is used as written. Otherwise it is mixed toward `text` in 5% steps until it does. On a dark theme that brightens it, on a light theme it deepens it.

The app then maps the derived colors onto its variables: `--ink-0` is the background, `--ink-1` the pane, `--ink-2` the surface, `--ink-3` the alternate surface, `--ink-4` the strong chip, `--line` the border and `--line-soft` the hairline.

## The 3D studio

The viewport behind the model follows the theme. A `scene` block sets its colors; every key is optional and derived when absent. A dark theme gets a dark studio built from its surfaces. A light theme gets a light studio: a pale gradient, darker floor lines and dark edges, so the model still reads.

| Key | What it colors | Derived on a dark theme | Derived on a light theme |
| --- | --- | --- | --- |
| `top` | Backdrop gradient, top edge | `surface` | `mix(background, white, 0.55)` |
| `bottom` | Backdrop gradient, bottom edge | `mix(background, black, 0.2)` | `mix(surfaceAlt, border, 0.6)` |
| `glow` | Soft glow behind the model | the strong chip | `mix(white, background, 0.25)` |
| `plate` | Side of the build plate | the strong chip | `mix(border, text, 0.18)` |
| `grid` | Floor grid lines | secondary text | `mix(border, text, 0.45)` |
| `edge` | Outline of the model's edges | `mix(background, black, 0.45)` | `mix(text, black, 0.15)` |
| `xray` | Edges in x-ray mode | the built-in default | `mix(accent, text, 0.4)` |

The bundled theme files spell their scene block out, so you can copy one and change it. Model, toolpath and gizmo colors do not change with the theme.

## Contrast rules

- Text (main, secondary, dim) reaches 4.5:1 on the background and the surface, in every bundled theme. A test checks it, with each color vision setting too.
- Glyph colors (status colors, the accent on a light theme) reach 3:1.
- With Higher contrast, secondary and dim text reach 7:1 and glyph colors and the accent 4.5:1. The same test checks it.
- If a theme misses these, the derived shades are lifted, so the app stays readable. Your base `text` is never changed, so give it enough contrast.

## Make a theme

1. Copy `packages/ui/themes/subban-dark.json` or `subban-light.json` and give it a new `id` and `name`. Give your light and dark files the same `family` to show them as one card.
2. Change the base colors. Start with `background`, `text` and `accent`; set `surface`, `surfaceAlt` and `border` a little lighter than `background` on a dark theme, a little darker on a light one.
3. Fill `ansi` from your terminal theme if you have one.
4. Import the file in Settings, or put it in the themes folder.
5. Check the warnings the import shows. A low contrast warning means `text` is too close to a background.

To share a theme, send the file. Set `credit` if the palette is someone else's.

## Example

```json
{
  "$schema": "./schema.json",
  "version": 1,
  "id": "my-light",
  "name": "My light",
  "family": "mine",
  "familyName": "Mine",
  "isDark": false,
  "background": "#f7f6f3",
  "surface": "#efede8",
  "surfaceAlt": "#e8e5df",
  "border": "#d9d5cd",
  "text": "#2a2833",
  "muted": "#77737f",
  "accent": "#7349c9",
  "selection": "#ddd3f3",
  "ansi": [
    "#2a2833",
    "#931d27",
    "#2b7536",
    "#9a6b00",
    "#3a67c8",
    "#a3378b",
    "#1f7a86",
    "#77737f",
    "#5d5a66",
    "#d0343c",
    "#3a9447",
    "#b58300",
    "#4f7fe0",
    "#bd4ca3",
    "#2b95a3",
    "#a9a5b0"
  ],
  "working": "#2b7536",
  "waiting": "#c8661b",
  "failed": "#931d27"
}
```
