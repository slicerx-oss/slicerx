# Look and feel presets

Four presets: SlicerX (default), Bambu Studio style, PrusaSlicer style, OrcaSlicer style. A preset is a control preset only: it changes the camera and mouse controls, the keyboard shortcuts and a tab name or two (Device for Printers in the Bambu and Orca styles, Plater for the first tab in the Prusa style, Model in the SlicerX style where the Bambu and Orca styles say Prepare). Every sentence that points at a tab uses the active look's name through `tabLabel` and `useTabLabel` in `packages/app/src/first-run/look.ts`; the workspace id stays `prepare`. The layout and the look are SlicerX's for everyone, and the theme owns color (docs/themes.md). No logos, artwork, fonts or exact accent colors from those apps are used. Names appear only as "Bambu Studio style" and so on, to say which behavior the preset follows.

First run asks "Which slicer do you use now?" and sets the preset from the answer (docs/first-run.md). Settings > Look and feel changes it later. The research below is the basis for the control and shortcut choices.

## 1. Research

Confidence tags: [src] read in official docs or source, [3p] third-party article or forum, [mem] from memory of screenshots or use, not verified, [none] nothing found. Version notes: Bambu findings come from the master branch of the public repository, Prusa from help.prusa3d.com for 2.9, Orca from the wiki, which already describes builds newer than 2.3.

### Bambu Studio

Controls
- Left drag on empty space rotates. Left drag on an object moves it. [src: GLCanvas3D.cpp on_mouse]
- Right drag or middle drag pans (the wiki says right only). [src, wiki 402 blocked]
- Wheel zooms toward the cursor. Preference `reverse_mouse_wheel_zoom` inverts it. [src]
- Click selects. Ctrl or Cmd+click adds. Shift+left drag box-selects. Alt+click picks a part. Right click opens a context menu. [3p: defkey.com 2.7.1 shortcuts]
- Mac trackpad: pan, pinch and rotate gestures are handled. Windows: Shift+scroll pans. Plain two-finger scroll on Mac is [none]. [src: on_gesture]
- View keys: 0 plate, 1 top, 2 bottom, 3 front, 4 rear, 5 left, 6 right, 7 isometric. Menu accelerators Ctrl+1 to 7 are reported unreliable. [src, 3p forum]
- Prepare keys: M move, S scale, R rotate, C cut, F place on face, I supports, P paint. A arrange, Shift+A arrange selected, Shift+B fill bed. Arrows move 10 mm, Shift+arrow 1 mm. Ctrl+G slice. [3p: defkey.com] Digits 1 to 9 are listed as filament select there, which collides with the view digits above; unresolved.
- Preview: arrows move the sliders (Shift 3x, Ctrl 5x), L toggles layer mode. [3p]

Layout
- Settings sidebar is docked on the left, minimum width 42 em, resizable since 2.2.0.85. Order: printer card with bed card and sync, filament (AMS slots), process. Process has a Global and Objects switch and an Advanced toggle. [src: Plater.cpp AddPane Left]
- Top tabs: Home, Prepare, Preview, Device, Project, Calibration. Slicing switches to Preview. [3p]
- Plate list, layer slider, legend, Slice plate and Print plate button positions: [mem] plates as thumbnails in the viewport, vertical layer slider at the right edge, horizontal slider at the bottom, action buttons at the bottom right. Not verified.

Look
- Corner radius 8, combo height 30 DIP, dividers 1 DIP, title bars 3 em. Light surface near #F8F8F8, one green accent, idle icons mid gray. Dark mode exists but is partly themed. Icon style [none]. [src: code constants, GitHub issues 10513 and 7087]

### PrusaSlicer

Controls
- Left drag rotates, right drag pans, wheel zooms; the scheme is not configurable (open requests: issues 14714, 9931, 6041). Ctrl+left rotates without the cursor over the plater. [src: help.prusa3d.com view_1761; the Ctrl behavior is [3p]]
- Left drag on an object moves it. [mem]
- Views: 0 isometric, 1 top, 2 bottom, 3 front, 4 back, 5 left, 6 right. B zooms to the bed. Z zooms to the selection, or to everything with nothing selected. K toggles perspective and orthographic. E toggles labels. Shift+Tab toggles the sidebar. [src: keyboard-shortcuts_1764]
- Ctrl+click adds to selection. Shift+drag box-selects. Alt+drag box-deselects. Ctrl+A all. Esc deselects. Del deletes. [src]
- M move, R rotate, S scale, F place on face, C cut. A arrange, Shift+A arrange selection. Arrows 10 mm, Shift+arrow 1 mm. Ctrl+R slice, Ctrl+G export G-code. Shift+? lists shortcuts. Tab switches 3D view and Preview. [src]
- Preview: Up and Down move the vertical slider, Left and Right the horizontal slider, L toggles the legend. [src]
- Trackpad: [none]. Zoom to cursor: preference exists, believed on by default [mem].

