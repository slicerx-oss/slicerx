#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Writes the settings Orca resolves for a stock printer, filament and process (the config block at the end of
its G-code) as JSON, one file per profile, for comparing against the app's resolved configuration.

    python3 resolved_dump.py --orca /Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer --workdir work --out out-dir [--profiles bbl,mk4s,k1]
"""
import argparse
import json
import os
import re
import subprocess

import models as model_lib
import parity
import profile_parity as pp
import slicers


def _find(vendor, kind, name):
    """The preset file and the vendor folder it was found in."""
    for root in pp.PROFILE_DIRS:
        base = os.path.join(root, vendor, kind)
        for dirpath, _dirs, files in os.walk(base):
            if name + ".json" in files:
                return os.path.join(dirpath, name + ".json"), vendor
    return None, None


def _flatten_file(vendor, kind, name):
    """A preset with everything it inherits merged in. The preset is looked for in the vendor folder (and its subfolders), then in the
    shared filament library; its parents are looked for in the folder it was found in first, as Orca resolves a library preset inside
    the library and not inside the printer's vendor."""
    path, found = _find(vendor, kind, name)
    if not path:
        path, found = _find("OrcaFilamentLibrary", kind, name)
    if not path:
        raise FileNotFoundError(f"{vendor}/{kind}/{name}")
    cur = json.load(open(path))
    parent = cur.get("inherits")
    base = _flatten_file(found, kind, parent) if parent else {}
    base.update({k: v for k, v in cur.items() if k != "inherits"})
    return base


def flatten_any(vendor, kind, name):
    """A system preset by name. A Bambu filament with no variant for this model falls back to the X1C one."""
    try:
        return _flatten_file(vendor, kind, name), name
    except FileNotFoundError:
        if kind == "filament" and "@BBL" in name:
            alt = name.split(" @BBL")[0] + " @BBL X1C"
            return _flatten_file("BBL", kind, alt), alt
        raise


TIER_WORDS = {"draft": ["Draft"], "extra_fine": ["Extra Fine", "SuperDetail"], "fine": ["Fine", "High Quality"], "standard": ["Standard", "SPEED"], "strong": ["Strength"]}


def _condition_holds(condition, machine):
    """Orca's compatible_printers_condition against a machine preset: `printer_notes=~/regex/`, `nozzle_diameter[0]==0.6`, `and`, `or`, `!`
    and parentheses, with other keys read from the machine preset (regular expressions match the whole text, as Orca's do)."""
    def notes(key):
        v = machine.get(key, "")
        return "\n".join(v) if isinstance(v, list) else str(v)

    def rx(key, pattern, negate=False):
        hit = re.fullmatch(pattern, notes(key), re.S) is not None
        return not hit if negate else hit

    expr = re.sub(r"(\w+)\s*(=~|!~)\s*/((?:[^/\\]|\\.)*)/", lambda m: f"rx({m.group(1)!r}, {m.group(3)!r}, {m.group(2) == '!~'})", condition)
    expr = re.sub(r"nozzle_diameter\[0\]", repr(float((machine.get("nozzle_diameter") or ["0"])[0])), expr)
    expr = re.sub(r"!(?!=)", " not ", expr)
    expr = re.sub(r"\bprinter_model\b|\bprinter_variant\b", lambda m: repr(str(machine.get(m.group(0), ""))), expr)
    try:
        return bool(eval(expr, {"__builtins__": {}}, {"rx": rx}))  # noqa: S307 - the condition comes from Orca's own profile files
    except Exception:
        return False


TIER_LAYER = {"draft": 0.28, "standard": 0.20, "fine": 0.12, "extra_fine": 0.08, "strong": 0.20}


