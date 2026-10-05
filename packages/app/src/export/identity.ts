// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Who is exporting, for the sx3mf metadata. An edition with accounts registers a resolver; without
// one (or signed out) the user id is empty.
type Resolver = () => Promise<string | null>

let resolver: Resolver | null = null

export function setExportIdentity(r: Resolver | null): void {
  resolver = r
}

export async function exportingUserId(): Promise<string> {
  try {
    return (await resolver?.()) ?? ''
  } catch {
    return ''
  }
}
