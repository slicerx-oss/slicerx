// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// SX_PROBE=1: slice the example plate through the native `slice` command
// with the Easy defaults and report launch and slice times.
import type { Host, PrintConfig } from '@slicerx/contracts'
import { EASY_DEFAULTS, readPreview } from '@slicerx/contracts'
import { applyEasy, defaultConfig } from '@slicerx/settings'
import { DEFAULT_MODEL, DEMO_MODELS } from '@slicerx/app'
import { invoke } from '@tauri-apps/api/core'

export async function runProbe(host: Host): Promise<void> {
  if (!(await invoke<boolean>('probe_enabled'))) return
  for (let i = 0; i < 100 && performance.getEntriesByName('sx-interactive').length === 0; i++) await new Promise((r) => setTimeout(r, 50))
  const report: Record<string, unknown> = { interactiveMs: Math.round(performance.getEntriesByName('sx-interactive')[0]?.startTime ?? -1) }
  try {
    const demo = DEMO_MODELS.find((m) => m.slug === DEFAULT_MODEL)
    if (!demo) throw new Error('The example model is missing')
    const mesh = await host.slicer.loadParts(demo.name, demo.build().parts)
    const config = applyEasy(EASY_DEFAULTS, defaultConfig() as PrintConfig)
    const t = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 128, 128, 0, 1]
    const result = await host.slicer.slice({ plate: { bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, objects: [{ id: 'example', name: demo.name, mesh: mesh.id, transform: t }] }, config })
    const preview = readPreview(await host.slicer.getPreview(result.id))
    Object.assign(report, { ok: true, triangles: mesh.triangles, layers: result.layerCount, segments: preview.segmentCount, sliceMs: Math.round(result.wallMs), timeS: Math.round(result.stats.timeS) })
  } catch (e) {
    Object.assign(report, { ok: false, error: e instanceof Error ? e.message : String(e) })
  }
  await invoke('probe_report', { report })
}
