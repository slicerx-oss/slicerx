# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""The matched print settings, and how each slicer receives them.

There is one table of values (MATCHED). Each slicer gets the same numbers under its own key
names. Key names and numbers come from the slicers' public setting names; no preset files
are copied into this repository. Anything not in the table stays at the slicer's own default,
and README.md lists the ones known to differ.
"""

# Values shared by all slicers. Lengths in mm, speeds in mm/s, temperatures in C.
MATCHED = {
    "layer_height": 0.2,
    "initial_layer_print_height": 0.2,
    "wall_loops": 2,
    "top_shell_layers": 5,
    "bottom_shell_layers": 3,
    "sparse_infill_density": 15,  # percent
    "line_width": 0.42,
    "infill_wall_overlap": 15,  # percent
    "brim_width": 5.0,
    "nozzle_diameter": 0.4,
    "nozzle_temperature": 220,
    "bed_temperature": 55,
    "filament_diameter": 1.75,
    "filament_density": 1.24,
    "printable_area": [[0, 0], [256, 0], [256, 256], [0, 256]],
    "printable_height": 250,
    "outer_wall_speed": 200,
    "inner_wall_speed": 300,
    "sparse_infill_speed": 270,
    "internal_solid_infill_speed": 250,
    "top_surface_speed": 200,
    "initial_layer_speed": 50,
    "initial_layer_infill_speed": 105,
    "travel_speed": 500,
    "retraction_length": 0.8,
    "retraction_speed": 30,
    "retraction_minimum_travel": 1.0,
    # SlicerX's time estimate has no acceleration model, so the other two are set to a high value
    # to keep their estimates in the same range. It is still an estimate, not a measured print time.
    "acceleration": 10000,
}

LINE_WIDTH_KEYS = (
    "line_width", "outer_wall_line_width", "inner_wall_line_width", "sparse_infill_line_width",
    "internal_solid_infill_line_width", "top_surface_line_width", "initial_layer_line_width",
    "support_line_width",
)
ACCEL_KEYS = (
    "default_acceleration", "outer_wall_acceleration", "inner_wall_acceleration", "top_surface_acceleration",
    "sparse_infill_acceleration", "initial_layer_acceleration", "travel_acceleration",
)
SPEED_KEYS = (
    "outer_wall_speed", "inner_wall_speed", "sparse_infill_speed", "internal_solid_infill_speed",
    "top_surface_speed", "initial_layer_speed", "initial_layer_infill_speed", "travel_speed",
)


def set_bed(size):
    """Square bed of the given side in mm. Models are centered on the default 256 mm bed."""
    MATCHED["printable_area"] = [[0, 0], [size, 0], [size, size], [0, size]]


def _s(v):
    """Slicer process settings are strings: 0.2 -> "0.2", 5.0 -> "5"."""
    return f"{v:g}" if isinstance(v, float) else str(v)


def sx_config():
    """PrintConfig JSON for `sx slice --config` (Orca key names)."""
    m = MATCHED
    return {
        "layer_height": m["layer_height"],
        "initial_layer_print_height": m["initial_layer_print_height"],
        "wall_loops": m["wall_loops"],
        "top_shell_layers": m["top_shell_layers"],
        "bottom_shell_layers": m["bottom_shell_layers"],
        "sparse_infill_density": m["sparse_infill_density"],
        "sparse_infill_pattern": "rectilinear",
        # Every line width key Orca gets, so a width sx would default on its own (support lines) matches.
        **{k: m["line_width"] for k in LINE_WIDTH_KEYS},
        "infill_wall_overlap": m["infill_wall_overlap"],
        "brim_type": "outer_only",
        "brim_width": m["brim_width"],
        # The same switches the other slicers get in slicer_process: a key left out here takes the app's
        # process default (sx PrintConfig::default), which is Orca's, so it would turn on a skirt loop,
        # Arachne walls, arc fitting and a 0.6 mm top shell minimum the table does not ask for.
        "skirt_loops": 0,
        "wall_generator": "classic",
        "top_shell_thickness": 0,
        "bottom_shell_thickness": 0,
        "enable_prime_tower": False,
        "ironing_type": "no ironing",
        "enable_arc_fitting": False,
        **{k: m["acceleration"] for k in ACCEL_KEYS},
        "enable_support": False,
        "nozzle_diameter": [m["nozzle_diameter"]],
        "nozzle_temperature": [m["nozzle_temperature"]],
        "hot_plate_temp": m["bed_temperature"],
        "filament_diameter": m["filament_diameter"],
        "filament_density": [m["filament_density"]],
        "filament_flow_ratio": [1],
        "printable_area": m["printable_area"],
        "printable_height": m["printable_height"],
        "gcode_flavor": "marlin2",
        **{k: m[k] for k in SPEED_KEYS},
        "retraction_length": m["retraction_length"],
        "retraction_speed": m["retraction_speed"],
        "retraction_minimum_travel": m["retraction_minimum_travel"],
    }


def slicer_process(flavor):
    """Process settings for Bambu Studio and OrcaSlicer, as key to string."""
    m = MATCHED
    p = {
        "layer_height": _s(m["layer_height"]),
        "initial_layer_print_height": _s(m["initial_layer_print_height"]),
        "wall_loops": _s(m["wall_loops"]),
        "wall_generator": "classic",
        "top_shell_layers": _s(m["top_shell_layers"]),
        "bottom_shell_layers": _s(m["bottom_shell_layers"]),
        "top_shell_thickness": "0",
        "bottom_shell_thickness": "0",
        "sparse_infill_density": f"{m['sparse_infill_density']}%",
        "sparse_infill_pattern": "zig-zag",  # the slicers' name for rectilinear
        "infill_wall_overlap": f"{m['infill_wall_overlap']}%",
        "brim_type": "outer_only",
        "brim_width": _s(m["brim_width"]),
        "skirt_loops": "0",
        "enable_support": "0",
        "enable_prime_tower": "0",
        "ironing_type": "no ironing",
        "enable_arc_fitting": "0",
        "gcode_flavor": flavor,
    }
    for k in LINE_WIDTH_KEYS:
        p[k] = _s(m["line_width"])
    for k in SPEED_KEYS:
        p[k] = _s(m[k])
    for k in ACCEL_KEYS:
        p[k] = _s(m["acceleration"])
    return p


def slicer_machine(flavor):
    """Machine settings for Bambu Studio and OrcaSlicer."""
    m = MATCHED
    return {
        "printable_area": [f"{x}x{y}" for x, y in m["printable_area"]],
        "printable_height": _s(m["printable_height"]),
        "nozzle_diameter": [_s(m["nozzle_diameter"])],
        "gcode_flavor": flavor,
        "retraction_length": [_s(m["retraction_length"])],
        "retraction_speed": [_s(m["retraction_speed"])],
        "retraction_minimum_travel": [_s(m["retraction_minimum_travel"])],
        # Relative extrusion needs the extruder position reset on each layer.
        "layer_change_gcode": "G92 E0",
        "machine_max_acceleration_extruding": [_s(m["acceleration"])] * 2,
        "machine_max_acceleration_travel": [_s(m["acceleration"])] * 2,
    }


def slicer_filament():
    m = MATCHED
    return {
        "filament_diameter": [_s(m["filament_diameter"])],
        "filament_density": [_s(m["filament_density"])],
        "nozzle_temperature": [_s(m["nozzle_temperature"])],
        "nozzle_temperature_initial_layer": [_s(m["nozzle_temperature"])],
        "hot_plate_temp": [_s(m["bed_temperature"])],
        "hot_plate_temp_initial_layer": [_s(m["bed_temperature"])],
        # SlicerX has no cooling slowdown or volumetric speed limit, so both are off here.
        "slow_down_for_layer_cooling": ["0"],
        "filament_max_volumetric_speed": ["100"],
        # Set, not inherited: a project file carries its own (Generic PLA in Orca's GUI is 0.98), and
        # Orca keeps the project's value over an inherited one.
        "filament_flow_ratio": ["1"],
    }


def assign(config, key, value):
    """Sets key, keeping the shape of an existing per-variant list (Bambu keeps two entries for some keys)."""
    cur = config.get(key)
    if isinstance(cur, list) and not isinstance(value, list):
        config[key] = [value] * len(cur)
    else:
        config[key] = value
