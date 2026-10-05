# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Writes packages/profiles/cura/ultimaker.json: the UltiMaker S series (S3, S5, S7, S6, S8) from Cura's own
machine definitions, print core variants, material and quality profiles.

Cura keeps a printer's settings as formulas in a stack of containers (definition, variant, material,
quality). This script resolves them the way Cura 5.13 does (UM's ContainerStack and SettingFunction,
Cura's GlobalStack, ExtruderStack and CuraFormulaFunctions: extruder settings fall through to the global
stack, global settings with a `resolve` take it, formulas see the values of the stack that asked) and
writes the results under Orca's key names.

Usage: python3 scripts/gen-ultimaker.py <Cura resources directory> [Cura version]
The resources directory is `resources` of a Cura checkout, or `share/cura/resources` of an installed Cura.
"""
import ast
import base64
import configparser
import hashlib
import json
import math
import os
import re
import sys
import uuid
import xml.etree.ElementTree as ET

R = sys.argv[1]
CURA_VERSION = sys.argv[2] if len(sys.argv) > 2 else '5.13.0'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'profiles', 'cura', 'ultimaker.json')


class Fn:
    def __init__(self, code):
        self.code = code
        self.compiled = compile(code, code, 'eval')
        self.names = {n.id for n in ast.walk(ast.parse(code, mode='eval')) if isinstance(n, ast.Name)}


def flatten(settings, out):
    for k, v in settings.items():
        out[k] = {kk: vv for kk, vv in v.items() if kk != 'children'}
        if 'children' in v:
            flatten(v['children'], out)


def def_chain(did):
    d = json.load(open(os.path.join(R, 'definitions', did + '.def.json')))
    base, meta = def_chain(d['inherits']) if 'inherits' in d else ({}, {})
    flat = {}
    for cat in d.get('settings', {}).values():
        flatten(cat.get('children', {}), flat)
    for k, v in flat.items():
        base.setdefault(k, {}).update(v)
    for k, v in d.get('overrides', {}).items():
        base.setdefault(k, {}).update(v)
    meta = dict(meta)
    meta.update(d.get('metadata', {}))
    meta['_name'] = d['name']
    return base, meta


FDM, _ = def_chain('fdmprinter')


def def_value(props):
    if 'value' in props:
        v = props['value']
        return Fn(str(v)) if isinstance(v, str) else v
    return props.get('default_value')


def convert(key, text):
    if isinstance(text, str) and text.startswith('='):
        return Fn(text[1:])
    if not isinstance(text, str):
        return text
    t = FDM.get(key, {}).get('type', 'str')
    if t == 'float':
        return float(ast.literal_eval(text.replace(',', '.')))
    if t == 'int':
        return ast.literal_eval(text)
    if t == 'bool' and text.lower() in ('true', 'false'):
        return text.lower() == 'true'
    if t in ('bool', 'polygon', 'polygons'):
        return ast.literal_eval(text)
    return text


def read_cfg(path):
    cp = configparser.ConfigParser(interpolation=None)
    cp.optionxform = str
    cp.read(path)
    return cp


NS = {'um': 'http://www.ultimaker.com/material', 'cura': 'http://www.ultimaker.com/cura'}
# XmlMaterialProfile's map of material file settings to Cura setting keys.
MAT = {'print temperature': 'default_material_print_temperature', 'heated bed temperature': 'default_material_bed_temperature',
       'standby temperature': 'material_standby_temperature', 'print cooling': 'cool_fan_speed', 'retraction amount': 'retraction_amount',
       'retraction speed': 'retraction_speed', 'build volume temperature': 'build_volume_temperature'}


class Machine:
    """One machine's global stack and two extruder stacks."""

    def __init__(self, machine, variants, materials, quality_type):
        self.mdef, self.meta = def_chain(machine)
        self.machine = machine
        self.resolving = set()
        gq = self.quality(None, None, quality_type, True)
        self.g = {'containers': [{}, gq], 'defn': self.mdef, 'ext': False}
        self.ext = []
        trains = self.meta['machine_extruder_trains']
        for pos in sorted(trains, key=int):
            ed = json.load(open(os.path.join(R, 'extruders', trains[pos] + '.def.json')))
            edef, _ = def_chain(ed['inherits'])
            for k, v in ed.get('overrides', {}).items():
                edef.setdefault(k, {}).update(v)
            i = int(pos)
            mat, guid = self.material(materials[i], variants[i])
            q = self.quality(materials[i], variants[i], quality_type, False)
            self.ext.append({'containers': [{}, q, mat, self.variant(variants[i])], 'defn': edef, 'ext': True, 'pos': i, 'guid': guid})

    def variant(self, name):
        vd = os.path.join(R, 'variants')
        for f in sorted(os.listdir(vd)):
            if not f.startswith(self.machine + '_'):
                continue
            cp = read_cfg(os.path.join(vd, f))
            if cp['general'].get('name') == name and cp['metadata'].get('hardware_type') == 'nozzle' and cp['general'].get('definition') == self.machine:
                return {k: convert(k, v) for k, v in cp['values'].items()} if cp.has_section('values') else {}
        raise SystemExit(f'{self.machine} has no print core {name}')

    def material(self, base, variant):
        root = ET.parse(os.path.join(R, 'materials', base + '.xml.fdm_material')).getroot()
        vals = {}
        for e in root.findall('./um:properties/*', NS):
            if e.tag.endswith('diameter'):
                vals['material_diameter'] = e.text

        def node(n):
            for e in n.findall('./um:setting', NS):
                if e.get('key') in MAT:
                    vals[MAT[e.get('key')]] = e.text
            for e in n.findall('./cura:setting', NS):
                v = e.text
                vals[e.get('key')] = True if v.lower() == 'yes' else False if v.lower() == 'no' else v
        node(root.find('./um:settings', NS))
        names = {self.mdef['machine_name']['default_value'], self.meta['_name']}
        for m in root.findall('./um:settings/um:machine', NS):
            if not {i.get('product') for i in m.findall('./um:machine_identifier', NS)} & names:
                continue
            node(m)
            for h in m.findall('./um:hotend', NS):
                if h.get('id') == variant:
                    node(h)
        return {k: convert(k, v) for k, v in vals.items()}, root.find('./um:metadata/um:GUID', NS).text

    def quality(self, material, variant, quality_type, global_q):
        qd = os.path.join(R, 'quality', self.meta.get('quality_definition', self.machine))
        for f in sorted(os.listdir(qd)):
            cp = read_cfg(os.path.join(qd, f))
            md = cp['metadata']
            if md.get('quality_type') != quality_type:
                continue
            if global_q and md.get('global_quality') == 'True':
                return {k: convert(k, v) for k, v in cp['values'].items()}
            if not global_q and md.get('variant') == variant and md.get('material') == material:
                return {k: convert(k, v) for k, v in cp['values'].items()}
        return {}

    def raw(self, st, key):
        for c in st['containers']:
            if key in c:
                return c[key]
        if key in st['defn']:
            return def_value(st['defn'][key])
        return self.raw(self.g, key) if st['ext'] else None

    def prop(self, st, key, p):
        d = st['defn'].get(key)
        if d is None and st['ext']:
            return self.prop(self.g, key, p)
        return None if d is None else d.get(p)

    def per_ext(self, st, key):
        d = st['defn'].get(key) or FDM.get(key, {})
        return bool(d.get('settable_per_extruder', True))

    def call(self, fn, provider, root):
        prov = root if root is not None else provider
        loc = {}
        for n in fn.names:
            if n in FDM or n in prov['defn'] or n in self.g['defn']:
                v = self.get(prov, n, root)
                if v is not None:
                    loc[n] = v
        glob = {'math': math, 'uuid': uuid, 'base64': base64, 'hashlib': hashlib}
        glob.update(self.ops(root))
        try:
            return eval(fn.compiled, glob, loc)
        except Exception:
            return 0  # as SettingFunction does

    def ops(self, root):
        def value_in(pos, key):
            pos = int(pos)
            st = self.ext[pos if 0 <= pos < len(self.ext) else 0]
            v = self.raw(st, key)
            v = self.call(v, st, root) if isinstance(v, Fn) else v
            return v.lower() if isinstance(v, str) else v

        def values(key):
            out = []
            for st in self.ext:
                v = self.raw(st, key)
                if v is not None:
                    out.append(self.call(v, st, root) if isinstance(v, Fn) else v)
            return out or [self.get(self.g, key, root)]

        def any_with(key):
            for st in self.ext:
                v = self.raw(st, key)
                if (self.call(v, st, root) if isinstance(v, Fn) else v):
                    return str(st['pos'])
            return None
        return {'extruderValue': value_in, 'extruderValues': values, 'resolveOrValue': lambda k: self.get(self.g, k, root),
                'defaultExtruderPosition': lambda: '0', 'anyExtruderNrWithOrDefault': any_with,
                'anyExtruderWithMaterial': lambda k: '0', 'valueFromContainer': lambda k, i: self.get(self.g, k, root),
                'extruderValueFromContainer': lambda p, k, i: value_in(p, k), 'defaultValueInExtruder': value_in}

    def limit(self, st, key, root):
        lim = self.prop(st, key, 'limit_to_extruder')
        if lim is None:
            return -1
        try:
            return int(self.call(Fn(lim), st, root) if isinstance(lim, str) else lim)
        except (TypeError, ValueError):
            return -1

    def get(self, st, key, root=None):
        if st['ext']:
            if not self.per_ext(st, key):
                return self.get(self.g, key, root)
            root = root or st
            lim = self.limit(st, key, root)
            if lim not in (-1, st['pos']) and lim < len(self.ext):
                return self.get(self.ext[lim], key, root)
            v = self.raw(st, key)
            return self.call(v, st, root) if isinstance(v, Fn) else v
        res = self.prop(st, key, 'resolve')
        if res and key not in self.resolving and key not in st['containers'][0]:
            self.resolving.add(key)
            try:
                return self.call(Fn(res), st, root)
            finally:
                self.resolving.discard(key)
        lim = self.limit(st, key, root)
        if lim != -1 and self.per_ext(st, key) and lim < len(self.ext):
            return self.get(self.ext[lim], key, root)
        v = self.raw(st, key)
        return self.call(v, st, root) if isinstance(v, Fn) else v

    def G(self, key):
        return self.get(self.g, key)

    def E(self, key):
        return [self.get(st, key) for st in self.ext]


