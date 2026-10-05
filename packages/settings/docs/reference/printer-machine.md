# Printer: Machine

67 settings. Keys are OrcaSlicer's own names. See the [index](index.md) for the other groups and the [guide](../guide.md) for how to read and apply them.

### `adaptive_bed_mesh_margin`

**Adaptive bed mesh margin**

- Type: number
- Unit: mm
- Default: 0
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `bed_custom_model`

**Bed custom model**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `bed_custom_texture`

**Bed custom texture**

- Type: string
- Default: empty
- Changing it redoes: preview only
- mimir class: read (not in the catalog: never written)

### `bed_exclude_area`

**Bed exclude area**

- Type: list of points [x, y]
- Default: [[0,0]]
- Changing it redoes: layers (the whole slice)
- mimir class: read (not in the catalog: never written)

### `bed_mesh_max`

**Bed mesh max**

- Type: point [x, y]
- Unit: mm
- Default: [99999,99999]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `bed_mesh_min`

**Bed mesh min**

- Type: point [x, y]
- Unit: mm
- Default: [-99999,-99999]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `bed_mesh_probe_distance`

**Bed mesh probe distance**

- Type: point [x, y]
- Unit: mm
- Default: [50,50]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `bed_temperature_formula`

**Bed temperature formula**

Which filament sets the bed temperature when a plate prints several: the first one, or the highest bed temperature among the filaments the layer prints.

- Type: enum
- Default: "by_highest_temp"
- Values: `by_first_filament` (By the first filament), `by_highest_temp` (By the highest temperature)
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `bed_texture_area`

**Bed texture area**

- Type: list of points [x, y]
- Default: empty list
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `best_object_pos`

**Best object pos**

- Type: point [x, y]
- Default: [0.5,0.5]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `color_bed_exclude_area`

**Colored bed exclusion area**

- Type: string
- Default: empty
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `creality_flush_time`

**Flush time**

- Type: number
- Unit: s
- Default: 0
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `default_bed_type`

**Default bed type**

- Type: string
- Default: empty
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `default_nozzle_volume_type`

**Default nozzle volume type** (develop mode)

- Type: list of enum values, one per extruder
- Default: ["Standard"]
- Values: `Standard`, `High Flow` (High flow), `Hybrid`, `TPU High Flow` (TPU high flow), `E3D High Flow` (E3D high flow), `Extra High Flow` (Extra high flow)
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `detraction_speed`

**Deretraction speed**

- Type: number
- Unit: mm/s
- Default: 0
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `disable_m73`

**Disable m73**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `enable_long_retraction_when_cut`

**Long retraction when cutting filament** (develop mode)

- Type: integer
- Default: 0
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `enable_power_loss_recovery`

**Enable power loss recovery**

- Type: enum
- Default: "printer_configuration"
- Values: `printer_configuration` (As the printer is set), `enable` (On), `disable` (Off)
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `extruder_clearance_dist_to_rod`

**Extruder clearance dist to rod**

- Type: number
- Unit: mm
- Default: 40
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `extruder_clearance_height_to_lid`

**Extruder clearance height to lid**

- Type: number
- Unit: mm
- Default: 120
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `extruder_clearance_height_to_rod`

**Extruder clearance height to rod**

- Type: number
- Unit: mm
- Default: 40
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `extruder_clearance_max_radius`

**Extruder clearance radius**

- Type: number
- Unit: mm
- Default: 68
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `extruder_clearance_radius`

**Extruder clearance radius**

- Type: number
- Unit: mm
- Default: 40
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `extruder_colour`

**Extruder color**

- Type: list of strings, one per extruder
- Default: [""]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `extruder_height_gap`

**Extruder height gap**

- Type: number
- Unit: mm
- Default: 0
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `extruder_offset`

**Extruder offset**

- Type: list of points [x, y]
- Unit: mm
- Default: [[0,0]]
- Changing it redoes: layers (the whole slice)
- mimir class: read (not in the catalog: never written)

### `extruder_printable_area`

**Extruder printable area**

- Type: list of point lists
- Default: empty list
- Changing it redoes: layers (the whole slice)
- mimir class: read (not in the catalog: never written)

### `extruder_printable_height`

**Extruder printable height**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0]
- Recommended range: 0 to 1000
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: layers (the whole slice)
- mimir class: read (not in the catalog: never written)

### `extruder_type`

**Extruder type**

- Type: list of enum values, one per extruder
- Default: ["Direct Drive"]
- Values: `Direct Drive` (Direct drive), `Bowden`
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `farthest_point_timelapse`

**Farthest point timelapse**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `gcode_flavor`

**Gcode flavor**

- Type: enum
- Default: "marlin"
- Values: `marlin` (Marlin (legacy)), `klipper` (Klipper), `reprapfirmware` (RepRapFirmware), `repetier` (Repetier), `marlin2` (Marlin 2), `reprap` (RepRap or Sprinter), `teacup` (Teacup), `makerware` (MakerWare (MakerBot)), `sailfish` (Sailfish (MakerBot)), `mach3` (Mach3 or LinuxCNC), `machinekit` (Machinekit), `smoothie` (Smoothie), `no-extrusion` (No extrusion), `griffin` (UltiMaker Griffin (S3, S5, S7)), `cheetah` (UltiMaker Cheetah (S6, S8))
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `gcode_skip_config_block`

