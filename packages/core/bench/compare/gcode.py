# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Reads the same numbers out of every slicer's G-code, so the output can be compared like for like."""
import re

# Layer markers: the compatible one, and the tag Orca's processor writes for a Bambu Lab printer (finished
# SlicerX files for those printers carry it too).
LAYER_MARKS = (";LAYER_CHANGE", "; CHANGE_LAYER")
# Bambu Lab tags and the compatible ones they stand for.
_BAMBU_TAGS = (
    ("; CHANGE_LAYER", ";LAYER_CHANGE"),
    ("; Z_HEIGHT: ", ";Z:"),
    ("; LAYER_HEIGHT: ", ";HEIGHT:"),
    ("; FEATURE: ", ";TYPE:"),
    ("; LINE_WIDTH: ", ";WIDTH:"),
    ("; WIPE_START", ";WIPE_START"),
    ("; WIPE_END", ";WIPE_END"),
)


def is_layer_mark(ln):
    """True for a line that starts a layer, in either form."""
    return ln.startswith(LAYER_MARKS)


def plain(ln):
    """A Bambu Lab tag line in its compatible form (`; FEATURE: Outer wall` -> `;TYPE:Outer wall`); other lines as they are."""
    if ln.startswith("; "):
        for bambu, compatible in _BAMBU_TAGS:
            if ln.startswith(bambu):
                return compatible + ln[len(bambu):]
    return ln


_TIME = re.compile(r"(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(\d+)s")


def parse_duration(text):
    """'1h 51m 22s' -> seconds."""
    m = _TIME.search(text)
    if not m:
        return None
    d, h, mi, s = (int(x) if x else 0 for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + s


def stats(path):
    """Layers, extruded filament length, feature split and the slicer's own time estimate.

    Layers count layer markers (either form), or distinct Z of extruding moves when there are none.
    Filament is the sum of positive E deltas on moves that change X or Y (retractions and
    purges are excluded), so it is computed the same way for every slicer.
    """
    relative = False
    e = z = total = 0.0
    zs = set()
    by_type = {}
    kind = "unlabeled"
    layer_changes = arcs = lines = 0
    est = None
    with open(path, errors="replace") as f:
        for ln in f:
            lines += 1
            if ln[0] == ";":
                tag = plain(ln)
                if tag.startswith(";TYPE:"):
                    kind = tag[6:].strip()
                elif is_layer_mark(ln):
                    layer_changes += 1
                elif "total estimated time" in ln:
                    est = parse_duration(ln.split("total estimated time", 1)[1])
                elif est is None and "estimated printing time" in ln:
                    est = parse_duration(ln.split("=", 1)[-1])
                continue
            words = ln.split(";", 1)[0].split()
            if not words:
                continue
            g = words[0]
            if g == "M82":
                relative = False
            elif g == "M83":
                relative = True
            elif g in ("G2", "G3"):
                arcs += 1
            if g in ("G0", "G1", "G2", "G3", "G92"):
                fields = {w[0]: w[1:] for w in words[1:] if len(w) > 1}
                if "Z" in fields:
                    try:
                        z = float(fields["Z"])
                    except ValueError:
                        pass
                if "E" in fields:
                    try:
                        v = float(fields["E"])
                    except ValueError:
                        continue
                    if g == "G92":
                        e = v
                        continue
                    delta = v if relative else v - e
                    if not relative:
                        e = v
                    if delta > 0 and ("X" in fields or "Y" in fields):
                        total += delta
                        by_type[kind] = by_type.get(kind, 0.0) + delta
                        zs.add(round(z, 3))
    return {
        "layers": layer_changes or len(zs),
        "filament_mm": round(total, 1),
        "by_feature_mm": {k: round(v, 1) for k, v in sorted(by_type.items(), key=lambda kv: -kv[1])},
        "arc_moves": arcs,
        "lines": lines,
        "estimated_time_s": est,
    }