# The models, their Cura definition, the default print cores (Cura's and the maker's), and whether the
# build volume is enclosed and temperature controlled.
MODELS = [
    ('ultimaker-s3', 'ultimaker_s3', 'AA 0.4', 'BB 0.4'),
    ('ultimaker-s5', 'ultimaker_s5', 'AA 0.4', 'BB 0.4'),
    ('ultimaker-s7', 'ultimaker_s7', 'AA 0.4', 'BB 0.4'),
    ('ultimaker-s6', 'ultimaker_s6', 'AA+ 0.4', 'BB 0.4'),
    ('ultimaker-s8', 'ultimaker_s8', 'AA+ 0.4', 'BB 0.4'),
]
# Other nozzle sizes: the print cores for each extruder, falling back when the machine has no such core.
NOZZLES = {
    '0.25': [['AA 0.25'], ['AA 0.25']],
    '0.6': [['CC+ 0.6', 'CC 0.6'], ['CC+ 0.6', 'CC 0.6']],
    '0.8': [['AA 0.8'], ['BB 0.8', 'AA 0.8']],
}
# Cura quality types per SlicerX tier.
TIERS = {'draft': 'draft', 'standard': 'fast', 'fine': 'normal', 'extra_fine': 'high'}


def has_variant(machine, name):
    vd = os.path.join(R, 'variants')
    for f in os.listdir(vd):
        if f.startswith(machine + '_'):
            cp = read_cfg(os.path.join(vd, f))
            if cp['general'].get('name') == name and cp['general'].get('definition') == machine:
                return True
    return False


