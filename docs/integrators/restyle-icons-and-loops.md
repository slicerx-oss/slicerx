# Restyle tool icons and tooltip loops

An edition can recolor the Model ribbon, tooltip loops and viewport constraint glyphs through `brand.theme`. Set shared values in `tokens.visuals`, then override them in `light.visuals` and `dark.visuals`. No stylesheet or entry-point edit is needed.

This guide is for a source checkout. Follow [Building your own edition](../integrating.md) for the product name, artwork, identifiers and build prerequisites.

## Set light and dark colors

In an existing, valid `editions/harbor/edition.config.ts`, set this part of `brand`:

```ts
theme: {
  base: 'subban',
  tokens: { visuals: { '--ti-nd': '#fff8e7' } },
  dark: {
    visuals: {
      '--accent': '#7fd4c5',
      '--ti-a1': '#ffca80',
      '--ti-sk': '#8be9e0',
      '--stage-a1': '#8dc8ff',
      '--stage-a2': '#428bbc',
      '--stage-a3': '#28577a',
      '--stage-aol': '#112b3d',
      '--glyph-picked-line': '#142d28',
      '--glyph-picked-edge': '#9de3c8',
      '--glyph-picked-halo': '#9de3c8',
    },
  },
  light: {
    visuals: {
      '--accent': '#146676',
      '--ti-a1': '#aa4900',
      '--ti-sk': '#09665e',
      '--stage-a1': '#9dcefa',
      '--stage-a2': '#1e6093',
      '--stage-a3': '#17476c',
      '--stage-aol': '#102f46',
      '--glyph-picked-line': '#0c6b55',
      '--glyph-picked-edge': '#173c31',
      '--glyph-picked-halo': '#ffffff',
    },
  },
},
```

The order is the selected theme, shared edition tokens, active light or dark edition values, then the look preset with edition visual overrides reapplied. An explicit `visuals['--accent']` wins over the preset's accent choice. Omitted values keep their defaults. Switching modes removes overrides that the next mode does not define.

`brand.colors` names colors for generated models. It does not set the interface palette. Individual `--ti-*` and `--stage-*` properties also do not belong in `tokens.colors`: the schema accepts arbitrary color names, but the renderer maps only the known theme color keys to CSS.

Use six-digit hex colors. Visual tokens other than `--accent` also accept two alpha digits, such as `#ffffffd9`. The accent stays opaque because it also colors new objects and scene selection. Unknown visual token names and non-color values are rejected. Config validation checks syntax, not contrast.

`tokens.colors` still sets the ordinary theme palette; `light.colors` and `dark.colors` can vary it by mode. Existing `tokens.colors.purple` configurations keep working. Without an explicit visual accent, the look preset selects the accent from those palette colors as before. Fonts, font files and radii remain shared under `tokens`.

For a host that applies themes directly, pass the same properties as `visuals` to `createTheme`:

```ts
import { applyTheme, createTheme, subbanLight } from '@slicerx/ui'

applyTheme(createTheme({
  visuals: { '--accent': '#146676', '--ti-sk': '#09665e', '--stage-a1': '#9dcefa' },
}, subbanLight))
```

Apply the new theme when your host switches modes. Values are set at the document root by default, so tooltip portals inherit them. The edition app does this automatically. Keep the generated icon files unchanged.

## Tool icon tokens

Defaults come from [`packages/ui/src/tokens.css`](../../packages/ui/src/tokens.css). In this table, `mix(A, p, B)` means `color-mix(in srgb, A p%, B)`, and a name beginning with `--` means `var(--name)`. These are formulas, not fixed screenshots: changing the underlying palette changes their resolved values.

| Token | Role | Dark default | Light default |
| --- | --- | --- | --- |
| `--accent` | Shared selection, focus and action accent | `--purple` | `--purple` |
| `--ti-t1` | Light neutral face | `mix(--fg, 70, --muted)` | `mix(--ink-0, 25, white)` |
| `--ti-t2` | Middle neutral face | `mix(--muted, 92, --ink-4)` | `mix(--fg, 18, --ink-0)` |
| `--ti-t3` | Dark neutral face | `mix(--muted, 52, --ink-4)` | `mix(--fg, 42, --ink-0)` |
| `--ti-ol` | Neutral contour and node border | `mix(--ink-0, 62, black)` | `mix(--fg, 88, --ink-0)` |
| `--ti-a1` | Light accent face | `mix(--accent, 82, white)` | `mix(--accent, 62, white)` |
| `--ti-a2` | Middle accent face | `mix(--accent, 86, --ink-0)` | `--accent` |
| `--ti-a3` | Dark accent face | `mix(--accent, 64, --ink-0)` | `mix(--accent, 78, --fg)` |
| `--ti-aol` | Accent contour | `mix(--accent, 18, --ti-ol)` | `mix(--accent, 40, --fg)` |
| `--ti-hl` | Cavity fill | `mix(--ink-0, 80, black)` | `mix(--fg, 82, --ink-0)` |
| `--ti-sk` | Accent sketch stroke and filled sketch pixels | `--ti-a1` | `--ti-a2` |
| `--ti-sg` | Secondary sketch stroke and filled pixels | `--ti-t2` | `--ti-t3` |
| `--ti-nd` | Vertex node fill | `white` fallback | `white` fallback |
| `--ti-hi` | Declared highlight token, unused by the current tool icon renderer | `rgba(255, 255, 255, 0.42)` | `rgba(255, 255, 255, 0.85)` |
| `--ti-sh` | Declared shadow token, unused by the current tool icon renderer | `rgba(12, 10, 26, 0.13)` | `rgba(40, 28, 78, 0.09)` |
| `--ti-sh3` | Declared secondary shadow token, unused by the current tool icon renderer | `rgba(12, 10, 26, 0.08)` | `rgba(40, 28, 78, 0.06)` |