Layout
- Top tabs: Plater, Print Settings, Filament Settings, Printer Settings, plus a Printables tab in 2.9. Settings live in the separate tabs, not the plater sidebar. [src]
- Right sidebar: printer, filament and print preset combos, checkboxes for supports and brim, then the object list and an object manipulation panel (position, rotation, scale, size). Left toolbar holds tools. [src: user-interface_208, first-print-2-9]
- Simple, Advanced and Expert mode selector at top right gates which options show. [src]
- Preview: vertical layer slider at the right, horizontal slider after slicing that plays back by time, legend with clickable rows that hide feature types, view type combo. A 3D view and Preview switcher sits at the lower left. [src]
- Slice now and Export G-code positions: [none].

Look
- Light and dark. Dark follows the OS on macOS and Linux, manual on Windows. Orange accent for selected controls since 2.7.0, reported low contrast in dark mode (issue 11556). Native controls, small and mostly square [mem]. PrusaSlicer 3.0 preview describes a redesign; out of scope. [src]

### OrcaSlicer

Controls
- Left rotate, right pan by default. Preferences > Camera has per-button mapping (None, Pan, Rotate for left, middle, right), Swap mouse buttons, Use free camera, Reverse mouse zoom, Zoom to mouse position. The per-button mapping merged May 2026 (PR 10736) and editable shortcuts arrived in 2.4.2 or later. [src: wiki, PR]
- Views: Ctrl+0 default, Ctrl+1 top, 2 bottom, 3 front, 4 behind, 5 left, 6 right, 7 current plate. I and O zoom in Prepare [3p]. No zoom to selection and no perspective toggle (request 13331). [src]
- Alt+left picks a part. Ctrl+left multi-selects. Shift+left rectangle select in Prepare. Ctrl+A, Esc, Del. A arrange all, Shift+A arrange plate, Q auto-orient. Arrows 10 mm, Shift 1 mm. [src]
- M move, R rotate, S scale, C cut, L supports, P seam, N multi-material. Painting brushes C, S, F, T; Ctrl+wheel changes radius. [src]
- Tab toggles Prepare and Preview. Space opens Speed Dial. Preview: Shift+G jump to layer, L single layer, arrows move the slider. [src]
- Trackpad: [none]. Known bugs: zoom to mouse position (3615), free camera pan reorients the view (10266).

Layout
- Tabs: Prepare, Preview, Device (embeds Klipper, OctoPrint, Mainsail and Fluidd UIs). Calibration is a menu. [3p: obico.io, wiki]
- Left sidebar with printer, filament and process presets with edit icons; process groups Quality, Strength, Speed, Support, Multimaterial, Others. Inherited from Bambu Studio. [3p]
- Four modes: Simple, Advanced, Expert, Developer. Developer is enabled in Preferences and disables the selector. [src]
- Plate list, object list, layer slider, legend, action buttons: [none]; assume the Bambu Studio positions.

Look
- Nothing verified. Assume the Bambu Studio look with a green or teal accent [mem]; the preset below does not depend on it.

### What the research means for the presets

Agreed by all three: left rotates, right and middle pan, wheel zooms, Shift+drag box selects, Alt picks a part, M R S C F for tools, A arranges, arrows nudge 10 mm and Shift 1 mm.
Real conflicts to resolve in SlicerX: view digits (Bambu 0 is plate and 7 is isometric, Prusa 0 is isometric), slice shortcut (Ctrl+G slices in Bambu, exports in Prusa), L (legend in Prusa, layer mode in Bambu and Orca), Shift+drag (box select in Prepare, so SlicerX cannot use it to pan there).
Worth stealing: Prusa's Z, B and K, Orca's per-button mapping and free camera, Bambu's Global and Objects switch, Prusa's clickable legend, Prusa's time slider, Orca's Speed Dial idea (our command palette).
Avoid: unreliable menu accelerators, a fixed mouse scheme, low-contrast accent in dark mode, key collisions inside one app.

## 2. The preset type

Ids: `slicerx`, `bambu-studio`, `prusaslicer`, `orcaslicer` (the same in contracts, the viewport `ControlsMap`, keymaps and the edition config). The type lives in `packages/contracts/src/lookfeel.ts` (LookAndFeelPreset, LayoutSpec, LookSpec, LookAndFeelChoice, LOOK_OPTIONS). The preset values, `resolvePreset(id)`, `applyPreset(preset, el?)`, `clearPreset`, `onLookChange`, `themeNameFor`, the keymaps (`KEYMAPS`, `keymapFor(id, overrides)`, `keymapConflicts`) live in `packages/ui/src/lookfeel.ts`, imported from `@slicerx/ui` or the React-free `@slicerx/ui/look`. Tests: `packages/ui/test/lookfeel.test.ts`.

