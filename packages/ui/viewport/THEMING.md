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

`features` is keyed by the SXPV feature id. `heatRamp` takes two to eight stops, low to high. `toolColors` are used until the app calls `setToolColors`.

`setTheme` throws an `Error` that lists every invalid color, so a bad theme fails loudly. `themeProblems(theme)` returns the same list without throwing, for settings screens. Build legends from `resolveTheme(theme)` (from `@slicerx/viewport/palette`) so swatches match what the scene draws.

Keep the roles apart: selection and live layer are not toolpath colors, and red and amber on the overhang map mean overhang. Clay, overhang and edge materials are shared by every viewport on the page, so a page has one theme for them.

## Camera and mouse controls

`createViewport(canvas, { controls: 'bambu' })` or `vp.setControls('prusa')`. Ids: `slicerx`, `bambu-studio`, `prusaslicer`, `orcaslicer` (the LookId values). Pass a `ControlsMap` for your own bindings.
