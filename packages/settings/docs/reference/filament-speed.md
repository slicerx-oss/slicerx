# Filament: Speed

1 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `filament_ironing_speed`

**Filament ironing speed**

- Type: list of numbers, one per extruder
- Unit: mm/s
- Default: empty list
- Recommended range: 1 to no maximum
- Automatic: The value 0 means automatic and is always allowed.
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