def process_for(vendor, machine_name, tier):
    """The process preset of a quality tier for this machine preset. A preset is compatible when it lists the machine in compatible_printers
    or its compatible_printers_condition holds for the machine. The tier is picked by the words in the name (Draft, Fine, ...), else by the
    layer height nearest to the tier's, scaled to the nozzle."""
    machine = flatten_any(vendor, "machine", machine_name)[0]
    names = []
    for root in pp.PROFILE_DIRS:
        base = os.path.join(root, vendor, "process")
        for _dirpath, _dirs, files in os.walk(base):
            names += [f[:-5] for f in files if f.endswith(".json") and not f.startswith("fdm_")]
        break
    compatible = []
    for name in sorted(set(names)):
        try:
            flat = _flatten_file(vendor, "process", name)
        except FileNotFoundError:
            continue
        compat = flat.get("compatible_printers") or []
        condition = flat.get("compatible_printers_condition") or ""
        if isinstance(compat, list) and machine_name in compat:
            compatible.append((name, flat, False))
        elif not compat and condition and _condition_holds(condition, machine):
            compatible.append((name, flat, True))
    words = TIER_WORDS[tier]
    hits = [(n, f, c) for n, f, c in compatible if any(w in n for w in words) and not (tier == "fine" and ("Extra Fine" in n or "SuperDetail" in n))]
    # Presets that list the machine are taken by the tier's words (the first by name). Presets a condition admits (Prusa's, named by layer
    # height and purpose, with several per nozzle) are taken by the layer height nearest to the tier's, scaled to the nozzle.
    if hits and not all(c for _, _, c in hits):
        return hits[0][0]
    nozzle = float((machine.get("nozzle_diameter") or ["0.4"])[0])
    want = TIER_LAYER[tier] * nozzle / 0.4
    wanted_kind = "STRUCTURAL" if tier == "strong" else "SPEED"
    ranked = []
    for name, flat, _by_condition in (hits or compatible):
        if "SOLUBLE" in name:
            continue
        try:
            layer = float(flat.get("layer_height"))
        except (TypeError, ValueError):
            continue
        ranked.append((abs(layer - want), 0 if wanted_kind in name.upper() else 1, name))
    return sorted(ranked)[0][2] if ranked else None


