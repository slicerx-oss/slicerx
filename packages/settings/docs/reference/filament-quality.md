# Filament: Quality and geometry

3 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `filament_ironing_flow`

**Filament ironing flow**

- Type: list of percents, one per extruder
- Unit: %
- Default: empty list
- Recommended range: 0 to 100
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_ironing_inset`

**Filament ironing inset**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: empty list
- Recommended range: 0 to 100
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `filament_ironing_spacing`

**Filament ironing spacing**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: empty list
- Recommended range: 0 to 1
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
