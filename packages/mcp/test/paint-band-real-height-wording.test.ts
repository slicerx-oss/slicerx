// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A painted band that stands for a real feature goes at that feature's real height, as the tools say it, word for word:
// in design.plan's colors field and in the paint target of paint.preview and the app link's paint preview, read
// through each tool's input schema as a client gets it.
import { toolSpec, type PilotTool } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { appPaintTools } from '../src/app-paint'
import { paintTools } from '../src/paint'
import { createPlanRegistry } from '../src/design-check'
import { createCardPlans } from '../src/tab-tools'
import { NO_ENGINE_HOST } from '../src/toolset'

const BAND =
  "A band that stands for a real feature (a stripe, a trim line, the line where one paint meets another) sits at that feature's real height scaled to the model, looked up first when it isn't known; never a thin token band in its place."

const field = (tool: PilotTool<never>, name: string): string | undefined => (toolSpec(tool).inputSchema.properties as Record<string, { description?: string }>)[name]?.description

describe('a band that stands for a real feature', () => {
  it('sits at its real height in design.plan\'s colors, after the band painted on by height', () => {
    const plan = createCardPlans(createPlanRegistry()).planTool()
    expect(field(plan, 'colors')).toContain(`painted on by height. ${BAND} Left out, the part prints in one default filament`)
    expect(plan.version).toBe('1.25.0')
  })

  it('sits at its real height in the paint target of paint.preview and the app link\'s paint preview', () => {
    const preview = paintTools(NO_ENGINE_HOST).find((t) => t.name === 'paint.preview')!
    const app = appPaintTools(undefined, 'SlicerX').find((t) => t.name === 'app.paint_preview')!
    for (const tool of [preview, app]) {
      const target = field(tool, 'target')
      expect(target, tool.name).toContain(`even on a body built from many steps. ${BAND}`)
      expect(target?.endsWith(BAND), tool.name).toBe(true)
    }
    expect(preview.version).toBe('1.7.0')
    expect(app.version).toBe('1.4.0')
  })
})