How a preset applies
- `applyPreset` sets CSS variables on the root: `--accent` (points at a theme color, so it works in both themes), `--r-xs` to `--r-lg`, `--h-sm`, `--h-md`, `--h-lg`, `--gutter`, `--pad`, `--icon-size`, `--icon-stroke`, and `--f-display` (set to the body face when the preset drops the display font). It also sets `data-look`, `data-density`, `data-hairlines` and `data-gradient` for selectors. Apply the theme first, then the preset.
- Components read `--accent`, `--accent-tint` and `--accent-ring` for selection, focus and the primary action. `--purple` stays the palette purple and is no longer the interactive accent. App CSS that uses `var(--purple)` for selection or focus must move to `--accent` (studio-2).
- The logo mark keeps its gradient in every preset. `data-gradient="off"` tells the app to draw the active tab underline and the primary action solid; the base kit already does.
- `LayoutSpec.tabLabels` (added to contracts) renames a workspace tab per preset: Bambu and Orca style show Device for the Printers workspace, PrusaSlicer style shows Plater. The PrusaSlicer preset uses the settings model `tabs` with three extra workspace ids, `print-settings`, `filament-settings` and `printer-settings`, that studio-2 renders as full-width settings tabs.
- Row height: `rowHeight` sm, md, lg map to a medium control of 28, 30 and 34 px. Density sets the gutter (12, 16, 20 px) and panel padding (8, 12, 16 px).
- Nothing here changes parsed settings or G-code.

The person's density and accent from Settings > Look and feel ride on the preset: `withAppearance` in `packages/app/src/first-run/look.ts` sets the look's density (Compact, Comfortable, Roomy map to compact, standard, roomy) and, unless it is the theme's own, its accent before `applyPreset`. The theme, text, contrast and color vision settings are in docs/themes.md.

Settings > Look and feel holds the controls preset (Change opens the slicer screen of setup), Theme, Accent, Text, Accessibility, Workspace (Open models in, in editions with the modeling tools), Help and hints and Setup. Slice automatically, the electricity price and Drawing tools are on Settings > Slicing and modeling.

Persisted as `LookAndFeelChoice` (`id` plus `overrides`) in user settings, changeable any time in Settings > Look and feel, with the same live preview as first run. Individual overrides (invert zoom, swap buttons, free camera, each keybinding, layout and look parts) win over the preset.

## 3. Camera and mouse table

Legend: LMB, MMB, RMB drag on empty space unless noted. "Obj" means drag that starts on an object. Modifier variants list only what differs from plain. Unverified rows are marked (u).

| | SlicerX | Bambu Studio style | PrusaSlicer style | OrcaSlicer style |
| --- | --- | --- | --- | --- |
| LMB drag | rotate | rotate | rotate | rotate (mappable) |
| LMB drag on selected object | move on plate | move | move (u) | move |
| LMB drag on unselected object | rotate, click selects | select and move | select and move (u) | select and move |
| MMB drag | pan | pan | pan (u) | pan (mappable) |
| RMB drag | pan | pan | pan | pan (mappable) |
| Shift+LMB drag | box select in Prepare, pan in Preview | box select | box select | box select |
| Ctrl+LMB drag | rotate anywhere, also over gizmo panels | multi-select click only | rotate without hover (3p) | multi-select click only |
| Alt+LMB | pick part | pick part | box deselect (drag) | pick part |
| Space+LMB drag | pan | none | none | none |
| Wheel | zoom | zoom | zoom | zoom |
| Zoom to cursor | on | on | on (u) | on (u) |
| Invert zoom default | off | off | off | off, preference |
| Orbit center | selection, else plate center | plate center | scene center (u) | plate center, or cursor with free camera |
| Trackpad two-finger scroll | pan | zoom (u) | zoom (u) | zoom (u) |
| Shift+two-finger scroll | rotate | pan on Windows (src), zoom on Mac (u) | zoom (u) | zoom (u) |
| Pinch | zoom | zoom | zoom | zoom |
| Mac rotate gesture | rotate about vertical axis | rotate | none | rotate |
| Double click on empty space | fit plate | none | none | none |
| Double click on object | zoom to object | none | none | none |
| Rotate speed | 0.8 | 0.8 | 1.0 | 0.8 |
| Zoom speed | 0.9 | 0.9 | 0.9 | 0.9 |
| Remap buttons in Settings | yes, per button, all presets | yes | yes (a step beyond the original) | yes (native) |
| Free camera option | yes | no | no | yes, default off |