def num(v):
    v = float(v)
    return str(int(v)) if v == int(v) else repr(round(v, 4))


def pair(vals):
    return [num(v) for v in vals]


def qualities(machine, variant, material='generic_pla'):
    """The quality profiles Cura has for a print core and material (any material when None), by quality type."""
    mdef, meta = def_chain(machine)
    qd = os.path.join(R, 'quality', meta.get('quality_definition', machine))
    out = {}
    for f in sorted(os.listdir(qd)):
        md = read_cfg(os.path.join(qd, f))['metadata']
        if md.get('variant') == variant and md.get('quality_type') and (material is None or md.get('material') == material):
            out[md['quality_type']] = f
    return out


def layer_heights(machine, core):
    """The layer heights of every PLA quality Cura has for a print core (each quality type's global layer height)."""
    types = qualities(machine, core) or qualities(machine, core, None)
    return sorted({Machine(machine, [core, core], ['generic_pla', 'generic_pla'], qt).G('layer_height') for qt in types})


def machine_block(m, cores):
    w, d, h = m.G('machine_width'), m.G('machine_depth'), m.G('machine_height')
    flavor = m.G('machine_gcode_flavor')
    head = m.G('machine_head_with_fans_polygon')
    lift = [float(v) for v in m.E('retraction_hop')]
    out = {
        'printer_model': m.G('machine_name'),
        'printable_area': ['0x0', f'{num(w)}x0', f'{num(w)}x{num(d)}', f'0x{num(d)}'],
        'printable_height': num(h),
        'gcode_flavor': flavor.lower(),
        'nozzle_diameter': pair(m.E('machine_nozzle_size')),
        'print_core': list(cores),
        'extruder_offset': [f"{num(x)}x{num(y)}" for x, y in zip(m.E('machine_nozzle_offset_x'), m.E('machine_nozzle_offset_y'))],
        'toolchange_park_position': [f"{num(x)}x{num(y)}" for x, y in zip(m.E('machine_extruder_end_pos_x'), m.E('machine_extruder_end_pos_y'))],
        'extruder_type': ['Bowden', 'Bowden'],
        'single_extruder_multi_material': '0',
        'use_relative_e_distances': '0',
        'retraction_length': pair(m.E('retraction_amount')),
        'retraction_speed': pair(m.E('retraction_speed')),
        'deretraction_speed': pair(m.E('retraction_prime_speed')),
        'retraction_minimum_travel': pair(m.E('retraction_min_travel')),
        'retract_length_toolchange': pair(m.E('switch_extruder_retraction_amount')),
        'retract_speed_toolchange': pair(m.E('switch_extruder_retraction_speed')),
        'deretract_speed_extruder_change': pair(m.E('switch_extruder_prime_speed')),
        'retract_lift_toolchange': pair(h if on else 0 for h, on in zip(m.E('retraction_hop_after_extruder_switch_height'), m.E('retraction_hop_after_extruder_switch'))),
        # Cura's initial printing temperature, as a drop under the printing temperature.
        'toolchange_temperature_drop': pair(p - i for p, i in zip(m.E('material_print_temperature'), m.E('material_initial_print_temperature'))),
        'z_hop': pair(lift),
        'z_hop_types': ['Slope Lift', 'Slope Lift'],
        'hotend_heating_rate': pair(m.E('machine_nozzle_heat_up_speed')),
        'hotend_cooling_rate': pair(m.E('machine_nozzle_cool_down_speed')),
        'support_chamber_temp_control': '1' if m.G('machine_heated_build_volume') else '0',
        'machine_max_speed_x': pair([m.G('machine_max_feedrate_x')] * 2),
        'machine_max_speed_y': pair([m.G('machine_max_feedrate_y')] * 2),
        'machine_max_speed_z': pair([m.G('machine_max_feedrate_z')] * 2),
        'machine_max_speed_e': pair([m.G('machine_max_feedrate_e')] * 2),
        'machine_max_acceleration_x': pair([m.G('machine_max_acceleration_x')] * 2),
        'machine_max_acceleration_y': pair([m.G('machine_max_acceleration_y')] * 2),
        'machine_max_acceleration_z': pair([m.G('machine_max_acceleration_z')] * 2),
        'machine_max_acceleration_e': pair([m.G('machine_max_acceleration_e')] * 2),
        'machine_max_jerk_x': pair([m.G('machine_max_jerk_xy')] * 2),
        'machine_max_jerk_y': pair([m.G('machine_max_jerk_xy')] * 2),
        'machine_max_jerk_z': pair([m.G('machine_max_jerk_z')] * 2),
        'machine_max_jerk_e': pair([m.G('machine_max_jerk_e')] * 2),
        'extruder_clearance_radius': num(round(max(math.hypot(x, y) for x, y in head), 1)),
        'extruder_clearance_height_to_rod': num(m.G('gantry_height')),
        'extruder_clearance_height_to_lid': num(m.G('gantry_height')),
    }
    return out


