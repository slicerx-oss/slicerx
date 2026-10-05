#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Slicing speed comparison: SlicerX, Bambu Studio and OrcaSlicer on the same models and settings.

    python3 compare.py                      # every slicer found, every model, 10 runs each
    python3 compare.py --models cube,knot --runs 5
    python3 compare.py --selftest           # checks the generated models only

Python 3.9 or newer, standard library only. See README.md for the method and its limits.
"""
import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time

import gcode
import measure
import models as model_lib
import report
import settings
import slicers


def pct(values, p):
    s = sorted(values)
    return s[round((len(s) - 1) * p)] if s else None


def summarize(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return {"n": len(values), "median": round(pct(values, 0.5), 2), "p90": round(pct(values, 0.9), 2),
            "min": round(min(values), 2), "max": round(max(values), 2), "all": [round(v, 2) for v in values]}


def machine_info():
    info = {"platform": platform.platform(), "python": platform.python_version(), "cpu_count": os.cpu_count()}
    try:
        if sys.platform == "darwin":
            info["cpu"] = subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip()
            info["memory_gb"] = round(int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)) / 2**30, 1)
        elif sys.platform.startswith("linux"):
            for ln in open("/proc/cpuinfo"):
                if ln.startswith("model name"):
                    info["cpu"] = ln.split(":", 1)[1].strip()
                    break
            for ln in open("/proc/meminfo"):
                if ln.startswith("MemTotal"):
                    info["memory_gb"] = round(int(ln.split()[1]) / 2**20, 1)
                    break
        else:
            info["cpu"] = platform.processor()
    except (OSError, subprocess.SubprocessError):
        pass
    return info


def load_avg():
    return round(os.getloadavg()[0], 2) if hasattr(os, "getloadavg") else None


def triangle_count(path):
    return (os.path.getsize(path) - 84) // 50


def execute(job, keep_err=False):
    """Runs a job and returns the measurement plus a success flag."""
    out = open(job.stdout, "w") if job.stdout else subprocess.DEVNULL
    err = open(job.stdout + ".err", "w") if (job.stdout and keep_err) else subprocess.DEVNULL
    try:
        launch = time.time()
        r = measure.run(job.cmd, stdout=out, stderr=err)
    finally:
        if job.stdout:
            out.close()
        if keep_err and job.stdout:
            err.close()
    r["t_launch"] = launch
    r["ok"] = r["rc"] == 0 and job.gcode is not None and os.path.exists(job.gcode) and os.path.getsize(job.gcode) > 0
    return r


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--slicers", default="", help="comma list of sx, orca, bambu (default: all found)")
    ap.add_argument("--models", default=",".join(model_lib.MODELS), help="comma list; default all")
    ap.add_argument("--runs", type=int, default=10)
    ap.add_argument("--warmup", type=int, default=1)
    ap.add_argument("--workdir", default="compare-work")
    ap.add_argument("--out", default="compare-results.json")
    ap.add_argument("--markdown", default="compare-results.md")
    ap.add_argument("--sx"), ap.add_argument("--orca"), ap.add_argument("--bambu"), ap.add_argument("--bambu-profiles")
    ap.add_argument("--bed", type=int, help="square bed side in mm (default 256); SlicerX still centers models on 256 mm")
    ap.add_argument("--no-phases", action="store_true", help="skip the extra phase-timing runs")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--force", action="store_true", help="regenerate model files")
    a = ap.parse_args()

    if a.selftest:
        bad = 0
        for name, build in model_lib.MODELS.items():
            if name == "dense":
                continue
            tris = build()
            problems, vol = model_lib.check(tris)
            print(f"{name}: {len(tris)} triangles, {problems} open or misoriented edges, volume {vol:.0f} mm^3")
            bad += problems + (vol <= 0)
        return 1 if bad else 0

    if a.bed:
        settings.set_bed(a.bed)
    work = os.path.abspath(a.workdir)
    os.makedirs(os.path.join(work, "models"), exist_ok=True)
    names = [n for n in a.models.split(",") if n]
    stls = {}
    for n in names:
        p = os.path.join(work, "models", f"{n}.stl")
        if a.force or not os.path.exists(p):
            print(f"generating {n} ...", flush=True)
            model_lib.write_stl(p, model_lib.MODELS[n]())
        stls[n] = p

    pool = {"sx": slicers.SlicerX(a.sx), "orca": slicers.Orca(a.orca), "bambu": slicers.Bambu(a.bambu, a.bambu_profiles)}
    wanted = [k for k in (a.slicers.split(",") if a.slicers else pool) if k]
    active = []
    for k in wanted:
        if pool[k].available():
            active.append(pool[k])
        else:
            print(f"skipping {k}: not found (use --{k.replace('_', '-')} PATH)", file=sys.stderr)
    if not active:
        print("no slicer found", file=sys.stderr)
        return 2
    for s in active:
        print(f"preparing {s.name} ...", flush=True)
        s.prepare(work, stls)

    out_dir = os.path.join(work, "out")
    os.makedirs(out_dir, exist_ok=True)
    result = {"machine": machine_info(), "runs": a.runs, "warmup": a.warmup, "slicers": {}, "models": {}}
    result["load_before"] = load_avg()
    for model in names:
        entry = {"triangles": triangle_count(stls[model]), "slicers": {}}
        for s in active:
            for _ in range(a.warmup):
                execute(s.job(model, out_dir), keep_err=True)
        runs = {s.key: [] for s in active}
        for i in range(a.runs):  # interleaved, so background load hits every slicer alike
            for s in active:
                job = s.job(model, out_dir)
                r = execute(job, keep_err=True)
                runs[s.key].append(r)
        line = ", ".join(f"{s.name} {summarize([r['wall_ms'] for r in runs[s.key] if r['ok']])['median'] if any(r['ok'] for r in runs[s.key]) else 'failed'} ms" for s in active)
        print(f"{model} ({entry['triangles']} triangles): {line}", flush=True)
        for s in active:
            ok = [r for r in runs[s.key] if r["ok"]]
            d = {"failed_runs": len(runs[s.key]) - len(ok),
                 "wall_ms": summarize([r["wall_ms"] for r in ok]),
                 "rss_mb": summarize([r["rss_mb"] for r in ok]),
                 "cpu_s": summarize([r["cpu_s"] for r in ok])}
            if ok:
                gpath = last_gcode(s, model, out_dir)
                d["gcode"] = gcode.stats(gpath)
                d["gcode"]["bytes"] = os.path.getsize(gpath)
                if s.key == "sx":
                    s.read_version(gpath)
                    d["gcode"]["estimated_time_s"] = s.summary(os.path.join(out_dir, f"{model}-sx.out")).get("estimated_time_s")
                    try:
                        d["warnings"] = sorted({ln.strip() for ln in open(os.path.join(out_dir, f"{model}-sx.out.err")) if ln.startswith("warning")})
                    except OSError:
                        pass
            entry["slicers"][s.key] = d
        if not a.no_phases:
            phases(active, model, out_dir, a.runs, entry)
        result["models"][model] = entry
    result["load_after"] = load_avg()
    result["slicers"] = {s.key: {"name": s.name, "path": s.path, "version": s.version} for s in active}
    with open(a.out, "w") as f:
        json.dump(result, f, indent=1)
    with open(a.markdown, "w") as f:
        f.write(report.markdown(result))
    print(f"wrote {a.out} and {a.markdown}")
    return 0


def last_gcode(s, model, out_dir):
    if s.key == "sx":
        return os.path.join(out_dir, f"{model}-sx.gcode")
    return os.path.join(out_dir, f"{model}-{s.key}", "plate_1.gcode")


def phases(active, model, out_dir, runs, entry):
    """Extra runs for the phase split: Bambu Studio from its debug-4 log, SlicerX from `sx bench`."""
    for s in active:
        d = entry["slicers"][s.key]
        if s.key == "bambu":
            rows = []
            for _ in range(runs):
                job = s.job(model, out_dir, tag="phase", debug=4)
                r = execute(job)
                if r["ok"]:
                    p = s.phases(job.stdout, r["t_launch"], r["wall_ms"])
                    if p:
                        rows.append(p)
            if rows:
                d["phases_ms"] = {k: summarize([p[k] for p in rows]) for k in rows[0]}
        elif s.key == "sx":
            rows = []
            for _ in range(runs):
                job = s.bench_job(model, out_dir)
                r = execute(job)
                try:
                    j = json.load(open(job.stdout))
                    st = j["stage_ms"]
                    rows.append({"total_ms": j["median_ms"], "slice_ms": j["median_ms"] - st["gcode_wall"] - st["preview_wall"],
                                 "gcode_ms": st["gcode_wall"], "preview_ms": st["preview_wall"], "threads": j["threads"]})
                except (OSError, ValueError, KeyError):
                    pass
            if rows:
                d["phases_ms"] = {k: summarize([p[k] for p in rows]) for k in rows[0] if k != "threads"}
                d["threads"] = rows[0]["threads"]


if __name__ == "__main__":
    sys.exit(main())