Notes for the implementer
- SlicerX drops the earlier Shift+LMB pan and Alt+LMB zoom rows from controls.ts: Shift+drag is box select in Prepare in all three reference slicers, so pan moves to Space+LMB, MMB and RMB. Add a `space` modifier to `Modifiers`. In Preview there is no box select, so Shift+LMB pans there (add a `context` field to `DragBinding`: 'prepare' | 'preview' | 'any').
- The trackpad rows for the three styles are marked unverified because no official statement exists. Keep them as the current values and let the Settings screen override them. Do not present these as facts in the UI.
- Two-finger scroll as pan in SlicerX matches how design tools and maps behave; if a scroll wheel on a mouse sends line-based deltas, treat those as zoom (detect by `deltaMode` and integer steps).
- An object drag is not a camera action. The controls map only says whether the canvas hands it to the object layer; add `objectDrag: 'move-selected' | 'move-any'` to `ControlsMap` (SlicerX `move-selected`, the others `move-any`).
- Orbit center 'selection' falls back to the plate center with nothing selected.

## 4. Keymaps

One keymap per preset, all remappable, with a searchable list on Shift+? in every preset (adopted from Prusa). Ctrl means Cmd on macOS.

| Action | SlicerX | Bambu style | Prusa style | Orca style |
| --- | --- | --- | --- | --- |
| Views: plate or default | 0 | 0 | 0 is isometric | Ctrl+0 |
| Top, bottom, front, back, left, right | 1 to 6 | 1 to 6 | 1 to 6 | Ctrl+1 to 6 |
| Isometric | 7 | 7 | 0 | none (Ctrl+0 default view) |
| Zoom to selection or all | Z | none | Z | none |
| Zoom to bed | B | none | B | none |
| Perspective or orthographic | K | none | K | none |
| Move, rotate, scale | M, R, S | M, R, S | M, R, S | M, R, S |
| Cut | C | C | C | C |
| Place on face | F | F | F | F |
| Supports paint | I | I | none | L |
| Auto-orient | Q | none | none | Q |
| Arrange all, arrange selected | A, Shift+A | A, Shift+A | A, Shift+A | A, Shift+A |
| Nudge 10 mm, 1 mm | arrows, Shift+arrows | same | same | same |
| Prepare and Preview | Tab | click tab | Tab | Tab |
| Design and Slice | Ctrl+E | Ctrl+E | Ctrl+E | Ctrl+E |
| Slice | Ctrl+Enter | Ctrl+G | Ctrl+R | Ctrl+R |
| Export G-code or print | Ctrl+Shift+E | Ctrl+Shift+E | Ctrl+G | Ctrl+Shift+E |
| Command palette | Ctrl+K | Ctrl+K | Ctrl+K | Space (Speed Dial idea, opens the palette) |
| Copy, cut, paste | Ctrl+C, Ctrl+X, Ctrl+V | same | same | same |
| Duplicate | Ctrl+D | none | none | Ctrl+D |
| Preview legend | L | L | L | L |
| Single layer | Shift+L | L | Shift+L | L |
| Jump to layer | Shift+G | Shift+G | Shift+G | Shift+G |
| Move layer slider | Up and Down, W | arrows | Up and Down, W | arrows |
| Shortcut list | Shift+? | Shift+? | Shift+? | Shift+? |

Conflict rule: in the Bambu and Orca styles L keeps its native meaning in Preview; in SlicerX and Prusa styles L is the legend and Shift+L is single layer. The Bambu digit conflict (views versus filament select) is resolved as views; filament select stays in the sidebar. Rows marked "none" mean the action exists in the command palette and menu but has no default key.

## 5. Picker previews

The first-run picker (see docs/first-run.md) shows each preset as a card and previews the SlicerX window in that style, drawn from the preset's tabs, keymap and camera map, with its two or three main differences pinned on it and a plate to try the mouse. No screenshot of any other app appears anywhere.

## 6. Acceptance

- Switching the preset changes camera behavior immediately in the same session, with a unit test per preset on `resolveDrag` and `resolveWheel`.
- The UI never asserts a behavior of another app as fact. Preset copy says "follows Bambu Studio's mouse and layout conventions".

Known difference: OrcaSlicer binds Ctrl+K to "Clone selected" in its object list. In SlicerX, Ctrl+K opens the command bar in every look, so the Orca look puts Duplicate on Ctrl+D instead.

Sidebar order: printer, filament, objects, print settings (`objectList: 'sidebar-after-filament'`). The object row is the selection state, so it stays in view at 1440 x 900 without scrolling.
