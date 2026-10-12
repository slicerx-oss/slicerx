// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What an agent may do with the open project over the app link, and the page's answer to each. The hub keeps the same
// list (packages/connect/link/src/roles.rs, APP_LINK_METHODS) and refuses every other name before it reaches here; a
// test checks the two lists match. Nothing here prints, queues, approves, signs in or changes settings.
import { appName } from '../edition'
import { bounds } from '../plate/transform'
import { LinkError } from './methods-error'
import { listSessions, readSession } from './sessions'
import { get } from '../state/store'

export type LinkClass = 'read' | 'edit'

export const APP_LINK_METHODS: Record<string, LinkClass> = {
  'app.info': 'read',
  'plate.list': 'read',
  // mimir's conversations in this window: what was said and what mimir did.
  'mimir.sessions': 'read',
  'mimir.session': 'read',
}

export { LinkError } from './methods-error'

const round = (v: number): number => Math.round(v * 1000) / 1000

type Handler = (args: Record<string, unknown>) => unknown

const HANDLERS: Record<keyof typeof APP_LINK_METHODS, Handler> = {
  'app.info': () => {
    const s = get()
    return { app: appName(), tab: s.modelMode, workspace: s.workspace, objects: s.plate.length, methods: APP_LINK_METHODS }
  },
  'plate.list': () => ({
    objects: get().plate.map((e) => {
      const b = bounds(e.parts, e.transform)
      return {
        id: e.id,
        name: e.name,
        parts: e.parts.length,
        transform: e.transform.map(round),
        ...(b ? { minMm: b.min.map(round), maxMm: b.max.map(round), sizeMm: b.max.map((v, i) => round(v - b.min[i]!)) } : {}),
        ...(e.history ? { steps: e.history.steps.length } : {}),
      }
    }),
  }),
  'mimir.sessions': () => listSessions(),
  'mimir.session': (args) => readSession(args),
}

/** Runs one call the hub handed over. The hub already checked the method and the client's grant. */
export async function runCall(method: string, args: Record<string, unknown>): Promise<unknown> {
  const h = Object.hasOwn(HANDLERS, method) ? HANDLERS[method] : undefined
  if (!h) throw new LinkError('not_found', `${appName()} has no app link method ${method}`)
  return h(args)
}
