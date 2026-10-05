'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import type { IconName } from './icons/icon-paths'
import { applyTheme, clearTheme, nocturne, themeToCss, type Theme } from './theme'

/** Icon overrides: inner SVG markup on the 24px grid, keyed by icon name. */
export type IconOverrides = Partial<Record<IconName, string>>

export interface ThemeContextValue {
  theme: Theme
  icons: IconOverrides
  /** Replaces the Logo (wordmark and mark) wherever the package renders it. */
  logo: ReactNode | undefined
}

const ThemeContext = createContext<ThemeContextValue>({ theme: nocturne, icons: {}, logo: undefined })

/** The current theme, icon overrides and logo slot. Nocturne with no overrides outside a provider. */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export interface ThemeProviderProps {
  theme?: Theme
  icons?: IconOverrides
  /** Custom brand element for the app bar and lockups. Omit to keep the SlicerX logo. */
  logo?: ReactNode
  /**
   * Where the variables go. "root" (default) themes the whole document, so the page background,
   * dialogs and toasts follow. "scope" wraps children in a div and themes only that subtree.
   */
  scope?: 'root' | 'scope'
  children?: ReactNode
}

/**
 * Applies a theme and provides it to components. Changing the theme prop re-applies it at once,
 * with no reload. Server rendering emits the variables as a style tag so the first paint is
 * already themed.
 */
export function ThemeProvider({ theme = nocturne, icons = {}, logo, scope = 'root', children }: ThemeProviderProps) {
  const ref = useRef<HTMLDivElement>(null)
  const value = useMemo<ThemeContextValue>(() => ({ theme, icons, logo }), [theme, icons, logo])

  useIsoLayoutEffect(() => {
    const el = scope === 'scope' ? ref.current ?? undefined : undefined
    if (scope === 'scope' && !el) return
    applyTheme(theme, el)
    return () => clearTheme(el)
  }, [theme, scope])

  const ssrStyle = typeof window === 'undefined' ? <style>{themeToCss(theme, scope === 'root' ? ':root' : `[data-sx-theme="${theme.name}"]`)}</style> : null

  return (
    <ThemeContext.Provider value={value}>
      {ssrStyle}
      {scope === 'scope' ? (
        <div ref={ref} data-sx-theme={theme.name} className="sx-theme-scope">
          {children}
        </div>
      ) : (
        children
      )}
    </ThemeContext.Provider>
  )
}
