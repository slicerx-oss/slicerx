# @slicerx/ui

Shared presentational React UI for web, desktop and mobile: the Nocturne tokens, the 368 icons and the logo, and the primitives. Plain CSS with custom properties, `sx-` prefixed class names, no data fetching, no app state.

`viewport/` is a separate package (`@slicerx/viewport`) that owns the 3D render loop.

## Setup

```ts
// once, at the app root (Vite) or in app/layout.tsx (Next)
import '@slicerx/ui/styles.css'   // pulls in tokens.css, the reset, focus and reduced motion rules
```

Fonts: link `FONTS_HREF` (exported) in the document head, or self-host the same three families.

The package ships TypeScript source (`exports` points at `src/index.ts`). Vite consumes it as is. Next.js needs `transpilePackages: ['@slicerx/ui']` in `next.config.ts`.

## Public API

Tokens

- `tokens.css`: `--ink-0..4`, `--line`, `--line-soft`, `--fg`, `--muted`, `--dim`, the seven colors, `--grad`, `--on-grad`, tints (`--purple-tint`, `--pink-tint`, `--purple-ring`, `--glass`), type (`--f-display`, `--f-body`, `--f-mono`, `--fs-xs..title`), spacing (`--s-1..8`, `--gutter`), radius (`--r-xs..lg`, `--r-pill`), control heights (`--h-sm/md/lg/bar/status`, `--w-rail`, `--w-side`), shadows, motion (`--t-fast/base/slow`, `--ease`), z-index (`--z-*`).
- `BRAND` (`name` SlicerX, `tagline` "The AI-ready slicer", `pilot` "mimir", `printers` "Printers"): use these, never retyped strings.
- `@slicerx/ui/icons` is a React-free entry with `ICON_PATHS`, `ICON_GROUPS`, `IconName`, `ICON_VIEWBOX`, `ICON_STROKE`, and the mark geometry (`MARK_PATH`, `MARK_VIEWBOX`, `markBars()`), for native renderers.
- `@slicerx/ui/theme` is the same theming API with no React import, for Node tools and servers.
- `NOCTURNE` (hex values for canvases and WebGPU), `NOCTURNE_VARS`, `ROLE` (which color means what), `FONTS`, `FONTS_HREF`, `MOTION`, `readToken(name)`, `prefersReducedMotion()`.

Theming (see THEMING.md)

- `Theme` type, `nocturne` (default), `nocturneLight`, `forge` (example rebrand), `themes`.
- `createTheme(overrides, base?)`, `themeToVars()`, `themeToCss()`, `applyTheme()`, `clearTheme()`, `onThemeChange()`, `resolveColor()`.
- `<ThemeProvider theme icons logo scope>` and `useTheme()`. Runtime switching needs no reload; the server render emits the variables.

Icons and brand

- `<Icon name size label />`, `IconName`, `ICON_PATHS`, `ICON_GROUPS`, `ICON_COUNT`, `isIconName()`. Decorative unless `label` is set.
- 368 icons in 23 groups: Workspace, Slicing, Plate tools, Hardware, Creators, Library, mimir, Interface, Materials, Calibration, Sensors, Devices and cloud, Integrations, Views, Actions, Printers, Nozzle, Filament, Multi-material, Bed, Connect, Controls, Community. All are drawn on a 24px grid for a 1.75 stroke with round caps and joins in `currentColor`, with no fills except small dots. The base 68 live in `icons/base.mjs`, the rest in `icons/extra.mjs` and `icons/hardware.mjs` (printer types, nozzles, filament, units, plates, connections, controls, community); `icon-paths.ts` is generated from all three.
- `<MakerTile maker size label />`: neutral lettermark tile for the 12 printer makers in `MAKERS`; no maker artwork (see packages/brand-icons/LOGOS.md).
- `<Mark size from to />` the layered X. `<Logo size="md|lg|xl" href tagline />` the "Slicer" wordmark plus mark; `tagline` adds "The AI-ready slicer" under it for splash, about and the site footer.

Primitives (each takes `className`; every control needs an `id`)

