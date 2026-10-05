// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Theming tools: read the built-in themes, and build a theme for an embedded
// SlicerX (colors, fonts, gradient, radii, spacing) with a contrast check and
// the stylesheet the integrator's page loads. The server has no page of its
// own, so "setting" a theme means producing the files the page applies.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createTheme, nocturne, resolveColor, themes, themeToCss, themeToVars, type Theme, type ThemeInput } from '@slicerx/ui/theme'
import { z } from 'zod'

export interface ContrastCheck {
  pair: string
  ratio: number | null
  required: number
  ok: boolean | null
}

function rgb(color: string): [number, number, number] | undefined {
  const hex = color.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(hex)) return [0, 1, 2].map((i) => parseInt(hex.charAt(i).repeat(2), 16)) as [number, number, number]
  if (/^[0-9a-f]{6}$/i.test(hex)) return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
  return undefined
}

function luminance([r, g, b]: [number, number, number]): number {
  const c = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b)
}

/** WCAG contrast ratio of two hex colors, or null when either is not a hex color. */
export function contrast(a: string, b: string): number | null {
  const x = rgb(a)
  const y = rgb(b)
  if (!x || !y) return null
  const [hi, lo] = [luminance(x), luminance(y)].sort((m, n) => n - m) as [number, number]
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

/** The readability rules from the theming guide: body text at WCAG AA, visible control edges, readable text on the gradient. */
export function checkTheme(theme: Theme): ContrastCheck[] {
  const c = theme.colors
  const pairs: [string, string, string, number][] = [
    ['fg on ink0', c.fg, c.ink0, 4.5],
    ['fg on ink1', c.fg, c.ink1, 4.5],
    ['fg on ink2', c.fg, c.ink2, 4.5],
    ['fg on ink3', c.fg, c.ink3, 4.5],
    ['muted on ink1', c.muted, c.ink1, 4.5],
    // A hairline against a raised fill. Controls are identified by their fill and label, so this edge is
    // decoration: the SlicerX palettes sit at 1.16 (light) to 1.29 (dark), and 1.15 keeps the rule
    // against a border that disappears into its fill.
    ['line against ink3', c.line, c.ink3, 1.15],
    ['onGrad on gradient start', c.onGrad, resolveColor(theme, theme.gradient.from), 4.5],
    ['onGrad on gradient end', c.onGrad, resolveColor(theme, theme.gradient.to), 4.5],
    ['onGrad on accent (primary button)', c.onGrad, c.purple, 4.5],
  ]
  return pairs.map(([pair, a, b, required]) => {
    const ratio = contrast(a, b)
    return { pair, ratio, required, ok: ratio === null ? null : ratio >= required }
  })
}

const color = z.string().min(1).max(64)
const colorKeys = Object.keys(nocturne.colors) as (keyof Theme['colors'])[]
const themeInput = z
  .object({
    name: z.string().regex(/^[a-z0-9-]{1,40}$/, 'lowercase letters, digits and dashes').optional(),
    scheme: z.enum(['dark', 'light']).optional(),
    colors: z.object(Object.fromEntries(colorKeys.map((k) => [k, color.optional()])) as Record<keyof Theme['colors'], z.ZodOptional<typeof color>>).partial().optional(),
    gradient: z.object({ from: color, to: color, angle: z.string().max(16) }).partial().optional(),
    fonts: z.object({ display: z.string().max(200), body: z.string().max(200), mono: z.string().max(200), href: z.string().url().max(500) }).partial().optional(),
    radius: z.object({ xs: z.string().max(16), sm: z.string().max(16), md: z.string().max(16), lg: z.string().max(16) }).partial().optional(),
    spacing: z.object({ unit: z.number().min(4).max(16) }).partial().optional(),
  })
  .strict()

type Result = (data: object, text?: string) => CallToolResult

export function registerThemingTools(server: McpServer, opts: { outDir: string; ok: Result; guard(fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> }): void {
  const { ok, guard } = opts
  const names = Object.keys(themes) as (keyof typeof themes)[]
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const

  server.registerTool(
    'slicerx_theme_get',
    {
      title: 'Get a built-in theme',
      description:
        'Return a built-in theme (nocturne, the dark default; nocturneLight; forge, an example rebrand) as the theme object, its CSS variables and a ready stylesheet. Use it as the base for slicerx_theme_create.',
      inputSchema: { name: z.enum(names as [string, ...string[]]).default('nocturne') },
      annotations: readOnly,
    },
    (args) =>
      guard(() => {
        const theme = themes[args.name as keyof typeof themes]
        return ok({ theme, vars: themeToVars(theme), css: themeToCss(theme), contrast: checkTheme(theme) })
      }),
  )

  server.registerTool(
    'slicerx_theme_create',
    {
      title: 'Create a theme',
      description: [
        'Build a theme for an embedded SlicerX: overrides on top of a built-in base, covering colors (Nocturne role names: purple is the accent, pink commerce, cyan live data, green ok, orange attention, red error), the gradient, fonts, radii and the spacing unit.',
        'Returns the full theme, its CSS variables, a stylesheet scoped to a selector, and a WCAG contrast check; fix any failing pair before shipping.',
        'The gradient is for the layered X mark and at most one hero moment; controls, including the primary button, use the solid accent color.',
        'With save: true it writes <name>.json and <name>.css to the server output folder. The page applies it with applyTheme(theme) or <ThemeProvider theme={theme}>, or by loading the stylesheet.',
      ].join(' '),
      inputSchema: {
        base: z.enum(names as [string, ...string[]]).default('nocturne'),
        overrides: themeInput,
        selector: z.string().max(120).default(':root').describe('CSS selector the stylesheet targets, such as ":root" or \'[data-sx-theme="acme"]\''),
        save: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      guard(() => {
        const theme = createTheme(args.overrides as ThemeInput, themes[args.base as keyof typeof themes])
        const css = themeToCss(theme, args.selector)
        const checks = checkTheme(theme)
        const failing = checks.filter((c) => c.ok === false)
        const out: Record<string, unknown> = { theme, vars: themeToVars(theme), css, contrast: checks }
        if (args.save) {
          const dir = join(opts.outDir, 'themes')
          mkdirSync(dir, { recursive: true })
          const json = join(dir, `${theme.name}.json`)
          const sheet = join(dir, `${theme.name}.css`)
          writeFileSync(json, `${JSON.stringify(theme, null, 2)}\n`)
          writeFileSync(sheet, `${css}\n`)
          out['files'] = { json, css: sheet }
        }
        const summary = `Theme "${theme.name}" (${theme.scheme}, based on ${args.base}): ${failing.length === 0 ? 'every checked pair passes' : `${failing.length} contrast pair${failing.length === 1 ? '' : 's'} below the minimum: ${failing.map((f) => `${f.pair} ${f.ratio}:1, needs ${f.required}:1`).join('; ')}`}.`
        return ok(out, `${summary}\n\n${css}`)
      }),
  )
}
