// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Small helpers for the release gate (docs/release-gate.md): masking what could be a secret, bounded waits, file
// hashes and reading temperature changes out of G-code. No dependencies beyond Node.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The addresses the gate may use: release-gate test accounts only (docs/release-gate.md). */
export const QA_ACCOUNT = /^[a-z0-9._+-]+@qa\.slicerx\.app$/

/**
 * Masks anything in a text that could be a secret before it reaches a log or the report: JWTs, bearer tokens, sign-in
 * codes and tokens in addresses, Supabase keys, the bridge's per-run token (64 hex digits) and sign-in callbacks.
 */
export function mask(text) {
  return String(text ?? '')
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[jwt]')
    .replace(/(Bearer\s+)[^\s"',]+/gi, '$1[masked]')
    .replace(/([a-z][\w+.-]*:\/\/auth\/callback)[?#][^\s"'<>]*/gi, '$1?[masked]')
    .replace(/([?&#](?:code|token|access_token|refresh_token|id_token|token_hash|apikey|api_key|key|otp)=)[^&#\s"'<>]+/gi, '$1[masked]')
    .replace(/\bsb_(publishable|secret)_[\w-]+/g, 'sb_$1_[masked]')
    .replace(/\b[0-9a-f]{64}\b/gi, '[token]')
}

/**
 * Calls `check` every `everyMs` until it returns something other than null or undefined, or `timeoutMs` passes.
 * `onWait(waitedMs)` runs between checks (progress lines). Errors from `check` propagate.
 */
export async function waitUntil(check, { timeoutMs, everyMs = 1000, onWait } = {}) {
  const started = Date.now()
  for (;;) {
    const value = await check()
    const waitedMs = Date.now() - started
    if (value !== null && value !== undefined) return { value, waitedMs, timedOut: false }
    if (waitedMs >= timeoutMs) return { value: null, waitedMs, timedOut: true }
    await onWait?.(waitedMs)
    await sleep(Math.min(everyMs, Math.max(0, timeoutMs - waitedMs)))
  }
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

/** Every M104 and M109 in G-code with the Z it happens at (the last Z a move named before it). */
export function temperatureChanges(gcode) {
  let z = 0
  const out = []
  for (const raw of gcode.split('\n')) {
    const line = raw.split(';')[0]
    const mz = /^G[01]\b.*\bZ(-?[\d.]+)/i.exec(line)
    if (mz) z = Number(mz[1])
    const mt = /^(M10[49])\b.*\bS(\d+(?:\.\d+)?)/i.exec(line)
    if (mt) out.push({ cmd: mt[1].toUpperCase(), s: Number(mt[2]), z })
  }
  return out
}

/**
 * A temperature tower's check. The printer's start G-code and the first layer set temperatures of their own; the
 * tower's floors are the last changes of the print (before the end G-code turns the heater off): exactly `expected`,
 * one M104 per floor, at rising Z, `floorMm` apart (within half a millimetre). Returns { ok, floors, before, why }.
 */
export function towerCheck(gcode, expected, floorMm) {
  const all = temperatureChanges(gcode).filter((t) => t.cmd === 'M104' && t.s > 0)
  const changes = all.filter((t, i) => i === 0 || t.s !== all[i - 1].s)
  const floors = changes.slice(-expected.length)
  const before = changes.slice(0, Math.max(0, changes.length - expected.length))
  const temps = floors.map((t) => t.s)
  const same = temps.length === expected.length && temps.every((t, i) => t === expected[i])
  const rising = floors.every((t, i) => i === 0 || t.z > floors[i - 1].z)
  const gaps = floors.slice(1).map((t, i) => t.z - floors[i].z)
  const spaced = floorMm === undefined || gaps.every((g) => Math.abs(g - floorMm) <= 0.5)
  const why = !same
    ? `expected the last changes to be ${expected.join(', ')}; the G-code changes through ${changes.map((t) => t.s).join(', ') || 'nothing'}`
    : !rising
      ? 'the changes do not rise with Z'
      : spaced
        ? ''
        : `the floors are ${gaps.map((g) => g.toFixed(2)).join(', ')} mm apart, not ${floorMm}`
  return { ok: same && rising && spaced, floors, before, why }
}

/** Seconds as a person reads them: 1 h 20 min, 57 min, 40 s. */
export function duration(s) {
  if (typeof s !== 'number' || !Number.isFinite(s)) return '?'
  const m = Math.round(s / 60)
  if (s < 60) return `${Math.round(s)} s`
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`
}

/** A file-name-safe slug. */
export const slug = (t) =>
  String(t)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'x'
