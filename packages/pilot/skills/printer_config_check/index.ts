// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// printer_config_check: compare what a printer and its plugin report with the
// knowledge entry for that model, and list findings with sources.
import type { Cell } from '@slicerx/contracts'
import { z } from 'zod'
import { defineSkill } from '../../src/tool'
import { amsFit, arr, filamentDoc, obj, oneLine, printerDoc, strs } from '../d_common/index'

type Severity = 'info' | 'warn' | 'bad'
interface Finding {
  severity: Severity
  finding: string
  sources: string[]
}

export function createPrinterConfigCheck() {
  return defineSkill({
    name: 'printer_config_check',
    version: '1.0.0',
    permission: 'read',
    description:
      'Check one printer against the knowledge base entry for its model: input shaping and pressure advance notes, stock nozzle against the loaded filament, hotend limit, AMS compatibility of loaded materials, camera, and the model\'s own notes for mimir. Uses printer status and plugin status output. Firmware versions are only compared when the plugin reports one. Read only.',
    input: z.object({ printerId: z.string().min(1).describe('Printer id, such as "bay-1"') }),
    args: (i) => i.printerId,
    async run(i, ctx) {
      const info = (await ctx.host.printers.list()).find((p) => p.id === i.printerId)
      if (!info) return { ok: false, summary: `No printer "${i.printerId}"` }
      const st = await ctx.host.printers.status(i.printerId).catch(() => null)
      const plugin = await ctx.host.printers.callTool(info.plugin, 'status', { printerId: i.printerId }).catch(() => null)
      const doc = printerDoc(ctx, info.vendor, info.model)
      const findings: Finding[] = []
      const add = (severity: Severity, finding: string, sources: string[] = []): void => void findings.push({ severity, finding, sources })
      if (!st) add('bad', `${info.name} is not reachable, so nothing below reflects its current state`)
      else if (st.state === 'error' || st.state === 'offline') add('bad', `${info.name} is ${st.state}${st.message ? `: ${oneLine(st.message, 120)}` : ''}`)
      if (!doc) {
        add('info', `The knowledge base has no entry for ${info.vendor} ${info.model}, so only reported values are shown`)
      } else {
        const d = doc.data
        const motion = obj(d['motion'])
        if (motion['input_shaping'] === 'manual') add('info', `${doc.name} needs input shaping run by hand. Re-run it after moving the printer or changing belts or toolhead weight.`, strs(motion['src']))
        for (const c of arr(d['builtin_calibrations'])) {
          const cal = obj(c)
          const id = String(cal['id'] ?? '')
          if (/flow_dynamics|pressure/.test(id) && typeof cal['what'] === 'string') add('info', `${id.replaceAll('_', ' ')}: ${cal['what']}`, strs(cal['src']))
        }
        const hot = obj(d['hotend'])
        const stock = obj(hot['stock_nozzle'])
        const stockMat = String(stock['material'] ?? '')
        const maxT = Number(hot['max_temp_c'] ?? NaN)
        for (const slot of st?.slots ?? []) {
          if (!slot.material) continue
          const f = filamentDoc(ctx, slot.material)
          if (!f) continue
          const nozzle = obj(f.data['nozzle'])
          if (nozzle['hardened_required'] === true && /stainless/i.test(stockMat)) add('warn', `${slot.id} holds ${f.name}, which is abrasive, and the stock nozzle is ${stockMat.replaceAll('_', ' ')}. Fit a hardened nozzle first.`, [...strs(hot['src']), ...f.sources.slice(0, 1)])
          const maxNeeded = Number(obj(f.data['nozzle_temp_c'])['max'] ?? NaN)
          if (Number.isFinite(maxT) && Number.isFinite(maxNeeded) && maxNeeded > maxT) add('bad', `${slot.id} holds ${f.name}, which can need ${maxNeeded} C. The hotend stops at ${maxT} C.`, [...strs(hot['src']), ...f.sources.slice(0, 1)])
          if (info.filamentSystem === 'ams' && /bambu/i.test(info.vendor)) {
            const fit = amsFit(f)
            if (fit.ams === 'not_compatible') add('warn', `${slot.id} holds ${f.name} in the AMS, and Bambu lists it as not compatible with the AMS. Feed it from an external spool.`, fit.sources)
          }
        }
        if (strs(d['sensors']).includes('chamber_camera') && st && !st.cameraAvailable) add('warn', `${doc.name} has a chamber camera but none is reachable now. Check the network and LAN mode settings.`, strs(d['sensors_src']))
        for (const n of strs(d['pilot_notes']).slice(0, 4)) add('info', n, doc.sources.slice(0, 2))
      }
      // Firmware, when the plugin reports one.
      const fw = ['firmware', 'firmware_version', 'fw'].map((k) => obj(plugin)[k]).find((v): v is string => typeof v === 'string')
      if (fw) add('info', `Plugin reports firmware ${oneLine(fw, 40)}. Compare it with the latest release for ${info.model}.`)
      else add('info', 'The plugin status has no firmware version, so firmware was not compared.')
      const rank: Record<Severity, number> = { bad: 0, warn: 1, info: 2 }
      findings.sort((a, b) => rank[a.severity] - rank[b.severity])
      const sources = new Set<string>([...(doc?.sources.slice(0, 2) ?? []), ...findings.flatMap((f) => f.sources)])
      const rows: Cell[][] = findings.map((f) => [{ text: f.severity, tone: f.severity === 'bad' ? 'bad' : f.severity === 'warn' ? 'warn' : 'dim' }, f.finding])
      const bad = findings.filter((f) => f.severity === 'bad').length
      const warn = findings.filter((f) => f.severity === 'warn').length
      return {
        summary: `${info.name}: ${bad} problems, ${warn} warnings, ${findings.length - bad - warn} notes`,
        output: { printer: { id: info.id, name: info.name, model: info.model, state: st?.state ?? 'offline' }, knowledgeEntry: doc?.id ?? null, findings },
        display: [{ kind: 'table', head: ['level', 'finding'], rows }],
        untrusted: true,
        citations: ctx.kb.cite(sources),
      }
    },
  })
}
