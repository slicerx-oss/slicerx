// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds src/parts/generated/standard-parts.json, the standard parts table, from a folder of checked category files
// (bearings.json, motors.json, raspberry-pi.json and so on). In each file, every record's measurements are objects
// with value, unit and source_url (status, derivation, reason and limit where they apply); everything else that is
// text is kept as information about the record. Values are copied as they are: a null stays null, never a guess.
//   pnpm --filter @slicerx/pilot parts:build <folder>
//   pnpm --filter @slicerx/pilot parts:build <folder> --check   (exits 1 when the table differs from the folder)
//   pnpm --filter @slicerx/pilot parts:build <folder> --out <file>   (writes the table there instead)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPartsTable, type PartCategory, type PartRecord, type PartSize, type PartsTable } from '../src/parts/table'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'parts', 'generated', 'standard-parts.json')

const LICENSE = 'Facts transcribed from the published datasheets, drawings and charts each value names in source_url. The table is Apache-2.0; see REUSE.toml.'

/** Words a request uses for each category. A category not listed here is named by its file name. */
const WORDS: Record<string, string[]> = {
  bearings: ['bearing', 'ball bearing'],
  motors: ['motor', 'stepper', 'stepper motor', 'nema'],
  'screw-holes': ['screw', 'bolt', 'clearance hole', 'tap drill'],
  'heat-set-inserts': ['insert', 'heat set insert', 'threaded insert'],
  'raspberry-pi': ['raspberry pi', 'rpi'],
  spools: ['spool', 'filament spool', 'reel'],
  'spur-gears': ['gear', 'spur gear'],
  gopro: ['gopro', 'gopro mount'],
  phones: ['phone', 'smartphone', 'iphone', 'pixel'],
  cells: ['battery', 'cell'],
  arduino: ['arduino', 'arduino board'],
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Obj = { [k: string]: Json }

const isObj = (v: Json | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isMeasure = (v: Json | undefined): v is Obj => isObj(v) && 'value' in v && ('unit' in v || v['status'] === 'unsourced')
const str = (v: Json | undefined): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

function size(key: string, m: Obj, where: string): PartSize {
  const value = m['value'] as PartSize['value']
  const out: PartSize = { key, value, unit: str(m['unit']) ?? null, source_url: str(m['source_url']) ?? null }
  for (const k of ['limit', 'derivation', 'reason', 'locator', 'verified_utc', 'note'] as const) {
    const v = str(m[k])
    if (v) out[k] = v
  }
  const status = m['status']
  if (status === 'derived' || status === 'unsourced') out.status = status
  else if (status !== undefined) throw new Error(`${where} ${key}: unknown status ${JSON.stringify(status)}`)
  return out
}

/** Splits a record into its sizes and its text facts, with dotted keys for nested values. */
function flatten(v: Json, key: string, sizes: PartSize[], info: Record<string, string>, where: string): void {
  if (isMeasure(v)) {
    sizes.push(size(str(v['field']) ?? key, v, where))
    return
  }
  if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) flatten(x, key ? `${key}.${k}` : k, sizes, info, where)
    return
  }
  if (Array.isArray(v)) {
    if (v.every((x) => !isObj(x))) {
      if (v.length) info[key] = v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ')
      return
    }
    v.forEach((x, i) => {
      // a list of named entries (ports) keys each by its name; a list of measurements by their field names
      const name = isObj(x) ? str(x['name']) : undefined
      if (isObj(x) && name) {
        const { name: _n, ...rest } = x
        flatten(rest, `${key}.${name}`, sizes, info, where)
      } else if (isMeasure(x)) flatten(x, `${key}.${i}`, sizes, info, where)
      else flatten(x, `${key}.${i}`, sizes, info, where)
    })
    return
  }
  if (v !== null && v !== undefined && v !== '') info[key] = String(v)
}

/** A name without its revision words: "Raspberry Pi 4 Model B" also reads "Raspberry Pi 4". */
function trimmed(name: string): string {
  return name.replace(/\s+(model\s+[a-z]\+?|rev\.?\s*\d+|r\d+)$/i, '').trim()
}