def swap_nozzle(name, nozzle):
    """A preset name with its 0.4 mm nozzle size replaced: '... 0.4 nozzle', '(0.4 nozzle)', or '@BBL X1C' (which gains ' 0.6 nozzle')."""
    if "0.4" in name:
        return name.replace("0.4", nozzle)
    return name + f" {nozzle} nozzle" if "@BBL" in name else name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--orca", required=True)
    ap.add_argument("--workdir", default="resolved-work")
    ap.add_argument("--out", required=True)
    ap.add_argument("--profiles", default="bbl,mk4s,k1")
    ap.add_argument("--settings", help="packages/settings: dump every printer model and quality tier it lists, as orca-<model>.<tier>.json")
    ap.add_argument("--only", help="comma separated model ids with --settings")
    ap.add_argument("--filament", help="with --settings and --only: dump these models with this filament preset instead of the default one (needs --tag)")
    ap.add_argument("--bed", help="build plate for the dump (Orca refuses a filament the default plate does not support, such as PETG on the cool plate)")
    ap.add_argument("--tag", help="name for the --filament dump: orca-<model>.<tier>.<tag>.json")
    ap.add_argument("--tiers", help="comma separated tiers to dump with --settings (default: all)")
    ap.add_argument("--nozzle", help="with --settings: dump the machine, process and filament presets of this nozzle size (0.2, 0.6, 0.8): the preset names of the 0.4 mm ones with the nozzle swapped")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    jobs = []
    if a.settings:
        machines = json.load(open(os.path.join(a.settings, "../profiles/machine.json")))["models"]
        speeds = json.load(open(os.path.join(a.settings, "../profiles/process-speeds.json")))["models"]
        only = set(a.only.split(",")) if a.only else None
        for model, entry in machines.items():
            if only and model not in only:
                continue
            vendor, machine = entry["orca"]["vendor"], entry["orca"]["profile"]
            try:
                flat = flatten_any(vendor, "machine", machine)[0]
            except FileNotFoundError:
                print(model, "no machine profile", vendor, machine)
                continue
            fils = flat.get("default_filament_profile") or []
            fil = (fils[0] if isinstance(fils, list) and fils else fils if isinstance(fils, str) else "") or ""
            if a.filament:
                fil = a.filament
            if not fil:
                print(model, "no default filament profile")
                continue
            for tier, path in (speeds.get(model) or {}).items():
                if a.tiers and tier not in a.tiers.split(","):
                    continue
                proc = path.split("/", 2)[-1]
                m2, p2, f2 = machine, proc, fil
                if a.nozzle and a.nozzle != "0.4":
                    m2 = swap_nozzle(machine, a.nozzle)
                    p2 = process_for(vendor, m2, tier)
                    if not p2:
                        print(model, tier, "no process preset for", m2)
                        continue
                    try:
                        flat2 = flatten_any(vendor, "machine", m2)[0]
                    except FileNotFoundError:
                        print(model, "no machine preset", m2)
                        continue
                    d2 = flat2.get("default_filament_profile") or []
                    f2 = (d2[0] if isinstance(d2, list) and d2 else d2 if isinstance(d2, str) else "") or fil
                tag = f".{a.tag}" if a.filament and a.tag else ""
                nz = f".n{a.nozzle}" if a.nozzle and a.nozzle != "0.4" else ""
                jobs.append((f"{model}.{tier}{tag}{nz}", vendor, m2, p2, f2))
    else:
        jobs = [(key, *pp.PROFILES[key]) for key in a.profiles.split(",")]
    for key, vendor, machine, process, filament in jobs:
        if os.path.exists(os.path.join(a.out, f"orca-{key}.json")):
            continue
        w = os.path.join(os.path.abspath(a.workdir), key)
        os.makedirs(os.path.join(w, "models"), exist_ok=True)
        stl = os.path.join(w, "models", "block.stl")
        model_lib.write_stl(stl, model_lib.MODELS["block"]())
        orca = parity.ParityOrca(slicers.Orca(a.orca).path, {})
        orca.prepare(w, {"cube": stl})
        try:
            mach = flatten_any(vendor, "machine", machine)[0]
            flatten_any(vendor, "process", process)
            _, filament = flatten_any(vendor, "filament", filament)
        except FileNotFoundError as e:
            print(key, "missing preset", e)
            continue
        # The comparison wants the maker's own layer change G-code, so this does not override it as profile_parity does.
        mach.update({"type": "machine", "name": "compare machine", "from": "User", "inherits": machine})
        if a.bed:
            mach["curr_bed_type"] = a.bed
        json.dump(mach, open(orca.files["machine"], "w"))
        proc = flatten_any(vendor, "process", process)[0]
        proc.update({"type": "process", "name": "compare process", "from": "User", "inherits": process, "compatible_printers": ["compare machine", machine]})
        proc.pop("compatible_printers_condition", None)
        json.dump(proc, open(orca.files["process"], "w"))
        fil, _ = flatten_any(vendor, "filament", filament)
        fil.update({"type": "filament", "name": "compare filament", "from": "User", "inherits": filament, "compatible_printers": ["compare machine", machine]})
        fil.pop("compatible_printers_condition", None)
        json.dump(fil, open(orca.files["filament"], "w"))
        out = os.path.join(w, "orca")
        os.makedirs(out, exist_ok=True)
        r = subprocess.run(orca._cmd(stl, out, ["--debug", "1", "--arrange", "0"]), capture_output=True, text=True)
        og = os.path.join(out, "plate_1.gcode")
        if not os.path.exists(og):
            print(key, "Orca produced no G-code:", (r.stdout + r.stderr)[-400:])
            continue
        block = pp.config_block(og)
        # Orca's CLI turns the prime tower off when the plate has one filament; the preset's own value is what a multi-color plate uses.
        if "enable_prime_tower" in proc:
            block["enable_prime_tower"] = proc["enable_prime_tower"]
        json.dump(block, open(os.path.join(a.out, f"orca-{key}.json"), "w"), indent=1, sort_keys=True)
        json.dump({"vendor": vendor, "machine": machine, "process": process, "filament": filament}, open(os.path.join(a.out, f"orca-{key}.names"), "w"))
        print(key, len(block), "settings")


if __name__ == "__main__":
    main()
