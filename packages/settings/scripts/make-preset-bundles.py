# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Writes OrcaSlicer and Bambu Studio preset bundles in the apps' own export format, from the system
# profiles of the installed app. Neither app's command line can export a bundle, so this follows the
# export code (Orca 2.4.2 ExportConfigsDialog::archive_preset_bundle_to_file and
# archive_filament_bundle_to_file, Bambu Studio 2.8 the same functions) and Preset::save for the
# preset files: only the keys that differ from the parent, plus from, inherits, name, version and
# the *_settings_id key, sorted, four space indent; bundle_structure.json is compact with sorted keys.
#
#   python3 make-preset-bundles.py orca  /Applications/OrcaSlicer.app/Contents/Resources/profiles out
#   python  make-preset-bundles.py bambu "C:\Program Files\Bambu Studio\resources\profiles" out
#
# fixtures/preset-files holds the output of OrcaSlicer 2.4.2 on macOS and Bambu Studio 2.8.2 on Windows, renamed
# orca-2.4.2-printer.orca_printer, orca-2.4.2-filament.orca_filament, bambu-studio-2.8.2-printer.bbscfg and
# bambu-studio-2.8.2-filament.bbsflmt.
import json, os, sys, time, zipfile

app, root, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
vendor_dir = os.path.join(root, 'BBL')


def semver(v):
    return '.'.join(str(int(p)) for p in v.split('.'))


version = semver(json.load(open(os.path.join(root, 'BBL.json'), encoding='utf-8'))['version'])

# name -> system preset, per kind folder
index = {}
for kind in ('machine', 'process', 'filament'):
    for dirpath, _, files in os.walk(os.path.join(vendor_dir, kind)):
        for f in files:
            if f.endswith('.json'):
                try:
                    j = json.load(open(os.path.join(dirpath, f), encoding='utf-8'))
                except Exception:
                    continue
                if isinstance(j, dict) and 'name' in j:
                    index[(kind, j['name'])] = j


def resolved(kind, name):
    j = index[(kind, name)]
    base = resolved(kind, j['inherits']) if j.get('inherits') else {}
    out = dict(base)
    out.update(j)
    return out


def dump(obj):
    return json.dumps(obj, indent=4, sort_keys=True, ensure_ascii=False) + '\n'


SID = {'machine': 'printer_settings_id', 'process': 'print_settings_id', 'filament': 'filament_settings_id'}


def user_preset(kind, name, parent, changes):
    if parent:
        assert (kind, parent) in index, f'no system preset {parent}'
        full = resolved(kind, parent)
        for k, v in changes.items():
            assert full.get(k) != v or k.endswith('extruder_id') or k.endswith('extruder_variant'), f'{k} does not change {parent}'
    p = dict(changes)
    p['from'] = 'User'
    p['inherits'] = parent
    p['name'] = name
    p['version'] = version
    p[SID[kind]] = [name] if kind == 'filament' else name
    return p


def zip_bundle(path, files, structure):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for arc, body in files:
            z.writestr(arc, body)
        z.writestr('bundle_structure.json', json.dumps(structure, separators=(',', ':'), sort_keys=True, ensure_ascii=False))


clock = str(int(time.time()))

if app == 'orca':
    printer = user_preset('machine', 'My A1 0.4 nozzle', 'Bambu Lab A1 0.4 nozzle', {
        'retraction_length': ['0.9'], 'z_hop': ['0.6'], 'nozzle_type': ['hardened_steel'],
    })
    process = user_preset('process', 'My 0.20mm Standard @BBL A1', '0.20mm Standard @BBL A1', {
        'wall_loops': '3', 'sparse_infill_density': '20%', 'sparse_infill_pattern': 'gyroid', 'seam_position': 'back', 'brim_type': 'no_brim', 'top_shell_layers': '6',
    })
    filament = user_preset('filament', 'My PLA Basic @BBL A1', 'Bambu PLA Basic @BBL A1', {
        'nozzle_temperature': ['215'], 'nozzle_temperature_initial_layer': ['215'], 'filament_flow_ratio': ['0.97'], 'pressure_advance': ['0.025'], 'enable_pressure_advance': ['1'],
    })
    ext = ('orca_printer', 'orca_filament')
    vendor_key, filament_vendor = 'printer_vendor', 'BBL'
    filaments = [filament]
