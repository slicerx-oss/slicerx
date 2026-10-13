// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether an edition runs mimir on mimir cloud, and where. Kept apart from cloud.ts so the shell never loads it.
import type { EditionConfig } from '@slicerx/edition-config'
import { cloudTestBase, mimirCloudHost, type MimirCloudHost } from './cloud'

/** The model mimir cloud runs; the proxy pins it whatever is sent. */
export const CLOUD_MODEL = 'claude-haiku-5-5'

/** The proxy's base for the pilot's adapter, which adds /v1/messages. Null when the edition has no cloud. */
export function cloudBase(edition: EditionConfig): string | null {
  const test = cloudTestBase()
  if (test) return test
  const url = edition.ai.keySource === 'cloud' ? edition.backend.supabase?.url : undefined
  if (!url) return null
  try {
    return `${new URL(url).origin}/functions/v1/mimir`
  } catch {
    return null
  }
}

/** True when this build can run mimir on mimir cloud: the edition has it and the shell carries it. */
export function cloudReady(edition: EditionConfig, h: MimirCloudHost | null = mimirCloudHost()): boolean {
  return h !== null && cloudBase(edition) !== null
}
