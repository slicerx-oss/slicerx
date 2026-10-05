#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""The explicit base config of the parity harness.

SlicerX gives every key a config leaves out the settings schema's default (packages/settings/defaults.json),
which is what the app starts from, not what OrcaSlicer would use. So a parity case that only lists the keys it
is about would compare two different prints. Every case runs on this base instead:

- orca_base.json: the settings OrcaSlicer 2.4.2 resolves for the parity reference (its generic Marlin printer,
  0.20 mm process and generic PLA, with the matched values of settings.py on top), as Orca wrote them in the
  config block at the end of its G-code. Pinned in the repository like tests/common pins the unit tests, so a
  change of a schema default does not move the parity cases.
- SX_ONLY: the schema keys Orca 2.4.2 does not have, set to the value that prints the way Orca does.

    python3 orca_base.py --orca path/to/OrcaSlicer --write   # regenerate orca_base.json
    python3 orca_base.py --check                             # every schema key is covered
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BASE_PATH = os.path.join(HERE, "orca_base.json")
SCHEMA_PATH = os.path.join(HERE, "..", "..", "..", "settings", "defaults.json")

# Schema keys Orca 2.4.2 does not have, at the value that behaves like Orca.
SX_ONLY = {
    "prime_tower_auto_position": False,  # Orca keeps the tower where the settings put it
    "wave_overhangs": False,
    "zaa_enabled": False,
    "enable_mixed_color_sublayer": False,
    "brim_ears_outer_only": False,  # 2.4.2 puts ears in holes too
    "small_support_perimeter_threshold": 0,  # 2.4.2 has no small support perimeter speed
    "small_support_perimeter_speed": "100%",
    "top_layer_direction": -1,  # follows the solid infill direction, as in 2.4.2
}

# Keys of the config block that describe the run, not a setting.
NOT_SETTINGS = {"thumbnails", "thumbnails_format", "printer_settings_id", "print_settings_id", "filament_settings_id",
                "post_process", "filename_format", "has_scarf_joint_seam"}


def _orca_block(orca_path, work):
    import models as model_lib
    import parity
    import profile_parity
    import slicers

    os.makedirs(os.path.join(work, "models"), exist_ok=True)
    stl = os.path.join(work, "models", "cube.stl")
    model_lib.write_stl(stl, model_lib.MODELS["cube"]())
    orca = parity.ParityOrca(slicers.Orca(orca_path).path, {})
    orca.prepare(work, {"cube": stl})
    job = orca.job("cube", work)
    subprocess.run(job.cmd, capture_output=True, text=True)
    if not os.path.exists(job.gcode):
        raise SystemExit("Orca produced no G-code")
    return profile_parity.config_block(job.gcode)


def load_block():
    """The pinned Orca config block (strings, as Orca wrote them)."""
    with open(BASE_PATH) as f:
        return json.load(f)["settings"]


def sx_base():
    """The SlicerX config every parity case starts from."""
    import profile_parity

    return profile_parity.sx_config_from_block(load_block())


def _engine_text():
    src = os.path.join(HERE, "..", "..", "src")
    parts = []
    for root, _dirs, files in os.walk(src):
        parts += [open(os.path.join(root, f), errors="replace").read() for f in files if f.endswith(".rs")]
    return "\n".join(parts)


def uncovered():
    """Schema keys the engine reads that are neither in the pinned block nor in SX_ONLY: each needs a value here
    before parity is trusted. (Host, upload and thumbnail keys do not change the print and are skipped.)"""
    schema = json.load(open(SCHEMA_PATH))
    block = load_block()
    text = _engine_text()
    skip = ("host", "print_host", "printhost", "thumbnails", "post_process", "wave_overhang_")
    return sorted(k for k in schema if k not in block and k not in SX_ONLY and f'"{k}"' in text
                  and not k.startswith(skip))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--orca")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--workdir", default="orca-base-work")
    a = ap.parse_args()
    if a.write:
        block = _orca_block(a.orca, os.path.abspath(a.workdir))
        version = block.pop("version", None)
        block = {k: v for k, v in sorted(block.items()) if k not in NOT_SETTINGS}
        with open(BASE_PATH, "w") as f:
            json.dump({"orca": "2.4.2", "note": "written by orca_base.py --write; do not edit by hand",
                       "settings": block}, f, indent=0, sort_keys=False)
            f.write("\n")
        print(f"{len(block)} settings written to {BASE_PATH}" + (f" (version {version})" if version else ""))
    if a.check or not a.write:
        miss = uncovered()
        for k in miss:
            print("not covered:", k)
        return 1 if miss else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
