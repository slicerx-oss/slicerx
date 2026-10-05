// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The knowledge base mimir's guide tools read (kb.troubleshoot, kb.filament and
// the rest). It is bundled with the app and loaded on first use, so the panel
// costs nothing until it opens. Without it every guide lookup comes back empty.
import { createKnowledgeBase, type KbIndex, type KnowledgeBase } from '@slicerx/pilot'

let loading: Promise<KnowledgeBase> | null = null

export function bundledKb(): Promise<KnowledgeBase> {
  loading ??= import('@slicerx/pilot/kb.json').then((m) => createKnowledgeBase(m.default as unknown as KbIndex))
  return loading
}
