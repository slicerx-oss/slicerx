'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { HTMLAttributes, ReactNode } from 'react'
import { tipAttrs } from './tooltip'
import { Icon } from '../icons/icon'
import type { IconName } from '../icons/icon-paths'
import { Logo } from '../icons/mark'
import { Kbd } from './chip'

export interface TabSpec<K extends string = string> {
  id: K
  label: string
  icon: IconName
  href?: string
  /** A small status dot on the tab: ok is quiet, warn draws the eye. */
  status?: 'ok' | 'warn'
}

/** The six workspaces, in tab order. The fleet icon is for user-made printer groups, not this tab. */
export const WORKSPACE_TABS = [
  { id: 'prepare', label: 'Prepare', icon: 'prepare' },
  { id: 'preview', label: 'Preview', icon: 'preview' },
  { id: 'feed', label: 'Feed', icon: 'feed' },
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'printers', label: 'Printers', icon: 'printer' },
  { id: 'pilot', label: 'mimir', icon: 'pilot' },
] as const satisfies readonly TabSpec[]

export type WorkspaceId = (typeof WORKSPACE_TABS)[number]['id']

export interface TabsProps<K extends string> {
  tabs: readonly TabSpec<K>[]
  active: K
  onChange?: (id: K) => void
  label?: string
  /** A custom first entry, before the tabs (the app's Design | Slice pair). */
  lead?: ReactNode
}

/** Top tabs with the gradient underline on the active one. Labels hide under 560px. */
export function Tabs<K extends string>({ tabs, active, onChange, label = 'Workspaces', lead }: TabsProps<K>) {
  return (
    <nav className="sx-tabs" aria-label={label}>
      {lead}
      {tabs.map((t) => {
        const current = t.id === active ? ('page' as const) : undefined
        const inner = (
          <>
            <Icon name={t.icon} />
            <span>{t.label}</span>
            {t.status ? <i className={t.status === 'warn' ? 'sx-dot warn tab-dot' : 'sx-dot tab-dot'} aria-hidden="true" /> : null}
          </>
        )
        return t.href ? (
          <a key={t.id} className="sx-tab" data-tab={t.id} data-testid={`tab-${t.id}`} href={t.href} aria-current={current} aria-label={t.label} onClick={() => onChange?.(t.id)}>
            {inner}
          </a>
        ) : (
          <button key={t.id} type="button" className="sx-tab" data-tab={t.id} data-testid={`tab-${t.id}`} aria-current={current} aria-label={t.label} onClick={() => onChange?.(t.id)}>
            {inner}
          </button>
        )
      })}
    </nav>
  )
}

export interface AppBarProps extends HTMLAttributes<HTMLElement> {
  /** Usually a Tabs element. */
  children?: ReactNode
  /** Right side: search button, online pill, avatar. */
  right?: ReactNode
  /** Where the logo links; omit for a static logo. */
  homeHref?: string
}

/** The 52px top bar: logo, tabs, and a right group. */
export function AppBar({ children, right, homeHref, className, ...rest }: AppBarProps) {
  return (
    <header className={className ? `sx-appbar ${className}` : 'sx-appbar'} {...rest}>
      {homeHref ? <Logo href={homeHref} /> : <Logo />}
      {children}
      {right ? <div className="sx-appbar-right">{right}</div> : null}
    </header>
  )
}

export interface SearchButtonProps {
  onClick: () => void
  placeholder?: string
  /** Shown as the key cap; the app decides Cmd or Ctrl. */
  shortcut?: string
}

/** The fake search field in the bar that opens the command palette. */
export function SearchButton({ onClick, placeholder = 'Search models, settings, printers', shortcut = 'Cmd K' }: SearchButtonProps) {
  return (
    <button type="button" className="sx-searchbtn" onClick={onClick} aria-label={`${placeholder} (${shortcut})`} aria-keyshortcuts="Meta+K Control+K">
      <Icon name="search" />
      <span>{placeholder}</span>
      <Kbd>{shortcut}</Kbd>
    </button>
  )
}

export interface AvatarProps {
  /** Two letters at most. */
  initials: string
  title?: string
}

export function Avatar({ initials, title = 'Your account' }: AvatarProps) {
  return (
    <div className="sx-avatar" {...tipAttrs({ title })} aria-label={title}>
      {initials.slice(0, 2).toUpperCase()}
    </div>
  )
}

export interface StatusLineProps extends HTMLAttributes<HTMLElement> {
  /** Left items, in the mono face: engine, thread count, GPU. */
  items: readonly ReactNode[]
  /** Pinned at the right end. */
  right?: ReactNode
}

/** The 28px mono status line at the bottom of the frame. */
export function StatusLine({ items, right, className, ...rest }: StatusLineProps) {
  return (
    <footer className={className ? `sx-status ${className}` : 'sx-status'} {...rest}>
      {items.map((it, i) => (
        <span key={i}>{it}</span>
      ))}
      {right ? <span data-right>{right}</span> : null}
    </footer>
  )
}

export interface FrameProps extends HTMLAttributes<HTMLDivElement> {
  bar: ReactNode
  status?: ReactNode
  children?: ReactNode
}

/** The rounded app frame: bar on top, one main region, status line under it. */
export function Frame({ bar, status, className, children, ...rest }: FrameProps) {
  return (
    <div className="sx-frame-root">
      <div className={className ? `sx-frame ${className}` : 'sx-frame'} {...rest}>
        {bar}
        <main className="sx-main">{children}</main>
        {status}
      </div>
    </div>
  )
}
