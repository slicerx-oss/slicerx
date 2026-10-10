# Changelog

All notable changes to `@slicerx/embed` are listed here. The format follows Keep a Changelog, and the package uses semantic versioning (0.x: a breaking change bumps the minor version).

## [Unreleased]

### Fixed

- `Viewport` no longer forces `quality="high"`: its default is `auto`, which lets the viewport pick `low` without ambient occlusion on a weak or software GPU. A host's `quality` still overrides it.
- `<sx-viewport>` fills the element's height again; the view stopped at 240 px inside its theme wrapper.
- `tokenKeys` sends a publishable key (`sb_publishable_`) only as `apikey`, since it is not a JWT; the account token stays in the body. A legacy anon JWT is still also sent as the bearer.

### Changed

- `decodeStl` and `<sx-viewport src>` color a plain STL white PLA (`#ebebe6`) instead of the accent purple, which hid the selection outline. Picking rotate or scale with one object on the plate and nothing selected selects it, so its handles show.
- The default theme is now called Subban: `subban` and `subbanLight` replace `nocturne` and `nocturneLight`, which stay as deprecated names for the same themes. Subban light uses a new pale violet palette.

### Added

- Prepare tools in `Viewport` and `<sx-viewport>`: `tools` puts a toolbar over the view with select, move, rotate, scale, arrange and drop to bed (keys M, R, S and A). Move shows X, Y and Z arrows on the selected model, each a drag along its axis, Z stopping at the bed. `tool`, `selection`, `onToolChange`, `onSelect` and `onTransform` (`tool`, `select` and `transform` events on the element), and `arrange()` and `dropToBed()` on the element.
- `reveal: 'each-plate'` (`reveal="each-plate"`) plays the plate reveal for every new plate; `playReveal()` on the element plays it on demand.
- `bedOutline: 'subtle'` (`bed-outline="subtle"`): a faint hairline bed outline without the glow.
- `look="cad"` on `<sx-viewport>`.

- `LocalAiSetup` and `useLocalAi`: Set up local AI as one piece or a hook, themed like the other pieces, with the models an edition allows.

- The pre-alpha agreement for apps that build SlicerX in: `Agreement` (React) and `<sx-agreement>`, with `agreementNeeded`, `readAgreement` and `acceptAgreement`, which records the version and date. `RELEASE` gives the release stage and the bug reports link to pass through. The version is the app's, so both ask again at the same time.
- The theme API without a second package: `createTheme`, `nocturne`, `nocturneLight`, `themeToCss` and the `Theme` types.
- The 3D scene follows the surrounding theme (its accent, and a light studio for a light theme). `<Viewport sceneTheme>` and the `sceneTheme` property of `<sx-viewport>` set any scene, toolpath or heat ramp color.
- `toolColors` on `Viewport` and `<sx-viewport>`: the filament color per slot.
- A `theme` property on the elements that takes a full theme. `<Viewport onError>` and an `error` event on `<sx-viewport>` for crash reports.
- The module can be imported where `HTMLElement` does not exist, such as a server render.
- `@slicerx/embed/sxlock`: `openSxlock`, `sealSxlock`, `readSxlockHeader` and `tokenKeys` (open with `sxlock_open`, lock with `sxlock_seal`) for locked projects (`.sxlock`), `lockSxlock`, `unlockSxlock` and `resealSxlock` for copies of an open locked file, and `SxlockError` with a code and a message for each refusal.
- Packaging for npm: a library build (`dist/index.js`, `dist/mesh.js`) with React, zod and `@slicerx/viewport` external and the settings schema bundled, and self-contained type declarations.
- `<Viewport>`: `@slicerx/viewport` as a React component (plate, SXPV preview, look, color mode, layer, view, pick events).
- `<SettingsPanel>`: Easy and Advanced settings over `@slicerx/settings`, reporting the resolved Orca config on every change.
- `defineSlicerXElements()`: the same two pieces as `<sx-viewport>` and `<sx-settings-panel>` custom elements, each in its own shadow root.
- `decodeStl` and `decodeQuantized` model decoders (`@slicerx/embed/mesh`).
- `EmbedTheme` and a `theme` attribute on both elements (`dark` or `light`); any `@slicerx/ui` theme works with the React pieces.
