// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { themeToCss, themeToVars, type Theme } from '@slicerx/ui/theme'
import { z } from 'zod'
import { builtInNames, builtInThemes, checkTheme } from '../theming'
import { serverTool } from './deps'

export default () =>
  serverTool({
    name: 'theme.get',
    title: 'Get a built-in theme',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'theme',
    ungated: true,
    description:
      'Return a built-in theme (subban, the dark default; subbanLight; forge, an example rebrand) as the theme object, its CSS variables and a ready stylesheet. Use it as the base for slicerx_theme_create.',
    input: z.object({ name: z.enum(builtInNames).default('subban') }),
    async run(args) {
      const theme = builtInThemes[args.name] as Theme
      return { summary: theme.name, structured: { theme, vars: themeToVars(theme), css: themeToCss(theme), contrast: checkTheme(theme) } }
    },
  })
