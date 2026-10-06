// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A failed connection test in plain words: one sentence on what went wrong and what to do. The
// copy is keyed by the failure kind the bridge reports (tls, auth, timeout), never by parsing its
// message; the raw message goes only into Copy details.
import { bambuFamily, bambuGuide } from './bambu-lan'
import type { AuthNeed, TestOutcome } from './setup-registry'
import { appName } from '../edition'

export type FailureKind = 'tls' | 'auth' | 'no-answer' | 'other'

export type FailureAction = 'report' | 'update' | 'retry'

export interface FailureCopy {
  kind: FailureKind
  title: string
  body: string
  /** Extra lines: where the code is, what to switch on. */
  tips: string[]
  actions: FailureAction[]
}

/**
 * The kind of a failed test, from the bridge's stable `kind` (`tls`, `auth`, `timeout`, `other`). An
 * `other` that the cause calls unreachable is no answer at all. Hosts without `kind` go by the cause.
 */
export function failureKind(o: TestOutcome): FailureKind {
  const k = o.kind
  if (k === 'tls' || o.detail === 'certificate') return 'tls'
  if (k === 'auth' || (!k && o.cause === 'auth')) return 'auth'
  if (k === 'timeout' || ((!k || k === 'other') && (o.cause === 'timeout' || o.cause === 'unreachable'))) return 'no-answer'
  return 'other'
}

/** The words for a refused sign-in when the printer said why (Moonraker, and printers paired on their own screen). */
const NEED_COPY: Record<AuthNeed, { title: string; body: string; tips: string[] }> = {
  not_trusted: {
    title: 'The printer doesn\'t trust this computer.',
    body: 'Enter the printer\'s API key, then try once more.',
    tips: ['Or let this computer in without a key: add its network to trusted_clients under [authorization] in moonraker.conf, then restart Moonraker.', 'From a computer the printer trusts, curl http://PRINTER_IP:7125/access/api_key shows the key.'],
  },
  key_wrong: {
    title: 'The printer didn\'t accept the API key.',
    body: 'Enter it again, then try once more.',
    tips: ['Copy the key again from Mainsail or Fluidd, or from curl http://PRINTER_IP:7125/access/api_key on a computer the printer trusts. Keys change when someone generates a new one.'],
  },
  login_required: {
    title: 'The printer asks for a user login.',
    body: 'Logins are required on this printer (Fluidd or Mainsail accounts, or Require Login on a Snapmaker U1). Enter its API key instead, which works with logins on, then try once more.',
    tips: ['From a computer that is signed in, curl http://PRINTER_IP:7125/access/api_key shows the key.'],
  },
  pair_again: {
    title: 'The printer forgot this computer.',
    body: 'It loses its pairing when it is turned off. Pair it again, then tap Yes on its touchscreen within a minute.',
    tips: [],
  },
  declined: {
    title: 'The connection was turned down on the printer.',
    body: 'Pair again, and tap Yes or Allow on the printer\'s screen when it asks.',
    tips: [],
  },
  lan_mode_off: {
    title: 'LAN Mode is off on the printer.',
    body: 'The printer is in cloud mode and takes no local connection. In its Settings > Network, turn on LAN Mode, then try once more.',
    tips: ['Turning on LAN Mode removes the printer from your Anycubic account for good. Turning it off later does not bring it back; you would pair it again in the Anycubic app.', 'A printer can drop back to cloud mode on its own. If it worked before, check LAN Mode again.'],
  },
}

/** The panel's words for a failed test of the printer at `address`. */
export function failureCopy(o: TestOutcome, ctx: { address: string; family: string | null; model?: string | undefined }): FailureCopy {
  const kind = failureKind(o)
  const bambu = ctx.family === 'bambu-lan'
  const fam = bambu ? bambuFamily(ctx.model) : null
  switch (kind) {
    case 'tls':
      return { kind, title: `${appName()} couldn't confirm this is your printer.`, body: `The problem is in ${appName()}, not your network. Sending a report helps us fix it.`, tips: [], actions: ['report', 'update'] }
    case 'auth': {
      const need = o.authNeed ? NEED_COPY[o.authNeed] : undefined
      if (need) return { kind, ...need, actions: ['retry'] }
      const tips = bambu ? [fam ? bambuGuide(fam).accessCode : 'Check your printer\'s network settings for the LAN Only page. The access code is shown there.', 'If the code worked before, read it again from the printer, since it may have changed.'] : ['Check the API key or password, and that it belongs to this printer.']
      return { kind, title: bambu ? 'The access code didn\'t work.' : 'The printer didn\'t accept the key.', body: 'Enter it again, then try once more.', tips, actions: ['retry'] }
    }
    case 'no-answer': {
      const tips = bambu ? ['If it still doesn\'t answer, turn on LAN Only Mode on the printer.', `Developer Mode isn't needed to connect. It's optional, for printing directly from ${appName()}.`] : []
      return { kind, title: `No answer from ${ctx.address || 'the printer'}.`, body: 'Check the printer is on and on the same network as this computer.', tips, actions: ['retry'] }
    }
    default:
      return { kind, title: `The printer answered, but not the way ${appName()} expected.`, body: 'Sending a report with the details helps us fix it.', tips: [], actions: ['retry', 'report'] }
  }
}

/** The step list in plain words. */
export function stepWord(ok: boolean | null | undefined, running?: boolean): string {
  if (running) return 'Checking'
  if (ok === true) return 'Done'
  if (ok === false) return 'Failed'
  return 'Not reached'
}
