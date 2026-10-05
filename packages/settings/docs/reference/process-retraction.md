# Process: Retraction

2 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `reduce_crossing_wall`

**Avoid crossing walls**

- Type: boolean
- Default: off
- Tier: Expert, speed
- Changing it redoes: paths
- mimir class: edit (may change in a plate override)
- Effect: higher: Travel detours around walls to cut stringing and adds time. lower: Travel goes straight and can string

### `reduce_infill_retraction`

**Reduce infill retraction**

- Type: boolean
- Default: off
- Tier: Expert, speed
- Changing it redoes: perimeters
- mimir class: edit (may change in a plate override)
