---
name: theme-embed
description: Use when a developer wants to restyle or rebrand an embedded SlicerX (the viewport, the settings panel or the app UI) to match their product, for example "make SlicerX match our brand colors", "use our font", "light theme for the embed", "add our logo", or asks how SlicerX theming works.
---

# Theme an embedded SlicerX

Deliver a finished theme in one answer. Ask a question only when a required input (the accent color) is missing; otherwise choose sensible values, fix contrast yourself, and say what you chose.

SlicerX components read colors, the gradient, fonts, radii and spacing from CSS variables that a typed theme object sets.

## Steps

1. Collect the brand: accent color, a second color if they have one, light or dark, fonts (and the stylesheet URL that loads them), corner roundness, and the logo.
2. Start from `slicerx_theme_get` for the closest built-in theme: `nocturne` (dark, the default), `nocturneLight`, or `forge` (a full rebrand example).
3. Build the theme with `slicerx_theme_create`: `base`, and `overrides` with `name` (lowercase, dashes), `scheme`, `colors`, `gradient`, `fonts`, `radius` and `spacing`. Keep the color roles: `purple` is the accent (selection, focus, the primary button), `pink` commerce, `cyan` live data, `green` ok, `orange` attention, `red` error. Recolor the hues; do not swap the meanings.
4. Read the contrast report. Fix every pair below its minimum (body text needs 4.5:1) before handing the theme over, and say what you changed.
5. The gradient belongs to the layered X mark and at most one hero moment on a screen. Controls, including the primary button, use the solid accent color. If the user asks for the gradient on buttons, say plainly that you did not put it there and why, and offer the gradient for their logo or one hero area instead.
6. Give the developer the result in the form their page needs. Everything below comes from `@slicerx/embed`, the published package:
   - React: `createTheme(overrides, nocturne)` (or `nocturneLight` as the base for a light theme), then `<EmbedTheme theme={theme}>` around `Viewport`, `SettingsPanel` and `Agreement`. The 3D scene follows the theme; add `scene` colors (`top`, `bottom`, `glow`, `plate`, `grid`, `edge`, all `#rrggbb`) to set the backdrop, or pass `sceneTheme` to `Viewport`.
   - Without React: set the `theme` property of `<sx-viewport>`, `<sx-settings-panel>` or `<sx-agreement>` to the theme object, or use the stylesheet from `themeToCss(theme, selector)`.
   - With `save: true`, the tool writes `<name>.json` and `<name>.css` to the server's output folder.
7. For details, read the theming step of `slicerx://docs/integrators/agents`, then `slicerx://docs/theming-ui` and `slicerx://docs/theming-viewport` for every token.
