// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The order to paint a body of its own color in, as the tools say it, word for word: by feature first, then its top by
// direction, then any band across features by height last. Read through the input schema of paint.preview and the app
// link's paint preview as a client gets it, right after the sentence on a band's real height.
import { toolSpec, type PilotTool } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { appPaintTools } from '../src/app-paint'
import { paintTools } from '../src/paint'
import { NO_ENGINE_HOST } from '../src/toolset'

const BAND =
  "A band that stands for a real feature (a stripe, a trim line, the line where one paint meets another) sits at that feature's real height scaled to the model, looked up first when it isn't known; never a thin token band in its place."

const ORDER =
  'Painting a body by feature also colors its top faces. Paint a body of its own color by feature first, then give its top its own color with direction "top" at a small angle (about 5 degrees), and paint any band across features by height last.'

const field = (tool: PilotTool<never>, name: string): string | undefined => (toolSpec(tool).inputSchema.properties as Record<string, { description?: string }>)[name]?.description

describe('the order a body of its own color is painted in', () => {
  it('follows the real-height sentence in the paint target of paint.preview and the app link\'s paint preview', () => {
    const preview = paintTools(NO_ENGINE_HOST).find((t) => t.name === 'paint.preview')!
    const app = appPaintTools(undefined, 'SlicerX').find((t) => t.name === 'app.paint_preview')!
    for (const tool of [preview, app]) {
      const target = field(tool, 'target')
      expect(target, tool.name).toContain(`even on a body built from many steps. ${BAND} ${ORDER}`)
      expect(target?.endsWith(ORDER), tool.name).toBe(true)
    }
    expect(preview.version).toBe('1.8.0')
    expect(app.version).toBe('1.4.0')
  })
})
