// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The theme picker: one card per theme with its light and dark modes side by side, the mode
// (System, Light, Dark), a flavor choice for themes with more than one dark variant, and theme
// import and export. Used by Settings > Look and feel and by the first-run theme step.
import { Button, Icon, Seg } from '@slicerx/ui'
import { derivePalette, familyId, pickFamily, serializeTheme, themeFamilies, themeForScheme, type ThemeFamily, type ThemeFile } from '@slicerx/ui/theme'
import { useMemo, useRef, useState } from 'react'
import { useHost } from '../host'
import { get, set, useApp } from '../state/store'
import { importThemeText, removeUserTheme, themeList } from '../theme/user-themes'
import './theme-settings.css'

export type ThemeMode = 'system' | 'light' | 'dark'

/** A miniature of the app drawn from the theme's derived colors. */
function Preview({ theme, current }: { theme: ThemeFile; current: boolean }) {
  const p = useMemo(() => derivePalette(theme), [theme])
  return (
    <span className="th-prev" aria-hidden="true" data-current={current ? '' : undefined} style={{ background: p.background, borderColor: p.hairline }}>
      <i className="th-prev-pane" style={{ background: p.pane, borderColor: p.hairline }}>
        <b style={{ background: p.secondary }} />
        <b style={{ background: p.dim, width: '60%' }} />
        <b style={{ background: p.dim, width: '75%' }} />
        <em style={{ background: p.accent }} />
      </i>
      <i className="th-prev-vp" style={{ background: `radial-gradient(ellipse at 50% 40%, ${p.surfaceAlt}, ${p.background} 75%)` }}>
        <u style={{ background: p.accent }} />
        <u style={{ background: p.green, left: '58%', top: '38%' }} />
        <s style={{ background: p.orange }} />
      </i>
    </span>
  )
}

/** The mode as the picker shows it, from the stored scheme and Follow system. */
export function useThemeMode(): ThemeMode {
  const follow = useApp((s) => s.themeFollowsSystem)
  const scheme = useApp((s) => s.scheme)
  return follow ? 'system' : scheme
}

export function setThemeMode(mode: ThemeMode): void {
  if (mode === 'system') {
    const dark = typeof window === 'undefined' || !window.matchMedia ? true : window.matchMedia('(prefers-color-scheme: dark)').matches
    set({ themeFollowsSystem: true, scheme: dark ? 'dark' : 'light' })
  } else set({ themeFollowsSystem: false, scheme: mode })
}

export function ThemeModeSeg({ size = 'sm', full }: { size?: 'sm' | 'md'; full?: boolean }) {
  const mode = useThemeMode()
  return (
    <Seg
      label="Theme mode"
      size={size}
      full={Boolean(full)}
      value={mode}
      onChange={setThemeMode}
      options={[
        { value: 'system', label: 'System', icon: 'desktop' },
        { value: 'light', label: 'Light', icon: 'sun' },
        { value: 'dark', label: 'Dark', icon: 'moon' },
      ]}
    />
  )
}

/** The theme showing now, its family, and every family in the list. */
function useThemeState() {
  const scheme = useApp((s) => s.scheme)
  const ids = useApp((s) => s.themeIds)
  const user = useApp((s) => s.userThemes)
  const folder = useApp((s) => s.folderThemes)
  const all = useMemo(() => themeList(user, folder), [user, folder])
  const families = useMemo(() => themeFamilies(all), [all])
  const current = themeForScheme(scheme, ids, [...user, ...folder])
  const owned = useMemo(() => new Set(user.map((t) => t.id)), [user])
  return { scheme, ids, families, current, active: familyId(current), owned }
}

/** Picks a family: both slots take its modes. Showing one mode only, a family without that mode switches to the one it has. */
export function pickThemeFamily(family: ThemeFamily, flavor?: string): void {
  const s = get()
  const ids = pickFamily(s.themeIds, family, flavor)
  const has = s.scheme === 'dark' ? family.dark.length > 0 : family.light.length > 0
  set(!s.themeFollowsSystem && !has ? { themeIds: ids, scheme: s.scheme === 'dark' ? 'light' : 'dark' } : { themeIds: ids })
}

/** The line under a card's name: the flavor in use, how many there are, or which mode a one-mode theme has. */
export function familySubLabel(f: ThemeFamily, active: boolean, darkId: string): string {
  if (f.dark.length > 1) return active ? (f.dark.find((t) => t.id === darkId)?.flavor ?? `${f.dark.length} flavors`) : `${f.dark.length + f.light.length} flavors`
  if (!f.dark.length) return 'Light only'
  if (!f.light.length) return 'Dark only'
  return ''
}

