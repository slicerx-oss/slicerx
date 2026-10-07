// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Optional features. The base app never imports a feature package; the app
// entry passes the features it compiled in, and each shows only when every
// Host member it needs exists.
import type { AppFeature, AppFeatureId, Host, SettingsSectionSpec, WorkspaceSpec } from '@slicerx/contracts'
import { isIconName, type IconName } from '@slicerx/ui'
import { createContext, lazy, useContext, type ComponentType, type LazyExoticComponent } from 'react'

export interface ActiveWorkspace {
  id: string
  label: string
  icon: IconName
  /** Base workspaces render inline; feature workspaces load on first use. */
  component: LazyExoticComponent<ComponentType> | null
}

/** Tab order. Workspaces a build does not have are skipped; unknown ones go last. */
const ORDER = ['prepare', 'feed', 'library', 'printers', 'pilot']

const BASE: ActiveWorkspace[] = [
  { id: 'prepare', label: 'Slice', icon: 'slice', component: null },
  { id: 'library', label: 'My models', icon: 'library', component: null },
]

export interface ActiveSettingsSection {
  id: string
  label: string
  icon: IconName
  component: LazyExoticComponent<ComponentType>
}

export interface FeatureSet {
  ids: ReadonlySet<AppFeatureId>
  features: readonly AppFeature[]
  workspaces: readonly ActiveWorkspace[]
  /** Sections features add to Settings, in feature order. */
  settings: readonly ActiveSettingsSection[]
}

const lazyCache = new WeakMap<WorkspaceSpec | SettingsSectionSpec, LazyExoticComponent<ComponentType>>()

function isComponent(v: unknown): v is ComponentType {
  return typeof v === 'function'
}

function lazyWorkspace(spec: WorkspaceSpec | SettingsSectionSpec): LazyExoticComponent<ComponentType> {
  let c = lazyCache.get(spec)
  if (!c) {
    c = lazy(async () => {
      const mod = await spec.load()
      if (!isComponent(mod.default)) throw new Error(`Workspace ${spec.id} did not export a component`)
      return { default: mod.default }
    })
    lazyCache.set(spec, c)
  }
  return c
}

export function resolveFeatures(host: Host, features: readonly AppFeature[]): FeatureSet {
  const active = features.filter((f) => f.requires.every((k) => Reflect.get(host, k) !== undefined))
  const extra: ActiveWorkspace[] = active.flatMap((f) =>
    (f.workspaces ?? []).map((w) => ({ id: w.id, label: w.label, icon: isIconName(w.icon) ? w.icon : 'grid', component: lazyWorkspace(w) })),
  )
  const rank = (id: string) => {
    const i = ORDER.indexOf(id)
    return i < 0 ? ORDER.length : i
  }
  const workspaces = [...BASE, ...extra].sort((a, b) => rank(a.id) - rank(b.id))
  const settings: ActiveSettingsSection[] = active.flatMap((f) =>
    (f.settings ?? []).map((w) => ({ id: w.id, label: w.label, icon: isIconName(w.icon) ? w.icon : 'settings', component: lazyWorkspace(w) })),
  )
  return { ids: new Set(active.map((f) => f.id)), features: active, workspaces, settings }
}

export const FeaturesContext = createContext<FeatureSet>({ ids: new Set(), features: [], workspaces: BASE, settings: [] })

export function useFeatures(): FeatureSet {
  return useContext(FeaturesContext)
}

/** True when the feature is compiled in and the host has every member it needs. */
export function useHasFeature(id: AppFeatureId): boolean {
  return useContext(FeaturesContext).ids.has(id)
}
