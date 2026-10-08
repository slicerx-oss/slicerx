// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// e. Every starter design opened from the Vault and sliced on the gate's printer (Bambu Lab A1, 0.4 mm, PLA, no
// connection): one design alone on the plate, zero warnings, its time and grams, and for the temperature tower one
// M104 per floor in the exported G-code (written to the bridge's own temporary folder, never sent anywhere).
import { readFileSync } from 'node:fs'
import { STARTERS, TOWER } from '../lib/starters.mjs'
import { duration, towerCheck } from '../lib/util.mjs'
import { isGatePrinter } from './start.mjs'

export async function starters(s, { only } = {}) {
  const st0 = await s.state()
  if (!isGatePrinter(st0)) s.stop('the printer is the A1, 0.4 mm', st0.printer)
  s.check(`sliced on ${st0.printer.vendor} ${st0.printer.model}, ${st0.printer.nozzleMm} mm, ${st0.filament?.[0]?.type ?? '?'}`, st0.filament?.[0]?.type === 'PLA', st0.filament?.[0])
  const who = await s.user()
  s.info(who.signedIn ? `signed in as ${who.email}` : 'signed out (anonymous downloads)')
  const table = []
  for (const slug of only ?? STARTERS) {
    if (!(await s.clearPlate())) {
      s.check(`${slug}: the plate clears first`, false)
      continue
    }
    const r = await s.call('app_open_vault_design', { id: slug, timeoutMs: 120_000 })
    if (r.error) {
      s.check(`${slug}: opens from the Vault`, false, r.error)
      // A failed download leaves its sheet open with Try again in place of Open; close it for the next design.
      if ((await s.ids())['vault-listing-close']) await s.click('vault-listing-close').catch(() => undefined)
      continue
    }
    const { id, title } = r.data.listing
    const objs = r.data.state.plate.objects
    s.check(`${title}: alone on the plate`, objs.length > 0 && objs.every((o) => o.vaultListing === id), objs.map((o) => o.name))
    const sl = await s.call('app_slice', { timeoutMs: 600_000 })
    if (sl.error || sl.data?.status !== 'done') {
      s.check(`${title}: slices`, false, sl.error ?? sl.data)
      continue
    }
    const st = await s.state()
    const warnings = [
      ...(sl.data.warnings ?? []).map((w) => `slice: ${w.message}`),
      ...st.plate.objects.flatMap((o) => (o.listWarnings ?? []).map((w) => `${o.name}: ${w.text}`)),
    ]
    const line = `${duration(sl.data.timeS)}, ${sl.data.filamentG} g, ${sl.data.layers} layers`
    s.check(`${title}: zero warnings (${line})`, warnings.length === 0, warnings.length ? warnings : undefined)
    table.push({ title, time: duration(sl.data.timeS), grams: sl.data.filamentG, layers: sl.data.layers, warnings: warnings.length })
    await s.shot(slug, `${title}: ${line}, ${warnings.length} warnings`)
    if (slug === TOWER.slug) {
      const g = await s.call('app_export_gcode', {})
      if (g.error) {
        s.check(`${title}: G-code exports`, false, g.error)
        continue
      }
      const check = towerCheck(readFileSync(g.data.path, 'utf8'), TOWER.temps, TOWER.floorMm)
      const at = (list) => list.map((f) => `M104 S${f.s} at Z ${f.z.toFixed(2)}`)
      s.check(`${title}: one M104 per floor (${TOWER.temps.join(', ')}), ${TOWER.floorMm} mm apart`, check.ok, { floors: at(check.floors), beforeTheTower: at(check.before), ...(check.why ? { why: check.why } : {}) })
    }
  }
  s.info('times and grams', table)
}
