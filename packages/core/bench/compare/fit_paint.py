#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Fits the child vertex rotations of split paint triangles to OrcaSlicer's output (see paintdecode.py)."""
import argparse
import itertools
import os
import sys

import paintdecode as pd
import probe_paintcode as pp
import slicers

TRI = ((118.0, 0.0), (138.0, 0.0), (138.0, 20.0))


def leaf(state):
    return ("leaf", state)


def split(n, special, kids):
    return ("split", n, special, kids)


def encode(tree):
    out = []

    def go(t):
        if t[0] == "leaf":
            out.extend(pp.leaf(t[1]))
        else:
            out.append(t[1] | (t[2] << 2))
            for k in t[3]:
                go(k)

    go(tree)
    return "".join(f"{n:X}" for n in reversed(out))


def score(rows, code, rot):
    subs = pd.decode(code, TRI, rot)
    bad = total = 0
    for layer, cells in rows.items():
        z = 0.2 * layer - 0.1
        for y, t in cells:
            pt = (y, z)
            if not pd.inside(pt, TRI):
                continue
            # skip points close to any sub-triangle edge, where the wall's sampling is uncertain
            near = False
            for v, _ in subs:
                for i in range(3):
                    a, b = v[i], v[(i + 1) % 3]
                    dx, dy = b[0] - a[0], b[1] - a[1]
                    L = (dx * dx + dy * dy) ** 0.5 or 1.0
                    d = abs(dx * (pt[1] - a[1]) - dy * (pt[0] - a[0])) / L
                    if d < 0.7:
                        near = True
            if near:
                continue
            want = pd.state_at(subs, pt)
            total += 1
            if want is None or max(want, 1) != t + 1:
                bad += 1
    return bad, total


def random_tree(rng, depth):
    if depth == 0 or rng.random() < 0.35:
        return leaf(rng.choice([1, 2, 3, 4]))
    n = rng.choice([1, 2, 3])
    return split(n, rng.randrange(3), [random_tree(rng, depth - 1) for _ in range(n + 1)])


def check_random(a):
    import random
    rng = random.Random(a.seed)
    d = os.path.abspath(a.workdir)
    orca = slicers.Orca(a.orca).path
    worst = 0
    for i in range(a.random):
        tree = split(rng.choice([1, 2, 3]), rng.randrange(3), []) 
        n = tree[1]
        tree = split(n, tree[2], [random_tree(rng, 2) for _ in range(n + 1)])
        code = encode(tree)
        rows = pp.map_for(code, 4, d, orca)
        bad, total = score(rows, code, pd.ROT)
        print(f"random {i}: code {code} mismatches {bad} of {total}")
        worst = max(worst, bad)
    return 0 if worst == 0 else 1


def sweep(a):
    """Every parent layout and special side with one child split again, against the fitted layout."""
    d = os.path.abspath(a.workdir)
    orca = slicers.Orca(a.orca).path
    bad_any = 0
    for n in (1, 2, 3):
        for s in range(3):
            for k in range(n + 1):
                for m, t in ((1, 0), (1, 1), (1, 2), (2, 0), (3, 0)):
                    kids = [leaf(1)] * (n + 1)
                    kids = list(kids)
                    kids[k] = split(m, t, [leaf(2 + (j % 3)) for j in range(m + 1)])
                    code = encode(split(n, s, kids))
                    rows = pp.map_for(code, 4, d, orca)
                    bad, total = score(rows, code, pd.ROT)
                    if bad:
                        bad_any += 1
                    print(f"parent {n}/{s} child {k} split {m}/{t}: {bad} of {total}")
    return 0 if not bad_any else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sweep", action="store_true")
    ap.add_argument("--orca")
    ap.add_argument("--workdir", default="fit-work")
    ap.add_argument("--random", type=int, default=0, help="check this many random nested codes against the fitted layout")
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    if a.sweep:
        return sweep(a)
    if a.random:
        return check_random(a)
    d = os.path.abspath(a.workdir)
    orca = slicers.Orca(a.orca).path
    for n in (1, 2, 3):
        for k in range(n + 1):
            kids = [leaf(1)] * (n + 1)
            kids = list(kids)
            kids[k] = split(1, 0, [leaf(2), leaf(3)])
            code = encode(split(n, 0, kids))
            rows = pp.map_for(code, 3, d, orca)
            res = []
            for r in range(3):
                rot = {1: [0, 0], 2: [0, 0, 0], 3: [0, 0, 0, 0]}
                rot[n][k] = r
                # the child's own rotation r applies to the child that is split; the inner children keep 0
                res.append((score(rows, code, rot), r))
            print(f"split {n} child {k}: {res}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