/** The cards, as many columns as fit cards of at least `minWidth` px; phones get two. */
export function ThemePicker({ minWidth = 168 }: { minWidth?: number }) {
  const { scheme, ids, families, active, owned } = useThemeState()
  const follow = useApp((s) => s.themeFollowsSystem)
  const activeFamily = families.find((f) => f.id === active)
  return (
    <>
      <div className="th-grid" role="radiogroup" aria-label="Theme" style={{ ['--th-min' as string]: `${minWidth}px` }}>
        {families.map((f) => {
          const on = f.id === active
          const dark = f.dark.find((t) => t.id === ids.dark) ?? f.dark[0]
          const light = f.light.find((t) => t.id === ids.light) ?? f.light[0]
          const sub = familySubLabel(f, on, ids.dark)
          const mine = [...f.dark, ...f.light].filter((t) => owned.has(t.id))
          return (
            <span key={f.id} className="th-cell">
              <button type="button" role="radio" aria-checked={on} className="th-card" data-on={on ? '' : undefined} data-testid={`theme-${f.id}`} onClick={() => pickThemeFamily(f)}>
                <span className="th-pair">
                  {light ? <Preview theme={light} current={on && (follow || scheme === 'light')} /> : null}
                  {dark ? <Preview theme={dark} current={on && (follow || scheme === 'dark')} /> : null}
                </span>
                <span className="th-name">
                  <span>{f.name}</span>
                  {sub ? <small>{sub}</small> : null}
                </span>
                {on ? <Icon name="check" size={14} className="th-check" /> : null}
              </button>
              {mine.length ? <Button className="th-remove" variant="ghost" size="sm" icon="close" aria-label={`Remove ${f.name}`} tip="theme.remove" onClick={() => mine.forEach((t) => removeUserTheme(t.id))} /> : null}
            </span>
          )
        })}
      </div>
      {activeFamily && activeFamily.dark.length > 1 ? (
        <div className="th-flavor">
          <span className="th-flavor-label">Dark flavor</span>
          <Seg
            label="Dark flavor"
            size="sm"
            value={activeFamily.dark.some((t) => t.id === ids.dark) ? ids.dark : (activeFamily.dark[0]?.id ?? '')}
            onChange={(id) => pickThemeFamily(activeFamily, id)}
            options={activeFamily.dark.map((t) => ({ value: t.id, label: t.flavor ?? t.name }))}
          />
          {activeFamily.light[0] ? <small className="sx-muted">{activeFamily.light[0].flavor ?? activeFamily.light[0].name} is the light mode.</small> : null}
        </div>
      ) : null}
    </>
  )
}

/** Settings > Look and feel > Theme: the mode, the cards, and theme files. */
export function ThemeSettingsSection() {
  const host = useHost()
  const { current } = useThemeState()
  const file = useRef<HTMLInputElement>(null)
  const [note, setNote] = useState<{ ok: boolean; lines: string[] } | null>(null)

  const doImport = async (f: File | undefined) => {
    if (!f) return
    const r = importThemeText(await f.text(), f.name)
    if (r.ok) {
      const family = themeFamilies(themeList(get().userThemes, get().folderThemes)).find((x) => x.id === familyId(r.theme))
      if (family) pickThemeFamily(family)
      setNote({ ok: true, lines: [`Added ${r.theme.name}.`, ...r.warnings] })
    } else setNote({ ok: false, lines: r.errors })
    if (file.current) file.current.value = ''
  }

  const doExport = async () => {
    const blob = new Blob([serializeTheme(current)], { type: 'application/json' })
    await host.files.save(`${current.id}.json`, blob, { accept: ['.json'] })
  }

  return (
    <div className="set-group th-sec">
      <h4>Theme</h4>
      <div className="set-seg-row">
        <span className="set-seg-text">
          <span>Mode</span>
          <small>System switches between light and dark with your computer.</small>
        </span>
        <ThemeModeSeg />
      </div>
      <ThemePicker />
      <p className="set-actions">
        <Button variant="ghost" icon="import" tip="theme.import" onClick={() => file.current?.click()}>
          Import theme
        </Button>
        <Button variant="ghost" icon="export" tip="theme.export" onClick={() => void doExport()}>
          Export theme
        </Button>
        {host.themes ? (
          <Button variant="ghost" icon="folder" tip="theme.folder" onClick={() => void host.themes?.openFolder()}>
            Open themes folder
          </Button>
        ) : null}
        <input ref={file} type="file" accept=".json,application/json" className="sr-only" tabIndex={-1} aria-label="Theme file" onChange={(e) => void doImport(e.target.files?.[0])} />
      </p>
      {note ? (
        <ul className="th-note" role="status" data-ok={note.ok ? '' : undefined}>
          {note.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
