# Theming the 3D viewport

The viewport takes a `ViewportTheme` for the scene. Every field is optional and falls back to the SlicerX default. Colors are `#rrggbb`.

```ts
import { createViewport } from '@slicerx/viewport'

const vp = createViewport(canvas, {
  theme: {
    scene: { bgTop: '#1b2430', bgBottom: '#0d1117', selection: '#e0af68' },
    features: { [FEATURE.support]: '#3fb68b' },
    heatRamp: ['#2b6cb0', '#f6e05e', '#dd6b20'],
    toolColors: ['#f7d959', '#1d1d21'],
  },
})

vp.setTheme({ scene: { bgTop: '#ffffff' } }) // switch at runtime
vp.setTheme() // back to the defaults
```

`scene` keys: `bgTop`, `bgBottom`, `bgGlow` (background), `selection`, `selectionHidden` (outline), `liveLayer`, `travel`, `overhangRed`, `overhangAmber`, `overhangBase`, `clay`, `plateSide`, `floorGrid`, `edgeDark`, `edgeXray`, `xrayTint`.

The move, rotate and scale handles take `axisX`, `axisY`, `axisZ` (the axis fills), `axisUniform` (the scale gizmo's corners), `handleHot` (hovered or dragged), `handlePinned` (the handle a held key keeps fixed) and `handleHalo` (a thin outline under every handle). The app reads them from `--axis-x`, `--axis-y`, `--axis-z`, `--axis-uniform`, `--gizmo-hot`, `--gizmo-pinned` and `--gizmo-halo`. Keep every handle color at least 9:1 off `handleHalo`: then the fill or the outline keeps 3:1 against any color behind a handle. With a near black outline that means fills with a relative luminance of about 0.43 or more.

`features` is keyed by the SXPV feature id. `heatRamp` takes two to eight stops, low to high. `toolColors` are used until the app calls `setToolColors`.

`glyphs` recolors sketch constraint pixels: `line`, `pickedLine`, `node`, `pickedNode`, `center`, `halo`, `pickedEdge` and `pickedHalo`. These accept `#rrggbb` or `#rrggbbaa`. Omitted colors retain the existing defaults chosen from the studio background's lightness. Changing them with `setTheme` redraws existing glyph textures. See [edition restyling](../../../docs/integrators/restyle-icons-and-loops.md#viewport-sketch-glyphs) for the defaults and corresponding CSS properties.

`setTheme` throws an `Error` that lists every invalid color, so a bad theme fails loudly. `themeProblems(theme)` returns the same list without throwing, for settings screens. Build legends from `resolveTheme(theme)` (from `@slicerx/viewport/palette`) so swatches match what the scene draws.

Keep the roles apart: selection and live layer are not toolpath colors, and red and amber on the overhang map mean overhang. Clay, overhang and edge materials are shared by every viewport on the page, so a page has one theme for them.

## Camera and mouse controls

`createViewport(canvas, { controls: 'bambu' })` or `vp.setControls('prusa')`. Ids: `slicerx`, `bambu-studio`, `prusaslicer`, `orcaslicer` (the LookId values). Pass a `ControlsMap` for your own bindings.
