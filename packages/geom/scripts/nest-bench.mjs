// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The true shape nesting benchmark against OrcaSlicer and Bambu Studio (docs/core-features.md).
//
// 1. Write the plates' parts and manifest (packages/geom/examples/nest_bench.rs):
//      cargo run --release -p sx-geom --example nest_bench -- write DIR
// 2. Arrange every plate with a reference slicer's command line, where it is installed. CFG holds
//    machine.json, process.json and filament.json (full presets with the inherited values filled in):
//      node nest-bench.mjs slicer --exe PATH --cfg CFG --in DIR --out OUT [--rotations 0|1]
//    Each plate's parts are loaded once per copy, arranged with `--arrange 1` (and
//    `--allow-rotations` unless --rotations 0) and exported as a 3MF; the parts the slicer kept on
//    plate 1 are counted. Run it once per setting worth trying (rotations, printer structure).
// 3. Arrange every plate with sx-geom:
//      cargo run --release -p sx-geom --example nest_bench -- run --gap 2 > ours.jsonl
// 4. Print the table and refresh the reference counts the regression test holds us to. Each slicer
//    takes a comma separated list of result files: the first is its default settings, and the best
//    column is the most parts any of them placed on that plate:
//      node nest-bench.mjs table --ours ours.jsonl --orca a.json,b.json --bambu c.json,d.json [--reference FILE]
// No dependencies: the 3MF (a zip) is read with node:zlib.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'

function args(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true
    else out._.push(a)
  }
  return out
}

/** The files of a zip archive, by name. Stored and deflated entries only, which is all 3MF uses. */
function unzip(buf) {
  let end = buf.length - 22
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0) throw new Error('not a zip file')
  const count = buf.readUInt16LE(end + 10)
  let at = buf.readUInt32LE(end + 16)
  const files = new Map()
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10)
    const size = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen)
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(dataAt, dataAt + size)
    files.set(name, method === 8 ? inflateRawSync(raw) : raw)
    at += 46 + nameLen + extraLen + commentLen
  }
  return files
}

/** Object ids on plate 1 of a 3MF the reference slicers wrote, with each object's name. */
function plateOne(file) {
  const files = unzip(readFileSync(file))
  const settings = files.get('Metadata/model_settings.config')?.toString('utf8') ?? ''
  const names = new Map()
  for (const m of settings.matchAll(/<object id="(\d+)">\s*<metadata key="name" value="([^"]*)"/g)) names.set(m[1], m[2])
  const plates = [...settings.matchAll(/<plate>([\s\S]*?)<\/plate>/g)].map((m) => m[1])
  const first = plates.find((p) => /key="plater_id" value="1"/.test(p)) ?? ''
  const ids = [...first.matchAll(/key="object_id" value="(\d+)"/g)].map((m) => m[1])
  return ids.map((id) => names.get(id) ?? '')
}

function slicer(o) {
  const manifest = JSON.parse(readFileSync(join(o.in, 'manifest.json'), 'utf8'))
  mkdirSync(o.out, { recursive: true })
  const results = { slicer: o.name ?? o.exe, plates: {} }
  for (const plate of manifest.plates) {
    if (o.plate && o.plate !== plate.name) continue
    const files = plate.parts.flatMap((p) => Array.from({ length: p.copies }, () => join(o.in, p.file)))
    const out = `${plate.name}.3mf`
    const t0 = Date.now()
    try {
      execFileSync(o.exe, ['--arrange', '1', ...(o.rotations === '0' ? [] : ['--allow-rotations']), '--load-settings', `${join(o.cfg, 'machine.json')};${join(o.cfg, 'process.json')}`, '--load-filaments', join(o.cfg, 'filament.json'), '--export-3mf', out, '--outputdir', resolve(o.out), ...files], { stdio: 'ignore', timeout: 30 * 60 * 1000 })
    } catch (e) {
      if (!existsSync(join(o.out, out))) {
        results.plates[plate.name] = { error: String(e.message ?? e).slice(0, 200) }
        continue
      }
    }
    const seconds = (Date.now() - t0) / 1000
    const kept = plateOne(join(o.out, out))
    const area = new Map(plate.parts.map((p) => [`${p.name}.stl`, p.areaMm2]))
    const used = kept.reduce((s, n) => s + (area.get(n) ?? 0), 0)
    const [w, d] = manifest.bedMm
    results.plates[plate.name] = { wanted: files.length, placed: kept.length, utilization: Math.round((used / (w * d)) * 1000) / 10, seconds }
    console.log(plate.name, JSON.stringify(results.plates[plate.name]))
  }
  writeFileSync(join(o.out, 'results.json'), `${JSON.stringify(results, null, 1)}\n`)
}

/** Per plate: the default run (the first file) and the run that placed the most parts. */
function runs(files) {
  const all = files.split(',').map((f) => JSON.parse(readFileSync(f, 'utf8')))
  const by = (name) => {
    const list = all.map((r) => ({ ...(r.plates[name] ?? {}), setting: r.slicer }))
    const best = list.reduce((m, x) => ((x.placed ?? -1) > (m.placed ?? -1) ? x : m), list[0] ?? {})
    return { first: list[0] ?? {}, best }
  }
  return by
}

function table(o) {
  const ours = new Map(readFileSync(o.ours, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.plate, r]))
  const orca = runs(o.orca)
  const bambu = runs(o.bambu)
  const rows = ['| Plate | Parts | SlicerX | Orca default | Orca best | Bambu default | Bambu best |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |']
  const reference = {}
  let more = 0
  let fewer = 0
  for (const [name, r] of ours) {
    const a = orca(name)
    const b = bambu(name)
    const cell = (x) => (x.placed === undefined ? 'n/a' : `${x.placed} (${x.utilization}%)`)
    rows.push(`| ${name} | ${r.wanted} | ${r.placed} (${r.utilization}%) | ${cell(a.first)} | ${cell(a.best)} | ${cell(b.first)} | ${cell(b.best)} |`)
    const best = Math.max(a.best.placed ?? 0, b.best.placed ?? 0)
    if (r.placed > best) more++
    if (r.placed < best) fewer++
    reference[name] = { ours: r.placed, orca: a.first.placed ?? null, orcaBest: a.best.placed ?? null, bambu: b.first.placed ?? null, bambuBest: b.best.placed ?? null }
  }
  console.log(rows.join('\n'))
  console.log(`\nmore parts than the best of both on ${more} of ${ours.size} plates, fewer on ${fewer}`)
  if (o.reference) writeFileSync(o.reference, `${JSON.stringify({ gapMm: Number(o.gap ?? 2), plates: reference }, null, 1)}\n`)
}

const o = args(process.argv.slice(2))
if (o._[0] === 'slicer') slicer(o)
else if (o._[0] === 'table') table(o)
else {
  console.error('usage: nest-bench.mjs slicer --exe PATH --cfg DIR --in DIR --out DIR [--name NAME] [--plate NAME] [--rotations 0|1] | table --ours FILE --orca FILES --bambu FILES [--reference FILE]')
  process.exit(2)
}
