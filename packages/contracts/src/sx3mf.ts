// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The open .sx3mf project format (packages/sx3mf/SPEC.md): a complete 3MF
// project whose model part carries a few sx: metadata entries. Mirrors the
// Rust crate `sx3mf`; the fixture fixtures/sx3mf-info.json is written by it.

/** Namespace bound to the `sx` prefix in the model part. */
export const SX3MF_NAMESPACE = 'https://slicerx.app/schemas/sx3mf/2026'
/** Part name the library writes the package thumbnail to. */
export const SX3MF_THUMBNAIL_PART = '/Metadata/thumbnail.png'

/** The sx: entries of the model part. Absent entries are omitted. */
export interface Sx3mfMetadata {
  /** sx:Listing, the library model id. */
  listing?: string
  /** sx:Version, the listing version number, for example 1.2.0. */
  version?: string
  /** sx:VersionId, the listing version id. */
  versionId?: string
  /** sx:Creator, the creator id. */
  creator?: string
  /** sx:ExportedBy, the id of the account that exported the file; empty when signed out. */
  exportedBy?: string
}

/** What a reader learns from a 3MF or .sx3mf package. */
export interface Sx3mfInfo extends Sx3mfMetadata {
  /** True when the model binds the sx namespace or carries any sx: entry. */
  isSx3mf: boolean
  /** Part name of the root model, for example /3D/3dmodel.model. */
  modelPart: string
  title?: string
  designer?: string
  application?: string
  /** The package thumbnail. Not part of the JSON form. */
  thumbnailPng?: ArrayBuffer
}
