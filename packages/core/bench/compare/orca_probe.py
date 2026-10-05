#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Slice generated models in OrcaSlicer with setting overrides and keep the G-code.

    python3 orca_probe.py --orca <OrcaSlicer> --models cube,cube --set gcode_label_objects=firmware \
        --machine gcode_flavor=klipper --out probe-out

Used to read what Orca writes for a firmware feature (object labels, M73, thumbnails,
custom G-code) so the sx output can be checked against it. `--set` overrides process
settings, `--machine` machine settings, `--filament` filament settings; values are
strings, as Orca reads them. Prints the path of each G-code file. Standard library only.
"""
import argparse
import json
import os
import subprocess
import sys

import models as model_lib
import settings
import slicers


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--orca", required=True)
    ap.add_argument("--models", default="cube", help="comma separated model names from models.py; repeats place several objects")
    ap.add_argument("--set", action="append", default=[], help="process key=value")
    ap.add_argument("--machine", action="append", default=[], help="machine key=value")
    ap.add_argument("--filament", action="append", default=[], help="filament key=value")
    ap.add_argument("--flavor", default="marlin2")
    ap.add_argument("--system", default="", help="machine,process,filament system preset names to inherit instead of the generic Marlin ones")
    ap.add_argument("--out", default="probe-out")
    a = ap.parse_args()
    out = os.path.abspath(a.out)
    os.makedirs(os.path.join(out, "models"), exist_ok=True)

    def kv(items):
        out = dict(i.split("=", 1) for i in items)
        # A value that starts with [ is a JSON list, for settings Orca keeps as lists.
        return {k: json.loads(v) if v.startswith("[") else v for k, v in out.items()}

    names = [n for n in a.models.split(",") if n]
    stls = []
    for i, n in enumerate(names):
        p = os.path.join(out, "models", f"{n}-{i}.stl")
        model_lib.write_stl(p, model_lib.MODELS[n]())
        stls.append(p)
    orca = slicers.Orca(a.orca)
    machine, process, filament = kv(a.machine), kv(a.set), kv(a.filament)
    o_machine, o_process, o_filament = settings.slicer_machine, settings.slicer_process, settings.slicer_filament
    settings.slicer_machine = lambda f: {**o_machine(a.flavor), **machine}
    settings.slicer_process = lambda f: {**o_process(a.flavor), **process}
    settings.slicer_filament = lambda: {**o_filament(), **filament}
    if a.system:
        m, pr, fi = a.system.split(",")
        orca.work = out
        orca.files = {}
        for n, d0 in (("machine", {"type": "machine", "name": "probe machine", "from": "User", "inherits": m, **machine}),
                      ("process", {"type": "process", "name": "probe process", "from": "User", "inherits": pr,
                                   "compatible_printers": ["probe machine", m], "compatible_printers_condition": "", **process}),
                      ("filament", {"type": "filament", "name": "probe filament", "from": "User", "inherits": fi,
                                    "compatible_printers": ["probe machine", m], "compatible_printers_condition": "", **filament})):
            orca.files[n] = os.path.join(out, f"orca-{n}.json")
            json.dump(d0, open(orca.files[n], "w"))
    else:
        orca.prepare(out, {"cube": stls[0]})
    d = os.path.join(out, "orca")
    os.makedirs(d, exist_ok=True)
    cmd = [orca.path, "--slice", "0", "--outputdir", d, "--arrange", "1",
           "--load-settings", f"{orca.files['machine']};{orca.files['process']}",
           "--load-filaments", orca.files["filament"], *stls]
    r = subprocess.run(cmd, capture_output=True, text=True)
    files = sorted(f for f in os.listdir(d) if f.endswith((".gcode", ".bgcode", ".3mf")))
    if not files:
        print(r.stderr[-800:] or r.stdout[-800:], file=sys.stderr)
        return 1
    for f in files:
        print(os.path.join(d, f))
    return 0


if __name__ == "__main__":
    sys.exit(main())
