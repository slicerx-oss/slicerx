# @slicerx/embed

SlicerX pieces for other apps: the 3D viewport and the print settings panel, as React components and as custom elements for pages without React. It depends on `@slicerx/viewport`, `@slicerx/settings`, `@slicerx/ui` and `@slicerx/contracts` only. The package follows semver; every change is listed in `CHANGELOG.md`.

## Install

```sh
npm install @slicerx/embed react react-dom three
```

ES modules for the browser, with type declarations. React 19 and `three` 0.186 are peer dependencies: React for the components and inside the custom elements, three for the viewport. `@slicerx/viewport` comes along as a dependency. The settings schema and Easy mode it needs are bundled in.

## API

```tsx
import { Viewport, SettingsPanel, EmbedTheme, defineSlicerXElements, injectStyles } from '@slicerx/embed'

injectStyles() // once, on a page that does not load @slicerx/ui

<EmbedTheme theme="light">
  <Viewport plate={plate} preview={sxpvBytes} look="studio" colorMode="feature" layer={120} onPick={(e) => ...} onReady={(vp) => ...} />
  <SettingsPanel config={baseConfig} mode="easy" onChange={({ easy, overrides, config }) => ...} />
</EmbedTheme>
```

- `Viewport` props: `plate`, `preview` (SXPV bytes or parsed buffers), `look` (`studio`, `clay`, `xray`, `overhang`, `filament`, `cad`), `colorMode` (`feature`, `tool`, `speed`, `flow`, `layerTime`), `layer` (top visible layer, 1-based), `view` (`iso`, `top`, `front`, `fit`), `quality`, `onPick`, `onReady` (the live viewport handle), `label`, `className`, `style`.
- `SettingsPanel` props: `config` (a base profile; schema defaults when omitted), `easy`, `mode` (`easy` or `advanced`), `onChange`, which receives the Easy values, the Advanced overrides and the resolved config keyed by Orca setting names.
- `EmbedTheme` takes `dark`, `light` or any theme made with `createTheme` (exported here), and themes only its children. The 3D scene follows it: the accent marks the selection, and a light theme gets a light studio. `sceneTheme` on `Viewport` sets any scene, toolpath or heat ramp color on top.
- `Viewport` also takes `toolColors` (the filament color per slot, for `colorMode="tool"`) and `onError`, called when the 3D view cannot start or fails.
- Plain STL files open in white PLA (`#ebebe6`), so the accent selection outline shows on them.
- Prepare tools: `tools` (`true`, or a list of `select`, `move`, `rotate`, `scale`, `arrange` and `drop`) puts a toolbar over the view, with the keys M, R, S and A. With a model selected, move shows X, Y and Z arrows, each a drag along its axis (Z stops at the bed); a drag on the model itself still moves it freely on the plate. `tool` with `onToolChange` and `selection` with `onSelect` control the active tool and the selection; without them the view keeps its own. `onTransform` reports each move, turn, scale, arrange and drop; store the transform when `final` is true. The handle from `onReady` also has `arrange()` and `dropToBed(ids?)`.
- `reveal`: `true` (the default) plays the plate reveal on the first plate, `each-plate` on every new plate (another set of objects), `false` never. `playReveal()` on the handle plays it on demand.
- `bedOutline`: `default` or `subtle`, a faint hairline without the glow, in a color between the accent and the grid, for calm themes.
- `Agreement`, `agreementNeeded`, `readAgreement`, `acceptAgreement` and `RELEASE`: the pre-alpha agreement your app shows before the pieces are first used. See `docs/integrators/AGENTS.md` in the repository.
- `LocalAiSetup` and `useLocalAi`: SlicerX's Set up local AI. It recommends one model for the computer with the reason, finds a running Ollama or LM Studio (or links Ollama's download page through `onOpenUrl`), downloads the model through Ollama after a confirm that shows its size and license, and checks a tool call and the speed. `onReady` receives the model name and its OpenAI-compatible base URL. Props: `theme` (built with `createTheme` from your edition's tokens), `allowedModels`, `hardware` (a native read; the browser shows no graphics memory), `net` (the local requests; fetch by default, refused for anything but 127.0.0.1:11434 and :1234). In a browser page, Ollama must allow the page's origin (`OLLAMA_ORIGINS`); desktop hosts pass `net` from their main process.
- `decodeStl(bytes, name)` and `decodeQuantized(json)` turn model files into viewport parts (also at `@slicerx/embed/mesh`).

### Custom elements

```html
<script type="module">
  import { defineSlicerXElements } from '@slicerx/embed'
  defineSlicerXElements()
</script>
<sx-viewport src="bracket.stl" look="clay" theme="light"></sx-viewport>
<sx-settings-panel mode="advanced"></sx-settings-panel>
```

- `<sx-viewport>`: attributes `src` (an STL file), `look`, `color-mode`, `view`, `layer`, `theme`, `finish` (`matte`, `satin`, `glossy` or `silk`, one for every slot or one per slot), `plate-style` (`grid`, `textured-pei`, `smooth-pei`, `cool`, `engineering`), `tools` (present for every tool, or a list), `tool`, `reveal` (`each-plate` or `off`, read when the element starts) and `bed-outline` (`subtle`); properties `plate`, `preview` (SXPV bytes), `theme` (a full theme), `sceneTheme`, `toolColors` and `selection`; methods `playReveal()`, `arrange()` and `dropToBed(ids?)`; `pick`, `select`, `transform`, `tool` and `error` events.
- `<sx-settings-panel>`: attributes `mode` and `theme`; properties `config` and `theme`; a `change` event with `{ easy, overrides, config }`.
- `<sx-agreement>`: attribute `app-name`, property `theme`, an `accept` event with `{ version, acceptedAt }`.

Each element renders into its own shadow root, so page styles and the pieces do not affect each other.

## Locked projects

`@slicerx/embed/sxlock` opens and makes `.sxlock` files, projects locked to one SlicerX account (format and integrator guide: `packages/sx3mf/SPEC-sxlock.md`). It has no React or DOM dependency and runs in Node 20 and later.

```js
import { openSxlock, sealSxlock, readSxlockHeader, tokenKeys, SxlockError } from '@slicerx/embed/sxlock'

const keys = tokenKeys({ supabaseUrl, anonKey, token }) // the account's sxk_ token: sxlock_open, sxlock_seal or both
const sx3mf = await openSxlock(bytes, keys)            // throws SxlockError with a code and a message to show
const locked = await sealSxlock(sx3mf, keys)
```

Opening needs the network: the content key comes from the account service each time. `unlockSxlock` and `lockSxlock` also return the file's key (a non-extractable CryptoKey, for memory only), and `resealSxlock` writes another copy of that file with a fresh nonce and no network, for autosaves. `readSxlockHeader` reads the owner and key id offline. An app that embeds the whole SlicerX app passes the same keys as `EditionHost.sxlock`.

## Demo

`pnpm --filter @slicerx/embed dev` serves `demo/` on port 5191: a plain page that uses only the two custom elements, with a bracket model generated in the page.

## Status

Both components and both elements work in the demo in Chrome with WebGL2. `pnpm --filter @slicerx/embed test` covers the agreement and the scene theme; `examples/integrator-sample` renders the pieces in a headless browser.

Contributions: see CONTRIBUTING.md at the repository root.

## License

Apache-2.0 (`LICENSE-APACHE`, `NOTICE`; keep the "Made possible by SlicerX" credit). The bundle contains the settings schema and Easy mode from `@slicerx/settings`, and no printer profile data.

Packaging: `pnpm --filter @slicerx/embed pack` builds `dist/` (the library and self-contained declarations) and writes the tarball; pnpm applies `publishConfig.exports` and turns the `workspace:` ranges into versions. Publish with `pnpm publish --access public`; a plain `npm publish` from the folder would ship the workspace manifest, so `prepublishOnly` stops it.
