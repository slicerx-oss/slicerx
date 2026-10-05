// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Look and feel > Appearance: the theme picker with live previews, light and dark
// slots for Follow system, Motion, the two font choices, and theme import and export.
import { Button, Icon, Seg, Select, tipAttrs } from '@slicerx/ui'
import { MONO_FONTS, UI_FONTS, derivePalette, pickTheme, serializeTheme, themeForScheme, type ThemeFile } from '@slicerx/ui/theme'
import { useMemo, useRef, useState } from 'react'
import { useEdition } from '../edition'
import { useHost } from '../host'
import { get, set, useApp } from '../state/store'
import { importThemeText, removeUserTheme, themeList } from '../theme/user-themes'
import './theme-settings.css'

/** A miniature of the app drawn from the theme's derived colors. */
function Preview({ theme }: { theme: ThemeFile }) {
  const p = useMemo(() => derivePalette(theme), [theme])
  return (
    <span className="th-prev" aria-hidden="true" style={{ background: p.background, borderColor: p.hairline }}>
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

function ThemeGrid({ themes, activeId, label, onPick, owned }: { themes: readonly ThemeFile[]; activeId: string; label: string; onPick: (t: ThemeFile) => void; owned: ReadonlySet<string> }) {
  return (
    <div className="th-grid" role="radiogroup" aria-label={label}>
      {themes.map((t) => (
        <span key={t.id} className="th-cell">
          <button type="button" role="radio" aria-checked={t.id === activeId} className="th-card" data-on={t.id === activeId ? '' : undefined} onClick={() => onPick(t)}>
            <Preview theme={t} />
            <span className="th-name">{t.name}</span>
            {t.id === activeId ? <Icon name="check" size={14} className="th-check" /> : null}
          </button>
          {owned.has(t.id) ? <Button className="th-remove" variant="ghost" size="sm" icon="close" aria-label={`Remove ${t.name}`} tip="theme.remove" onClick={() => removeUserTheme(t.id)} /> : null}
        </span>
      ))}
    </div>
  )
}

export function ThemeSettingsSection() {
  const host = useHost()
  const scheme = useApp((s) => s.scheme)
  const follow = useApp((s) => s.themeFollowsSystem)
  const ids = useApp((s) => s.themeIds)
  const user = useApp((s) => s.userThemes)
  const folder = useApp((s) => s.folderThemes)
  const fonts = useApp((s) => s.fonts)
  const edition = useEdition()
  const motion = useApp((s) => s.motion) ?? edition.firstRun.defaultMotion ?? 'full'
  const file = useRef<HTMLInputElement>(null)
  const [note, setNote] = useState<{ ok: boolean; lines: string[] } | null>(null)

  const all = useMemo(() => themeList(user, folder), [user, folder])
  const dark = all.filter((t) => t.isDark)
  const light = all.filter((t) => !t.isDark)
  const owned = useMemo(() => new Set(user.map((t) => t.id)), [user])
  const current = themeForScheme(scheme, ids, [...user, ...folder])

  const pick = (t: ThemeFile) => {
    const next = pickTheme(get().themeIds, t)
    // Fixed: the picked theme shows now, so its brightness becomes the scheme. Follow system: it only fills its slot.
    set(follow ? { themeIds: next } : { themeIds: next, scheme: t.isDark ? 'dark' : 'light' })
  }

  const doImport = async (f: File | undefined) => {
    if (!f) return
    const r = importThemeText(await f.text(), f.name)
    if (r.ok) {
      pick(r.theme)
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
      <div className="th-row">
        <Seg
          label="Theme mode"
          size="sm"
          value={follow ? 'system' : 'fixed'}
          onChange={(v) => set({ themeFollowsSystem: v === 'system' })}
          options={[
            { value: 'fixed', label: 'One theme' },
            { value: 'system', label: 'Follow system' },
          ]}
        />
      </div>
      {follow ? (
        <>
          <p className="sx-muted sx-small th-lead">Dark theme, used when the system is dark</p>
          <ThemeGrid themes={dark} activeId={ids.dark} label="Dark theme" onPick={pick} owned={owned} />
          <p className="sx-muted sx-small th-lead">Light theme, used when the system is light</p>
          <ThemeGrid themes={light} activeId={ids.light} label="Light theme" onPick={pick} owned={owned} />
        </>
      ) : (
        <ThemeGrid themes={[...dark, ...light]} activeId={current.id} label="Theme" onPick={pick} owned={owned} />
      )}
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
      <h4>Motion</h4>
      <div className="th-row" {...tipAttrs({ title: 'Motion', body: "Follow system uses your computer's reduce motion setting. Remote Desktop often turns it on. On keeps the animations either way; Reduced stills them." })}>
        <Seg
          label="Motion"
          size="sm"
          value={motion}
          onChange={(v) => set({ motion: v as 'system' | 'full' | 'reduced' })}
          options={[
            { value: 'system', label: 'Follow system' },
            { value: 'full', label: 'On' },
            { value: 'reduced', label: 'Reduced' },
          ]}
        />
      </div>
      <h4>Fonts</h4>
      <div className="th-fonts">
        <label className="th-font" htmlFor="set-font-ui">
          <span>Interface</span>
          <Select id="set-font-ui" size="sm" value={fonts.ui} onChange={(e) => set({ fonts: { ...get().fonts, ui: e.target.value } })}>
            <option value="theme">Theme default</option>
            {UI_FONTS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="th-font" htmlFor="set-font-mono">
          <span>Numbers and code</span>
          <Select id="set-font-mono" size="sm" value={fonts.mono} onChange={(e) => set({ fonts: { ...get().fonts, mono: e.target.value } })}>
            <option value="theme">Theme default</option>
            {MONO_FONTS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
        </label>
      </div>
    </div>
  )
}
