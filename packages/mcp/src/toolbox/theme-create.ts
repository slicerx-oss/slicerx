// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTheme, themeToCss, themeToVars, type Theme, type ThemeInput } from '@slicerx/ui/theme'
import { z } from 'zod'
import { builtInNames, builtInThemes, checkTheme, themeInput } from '../theming'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'theme.create',
    title: 'Create a theme',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'theme',
    ungated: true,
    description: [
      'Build a theme for an embedded SlicerX: overrides on top of a built-in base, covering colors (Subban role names: purple is the accent, pink commerce, cyan live data, green ok, orange attention, red error), the gradient, fonts, radii and the spacing unit.',
      'Returns the full theme, its CSS variables, a stylesheet scoped to a selector, and a WCAG contrast check; fix any failing pair before shipping.',
      'The gradient is for the layered X mark and at most one hero moment; controls, including the primary button, use the solid accent color.',
      'With save: true it writes <name>.json and <name>.css to the server output folder. The page applies it with applyTheme(theme) or <ThemeProvider theme={theme}>, or by loading the stylesheet.',
    ].join(' '),
    input: z.object({
      base: z.enum(builtInNames).default('subban'),
      overrides: themeInput,
      selector: z.string().max(120).default(':root').describe('CSS selector the stylesheet targets, such as ":root" or \'[data-sx-theme="acme"]\''),
      save: z.boolean().default(false),
    }),
    hints: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
    async run(args) {
      const theme = createTheme(args.overrides as ThemeInput, builtInThemes[args.base] as Theme)
      const css = themeToCss(theme, args.selector)
      const checks = checkTheme(theme)
      const failing = checks.filter((c) => c.ok === false)
      const out: Record<string, unknown> = { theme, vars: themeToVars(theme), css, contrast: checks }
      if (args.save) {
        const dir = join(d.policy.outDir, 'themes')
        mkdirSync(dir, { recursive: true })
        const json = join(dir, `${theme.name}.json`)
        const sheet = join(dir, `${theme.name}.css`)
        writeFileSync(json, `${JSON.stringify(theme, null, 2)}\n`)
        writeFileSync(sheet, `${css}\n`)
        out['files'] = { json, css: sheet }
      }
      const summary = `Theme "${theme.name}" (${theme.scheme}, based on ${args.base}): ${failing.length === 0 ? 'every checked pair passes' : `${failing.length} contrast pair${failing.length === 1 ? '' : 's'} below the minimum: ${failing.map((f) => `${f.pair} ${f.ratio}:1, needs ${f.required}:1`).join('; ')}`}.`
      return { summary, structured: out, text: `${summary}\n\n${css}` }
    },
  })
