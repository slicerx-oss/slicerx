// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { toolStore } from '../plate/tools'
import { PLAYBACK_SPEEDS } from '../state/prefs'
import { get, set } from '../state/store'
import { playback } from '../workspaces/preview/playback'
import { LinkError } from './methods-error'

export const readPlayback = () => playback.read()

export function setPlayback(args: Record<string, unknown>) {
  const s = get()
  if (s.workspace !== 'prepare' || s.modelMode !== 'slice' || s.sliceLook !== 'toolpaths' || ['paint', 'brim', 'face'].includes(toolStore.getState().tool)) {
    throw new LinkError('busy', 'playback changes only while Slice is open and no object tool is in use')
  }
  const before = playback.read()
  if (!before.available) throw new LinkError('not_ready', 'open the sliced toolpath preview before controlling playback')
  const keys = Object.keys(args)
  if (!keys.length || keys.some((k) => !['playing', 'timeS', 'speed', 'followNozzle'].includes(k))) throw new LinkError('invalid_input', 'Give playing, timeS, speed or followNozzle')
  for (const key of ['playing', 'followNozzle']) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new LinkError('invalid_input', `${key} is true or false`)
  if (args['timeS'] !== undefined && (typeof args['timeS'] !== 'number' || !Number.isFinite(args['timeS']) || args['timeS'] < 0 || args['timeS'] > before.durationS!)) throw new LinkError('invalid_input', `timeS must be between 0 and ${before.durationS}`)
  if (args['speed'] !== undefined && !(PLAYBACK_SPEEDS as readonly unknown[]).includes(args['speed'])) throw new LinkError('invalid_input', `speed is one of ${PLAYBACK_SPEEDS.join(', ')}`)
  // Validate the whole request before changing preferences, the clock or its frame loop.
  if (args['playing'] === false) playback.pause()
  if (args['speed'] !== undefined) set({ playbackSpeed: args['speed'] as number })
  if (args['followNozzle'] !== undefined) set({ followNozzle: args['followNozzle'] as boolean })
  if (args['timeS'] !== undefined) playback.seek(args['timeS'] as number)
  if (args['playing'] === true) playback.play()
  return playback.read()
}
