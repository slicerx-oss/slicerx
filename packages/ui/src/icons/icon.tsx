'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useEffect, useReducer, type SVGProps } from 'react'
import { useTheme } from '../theme-provider'
import { ICON_NAMES, type IconName } from './icon-names'
import { STARTUP_ICON_PATHS } from './icon-startup'

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children'> {
  name: IconName
  /** Pixel size; the default is the .sx-ic size (18px). */
  size?: number
  /** Accessible name. Without one the icon is decorative and hidden from readers. */
  label?: string
}

// The icons the shell draws at its first paint load with it (icons/startup.mjs); the full table is a chunk of its
// own, loaded once the page is idle or when an icon outside the startup set is first drawn. Until it arrives such an
// icon is an empty box of its size, so nothing around it moves.
let allPaths: Readonly<Record<string, string>> | null = null
let loading: Promise<void> | null = null
const waiting = new Set<() => void>()

function loadAll(): Promise<void> {
  loading ??= import('./icon-paths').then(
    (m) => {
      allPaths = m.ICON_PATHS
      for (const wake of waiting) wake()
      waiting.clear()
    },
    () => {
      // A failed chunk load (offline, a new deploy) is retried at the next icon that needs it.
      loading = null
    },
  )
  return loading
}

if (typeof window !== 'undefined') {
  const idle = (window as { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback
  if (idle) idle(() => void loadAll())
  else setTimeout(() => void loadAll(), 1000)
}

/** One line icon from the SlicerX set, drawn on a 24px grid at stroke 1.75 in currentColor. */
export function Icon({ name, size, label, className, ...rest }: IconProps) {
  const { icons } = useTheme()
  const [, wake] = useReducer((n: number) => n + 1, 0)
  // Paths come from the generated icon files or the integrator's overrides, never from user input.
  const markup = icons[name] ?? STARTUP_ICON_PATHS[name] ?? allPaths?.[name]
  useEffect(() => {
    if (markup !== undefined) return
    waiting.add(wake)
    void loadAll()
    return () => {
      waiting.delete(wake)
    }
  }, [markup])
  return (
    <svg
      className={className ? `sx-ic ${className}` : 'sx-ic'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      // Names an icon still waiting for its table, for tests that check nothing pops in.
      data-icon-pending={markup === undefined ? name : undefined}
      dangerouslySetInnerHTML={{ __html: markup ?? '' }}
      {...rest}
    />
  )
}

/** Type guard for icon names coming from data (command registries, plugin manifests). */
export function isIconName(value: unknown): value is IconName {
  return typeof value === 'string' && ICON_NAMES.has(value)
}

/** Resolves once every icon can draw: for screenshots and tests that need the whole set at once. */
export function iconsReady(): Promise<void> {
  return allPaths ? Promise.resolve() : loadAll()
}
