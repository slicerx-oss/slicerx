// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app entry's view of upload-source: the code loads with the upload flow, not with the shell.
import { allPlates } from '../plate/plates'
import { get } from '../state/store'
import type { CoverImage, ProjectUpload } from './upload-source'

export type { CoverImage, ProjectUpload } from './upload-source'

export const projectHasModels = (): boolean => allPlates(get()).some((p) => p.objects.length > 0)
export const currentProjectUpload = (): Promise<ProjectUpload | null> => import('./upload-source').then((m) => m.currentProjectUpload())
export const coverForFile = (name: string, bytes: Uint8Array): Promise<CoverImage | null> => import('./upload-source').then((m) => m.coverForFile(name, bytes))
export const vaultCreatorsInFile = (name: string, bytes: Uint8Array): Promise<string[]> => import('./upload-source').then((m) => m.vaultCreatorsInFile(name, bytes))