- `<Button variant="default|primary|ghost|danger" size="sm|md|lg" icon iconEnd full pressed />`, `<ButtonLink href />`, `<LinkButton expanded />`. One `primary` per screen.
- `<Chip tone="neutral|vault|free|purple|pink|cyan|green|orange|red" icon mono />`, `<Pill state="ok|run|warn|bad|off" />`, `<Kbd />`, `<Eyebrow />`.
- `<Input id mono unit icon size />`, `<Textarea id />`, `<Select id />`, `<Field htmlFor label aside hint error />`.
- `<Range id value min max step onChange label unit ticks />` slider with a filled track.
- `<Seg label value onChange options=[{value,label,icon,title}] size full mono />`, `<Switch id checked onChange tone />`, `<SwitchRow id label detail />`.
- `<MenuAnchor>` + `<Menu open onClose label align static>` with `<MenuItem icon aside checked tone />`, `<MenuHeading />`, `<MenuSeparator />`.
- `<Dialog open onClose title footer splitFooter size required />` on the native dialog element.
- `<CommandPalette open onClose query onQueryChange groups onSelect footerRight />`. The app filters; the palette renders, tracks the active row and handles keys.
- `<Panel edge>` with `<Block title aside expanded onExpandedChange id />` and `<KeyValues items />`.
- `<Rail side label collapsed onCollapsedChange items onSelect peekOnHover dropActive footer>`: the collapsible icon-rail sidebar. Glows on the inner edge as the pointer nears it (`useEdgeGlow`), peeks open on hover intent as an overlay, glows pink with `dropActive`. The parent remembers the collapsed state per workspace.
- Shell: `<Frame bar status>`, `<AppBar homeHref right>`, `<Tabs tabs active onChange />`, `WORKSPACE_TABS`, `<SearchButton onClick />`, `<Avatar initials />`, `<StatusLine items right />`.
- `<ToastProvider>` and `useToast()(message, { tone, duration })`.
- Hooks: `useEdgeGlow(ref, { side, reach })`, `useDismiss(ref, active, onDismiss)`.

Helper classes: `sx-mono`, `sx-display`, `sx-eyebrow`, `sx-dim`, `sx-muted`, `sx-small`, `sx-hairline`, `sx-kbd`, `sx-overlay`, `sx-main`.

## Rules for consumers

- No hex values in component styles; use the variables. No copied CSS from elsewhere.
- Purple is accent, selection and focus. Pink is creators, commerce and Vault. Cyan is progress and live data. Green ok, orange attention, red error. Buttons, tabs, chips and focus rings use solid colors; `--grad` belongs to the layered X mark and at most one hero moment per surface.
- No gradient text, no blur or glass panels, no outer glows, no decorative badges or sparkles. The rail's edge light is the one pointer-driven highlight and it stays faint.
- The AI sub-brand is mimir in every label (tab, chips, copy). The tab id stays `pilot`. The printers workspace is "Printers" (id `printers`, printer icon); the fleet icon marks a user-made group of printers.
- Works at 390px: no horizontal scroll, 16px gutter. Tab labels hide under 560px; a collapsed rail hides under 900px.

## Gallery

`import { Gallery, GALLERY_CSS } from '@slicerx/ui/gallery'` renders every primitive in a realistic state. Mount it on a dev-only route (`<Gallery palette />` shows the command palette open) and put `GALLERY_CSS` in a style tag.

## Scripts

- `pnpm gen:icons` regenerates `src/icons/icon-paths.ts` (the full table), `src/icons/icon-names.ts` (the names) and `src/icons/icon-startup.ts` from `icons/base.mjs`, `icons/extra.mjs` and `icons/hardware.mjs`. It fails if a name is drawn twice, if a group lists a name with no drawing, if a drawing is in no group, or if `icons/startup.mjs` lists an icon that is not drawn.
- Only the icons in `icons/startup.mjs` load with the web shell. `Icon` draws any other as an empty box of its size until the full table, a chunk of its own, has loaded (when the page is idle, or at the first such icon); `iconsReady()` resolves once it has. The web build (apps/web/scripts/bundle-size.mjs) fails when a startup chunk names an icon missing from `icons/startup.mjs`, and apps/web/e2e/icons.spec.ts checks that the first frame of each workspace draws every icon without the full table. To use a new icon at startup, add it to `icons/startup.mjs` and run `pnpm gen:icons`.
- `node scripts/icon-sheet.mjs <out.html>` writes a contact sheet of every icon at 24px and 48px for review.
- `pnpm test` (vitest): token parity with the `nocturne` theme, icon parity with `icons/base.mjs`, icon markup limited to plain shapes inside the 24px grid, no hard-coded color or font in any component, theme merging and runtime switching, and a server render of every primitive. `GALLERY_OUT=<dir> pnpm test` also writes `gallery.html`, `gallery-palette.html`, `gallery-light.html` and `gallery-forge.html` for review screenshots.
- `pnpm typecheck`.

Dependencies: `react` and `react-dom` 19.3.0 as peers (dev copies for tests), `@types/react`, `@types/react-dom`, `vitest` 5.0.2 for the tests, `playwright` 1.63.0 for `scripts/shot.mjs` (headless screenshots of a running app for design review).

## Not yet built

Drag and drop wiring on `Rail` (only the `dropActive` styling exists) and a tooltip primitive.
