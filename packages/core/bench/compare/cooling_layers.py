#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""cooling_layers.py <gcode> [slow_down_layer_time fan_cooling_layer_time fan_min fan_max close_first_layers]

Per layer of any slicer's G-code: the layer time as Orca 2.4.2's cooling buffer counts it (every move's length over
its commanded feed rate, E-only moves at their feed rate, G4 waits, nothing before the layer's first extrusion), the
fan that time gives (floor of the blend between the two times, M106 S as 255.5 per hundred cut to an integer), and the
M106 in force when the layer starts in the file. sx, Orca and Bambu Studio layers can be set side by side with it;
Bambu Studio writes its fan after the layer change, so its value shows one layer late. Standard library only.
"""
import math, re, sys
path = sys.argv[1]
slow, fcool, fmin, fmax, close = (float(x) for x in (sys.argv[2:7] if len(sys.argv) >= 7 else (5, 60, 20, 100, 1)))
lines = open(path, errors='replace').read().split('\n')
mark = re.compile(r'^(;LAYER_CHANGE|; CHANGE_LAYER)\s*$')
layers = []  # list of lists of lines
cur = None
fan_before = []
fan = None
for l in lines:
    if mark.match(l):
        cur = []
        layers.append(cur)
        fan_before.append(fan)
        continue
    m = re.match(r'^M106 S([\d.]+)', l)
    if m:
        fan = float(m.group(1))
    if cur is not None:
        cur.append(l)
# fan in force for layer i is the last M106 before layer i+1's marker
fans = fan_before
x = y = z = 0.0; F = 0.0; rel = True
def num(w, k, d):
    for t in w:
        if t[0] == k:
            try: return float(t[1:])
            except: return d
    return d
print('layer  T_s     fan%  S_rule  S_file')
for i, body in enumerate(layers):
    T = 0.0; started = False
    last = i == len(layers) - 1
    for l in body:
        # The last layer ends where the end G-code begins: the custom block every slicer opens after the last layer.
        if last and started and re.match(r'^(; FEATURE: Custom|;TYPE:Custom)\s*$', l):
            break
        c = l.split(';')[0].split()
        if not c: continue
        if c[0] == 'M83': rel = True; continue
        if c[0] == 'M82': rel = False; continue
        if c[0] == 'G4':
            if started: T += num(c[1:], 'S', 0) + num(c[1:], 'P', 0) / 1000
            continue
        if c[0] not in ('G0', 'G1', 'G2', 'G3'): continue
        nx, ny, nz = num(c[1:], 'X', x), num(c[1:], 'Y', y), num(c[1:], 'Z', z)
        F = num(c[1:], 'F', F)
        e = num(c[1:], 'E', None) if any(t[0] == 'E' for t in c[1:]) else None
        d = math.dist((x, y, z), (nx, ny, nz))
        if not started and e is not None and e > 0 and d > 0:
            started = True
        if started and F > 0:
            length = d if d > 0 else (abs(e) if e is not None else 0)
            T += length / (F / 60)
        x, y, z = nx, ny, nz
    if i < close:
        p = 0
    elif T < slow:
        p = fmax
    elif T < fcool:
        t = (T - slow) / (fcool - slow)
        p = math.floor(t * fmin + (1 - t) * fmax)
    else:
        p = 0
    s = int(255.5 * p / 100) if p > 0 else 0
    print(f'{i+1:5d} {T:7.2f} {p:5.0f} {s:6d} {str(fans[i]):>6}')