`--ti-nd` has no declaration in the default token sheet; the icon stylesheet supplies its white fallback. The default dark palette has `--purple: #bd93f9`; the bundled light theme starts from accent `#7542bd`. A selected theme or edition override can change those colors.

The icon classes use these variables for fills and contours. At 32 and 24 px, sketch paths use a 2 px primary stroke, 1 px secondary stroke and 1.5 px general line. The 16 px drawings use filled whole pixels instead of scaling those strokes down. [The icon stylesheet source](../../packages/ui/icons/tool/css.mjs) defines the mapping.

## Tooltip stage tokens

Tooltip loops render inline SVG and inherit the root's CSS variables. A theme switch recolors the same drawing. They do not need separate light and dark image files.

| Token | Role | Dark default | Light default |
| --- | --- | --- | --- |
| `--stage-t1` | Light neutral face | `#d6d8e4` | `#ffffff` |
| `--stage-t2` | Middle neutral face | `#9da1b6` | `#cfccd9` |
| `--stage-t3` | Dark neutral face | `#6c7086` | `#9b97a8` |
| `--stage-ol` | Neutral contour and cavities | `#1a1b24` | `#36333f` |
| `--stage-a1` | Light accent face and highlights | `mix(--accent, 72, white)` | `mix(--accent, 78, white)` |
| `--stage-a2` | Middle accent face | `mix(--accent, 88, black)` | `--accent` |
| `--stage-a3` | Dark accent face | `mix(--accent, 64, black)` | `mix(--accent, 80, black)` |
| `--stage-aol` | Accent contour | `mix(--accent, 22, black)` | `mix(--accent, 40, black)` |
| `--stage-cut` | Removed material and cut readouts | `--red` | `--red` |
| `--stage-pill` | Readout background | `#16171e` | `#2d2834` |
| `--stage-pill-text` | Readout and keycap text | `#f8f8f2` | Same |
| `--stage-pill-line` | Readout border | `rgb(255 255 255 / 18%)` | Same |
| `--stage-grid` | Grid | `--scene-grid`, else `#5a5e74` | `--scene-grid`, else `#8b8395` |
| `--stage-ptr` | Pointer fill | `white` | Same |
| `--stage-ptr-line` | Pointer contour | `#111218` | Same |

An explicit `--stage-grid` overrides the grid independently of the scene. Without one, the SVG reads `--scene-grid` in its own scope, then the internal `--stage-grid-fallback` value shown above. The frame's background uses `--scene-top` and `--scene-bottom`, with `--ink-2` and `--ink-0` as fallbacks. Its border uses `--line-soft`.

The stage has some fixed details: the pointer shadow is black at 35% opacity, the click ripple is white, and keycaps mix white with transparency. The token table does not promise control over those details. See [the stage renderer](../../packages/ui/src/components/tooltip-stage-svg.ts) and [frame styling](../../packages/ui/src/styles.css).

## Viewport sketch glyphs

The sketch symbols inside ribbon icons follow `--ti-sk` and `--ti-sg`. Viewport constraint glyphs use the properties below. Their defaults follow the studio background's lightness, which may differ from the interface scheme in a custom theme. Explicit edition overrides follow the selected light or dark scheme. [`glyphInk`](../../packages/ui/viewport/src/cadtools.ts) redraws the existing textures when the colors change.

| Token | Glyph part | Dark studio default | Light studio default |
| --- | --- | --- | --- |
| `--glyph-line` | Unpicked line | `#f8f8f2` | `#282a36` |
| `--glyph-picked-line` | Picked line | `#191a21` | `#8f6a00` |
| `--glyph-node` | Unpicked node ring | `#191a21` | `#282a36` |
| `--glyph-picked-node` | Picked node ring | `#191a21` | `#282a36` |
| `--glyph-center` | Node center | `#ffffff` | `#ffffff` |
| `--glyph-halo` | Unpicked halo | `rgba(25, 26, 33, 0.85)` | `rgba(255, 255, 255, 0.85)` |
| `--glyph-picked-edge` | Picked halo beside a lit pixel | `#f1fa8c` | `#282a36` |
| `--glyph-picked-halo` | Picked halo at a corner | `#f1fa8c` | `rgba(255, 255, 255, 0.85)` |

