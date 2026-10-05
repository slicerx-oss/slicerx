// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Optional features plug into the base app through this interface. The base
// app never imports a feature package; the app entry passes the compiled-in
// features to SlicerXApp. Editions register their own features the same way.
import type { CommandSpec, Host } from './host'

/** Features the base app ships. Editions add their own ids. */
export const BASE_FEATURE_IDS = ['pilot', 'connect'] as const
export type AppFeatureId = string

export interface WorkspaceSpec {
  id: string
  label: string
  icon: string
  /** Lazy so a feature's code loads on first use. */
  load: () => Promise<{ default: unknown }>
}

/** A section a feature adds to the Settings dialog. */
export interface SettingsSectionSpec {
  id: string
  label: string
  icon: string
  /** Lazy so the section's code loads when it is first opened. */
  load: () => Promise<{ default: unknown }>
}

export interface AppFeature {
  id: AppFeatureId
  /**
   * Host members this feature needs, by name. Edition features may name members
   * of an extended host (such as `store`); the app skips a feature when any is missing.
   */
  requires: readonly string[]
  workspaces?: WorkspaceSpec[]
  settings?: SettingsSectionSpec[]
  commands?: (host: Host) => CommandSpec[]
}
