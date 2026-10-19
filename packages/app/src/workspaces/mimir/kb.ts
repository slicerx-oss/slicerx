// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The knowledge base mimir's guide tools read (kb.troubleshoot, kb.filament and
// the rest), with the running edition's own knowledge (ai.brain.knowledge) as its
// edition index: those docs are searched next to the bundled ones and cite as the
// edition's. Both ship with the app and load on first use, so the panel costs
// nothing until it opens. Without them every guide lookup comes back empty.
import { createKnowledgeBase, type KbIndex, type KnowledgeBase } from '@slicerx/pilot'
import { currentEdition } from '../../edition'

let loading: { edition: string; kb: Promise<KnowledgeBase> } | null = null

/** The running edition's own knowledge index, as the build put it in (null when it has none). */
export async function editionKbIndex(): Promise<KbIndex | null> {
  return ((await import('@slicerx/pilot/edition-kb')).default as KbIndex | null) ?? null
}

export function bundledKb(): Promise<KnowledgeBase> {
  const edition = currentEdition().id
  if (loading?.edition !== edition) {
    const kb = Promise.all([import('@slicerx/pilot/kb.json'), editionKbIndex()]).then(([m, index]) => createKnowledgeBase(m.default as unknown as KbIndex, index ? { id: edition, index } : undefined))
    loading = { edition, kb }
  }
  return loading.kb
}