Dark selection puts dark strokes inside a gold halo. Light selection uses a darker gold line with a dark contour beside lit pixels and a white halo at corners, so selection remains visible without color. The shared selected sketch geometry and dimension color is `#f1fa8c` in dark and `#b8860b` in light; the picked light glyph deliberately uses its own darker `#8f6a00`.

Leave the properties unset to retain these defaults, including when the studio changes. A direct `@slicerx/viewport` host can pass the corresponding `ViewportTheme.glyphs` keys: `line`, `pickedLine`, `node`, `pickedNode`, `center`, `halo`, `pickedEdge` and `pickedHalo`. Preserve the 16 by 16 pixel grid, the one-pixel halo, distinct node centers and the unchanged footprint when picked.

## Keep the geometry and behavior

- Keep text at least 4.5:1 against its background, and meaningful non-text controls and glyphs at least 3:1. Measure the resolved colors against the surfaces they touch, including selected and hover states. The bundled-theme contrast tests do not validate your edition overrides.
- Use the tool icon's native 32, 24 or 16 px variant. Keep the 16 px variant on whole pixels. Stretching it with CSS loses the pixel grid. Preserve accessible labels and focus rings.
- Keep the ribbon docked and flat, with its bottom divider. Its body heights are 83, 74 and 36 px for Large, Medium and Small, with a 28 px tab row. Hover, selection and tab changes must not move controls.
- Keep the demo tooltip 320 px wide and the stage aspect ratio 296:166. The standard loop lasts 3.5 seconds and uses the completed frame at 1.6 seconds while paused or under reduced motion. Preserve the tooltip text, reduced-motion behavior and transparent SVG ground.
- Check a 390 px viewport as well as desktop. Keep the tooltip within the viewport and its text readable. Recoloring should not alter layout, hit areas or animation timing.
- Keep the "Made possible by SlicerX" credit in About, linked to https://slicerx.app/support.

## Build and check

From the repository root, with the edition and its artwork already present:

```sh
node packages/edition-config/src/cli.ts check editions/harbor/edition.config.ts
pnpm edition:build editions/harbor/edition.config.ts --target web
pnpm --filter @slicerx/web exec vite preview --host 127.0.0.1 --port 5308
```

`--skip-wasm` is available on `edition:build` only when the required WebAssembly outputs have already been built. For a desktop release, use `--target desktop` instead of `--target web`.

For a web build without browser slicing, set `SLICERX_WEB_SLICING=0`. With the geometry WebAssembly output already present, you can use `--skip-wasm` while checking colors.

Open the preview URL printed by Vite. Select Model, try all three ribbon sizes, and open a tooltip with a loop. Compare the default edition and your edition in light and dark at 1440 px, then check a loop at 390 px. Inspect the root's `data-scheme`, `data-sx-theme` and computed `--ti-sk` / `--stage-a1` values if a color did not change. Check both moving and reduced-motion presentations.

For the covering source checks:

```sh
pnpm --filter @slicerx/edition-config exec vitest run test/theme-tokens.test.ts
pnpm --filter @slicerx/ui exec vitest run test/tool-icons.test.tsx test/theme-visuals.test.ts test/themefile.test.ts
pnpm --filter @slicerx/viewport exec vitest run test/cadtools.test.ts
pnpm --filter @slicerx/app exec vitest run test/edition-theme-tokens.test.ts test/demo-loop.test.ts test/ribbon-layout.test.ts
pnpm --filter @slicerx/web exec playwright test e2e/edition-theme-tokens.spec.ts e2e/model-ribbon.spec.ts e2e/tips.spec.ts --project=desktop --retries=0
```

The browser tests use the repository's [Playwright configuration](../../apps/web/playwright.config.ts), which builds a fresh test bundle and runs a native slicing host. Build a real `sx` with `cargo build --release -p sx-cli` and set `SX_CLI_BIN` to its absolute path (`target/release/sx.exe` on Windows). Keep the required geometry WebAssembly output in place. Set `SLICERX_CONFIG` to the absolute edition configuration path when running the tests against your edition.

The edition-color browser spec also needs a real `sx-link` (`cargo build --release -p sx-link`); set `SX_LINK_BIN` to that executable and `SX_LINK_REQUIRE=1`. It opens a temporary hub, grants a read client access, checks MCP read-back and saves desktop and 390 px screenshots in the Playwright results. To check your exact overrides, pass a JSON edition file in `SLICERX_CONFIG`; resolve a TypeScript config with `node packages/edition-config/src/cli.ts resolve <config>` first. The other specs cover the default control geometry and tooltip behavior.

The open app's `slicerx_app_look` response includes `theme.scheme`, `theme.visuals` (active CSS property values) and `theme.overrides` (shared and active edition values). A missing glyph property means the renderer uses the studio-dependent default above. This is read-only; recoloring comes from your build configuration. Keep screenshots of the actual edition build alongside the results: passing tests alone does not prove your custom palette's contrast.
