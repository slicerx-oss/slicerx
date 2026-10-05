'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '../icons/icon'
import type { IconName } from '../icons/icon-paths'
import { Kbd } from './chip'

export interface PaletteItem {
  id: string
  label: string
  /** Where the command lives or what it does, shown dim at the right. */
  hint?: string
  icon?: IconName
  /** Keys as shown, one per cap: ["Cmd", "S"]. */
  keys?: readonly string[]
  disabled?: boolean
}

export interface PaletteGroup {
  title: string
  items: readonly PaletteItem[]
}

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  query: string
  onQueryChange: (query: string) => void
  /** Already filtered by the caller. The palette only renders and navigates. */
  groups: readonly PaletteGroup[]
  onSelect: (item: PaletteItem) => void
  placeholder?: string
  /** Text shown when there are no items. */
  empty?: ReactNode
  /** Extra hint at the right end of the footer, for example the Pilot handoff. */
  footerRight?: ReactNode
  /** Accessible name. */
  label?: string
}

/**
 * The Cmd+K surface. The app owns the registry and the filtering (the budget is 16 ms per
 * keystroke over 500 commands); this renders the list, tracks the active row,
 * and handles arrows, Enter, and Escape.
 */
export function CommandPalette({ open, onClose, query, onQueryChange, groups, onSelect, placeholder = 'Search commands, models, settings, printers', empty = 'No commands match', footerRight, label = 'Commands' }: CommandPaletteProps) {
  const flat = useMemo(() => groups.flatMap((g) => g.items.filter((i) => !i.disabled)), [groups])
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = 'sx-palette-list'

  // Reset the cursor whenever the result set or the open state changes; that is not derived
  // state, it is a cursor into an external list.
  useEffect(() => {
    setActive(0)
  }, [query, open])
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])
  useEffect(() => {
    if (!open) return
    const row = listRef.current?.querySelector<HTMLElement>('[data-active]')
    row?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  if (!open) return null
  const clamp = (i: number) => (flat.length ? (i + flat.length) % flat.length : 0)
  const activeItem = flat[active]

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => clamp(i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => clamp(i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (activeItem) onSelect(activeItem)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div
      className="sx-palette-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="sx-palette" role="dialog" aria-modal="true" aria-label={label} onKeyDown={onKeyDown}>
        <div className="sx-palette-head">
          <Icon name="search" />
          <input
            ref={inputRef}
            id="sx-palette-input"
            className="sx-palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeItem ? `sx-palette-${activeItem.id}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div ref={listRef} id={listId} className="sx-palette-list" role="listbox">
          {flat.length === 0 ? <div className="sx-palette-empty">{empty}</div> : null}
          {groups.map((g) =>
            g.items.length ? (
              <div key={g.title} role="group" aria-label={g.title}>
                <div className="sx-palette-group">{g.title}</div>
                {g.items.map((item) => {
                  const isActive = activeItem?.id === item.id
                  return (
                    <button
                      key={item.id}
                      id={`sx-palette-${item.id}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      className="sx-palette-item"
                      data-active={isActive ? true : undefined}
                      disabled={item.disabled}
                      tabIndex={-1}
                      onPointerMove={() => {
                        const i = flat.indexOf(item)
                        if (i >= 0 && i !== active) setActive(i)
                      }}
                      onClick={() => onSelect(item)}
                    >
                      <Icon name={item.icon ?? 'terminal'} />
                      <span className="sx-palette-item-label">{item.label}</span>
                      {item.hint ? <span className="sx-palette-item-hint">{item.hint}</span> : null}
                      {item.keys?.length ? (
                        <span className="sx-palette-item-keys">
                          {item.keys.map((k) => (
                            <Kbd key={k}>{k}</Kbd>
                          ))}
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            ) : null,
          )}
        </div>
        <div className="sx-palette-foot">
          <span>
            <Kbd>Up</Kbd>
            <Kbd>Down</Kbd> move
          </span>
          <span>
            <Kbd>Enter</Kbd> run
          </span>
          {footerRight ? <span data-right>{footerRight}</span> : null}
        </div>
      </div>
    </div>
  )
}
