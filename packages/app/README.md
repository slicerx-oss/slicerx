# @slicerx/app

The SlicerX application, shared by the browser and desktop builds. It talks only to a `Host` and never imports a platform package.

- Base: the first tab (Model in the SlicerX style, Prepare in the Bambu and Orca styles) and Preview (one viewport, two sets of side panes), the Library of files on this device and built-in example models, Easy and Expert settings, the command bar, the approval dialog, and About with the link to this build's source.
- Features plug in through `AppFeature` modules. This package ships two, each its own entry point: `@slicerx/app/features/fleet` (the Printers workspace, fleets as optional printer groups, send, pause and resume) and `@slicerx/app/features/pilot` (mimir, and free text from the command bar). A feature shows only when every `Host` member it needs exists. Other features, such as a store, register the same way from outside this package and use only its public entry point.
- State: one small client store for what the user is doing, TanStack Query for printer and catalog data, Zod on everything read back from storage.
- UI comes from `@slicerx/ui`; `src/styles/app.css` only lays out the workspaces. Pass `theme` to rebrand, or let the user pick light or dark.
- The viewport is `@slicerx/viewport`, driven by store subscriptions and never re-rendered by React. Without WebGL2 a flat 2D view shows the plate and the toolpaths.

## API

```ts
<SlicerXApp host={host} features={[fleetFeature, pilotFeature]} theme={myTheme} />
useHost(), setWorkspace(id), toast(text, tone?), openModelBytes(host, name, bytes)
registerCommand(spec), searchCommands(query), runCommand(id, input?), commandTools()  // mimir sees tool commands as app.<id>
setVendorMarks(render)  // optional printer brand artwork, registered by an app entry
DEMO_MODELS, LayerArt, Swatch
```

Shortcuts: Cmd+K (Ctrl+K) command bar, Cmd+1 to Cmd+6 workspaces, Cmd+B and Cmd+Alt+B sidebars, Cmd+Enter slice, Cmd+E export G-code, Cmd+O open a model, ? for the full list.

Dependencies: react and react-dom 19.3.0, @tanstack/react-query 5.104.0, @tanstack/react-virtual 3.14.13, zod 4.6.5, zustand 5.0.15; for tests vitest 5.0.2, jsdom 30.1.1 and @testing-library/react 16.3.3. All MIT.

## Tests

`pnpm --filter @slicerx/app test`: fuzzy ranking, the command registry (at least 30 built-in commands, disabled and unknown commands refused, the tool names mimir sees), filtering 500 commands in under 16 ms per keystroke, and stored preferences surviving corrupt or hostile values.

## Status

Working in the browser build: the example plate in the first tab, slicing on the WASM worker pool, Preview with layer and move sliders and five color modes, the Printers workspace with fleets, sending a plate through the approval dialog, and mimir with the demo model. Not yet: 3MF files slice but do not show in the viewport, and the desktop app still uses the browser's printer and approval code.

Contributions: see CONTRIBUTING.md at the repository root.