def extruder_start(m):
    """Cura's extruder start code (the S6's and S8's pressure advance) as an Orca template: the material's
    pressure advance factor becomes the filament's pressure advance, written when the filament turns it on."""
    codes = {c for c in m.E('machine_extruder_start_code') if c}
    if not codes:
        return ''
    if len(codes) > 1:
        raise SystemExit(f'{m.machine}: the extruders start differently')
    code = codes.pop()
    if '{material_pressure_advance_factor}' in code:
        code = code.replace('{material_pressure_advance_factor}', '{pressure_advance[current_extruder]}')
        return '{if enable_pressure_advance[current_extruder]}' + code + '\n{endif}'
    if '{' in code:
        raise SystemExit(f'{m.machine}: a token the template does not know: {code}')
    return code


def process_block(m):
    """The speeds, accelerations and jerk of one quality, under Orca's keys."""
    E = lambda k: m.E(k)[0]
    travel_accel = E('acceleration_travel') if m.G('acceleration_travel_enabled') else E('acceleration_print')
    out = {
        'layer_height': num(m.G('layer_height')),
        'initial_layer_print_height': num(m.G('layer_height_0')),
        'outer_wall_speed': [num(E('speed_wall_0'))],
        'inner_wall_speed': [num(E('speed_wall_x'))],
        'sparse_infill_speed': [num(E('speed_infill'))],
        'internal_solid_infill_speed': [num(E('speed_topbottom'))],
        'top_surface_speed': [num(E('speed_roofing'))],
        'gap_infill_speed': [num(E('speed_wall_x'))],
        'support_speed': [num(E('speed_support'))],
        'support_interface_speed': [num(E('speed_support_interface'))],
        'bridge_speed': [num(E('bridge_wall_speed'))],
        'initial_layer_speed': [num(E('speed_print_layer_0'))],
        'initial_layer_infill_speed': [num(E('speed_print_layer_0'))],
        'travel_speed': [num(E('speed_travel'))],
        'travel_speed_z': [num(E('speed_z_hop'))],
        'default_acceleration': [num(E('acceleration_print'))],
        'outer_wall_acceleration': [num(E('acceleration_wall_0'))],
        'inner_wall_acceleration': [num(E('acceleration_wall_x'))],
        'sparse_infill_acceleration': [num(E('acceleration_infill'))],
        'top_surface_acceleration': [num(E('acceleration_roofing'))],
        'initial_layer_acceleration': [num(E('acceleration_layer_0'))],
        'travel_acceleration': [num(travel_accel)],
        # Idle cores wait at the material's standby temperature and heat up ahead of their switch: the time
        # Cura's heat-up speed needs from standby to the initial printing temperature.
        'ooze_prevention': '1',
        'preheat_time': num(min(120, math.ceil((E('material_initial_print_temperature') - E('material_standby_temperature')) / E('machine_nozzle_heat_up_speed')))),
    }
    # Cheetah (S6, S8) takes jerk in its own units (`M215`, thousandths); Orca's keys cannot hold them.
    if m.G('machine_gcode_flavor') != 'Cheetah':
        out.update({
            'default_jerk': [num(E('jerk_print'))],
            'outer_wall_jerk': [num(E('jerk_wall_0'))],
            'inner_wall_jerk': [num(E('jerk_wall_x'))],
            'infill_jerk': [num(E('jerk_infill'))],
            'top_surface_jerk': [num(E('jerk_roofing'))],
            'initial_layer_jerk': [num(E('jerk_layer_0'))],
            'travel_jerk': [num(E('jerk_travel'))],
        })
    return out


