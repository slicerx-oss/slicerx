// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Roles, the upload moderation queue and the upload scan report. Owned by store
// (records and rules) and cloud (the scanner that produces ScanReport).
import type { MemberRole } from './store'

/** Role names in privilege order. The `MemberRole` type and the queue, audit and creator link records live in store.ts (store owns them). */
export const ROLES = ['owner', 'moderator', 'creator', 'member'] as const satisfies readonly MemberRole[]

/** What each role may do. Enforced by row level security; the UI only mirrors it. */
export const ROLE_CAN = {
  owner: ['approve', 'reject', 'unpublish', 'grantRoles', 'editAnyCreator', 'upload', 'browse'],
  moderator: ['approve', 'reject', 'unpublish', 'upload', 'browse'],
  creator: ['upload', 'editOwnCreator', 'browse'],
  member: ['browse'],
} as const satisfies Record<MemberRole, readonly string[]>
export type Ability = (typeof ROLE_CAN)[MemberRole][number]

export const UPLOAD_CHECKS = ['type', 'size', 'archive', 'executables', 'mesh', 'malware'] as const
export type UploadCheckId = (typeof UPLOAD_CHECKS)[number]

/**
 * type        extension and magic bytes match 3mf, sx3mf or stl, and only allowed formats are accepted
 * size        under the edition's maxFileMb, and the uncompressed size of an archive stays under its cap
 * archive     no zip bombs (expansion ratio and entry count caps), no path traversal or absolute paths, no symlinks
 * executables no executables, scripts or macro files inside the archive, by extension and by magic bytes
 * mesh        the file parses as a mesh with at least one triangle, finite coordinates, sane bounds
 * malware     signature scan; the signature configuration stays private
 */
export interface UploadCheckResult {
  check: UploadCheckId
  passed: boolean
  /** Short machine readable reason when failed, such as `zip_ratio_exceeded` or `path_traversal`. */
  code?: string
  /** Human readable, shown to the uploader and the moderator. */
  detail?: string
}

export type ScanVerdict = 'clean' | 'rejected' | 'error'

export interface ScanRequest {
  /** Object path in the private quarantine bucket. */
  objectPath: string
  declaredFormat: 'stl' | '3mf' | 'sx3mf'
  maxFileMb: number
}

export interface ScanReport {
  verdict: ScanVerdict
  checks: UploadCheckResult[]
  /** For clean 3mf, sx3mf and stl files: what the mesh check measured. */
  mesh?: { triangles: number; boundsMm: [number, number, number] }
  scannerVersion: string
  scannedAt: string
}