else:
    printer = user_preset('machine', 'My A1 mini 0.4 nozzle', 'Bambu Lab A1 mini 0.4 nozzle', {
        'printer_extruder_id': ['1'], 'printer_extruder_variant': ['Direct Drive Standard'], 'retraction_length': ['0.9'], 'z_hop_types': ['Spiral Lift'],
    })
    process = user_preset('process', 'My 0.20mm Standard @BBL A1M', '0.20mm Standard @BBL A1M', {
        'print_extruder_id': ['1'], 'print_extruder_variant': ['Direct Drive Standard'], 'wall_loops': '3', 'sparse_infill_density': '25%', 'sparse_infill_pattern': '2dlattice', 'top_one_wall_type': 'all top', 'enable_height_slowdown': '1',
    })
    filament = user_preset('filament', 'My PLA Basic @BBL A1M', 'Bambu PLA Basic @BBL A1M', {
        'filament_extruder_variant': ['Direct Drive Standard'], 'nozzle_temperature': ['225'], 'filament_flow_ratio': ['0.97'], 'circle_compensation_speed': ['180'], 'filament_scarf_seam_type': ['external'],
    })
    # A filament made with Create filament: a root preset with its own filament_id and every value written out.
    base = resolved('filament', 'Bambu PLA Matte @BBL A1M')
    root_preset = {k: v for k, v in base.items() if k not in ('type', 'instantiation', 'setting_id', 'description', 'filament_id', 'inherits', 'from', 'name', 'compatible_printers', 'renamed_from')}
    root_preset.update({'filament_vendor': ['Matte Works'], 'filament_cost': ['21.99'], 'nozzle_temperature': ['215'], 'compatible_printers': ['My A1 mini 0.4 nozzle'], 'filament_extruder_variant': ['Direct Drive Standard']})
    root_preset = user_preset('filament', 'Matte Works PLA @My A1 mini 0.4 nozzle', '', root_preset)
    root_preset['filament_id'] = 'P4d3f1a9'
    index[('filament', root_preset['name'])] = root_preset
    tuned = user_preset('filament', 'Matte Works PLA Tuned', 'Matte Works PLA @My A1 mini 0.4 nozzle', {
        'filament_extruder_variant': ['Direct Drive Standard'], 'filament_flow_ratio': ['0.95'], 'slow_down_layer_time': ['10'],
    })
    ext = ('bbscfg', 'bbsflmt')
    vendor_key, filament_vendor = 'filament_vendor', 'Bambu Lab'
    filaments = [filament, root_preset, tuned]

pname = printer['name']
files = [(f'printer/{pname}.json', dump(printer))]
files += [(f"filament/{f['name']}.json", dump(f)) for f in filaments]
files.append((f"process/{process['name']}.json", dump(process)))
zip_bundle(os.path.join(out, f'{pname}.{ext[0]}'), files, {
    'version': '', 'bundle_id': f'offline_{pname}_{clock}', 'bundle_type': 'printer config bundle', 'printer_preset_name': pname,
    'printer_config': [files[0][0]], 'filament_config': [a for a, _ in files[1:-1]], 'process_config': [files[-1][0]],
})

# The filament bundle holds one product: every user preset whose base preset has that name before the @.
if app == 'orca':
    fam, fvendor, group = 'My PLA Basic', filament_vendor, [filament]
else:
    fam, fvendor, group = 'Matte Works PLA', 'Matte Works', [root_preset, tuned]
paths = [f"{fvendor}/{f['name']}.json" for f in group]
zip_bundle(os.path.join(out, f'{fam}.{ext[1]}'), [(p, dump(f)) for p, f in zip(paths, group)], {
    'version': '', 'bundle_id': f'offline_{fam}_{clock}', 'bundle_type': 'filament config bundle', 'filament_name': fam,
    vendor_key: [{'vendor': fvendor, 'filament_path': paths}],
})

# The preset files on their own, for loading into the app's command line.
for kind, p in [('machine', printer), ('process', process)] + [('filament', f) for f in filaments]:
    os.makedirs(os.path.join(out, 'files', kind), exist_ok=True)
    open(os.path.join(out, 'files', kind, p['name'] + '.json'), 'w', encoding='utf-8').write(dump(p))
print('version', version, 'wrote', sorted(os.listdir(out)))
