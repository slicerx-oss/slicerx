# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Formats compare.py results as markdown."""


def _ms(v):
    if v is None:
        return "n/a"
    return f"{v:,.0f}" if v >= 100 else f"{v:,.1f}"


def _hms(s):
    if s is None:
        return "n/a"
    s = int(round(s))
    return f"{s // 3600}h {s % 3600 // 60}m {s % 60}s" if s >= 3600 else f"{s // 60}m {s % 60}s"


def _row(cells):
    return "| " + " | ".join(str(c) for c in cells) + " |"


def markdown(r):
    out = ["# Slicing comparison results", ""]
    m = r["machine"]
    out.append(f"Machine: {m.get('cpu', 'unknown CPU')}, {m.get('cpu_count')} logical cores, {m.get('memory_gb', '?')} GB, {m['platform']}. "
               f"Load average before {r.get('load_before')}, after {r.get('load_after')}. {r['runs']} timed runs per cell after {r['warmup']} warm-up.")
    out.append("")
    out.append(_row(["Slicer", "Version", "Path"]))
    out.append(_row(["---", "---", "---"]))
    for s in r["slicers"].values():
        out.append(_row([s["name"], s["version"], f"`{s['path']}`"]))
    out.append("")
    for model, e in r["models"].items():
        out.append(f"## {model} ({e['triangles']:,} triangles)")
        out.append("")
        sl = e["slicers"]
        base = sl.get("sx", {}).get("wall_ms")
        out.append(_row(["Slicer", "Median ms", "p90 ms", "Time vs SlicerX", "Peak RSS MB", "CPU s", "Layers", "Filament m", "Est. print time", "G-code MB", "Arc moves"]))
        out.append(_row(["---"] * 11))
        for key, d in sl.items():
            w = d.get("wall_ms")
            g = d.get("gcode", {})
            ratio = "n/a"
            if w and base:
                ratio = "1.0x" if key == "sx" else f"{w['median'] / base['median']:.1f}x"
            name = r["slicers"][key]["name"] + (f" ({d['failed_runs']} failed)" if d["failed_runs"] else "")
            out.append(_row([
                name, _ms(w["median"]) if w else "failed", _ms(w["p90"]) if w else "n/a", ratio,
                f"{d['rss_mb']['median']:,.0f}" if d.get("rss_mb") else "n/a",
                f"{d['cpu_s']['median']:.2f}" if d.get("cpu_s") else "n/a",
                g.get("layers", "n/a"), f"{g['filament_mm'] / 1000:.2f}" if g else "n/a", _hms(g.get("estimated_time_s")),
                f"{g['bytes'] / 1e6:.1f}" if g else "n/a", g.get("arc_moves", "n/a")]))
        out.append("")
        out.append("Time vs SlicerX is each slicer's median wall time divided by SlicerX's (above 1.0x means slower than SlicerX).")
        out.append("")
        feats = {k: d["gcode"]["by_feature_mm"] for k, d in sl.items() if d.get("gcode")}
        if feats:
            names = sorted({f for v in feats.values() for f in v}, key=lambda f: -max(v.get(f, 0) for v in feats.values()))
            out.append(_row(["Extruded mm by feature", *[r["slicers"][k]["name"] for k in feats]]))
            out.append(_row(["---"] * (1 + len(feats))))
            for f in names:
                out.append(_row([f, *[f"{feats[k].get(f, 0):,.0f}" if f in feats[k] else "none" for k in feats]]))
            out.append("")
        ph = {k: d["phases_ms"] for k, d in sl.items() if d.get("phases_ms")}
        if ph:
            out.append("Phase medians in ms (each tool's own definition, see README):")
            out.append("")
            for k, p in ph.items():
                out.append(f"- {r['slicers'][k]['name']}: " + ", ".join(f"{n.replace('_ms', '').replace('_', ' ')} {_ms(v['median'])}" for n, v in p.items()))
            out.append("")
        for k, d in sl.items():
            for w in d.get("warnings", []):
                out.append(f"- {r['slicers'][k]['name']} reported: {w}")
        out.append("")
        gs = {k: d["gcode"] for k, d in sl.items() if d.get("gcode")}
        if len(gs) > 1:
            layers = {g["layers"] for g in gs.values()}
            fil = [g["filament_mm"] for g in gs.values()]
            notes = []
            if max(layers) - min(layers) > 1:
                notes.append("layer counts differ by more than one")
            if min(fil) > 0 and max(fil) / min(fil) > 1.15:
                notes.append(f"filament totals differ by {max(fil) / min(fil) - 1:.0%}, so the slicers are not doing the same amount of work")
            out.append("Like for like check: " + ("; ".join(notes) if notes else "layer counts and filament totals agree within 15 percent") + ".")
            out.append("")
    return "\n".join(out)
