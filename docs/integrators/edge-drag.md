# Drag to another plate

An app that embeds `@slicerx/viewport` and has more than one plate can let people send parts to another plate by dragging them past a bed edge, the way SlicerX does. It is one call with an adapter of your plate calls. The full reference, with every option, property and string, is "Drag to another plate" in the [viewport README](../../packages/ui/viewport/README.md#drag-to-another-plate).

## What people see

While a part moves, each bed edge shows a soft band off the bed with a chevron and a label. The left, top and right edges add the part to your other plates in plate order, and the bottom adds it to a new plate. With more than three other plates the top edge reads "+ More plates" and opens a list of the rest. Once the whole part (or the whole selection) is past the edge by 8 mm or 24 screen pixels, the line turns solid and the label is underlined. A release there moves it, the part flies into your plate bar, and your app shows the plate it went to. A release short of the line puts it back with a one-time hint, and Esc calls the move off.

## Turn it on

```ts
import { enableEdgeDrag } from '@slicerx/viewport/edge-drag'

const off = enableEdgeDrag(viewport, {
  plates: () => store.plates.map((p, i) => ({ id: p.id, label: p.name, order: i })),
  activePlate: () => store.activePlateId,
  move: (ids, dest) => {
    // one undo step: for 'new', adding the plate and moving into it undo together
    const plateId = dest === 'new' ? store.addPlate() : dest.plate
    store.moveObjectsToPlate(ids, plateId)
    return plateId
  },
  dropTarget: () => document.querySelector('.plate-bar')?.getBoundingClientRect() ?? null,
  obstacles: () => [...document.querySelectorAll('.toolbar')].map((el) => el.getBoundingClientRect()),
  onSwitch: (plateId) => store.showPlate(plateId),
})
```

What to map:

- `plates()` and `activePlate()`: your plate list in plate order, with the name each edge should show, and the plate on screen.
- `move(ids, dest)`: your own move to plate action. It places the parts, keeps the move as one undo step, and for `'new'` adds the plate first. Return the plate id (or a promise of it).
- `dropTarget()`: the rect of your plate bar or plate picker, so the part flies there on a drop. Leave it out and the part fades in place.
- `obstacles()`: your toolbars and panels over the view, so the view zooms out far enough to give each edge room clear of them.
- `onSwitch(plateId, ids)`: show that plate. The view then selects the parts.
- `canMove(ids)`: return false for anything that must stay, such as a prime tower.

The entry only sets the view's hook. The gesture code loads on the first part drag, and nothing runs, listens or draws while no part moves. `off()` turns it off.

## Your look and language

Set the `--sx-edge-*` custom properties on `:root` or around the viewer, or pass `theme`. Unset, they follow the tokens the viewport already uses (`--accent`, `--fg`, `--ink-0`), so a themed viewport gets a matching gesture.

```ts
enableEdgeDrag(viewport, {
  ...adapter,
  theme: { band: '#2ec4b6', label: '#f4f4f4' },
  labels: { addToNewPlate: '+ New plate' },
})
```

If you override colors, check them against your own background and bed: at least 3:1 for the bands, lines, chevron, ring and badge, and 4.5:1 for label, list and hint text.

## Accessibility

A polite live region says where a release adds the part, the armed state is shown by a solid line and an underline as well as color, Esc cancels, and reduced motion makes the zoom and drop instant with no pulse. The gesture needs a pointer, so keep a menu command that moves the selection to another plate.

## Check it

1. Drag a part slowly toward the right edge. The band shows, and the label names the next plate.
2. Keep going until the line turns solid and release. The part lands on that plate, and your app shows it with the part selected.
3. Drag toward the bottom edge and release past the line. A new plate is added with the part on it, and one undo takes both back.
4. Release just past the edge, short of the line. The part snaps back and the hint shows once.
5. Start a drag past the line and press Esc. The part goes back and nothing moves.
