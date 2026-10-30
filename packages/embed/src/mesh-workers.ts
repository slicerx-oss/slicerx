// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which mesh worker the embedded view builds big parts with (ViewportProps.meshWorker): its own by default, a host's
// own factory, or none, so every part is built on the page as before. A worker that cannot start or load leaves its
// parts to the page too (the viewport's pool falls back), so a strict CSP or a bundler that drops the file costs speed,
// never the model.
import type { MeshWorkerLike } from '@slicerx/viewport'

/** `true` (the default): the embed's own worker. `false`: build on the page. A function: the host's own worker. */
export type MeshWorkerSetting = boolean | (() => MeshWorkerLike)

/** Starts the embed's own mesh worker, a module served next to the embed's code. */
export function startMeshWorker(): MeshWorkerLike {
  return new Worker(new URL('./mesh-build-worker.ts', import.meta.url), { type: 'module', name: 'sx-mesh-build' }) as unknown as MeshWorkerLike
}

/** The factory the viewport gets for a setting, or undefined to build on the page (also where the page has no workers). */
export function meshWorkerFactory(setting: MeshWorkerSetting = true): (() => MeshWorkerLike) | undefined {
  if (typeof setting === 'function') return setting
  if (!setting || typeof Worker === 'undefined') return undefined
  return startMeshWorker
}
