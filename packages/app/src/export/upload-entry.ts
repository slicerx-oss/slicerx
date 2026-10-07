// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app entry's view of upload-source: the code loads with the upload flow, not with the shell.
import { allPlates } from '../plate/plates'
import { get } from '../state/store'
import type { CoverImage, ProjectUpload, UploadModel } from './upload-source'

export type { CoverImage, ProjectUpload, UploadModel } from './upload-source'
export type { DerivedColors } from './listing-colors'

export const projectHasModels = (): boolean => allPlates(get()).some((p) => p.objects.length > 0)
export const currentProjectUpload = (): Promise<ProjectUpload | null> => import('./upload-source').then((m) => m.currentProjectUpload())
export const coverForFile = (name: string, bytes: Uint8Array): Promise<CoverImage | null> => import('./upload-source').then((m) => m.coverForFile(name, bytes))
export const vaultCreatorsInFile = (name: string, bytes: Uint8Array): Promise<string[]> => import('./upload-source').then((m) => m.vaultCreatorsInFile(name, bytes))
export const projectModel = (): Promise<UploadModel> => import('./upload-source').then((m) => m.projectModel())
export const fileModel = (name: string, bytes: Uint8Array): Promise<UploadModel | null> => import('./upload-source').then((m) => m.fileModel(name, bytes))
export const coverInColors = (model: UploadModel, slotHex: Readonly<Record<number, string>>): Promise<CoverImage | null> => import('./upload-source').then((m) => m.coverInColors(model, slotHex))
