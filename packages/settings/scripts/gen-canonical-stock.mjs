// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Records versioned hashes with the engine's shared parser, never profile text.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const arg = (name) => process.argv[process.argv.indexOf(name) + 1]
for (const name of ['--profiles', '--source', '--version', '--sx', '--output']) {
  if (!process.argv.includes(name) || !arg(name) || arg(name).startsWith('--')) throw new Error(`Missing ${name}`)
}
const root = arg('--profiles')
const machines = JSON.parse(readFileSync(new URL('../../profiles/machine.json', import.meta.url), 'utf8')).models
const directories = new Map()
function presets(vendor) {
  if (directories.has(vendor)) return directories.get(vendor)
  const files = new Map()
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.json')) {
        const value = JSON.parse(readFileSync(path, 'utf8'))
        if (typeof value.name === 'string') files.set(value.name, value)
        files.set(entry.name.slice(0, -5), value)
      }
    }
  }
  try { walk(join(root, vendor, 'machine')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  directories.set(vendor, files)
  return files
}
function resolve(files, name, trail = []) {
  if (trail.includes(name)) throw new Error(`Profile inheritance cycle: ${[...trail, name].join(', ')}`)
  const own = files.get(name)
  if (!own) return undefined
  const next = [...trail, name]
  const parent = own.inherits ? resolve(files, own.inherits, next) : {}
  if (own.inherits && !parent) throw new Error(`Missing parent ${own.inherits}`)
  const result = { ...parent }
  for (const include of own.include ?? []) {
    const part = resolve(files, include, next)
    if (!part) throw new Error(`Missing include ${include}`)
    Object.assign(result, part)
  }
  return Object.assign(result, own)
}

const pending = []
for (const [model, machine] of Object.entries(machines)) {
  if (!machine.orca) continue
  const files = presets(machine.orca.vendor)
  const names = new Set([machine.orca.profile, ...Object.values(machine.nozzles ?? {}).map((n) => n.orcaProfile).filter(Boolean)])
  for (const name of names) {
    const profile = resolve(files, name)
    if (!profile || typeof profile.gcode_flavor !== 'string' || !profile.gcode_flavor) continue
    for (const [key, value] of Object.entries(profile)) {
      if (!key.endsWith('_gcode') || key === 'emit_machine_limits_to_gcode') continue
      for (const text of Array.isArray(value) ? value : [value]) {
        if (typeof text !== 'string' || !text.trim()) continue
        pending.push({ identity: { model, firmware: profile.gcode_flavor }, key, text })
      }
    }
  }
}
const entries = new Map()
for (let start = 0; start < pending.length; start += 100) {
  const batch = pending.slice(start, start + 100)
  const parsed = JSON.parse(execFileSync(arg('--sx'), ['canonical-script', '-', '--batch'], {
    input: JSON.stringify(batch.map((p) => p.text)), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true,
  }))
  if (!Array.isArray(parsed) || parsed.length !== batch.length) throw new Error('Engine canonicalization result length mismatch')
  batch.forEach(({ identity, key, text }, i) => {
    const canonical = parsed[i]
    if (canonical.version !== 1 || (!canonical.error && !/^[0-9a-f]{64}$/.test(canonical.fingerprint))) throw new Error('Invalid canonicalization result')
    const exactFingerprint = createHash('sha256').update(text).digest('hex')
    const entry = { identity, key, source: arg('--source'), version: arg('--version'), exactFingerprint, canonicalVersion: 1, canonicalFingerprint: canonical.error ? null : canonical.fingerprint }
    entries.set(JSON.stringify(entry), entry)
  })
}
const output = [...entries.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
if (output.length === 0) throw new Error('No stock scripts found; refusing to write an empty catalog')
writeFileSync(arg('--output'), `${JSON.stringify({ schemaVersion: 1, scripts: output }, null, 2)}\n`)
process.stderr.write(`${output.length} stock script fingerprints, ${output.filter((s) => s.canonicalFingerprint).length} canonical\n`)