**Gcode skip config block**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `grab_length`

**Grab length** (develop mode)

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0]
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `head_wrap_detect_zone`

**Toolhead wrap detection zone** (develop mode)

- Type: list of points [x, y]
- Default: empty list
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `is_support_multi_box`

**Supports several filament boxes**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_LED_light_exist`

**Has chamber light**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_platform_motion_enable`

**Has platform motion**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_ptc_exist`

**Has PTC heater**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `machine_switch_extruder_time`

**Extruder switch time**

- Type: number
- Unit: s
- Default: 0
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `max_layer_height`

**Max layer height**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0]
- Recommended range: 0 to no maximum
- Changing it redoes: layers (the whole slice)
- mimir class: read (not in the catalog: never written)

### `min_layer_height`

**Min layer height**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0.07]
- Recommended range: 0 to no maximum
- Changing it redoes: layers (the whole slice)
- mimir class: read (not in the catalog: never written)

### `nozzle_diameter`

**Nozzle diameter**

- Type: list of numbers, one per extruder
- Unit: mm
- Default: [0.4]
- Recommended range: no minimum to 100
- Changing it redoes: layers (the whole slice)
- mimir class: read (not in the catalog: never written)

### `nozzle_height`

**Nozzle height** (develop mode)

- Type: number
- Unit: mm
- Default: 2.5
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `nozzle_hrc`

**Nozzle hrc** (develop mode)

- Type: integer
- Default: 0
- Recommended range: 0 to 500
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `nozzle_type`

**Nozzle type**

- Type: list of enum values, one per extruder
- Default: ["undefine"]
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Values: `undefine` (Not set), `hardened_steel` (Hardened steel), `stainless_steel` (Stainless steel), `tungsten_carbide` (Tungsten carbide), `brass` (Brass)
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `nozzle_volume`

**Nozzle volume**

- Type: list of numbers, one per extruder
- Unit: mm3
- Default: [0]
- Nullable: A profile can store `nil` to take the value from another profile; the key is then left out.
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `parallel_printheads_bed_exclude_areas`

**Bed areas excluded for parallel heads**

- Type: list of strings, one per extruder
- Default: empty list
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `parallel_printheads_count`

**Parallel printheads count**

- Type: integer
- Default: 1
- Recommended range: 1 to 4
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `pellet_modded_printer`

**Pellet modded printer**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `preferred_orientation`

**Preferred orientation**

- Type: number
- Unit: degrees
- Default: 0
- Recommended range: -360 to 360
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `prime_tower_position_type`

**Prime tower position**

- Type: string
- Default: "Middle Upper"
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `print_core`

**Print core**

The print core each extruder holds, such as AA 0.4 or BB 0.4. UltiMaker printers check it against the core they hold before they start.

- Type: list of strings, one per extruder
- Default: [""]
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `print_in_clockwise`

**Print clockwise**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `printable_area`

**Printable area**

- Type: list of points [x, y]
- Default: [[0,0],[200,0],[200,200],[0,200]]
- Changing it redoes: layers (the whole slice)
- mimir class: read (not in the catalog: never written)

### `printable_height`

**Printable height**

- Type: number
- Unit: mm
- Default: 100
- Recommended range: 0 to 214700
- Changing it redoes: layers (the whole slice)
- mimir class: read (not in the catalog: never written)

### `printer_plugin_config_overrides`

**Plugin capabilities**

- Type: string
- Default: empty
- Changing it redoes: G-code only
- mimir class: read (never written)

### `remaining_times`

**Reports remaining time**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `scan_first_layer`

**Scan first layer**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `support_multi_filament`

**Supports several filaments**

- Type: boolean
- Default: off
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `support_parallel_printheads`

**Support parallel printheads**

- Type: boolean
- Default: off
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `time_cost`

**Time cost**

- Type: number
- Unit: money per hour
- Default: 0
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `toolchange_park_position`

**Tool change position**

Where the head goes before and after each extruder's tool change, in printer coordinates. UltiMaker printers switch print cores there.

- Type: list of points [x, y]
- Unit: mm
- Default: empty list
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `travel_slope`

**Travel slope**

- Type: list of numbers, one per extruder
- Unit: degrees
- Default: [3]
- Recommended range: 1 to 90
- Changing it redoes: paths
- mimir class: read (not in the catalog: never written)

### `use_relative_e_distances`

**Relative extruder moves**

- Type: boolean
- Default: on
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `wrapping_detection_layers`

**Wrapping detection layers** (develop mode)

- Type: integer
- Default: 20
- Recommended range: 0 to no maximum
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `wrapping_exclude_area`

**Wrapping exclude area**

- Type: list of points [x, y]
- Default: empty list
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)

### `z_offset`

**Z offset**

- Type: number
- Unit: mm
- Default: 0
- Changing it redoes: G-code only
- mimir class: read (not in the catalog: never written)
