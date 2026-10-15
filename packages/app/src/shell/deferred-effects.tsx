// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { AssistantStyle } from '@slicerx/ui/assistant-style'
import { QueueWatcher } from '../queue/watcher'

/** Assistant accents and queue reminders load after the shell can render. */
export function DeferredEffects() {
  return <><AssistantStyle /><QueueWatcher /></>
}
