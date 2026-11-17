// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The project's mixed filaments for an agent over the app link (app.mixed_filaments and app.mixed_filaments_set): read,
// or set as a whole list, checked as the Mix editor checks them. A set is one undo step, with a toast and Undo.
import { appMixInputs, type AppMixes } from '@slicerx/mcp/toolset'
import { setMixes } from '../filament/mixes'
import { slotCount } from '../filament/slots'
import { history } from '../plate/history'
import { get, toast } from '../state/store'
import { LinkError } from './methods-error'

const listed = (): AppMixes => ({ mixes: get().mixes.map((m) => ({ id: m.id, name: m.name, components: [...m.components] as [number, number], ratio: [...m.ratio] as [number, number] })) })

export function read(args: Record<string, unknown>): AppMixes {
  const parsed = appMixInputs.get.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  return listed()
}

export function change(args: Record<string, unknown>, client: string): AppMixes {
  const parsed = appMixInputs.set.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  const bad = setMixes(parsed.data.mixes, slotCount(get()))
  if (bad) throw new LinkError('invalid_input', bad)
  toast(`${client} changed the mixed filaments.`, 'info', { label: 'Undo', run: () => void history().undo() })
  return listed()
}
