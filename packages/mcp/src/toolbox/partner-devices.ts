// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Partner phones as the hub holds them, read only: another company's phone app the person paired in the app under
// that app's name. Pairing, letting one approve and revoking it are the person's, in Settings, Printer bridge, Devices.
import { productName } from '@slicerx/contracts'
import type { PartnerDevices } from '@slicerx/link-client'
import { z } from 'zod'
import { ToolInputError } from '../models'
import { serverTool, type ServerToolDeps } from './deps'

function readerOf(host: unknown): (() => Promise<PartnerDevices>) | undefined {
  const p = (host as { partners?: { devices?: () => Promise<PartnerDevices> } } | undefined)?.partners
  return typeof p?.devices === 'function' ? () => (p.devices as () => Promise<PartnerDevices>).call(p) : undefined
}

export default (d: ServerToolDeps) => {
  const printers = d.printers
  if (!printers) return null
  return serverTool({
    name: 'partner.devices',
    title: 'Partner phones',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'printers',
    ungated: true,
    description: `Read the partner phones the ${productName()} hub answers away from home: phone apps from other companies that the person paired in Settings, Printer bridge, Devices, each under its app's name. Each device has pairingId, partner (the app name), name and platform (the phone), rights (request: may ask to pause or stop a print; approve: may approve cards as the person's own phone does (pause, stop, skip, and a remote start after a plate check), never ones a partner app asked for, and answer mimir's questions; off until the person turns it on), addedAt, online (connected over the relay now), relayBytesToday against limits.relayBytesPerDay, and push (provider expo, apns or fcm, and platform) when it registered for alerts. remoteAccess says whether Remote access is on. Partner phones paired while Remote access was off are listed once it is on. Never a key. Pairing, changing rights and revoking are done by the person in the app; no tool can.`,
    input: z.object({}),
    hints: { readOnly: true, idempotent: false, openWorld: true },
    async run() {
      const read = printers.kind === 'link' ? readerOf(printers.host) : undefined
      if (!read) throw new ToolInputError(`Partner phones pair with the ${productName()} app through its hub; these printers have none.`, 'not_supported', { reason: 'no_hub' })
      const r = await read()
      d.gate.log.append({ tool: 'partner.devices', permission: 'read', decision: 'read', input_hash: '*', ok: true })
      const n = r.devices.length
      const names = [...new Set(r.devices.map((x) => x.partner))]
      const summary = n ? `${n} partner phone${n === 1 ? '' : 's'} (${names.join(', ')}), ${r.devices.filter((x) => x.online).length} connected now` : 'No partner phones'
      return { summary: r.remoteAccess ? summary : `${summary}; Remote access is off`, structured: { ...r } }
    },
  })
}
