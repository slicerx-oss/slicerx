// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineTool, type PilotTool, type ToolOutput } from '@slicerx/pilot'
import type { AppLinkCaller } from './app-route'
import { ToolInputError, type ErrorCode } from './errors'
import { projectSettingsReadInput } from './project-settings-input'

const CODES: Record<string, ErrorCode> = { invalid_input: 'invalid_input', bad_request: 'invalid_input', busy: 'busy', read_only: 'not_supported', denied: 'not_supported', not_found: 'not_supported' }

export function appSettingsTools(link: AppLinkCaller | undefined, appName: string): PilotTool<never>[] {
  return [defineTool({
    name: 'app.settings',
    version: '1.0.0',
    source: 'settings',
    permission: 'read',
    description: `Read project print settings in ${appName}: explicit overrides and effective values for the shown plate, including filament calibration and plate choices. shadowed lists overrides superseded by those choices. supported lists editable numeric, switch and choice process and filament keys, plus checked infill rotation templates and extra solid layers. readOnly lists plate type, filament mapping, print order and flush keys supplied by their own controls. Scripts, free text and printer settings are omitted. Optional keys narrows the values. Change or clear overrides with project.set_overrides and --app. Requires the open app with its link on.`,
    input: projectSettingsReadInput,
    async run(i) {
      if (!link) throw new ToolInputError(`Open ${appName} with its app link on and start this server with --printers link.`, 'not_configured')
      try {
        return await link.call<ToolOutput>('settings.get', i)
      } catch (e) {
        const code = String((e as { code?: unknown }).code ?? '')
        const message = e instanceof Error ? e.message : String(e)
        if (['app_link_off', 'app_closed', 'forbidden', 'unauthorized'].includes(code)) throw new ToolInputError(`The app link is unavailable: ${message}`, 'not_configured')
        throw new ToolInputError(message, CODES[code] ?? 'internal_error')
      }
    },
  })] as PilotTool<never>[]
}