/** The record's display name and the other names a request may use for it. */
function naming(category: string, r: Obj): { name: string; aliases: string[] } {
  const id = String(r['id'])
  const own = Array.isArray(r['aliases']) ? r['aliases'].filter((a): a is string => typeof a === 'string') : []
  const title = str(r['title']) ?? str(r['name']) ?? str(r['model'])
  const add = (name: string, aliases: string[]) => ({ name, aliases: [...new Set([...aliases, ...own])].filter((a) => a !== name && a !== id) })
  switch (category) {
    case 'bearings':
      return add(`${id} bearing`, [`${id}ZZ`, `${id}2RS`, `${id}-2RS`, `${id}RS`, `${id}Z`, `${id}2Z`, `${id}-2Z`])
    case 'motors': {
      const fam = /^nema\s*(\d+)$/i.exec(str(r['frame_family']) ?? '')
      const maker = str(r['manufacturer'])
      return add(`${maker ? `${maker} ` : ''}${id}${fam ? ` (NEMA ${fam[1]})` : ''}`, fam ? [`NEMA ${fam[1]}`, `NEMA${fam[1]}`] : [])
    }
    case 'screw-holes':
      return add(`${id} screw`, [`${id} bolt`])
    case 'heat-set-inserts': {
      const thread = str(isObj(r['thread']) ? r['thread']['value'] : undefined) ?? id
      const m = /^(M\d+(?:\.\d+)?)/i.exec(thread)?.[1] ?? thread
      return add(`${id.split('-')[0] ?? ''} ${m} heat-set insert`.trim(), [`${m} insert`, `${m} heat set insert`, `${m} threaded insert`, `${thread} insert`])
    }
    case 'raspberry-pi': {
      const name = title ?? id
      const short = trimmed(name)
      const bare = short.replace(/^raspberry\s+/i, '')
      return add(name, [short, bare, bare.replace(/^pi\b/i, 'RPi')])
    }
    case 'spools': {
      const cap = isObj(r['nominal_capacity']) ? r['nominal_capacity']['value'] : undefined
      const maker = id.split('-')[0] ?? id
      const Maker = maker.charAt(0).toUpperCase() + maker.slice(1)
      const mat = str(r['material'])
      return typeof cap === 'number' ? add(`${Maker} ${cap} kg${mat ? ` ${mat}` : ''} spool`, [`${Maker} ${cap} kg`, `${Maker} ${cap}kg spool`]) : add(title ?? id, [])
    }
    case 'spur-gears': {
      const words = id.replaceAll('_', ' ')
      return add(`spur gear ${words}`, [words, `gear ${words}`])
    }
    case 'gopro':
      return add('GoPro mount (interlocking fingers)', ['GoPro mount', 'GoPro fingers'])
    case 'cells': {
      const maker = str(r['manufacturer'])?.replace(/\s*\(.*\)$/, '')
      const format = str(r['format'])
      const model = title ?? id
      const ansi = (str(r['designation']) ?? '').split(/,\s*/).map((d) => d.replace(/^(ANSI|IEC)-/, '')).filter(Boolean)
      return add(`${maker ? `${maker} ` : ''}${model}${format ? ` (${format})` : ''}`, [model, ...(maker ? [`${maker} ${model}`] : []), ...(format ? [format, `${format} battery`, `${format} cell`] : []), ...ansi])
    }
    default: {
      // "UNO R3 (A000066)" by Arduino: also "Arduino UNO R3", "Arduino UNO", "UNO R3" and the code "A000066"
      const name = title ?? id
      const maker = str(r['manufacturer'])
      const base = name.replace(/\s*\(([^)]*)\)\s*$/, '').trim()
      const code = /\(([^)]*)\)\s*$/.exec(name)?.[1]
      const full = (s: string) => (maker && !s.toLowerCase().startsWith(maker.toLowerCase()) ? `${maker} ${s}` : s)
      return add(full(name), [base, trimmed(base), full(base), full(trimmed(base)), ...(code ? [code] : [])])
    }
  }
}

/** Reads every category file in `dir` into one table, in file name order. */
export function buildPartsTable(dir: string): PartsTable {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'validation.json')
    .sort()
  const categories: PartCategory[] = []
  const records: PartRecord[] = []
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Json
    if (!isObj(doc) || !Array.isArray(doc['records'])) continue
    const category = basename(f, '.json')
    categories.push({ id: category, words: WORDS[category] ?? [category.replace(/s$/, '').replaceAll('-', ' ')], scope: str(doc['scope']) ?? '', checked_utc: str(doc['checked_utc']) ?? '' })
    for (const r of doc['records']) {
      if (!isObj(r) || typeof r['id'] !== 'string') throw new Error(`${f}: a record without an id`)
      const sizes: PartSize[] = []
      const info: Record<string, string> = {}
      const { id: _id, title: _t, aliases: _a, ...rest } = r
      flatten(rest, '', sizes, info, `${f} ${r['id']}`)
      records.push({ category, id: r['id'], ...naming(category, r), info, sizes })
    }
  }
  // the loader's own checks: schema, unique ids, a source on every value
  return loadPartsTable({ schema_version: 1, license: LICENSE, categories, records })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const outAt = args.indexOf('--out')
  const out = outAt >= 0 ? resolve(args[outAt + 1] ?? '') : OUT
  const dir = args.find((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1))
  if (!dir || (outAt >= 0 && !args[outAt + 1])) {
    console.error('Usage: build-parts.ts <folder of category files> [--check] [--out <file>]')
    process.exit(2)
  }
  const table = buildPartsTable(resolve(dir))
  const text = `${JSON.stringify(table, null, 2)}\n`
  if (args.includes('--check')) {
    if (readFileSync(out, 'utf8') !== text) {
      console.error(`${out} is out of date with ${dir}: run pnpm --filter @slicerx/pilot parts:build ${dir}`)
      process.exit(1)
    }
  } else {
    writeFileSync(out, text)
    console.log(`Wrote ${table.records.length} records in ${table.categories.length} categories to ${out}`)
  }
}