def main():
    models, presets, speeds, families, gmodels = {}, {}, {}, {}, {}
    for id_, machine, core0, core1 in MODELS:
        m = Machine(machine, [core0, core1], ['generic_pla', 'generic_pva'], 'fast')
        block = machine_block(m, [core0, core1])
        nozzles = {}
        for size, (a, b) in NOZZLES.items():
            ca = next((c for c in a if has_variant(machine, c)), None)
            cb = next((c for c in b if has_variant(machine, c)), None)
            if not ca or not cb:
                continue
            mat1 = 'generic_pla' if cb[:2] != 'BB' else 'generic_pva'
            n = Machine(machine, [ca, cb], ['generic_pla', mat1], 'fast')
            other = machine_block(n, [ca, cb])
            hs = layer_heights(machine, ca)
            other['min_layer_height'] = num(min(hs))
            other['max_layer_height'] = num(max(hs))
            nozzles[size] = {'printCores': [ca, cb], 'differs': {k: v for k, v in other.items() if block.get(k) != v}}
        q = qualities(machine, core0)
        heights = []
        tiers = {}
        for tier, qt in TIERS.items():
            if qt not in q:
                continue
            pm = Machine(machine, [core0, core0], ['generic_pla', 'generic_pla'], qt)
            name = f'Cura {CURA_VERSION}/{machine}/{qt} {core0} PLA'
            presets[name] = process_block(pm)
            tiers[tier] = name
            heights.append(pm.G('layer_height'))
        heights = layer_heights(machine, core0)
        block['min_layer_height'] = num(min(heights))
        block['max_layer_height'] = num(max(heights))
        speeds[id_] = tiers
        start = m.G('machine_start_gcode') or ''
        end = m.G('machine_end_gcode') or ''
        family = {'start': start, 'end': end, 'beforeLayerChange': '', 'layerChange': '', 'changeFilament': '', 'extruderStart': extruder_start(m)}
        fam = 'ultimaker_' + m.G('machine_gcode_flavor').lower()
        if families.get(fam, family) != family:
            fam = id_.replace('-', '_')
        families[fam] = family
        gmodels[id_] = fam
        models[id_] = {
            'cura': {'definition': machine, 'printCores': [core0, core1], 'materials': ['generic_pla', 'generic_pva'], 'quality': 'fast'},
            'machine': block,
            'nozzles': nozzles,
        }
    data = {
        'comment': ("UltiMaker S series machine, print core, quality and G-code settings, resolved from UltiMaker Cura's "
                    "definitions, variants, materials and quality profiles under Orca's key names by "
                    "packages/settings/scripts/gen-ultimaker.py. Derived from UltiMaker Cura, "
                    "Copyright (C) UltiMaker B.V. and the Cura contributors, LGPL-3.0-or-later. "
                    "The material GUIDs in sx-core come from UltiMaker's fdm_materials (CC0-1.0)."),
        'license': 'LGPL-3.0-or-later',
        'cura': {'version': CURA_VERSION, 'source': f'https://github.com/Ultimaker/Cura/tree/{CURA_VERSION}/resources'},
        'models': models,
        'presets': presets,
        'speeds': speeds,
        'families': families,
        'gcodeModels': gmodels,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(data, f, indent=1, sort_keys=False)
        f.write('\n')
    print(f'{len(models)} models, {len(presets)} presets -> {os.path.relpath(OUT)}')


main()
