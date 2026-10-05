// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The knowledge base mimir's guide tools read (kb.troubleshoot, kb.filament and the rest), bundled
// with the app and indexed on first use. Without it every guide lookup on the phone comes back empty.
import { createKnowledgeBase, type KbIndex, type KnowledgeBase } from '@slicerx/pilot'
import kbIndex from '@slicerx/pilot/kb.json'

let kb: KnowledgeBase | null = null

export function bundledKb(): KnowledgeBase {
  kb ??= createKnowledgeBase(kbIndex as unknown as KbIndex)
  return kb
}
