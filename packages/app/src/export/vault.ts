// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Designs from the Vault leave SlicerX only as .sx3mf. An object carries the listing it came from (source.modelId,
// sx:Listing in its file), and plain mesh export refuses it; saving a project, slicing and printing still work.
import type { ModelSource } from '../state/store'

export const VAULT_SX3MF_ONLY = 'Designs from the Vault save as .sx3mf only. Save the project, or slice and print it.'

/** True when any of these objects came from the Vault. */
export function fromVault(objects: readonly { source?: ModelSource | undefined }[]): boolean {
  return objects.some((o) => Boolean(o.source?.modelId))
}
