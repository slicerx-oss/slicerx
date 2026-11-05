// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Phone alerts as the hub holds them, read only: whether it sends at all, and each registration (our phone's, and
// partner phones' own tokens) without the token. Registering is the phones' own, through their pairing.
import { productName } from '@slicerx/contracts'
import type { PushStatus } from '@slicerx/link-client'
import { z } from 'zod'
import { ToolInputError } from '../models'
import { serverTool, type ServerToolDeps } from './deps'

function readerOf(host: unknown): (() => Promise<PushStatus>) | undefined {
  const p = (host as { push?: { status?: () => Promise<PushStatus> } } | undefined)?.push
  return typeof p?.status === 'function' ? () => (p.status as () => Promise<PushStatus>).call(p) : undefined
}

export default (d: ServerToolDeps) => {
  const printers = d.printers
  if (!printers) return null
  return serverTool({
    name: 'push.status',
    title: 'Phone alert status',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'printers',
    ungated: true,
    description: `Read the phone alerts the ${productName()} hub sends while the app is closed (a print finished, stopped or needs the person, or a card waits). sending says whether the hub posts pushes at all. Each registration has tokenEnd (the token's last six characters, never the token), platform, prefs (printDone, printFailed, attention, approvals), createdAt and provider: expo for ${productName()}'s own phones and for a partner phone's own Expo token, apns or fcm for a partner token sent through that partner's gateway (gatewayHost). Partner registrations also carry partner (the app name) and sentThisHour against limits.partnerPushesPerHour. A partner phone without the approve right never gets approval alerts. Every push is fixed text that names no file, model or printer. Phones register themselves through their pairing; no tool can.`,
    input: z.object({}),
    hints: { idempotent: false, openWorld: true },
    async run() {
      const read = printers.kind === 'link' ? readerOf(printers.host) : undefined
      if (!read) throw new ToolInputError(`Phone alerts come from the ${productName()} hub; these printers have none.`, 'not_supported', { reason: 'no_hub' })
      const r = await read()
      d.gate.log.append({ tool: 'push.status', permission: 'read', decision: 'read', input_hash: '*', ok: true })
      const summary = `${r.sending ? 'Sending' : 'Not sending'} phone alerts: ${r.own} own phone${r.own === 1 ? '' : 's'}, ${r.partners} partner phone${r.partners === 1 ? '' : 's'}`
      return { summary, structured: { ...r } }
    },
  })
}
