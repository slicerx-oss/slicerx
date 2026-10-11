#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Proves that writing the part fan only when it changes drops repeated fan lines and changes nothing else.

    python3 fan_repeats.py --old <sx before> --new <sx after> [--models a.stl,b.stl] [--printers bambu-a1,...]
                           [--shards 1,4] [--workdir DIR] [--keep]

Each model is sliced on each printer with both builds: the settings schema's defaults, then the printer's shipped
process, filament and machine settings, then its start and end G-code, with support off. The old file goes through
`strip`, which removes a layer's own fan line (an M106 or M107 right before the layer change) when the last fan
command since the first layer's own fan line is the very same command. A pause (M600, M601, M0, M1, M25, PAUSE)
makes the fan unknown again. The result must equal the new file byte for byte. With several shard counts, the new
files of every count must be equal too. Prints one line per file, the lines dropped, and both builds' times; exits 1
on any difference. Standard library only.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
LAYER = re.compile(r"^(;LAYER_CHANGE|; CHANGE_LAYER)\s*$")
PAUSE = {"M600", "M601", "M0", "M1", "M25", "PAUSE"}
FAN = {"M106", "M107", "M126", "M127"}
PRINTERS = {
    "bambu-a1": "bambu-lab",
    "bambu-x1-carbon": "bambu-lab",
    "bambu-p1s": "bambu-lab",
    "prusa-mk4": "prusa",
    "generic-klipper": None,
}


def read(path):
    return json.load(open(os.path.join(REPO, path)))


def config(printer):
    """Schema defaults, the printer's resolved process, filament and machine, its start and end G-code."""
    c = {k: v[1] for k, v in read("packages/settings/defaults.json").items()}
    maker = PRINTERS[printer]
    if maker:
        m = read(f"packages/profiles/resolved/{maker}.json")["models"][printer]
        for part in (m["process"][m["base"]], m["filament"], m["machine"]):
            c.update(part)
    else:
        c["gcode_flavor"] = "klipper"
    g = read("packages/profiles/gcode.json")
    fam = g["families"][g["models"][printer]]
    c["machine_start_gcode"], c["machine_end_gcode"] = fam["start"], fam["end"]
    c["enable_support"] = False
    return c


def words(line):
    return " ".join(line.split(";", 1)[0].split())


def strip(text):
    """The old file with each layer's repeated own fan line removed (see the module doc)."""
    lines = text.split("\n")
    out, fan, known, dropped = [], None, False, 0
    for i, line in enumerate(lines):
        w = words(line)
        cmd = w.split(" ", 1)[0] if w else ""
        own = cmd in FAN and i + 1 < len(lines) and LAYER.match(lines[i + 1]) and line == w
        if own:
            if known and fan == w:
                dropped += 1
                continue
            known, fan = True, w
        elif known and cmd in FAN:
            fan = w
        elif known and cmd in PAUSE:
            fan = None
        out.append(line)
    return "\n".join(out), dropped


def slice_one(sx, mesh, printer, shards, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    req = {
        "schemaVersion": 1,
        "meshes": {"m": os.path.abspath(mesh)},
        "plate": {"objects": [{"id": "o", "name": os.path.basename(mesh), "mesh": "m"}]},
        "config": config(printer),
        "options": {"trustedGcode": True, "shards": shards},
    }
    path = os.path.join(out_dir, "request.json")
    json.dump(req, open(path, "w"))
    t = time.time()
    r = subprocess.run([sx, "slice", "--request", path, "--out-dir", out_dir], capture_output=True, text=True)
    took = time.time() - t
    if r.returncode != 0:
        return None, took, r.stderr.strip().splitlines()[-1:] or ["failed"]
    g = [f for f in os.listdir(out_dir) if f.endswith(".gcode")]
    return open(os.path.join(out_dir, g[0]), errors="replace").read(), took, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old", required=True)
    ap.add_argument("--new", required=True)
    ap.add_argument("--models", default=os.path.join(REPO, "packages/core/bench/models/x-mark.stl"))
    ap.add_argument("--printers", default=",".join(PRINTERS))
    ap.add_argument("--shards", default="1,4")
    ap.add_argument("--workdir", default="fan-repeats-work")
    ap.add_argument("--keep", action="store_true", help="keep the G-code files (deleted after each comparison)")
    a = ap.parse_args()
    shards = [int(s) for s in a.shards.split(",")]
    bad = 0
    total = {"old": 0.0, "new": 0.0, "dropped": 0, "files": 0}
    for mesh in a.models.split(","):
        for printer in a.printers.split(","):
            name = f"{os.path.splitext(os.path.basename(mesh))[0]}-{printer}"
            old, t_old, err = slice_one(a.old, mesh, printer, 1, os.path.join(a.workdir, name, "old"))
            if err:
                print(f"{name}: old build refused: {err[0]}")
                continue
            news = []
            for s in shards:
                new, t_new, err = slice_one(a.new, mesh, printer, s, os.path.join(a.workdir, name, f"new-s{s}"))
                if err:
                    print(f"{name}: new build refused at {s} shards: {err[0]}")
                    bad += 1
                    break
                news.append((s, new, t_new))
            if len(news) != len(shards):
                continue
            stripped, dropped = strip(old)
            same = stripped == news[0][1]
            shard_same = all(n[1] == news[0][1] for n in news)
            total["old"] += t_old
            total["new"] += news[0][2]
            total["dropped"] += dropped
            total["files"] += 1
            sha = hashlib.sha256(news[0][1].encode()).hexdigest()[:12]
            print(f"{name}: dropped {dropped} repeated fan lines, old stripped == new: {same}, "
                  f"shards {','.join(str(n[0]) for n in news)} equal: {shard_same}, new sha {sha}, "
                  f"time old {t_old:.2f} s new {news[0][2]:.2f} s")
            if not (same and shard_same):
                bad += 1
            elif not a.keep:
                shutil.rmtree(os.path.join(a.workdir, name), ignore_errors=True)
    print(f"{total['files']} files, {total['dropped']} lines dropped, {bad} differing; "
          f"wall time old {total['old']:.1f} s, new {total['new']:.1f} s (1 shard)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
