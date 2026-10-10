// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Screen 2: "Which slicer do you use now?" The answer picks the control preset (mouse, keys, tab
// names) and offers to bring that slicer's presets along. The preview on the right is the SlicerX
// window in that style, drawn from the same data the app uses, with its plate as a box to try the mouse.
import { LOOK_OPTIONS, type LookAndFeelChoice, type LookId } from '@slicerx/contracts'
import { Button, Chip, Dialog, Icon, LinkButton, Seg, Switch, type IconName } from '@slicerx/ui'
import { controlsPreset, withRemap, type ButtonRemap, type ControlsMap } from '@slicerx/viewport'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { crashReportsRequired, crashReportsSent, editionLinks, isFork } from '@slicerx/edition-config'
import { useEdition, appName } from '../edition'
import { useFeatures } from '../features'
import { useHost } from '../host'
import { formatShortcut } from '../lib/keys'
import { set, useApp } from '../state/store'
import { AUTO_SLICE_DETAIL, AUTO_SLICE_MODES, autoSliceFields, autoSliceMode } from '../state/auto-slice-mode'
import { controlOverrides, controlsFor, withControlOverrides, type ControlOverrides } from './controls'
import { LayoutPreview } from './layout-preview'
import { lookPreview, mouseLine, type LookPreview } from './look-preview'
import { choose } from './model'
import { controlsCaption } from './mouse-try'
import { ImportReportView } from '../presets/import-report'
import { APP_FOR_LOOK, APP_NAMES, importInstalled, importPickedFiles, presetImportFor, PRESET_FOLDERS, type ImportResult, type InstalledPreset, type SlicerApp } from './preset-import'

const API = { controlsPreset, withRemap }
type MouseButtonName = 'left' | 'middle' | 'right'

/** Cards in the order a person is likely to answer; "something else" takes the SlicerX defaults. */
const SLICERS: readonly { id: LookId; name: string; icon: IconName }[] = [
  { id: 'bambu-studio', name: 'Bambu Studio', icon: 'look-bambu-studio' },
  { id: 'orcaslicer', name: 'OrcaSlicer', icon: 'look-orcaslicer' },
  { id: 'prusaslicer', name: 'PrusaSlicer', icon: 'look-prusaslicer' },
  { id: 'slicerx', name: 'Something else, or none yet', icon: 'look-slicerx' },
]

/** The line under a card: the first two things the look sets apart. The SlicerX card says what it is. */
export function cardLine(p: LookPreview): string {
  if (p.id === 'slicerx') return `Start with the ${appName()} defaults`
  const line = p.notes
    .slice(0, 2)
    .map((n) => n.short)
    .join(', ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}

export const BUTTON_LABELS: Record<MouseButtonName, string> = { left: 'Left button', middle: 'Middle button', right: 'Right button' }
export const REMAP_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'pan', label: 'Pan' },
  { value: 'rotate', label: 'Rotate' },
] as const

export function plainAction(map: ControlsMap, b: MouseButtonName): 'none' | 'pan' | 'rotate' {
  const a = map.drags.find((d) => d.button === b && !d.mods && (d.context ?? 'any') !== 'preview')?.action
  return a === 'pan' || a === 'rotate' ? a : 'none'
}

function MouseDialog({ open, onClose, choice, onChange }: { open: boolean; onClose: () => void; choice: LookAndFeelChoice; onChange: (c: LookAndFeelChoice) => void }) {
  const o = controlOverrides(choice)
  const map = controlsFor(API, choice)
  const update = (patch: Partial<ControlOverrides>) => onChange(withControlOverrides(choice, { ...o, ...patch }))
  const setButton = (b: MouseButtonName, v: 'none' | 'pan' | 'rotate') => {
    const preset = plainAction(controlsPreset(choice.id), b)
    const remap: ButtonRemap = { ...o.remap }
    if (v === preset) delete remap[b]
    else remap[b] = v === 'none' ? null : v
    update({ remap })
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Mouse buttons"
      footer={
        <>
          <Button variant="ghost" onClick={() => onChange(withControlOverrides(choice, {}))}>
            Use the style's defaults
          </Button>
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      <div className="fr-mouse">
        {(['left', 'middle', 'right'] as const).map((b) => (
          <div className="fr-mouse-row" key={b}>
            <span>{BUTTON_LABELS[b]} drag</span>
            <Seg label={`${BUTTON_LABELS[b]} drag`} size="sm" value={plainAction(map, b)} options={REMAP_OPTIONS} onChange={(v) => setButton(b, v)} />
          </div>
        ))}
        <div className="sx-switchrow">
          <label htmlFor="fr-invert">Invert zoom</label>
          <Switch id="fr-invert" checked={map.wheel.invert} onChange={(v) => update({ invert: v })} />
        </div>
        <div className="sx-switchrow">
          <label htmlFor="fr-cursor">Zoom to cursor</label>
          <Switch id="fr-cursor" checked={map.wheel.zoomToCursor} onChange={(v) => update({ zoomToCursor: v })} />
        </div>
        <div className="sx-switchrow">
          <label htmlFor="fr-free">
            Free camera
            <small>Orbit around the point under the cursor instead of the plate.</small>
          </label>
          <Switch id="fr-free" checked={map.freeCamera} onChange={(v) => update({ freeCamera: v })} />
        </div>
        <p className="sx-small sx-muted">{controlsCaption(map)}</p>
      </div>
    </Dialog>
  )
}

type ScanState = { status: 'idle' } | { status: 'scanning' } | { status: 'done'; found: InstalledPreset[] } | { status: 'error'; message: string }
type ImportState = { status: 'idle' } | { status: 'importing' } | { status: 'done'; results: ImportResult[] }

const KIND_LABEL = { process: 'Process', filament: 'Filament', printer: 'Printer' } as const

function folderHint(app: SlicerApp): string {
  const f = PRESET_FOLDERS[app]
  const p = navigator.platform
  return p.startsWith('Mac') ? f.mac : p.startsWith('Win') ? f.windows : f.linux
}

/** How to get presets out of an app when SlicerX cannot look in its folder. */
function exportHint(app: SlicerApp, name: string) {
  if (app === 'prusaslicer') return <>In PrusaSlicer, choose File, Export, Export Config Bundle. Then pick that .ini file here.</>
  const bundle = app === 'orcaslicer' ? '.orca_printer or .orca_filament' : '.bbscfg or .bbsflmt'
  return (
    <>
      Pick a preset bundle exported from {name} ({bundle}), or the .json files in its preset folder:
      <span className="sx-mono fr-path">{folderHint(app)}</span>
    </>
  )
}

/** Bring presets over from the chosen slicer: found on disk by the desktop app, or picked as files. */
function PresetImport({ app }: { app: SlicerApp | null }) {
  const host = useHost()
  const imp = useMemo(() => presetImportFor(host), [host])
  const [scan, setScan] = useState<ScanState>({ status: 'idle' })
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [state, setState] = useState<ImportState>({ status: 'idle' })

  useEffect(() => {
    setState({ status: 'idle' })
    if (!app || !imp) {
      setScan({ status: 'idle' })
      return
    }
    let alive = true
    setScan({ status: 'scanning' })
    imp.scan(app).then(
      (found) => {
        if (!alive) return
        setScan({ status: 'done', found })
        setPicked(new Set(found.map((p) => p.path)))
      },
      (e: unknown) => alive && setScan({ status: 'error', message: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      alive = false
    }
  }, [app, imp])

  if (!app) {
    return (
      <section className="fr-import" data-off aria-labelledby="fr-import-h">
        <h2 className="fr-import-h" id="fr-import-h">
          <Icon name="import" size={16} /> Presets
        </h2>
        <p className="fr-import-what">Nothing to bring over. To import presets from another slicer later, open Settings, then Presets.</p>
      </section>
    )
  }

  const name = APP_NAMES[app]
  const run = async (fn: () => Promise<ImportResult[]>) => {
    setState({ status: 'importing' })
    try {
      const results = await fn()
      setState(results.length ? { status: 'done', results } : { status: 'idle' })
    } catch (e) {
      setState({ status: 'done', results: [{ name, ok: false, skipped: 0, message: e instanceof Error ? e.message : String(e) }] })
    }
  }
  const chooseFiles = () => void run(() => importPickedFiles(host, app))
  const found = scan.status === 'done' ? scan.found : []
  const selected = found.filter((p) => picked.has(p.path))
  const busy = state.status === 'importing'

  return (
    <section className="fr-import" aria-labelledby="fr-import-h">
      <h2 className="fr-import-h" id="fr-import-h">
        <Icon name="import" size={16} /> Bring your {name} presets
      </h2>
      <p className="fr-import-what">Your own printer, filament and process presets. The ones {name} ships with are already in {appName()}, and nothing in {name} changes.</p>
      {imp ? (
        <>
          {scan.status === 'scanning' ? (
            <p className="fr-scan" role="status">
              <span className="fr-spin" aria-hidden="true" /> Looking in <span className="sx-mono fr-path">{folderHint(app)}</span>
            </p>
          ) : null}
          {scan.status === 'error' ? <p className="app-err">{scan.message}</p> : null}
          {scan.status === 'done' && found.length === 0 ? (
            <p className="fr-import-note">
              No presets of your own in <span className="sx-mono fr-path">{folderHint(app)}</span>. If {name} keeps them somewhere else, pick the files.
            </p>
          ) : null}
          {found.length ? (
            <ul className="fr-import-list" aria-label={`${name} presets`}>
              {found.map((p) => (
                <li key={p.path}>
                  <label className="fr-check">
                    <input
                      type="checkbox"
                      checked={picked.has(p.path)}
                      onChange={(e) => {
                        const next = new Set(picked)
                        if (e.target.checked) next.add(p.path)
                        else next.delete(p.path)
                        setPicked(next)
                      }}
                    />
                    <span className="fr-import-name">{p.name}</span>
                    <Chip>{KIND_LABEL[p.kind]}</Chip>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="fr-import-note">{exportHint(app, name)}</p>
      )}
      <div className="fr-import-act">
        {found.length ? (
          <Button variant="primary" icon="import" disabled={busy || selected.length === 0} onClick={() => void run(() => importInstalled(imp!, selected))}>
            {busy ? 'Importing' : selected.length === 1 ? 'Import 1 preset' : `Import ${selected.length} presets`}
          </Button>
        ) : null}
        <Button variant={found.length ? 'ghost' : 'default'} size="sm" icon="folder" disabled={busy} onClick={chooseFiles}>
          {found.length ? 'Pick other files' : 'Choose preset files'}
        </Button>
      </div>
      {state.status === 'done' ? (
        <div className="fr-import-result">
          <ImportReportView results={state.results} />
        </div>
      ) : null}
    </section>
  )
}

function CrashReports() {
  const edition = useEdition()
  const crash = useApp((s) => s.crashReports)
  const locked = crashReportsRequired(edition)
  const [whatSent, setWhatSent] = useState(false)
  // A fork sends crash reports only to its own backend; without one there is nothing to turn on.
  if (isFork(edition) && !crashReportsSent(edition)) return null
  return (
    <div className="fr-crash">
      <label className="fr-check">
        <input type="checkbox" checked={crash || locked} disabled={locked} aria-describedby={locked ? 'fr-crash-locked' : undefined} onChange={(e) => set({ crashReports: e.target.checked })} />
        Send anonymous crash reports
      </label>
      {locked ? (
        <span className="fr-crash-locked sx-small" id="fr-crash-locked">
          Crash reports are always on in pre-alpha builds.
        </span>
      ) : null}
      <button type="button" className="fr-textbtn" aria-expanded={whatSent} aria-controls="fr-crash-what" onClick={() => setWhatSent(!whatSent)}>
        What is sent
      </button>
      {whatSent ? (
        <p className="fr-crash-what" id="fr-crash-what">
          When the app crashes: the error and stack trace, the last part of the app log, the app version and commit, the operating system, the printer model and firmware, and a random install ID. Tokens, keys, access codes, serial numbers, IP addresses, emails and your user name in folder paths are removed first. Your models and projects are never sent, but file names can appear in the log.{locked ? null : ' Off means nothing leaves this computer.'}
        </p>
      ) : null}
    </div>
  )
}

const SETUP_MODES = [
  { value: 'simple', label: 'Simple', testId: 'setup-mode-simple' },
  { value: 'advanced', label: 'Advanced', testId: 'setup-mode-advanced' },
  { value: 'expert', label: 'Expert', testId: 'setup-mode-expert' },
] as const

/** When the plate slices by itself. The same three choices as Settings > Slicing and modeling. */
function AutoSliceQuestion() {
  const mode = useApp(autoSliceMode)
  return (
    <div className="fr-mode" role="group" aria-labelledby="fr-autoslice-h">
      <span className="fr-mode-h" id="fr-autoslice-h">
        Auto slice
      </span>
      <Seg label="Auto slice" size="sm" value={mode} options={AUTO_SLICE_MODES.map((m) => ({ value: m.value, label: m.label, title: m.title, testId: `setup-autoslice-${m.value}` }))} onChange={(v) => set(autoSliceFields(v))} />
      <p className="fr-mode-hint">{AUTO_SLICE_DETAIL}</p>
    </div>
  )
}

/** How many settings the Slice sidebar shows. Developer mode reads as Expert here; it is chosen from the chip. */
function SettingsModeQuestion() {
  const mode = useApp((s) => s.settingsMode)
  return (
    <div className="fr-mode" role="group" aria-labelledby="fr-mode-h">
      <span className="fr-mode-h" id="fr-mode-h">
        Settings mode
      </span>
      <Seg label="Settings mode" size="sm" value={mode === 'developer' ? 'expert' : mode} options={SETUP_MODES} onChange={(v) => set({ settingsMode: v })} />
      <p className="fr-mode-hint">Change it any time from the chip at the top of the Slice sidebar.</p>
    </div>
  )
}

export function SlicerStep({ choice, onPick, phone }: { choice: LookAndFeelChoice; onPick: (c: LookAndFeelChoice) => void; phone: boolean }) {
  const host = useHost()
  const download = editionLinks(useEdition()).download
  const scheme = useApp((s) => s.scheme)
  const follow = useApp((s) => s.themeFollowsSystem)
  const autoSlice = useApp((s) => s.autoSlice)
  const { workspaces } = useFeatures()
  const [hover, setHover] = useState<LookId | null>(null)
  const [mouseOpen, setMouseOpen] = useState(false)
  const cards = useRef<(HTMLDivElement | null)[]>([])
  const app = APP_FOR_LOOK[choice.id] ?? null
  const keys = choice.overrides?.keys
  const previews = useMemo(() => new Map(SLICERS.map((s) => [s.id, lookPreview(s.id, workspaces, controlsPreset, formatShortcut, keys ?? {})])), [workspaces, keys])
  const shown = hover ?? choice.id
  const preview = previews.get(shown)!
  // The plate in the preview uses the shown style with the person's own mouse changes on top.
  const map = useMemo(() => controlsFor(API, choose(shown, choice)), [shown, choice])

  const pick = (id: LookId) => {
    if (id !== choice.id) onPick(choose(id, choice))
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>, i: number) => {
    const delta = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
    if (delta) {
      e.preventDefault()
      const next = (i + delta + SLICERS.length) % SLICERS.length
      cards.current[next]?.focus()
      setHover(null)
      pick(SLICERS[next]!.id)
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      pick(SLICERS[i]!.id)
    }
  }

  const label = shown === 'slicerx' ? `${appName()} defaults` : LOOK_OPTIONS[shown].label
  const head = (
    <>
      <h2 className="frp-title" id="frp-h">
        {label}
        {hover && hover !== choice.id ? <span className="frp-peek">Preview</span> : null}
      </h2>
    </>
  )

  return (
    <div className="fr-slicer">
      <header className="fr-head">
        <h1 className="fr-title fr-display">Which slicer do you use now?</h1>
        <p className="fr-lede">{appName()} takes on its mouse, shortcuts and tab names, so your hands already know the way. Print settings and G-code are the same whichever you pick.</p>
      </header>
      <div className="fr-slicer-grid">
        <div className="fr-slicer-left">
          <div className="fr-cards" role="radiogroup" aria-label="Slicer you use now" onMouseLeave={() => setHover(null)}>
            {SLICERS.map((s, i) => {
              const on = s.id === choice.id
              const line = cardLine(previews.get(s.id)!)
              return (
                <div
                  key={s.id}
                  ref={(el) => {
                    cards.current[i] = el
                  }}
                  role="radio"
                  aria-checked={on}
                  aria-describedby={`fr-card-${s.id}`}
                  tabIndex={on ? 0 : -1}
                  className="fr-card"
                  data-on={on ? true : undefined}
                  data-peek={hover === s.id && !on ? true : undefined}
                  onClick={() => pick(s.id)}
                  onMouseEnter={() => setHover(s.id)}
                  onKeyDown={(e) => onKey(e, i)}
                >
                  <span className="fr-card-ic" aria-hidden="true">
                    <Icon name={s.icon} size={26} />
                  </span>
                  <span className="fr-card-main">
                    <span className="fr-card-name">{s.name}</span>
                    <span className="fr-card-sum" id={`fr-card-${s.id}`}>
                      {line}
                    </span>
                  </span>
                  <span className="fr-radio" aria-hidden="true" />
                </div>
              )
            })}
          </div>
          <SettingsModeQuestion />
          <AutoSliceQuestion />
          <PresetImport app={app} />
          <div className="fr-slicer-more">
            <CrashReports />
            {host.kind === 'web' ? (
              <p className="fr-desktop">
                <Icon name="desktop" size={16} />
                <span>
                  <a href={download} target="_blank" rel="noreferrer">
                    Get the desktop app
                  </a>{' '}
                  to slice on your computer and find your presets without exporting them.
                </span>
              </p>
            ) : null}
          </div>
        </div>
        <LayoutPreview preview={preview} map={map} label={label} paintKey={`${scheme}-${follow}`} autoSlice={autoSlice} head={head} phone={phone}>
          <p className="frp-mouse">
            <Icon name="mouse" size={16} />
            <span>
              {mouseLine(map)}.
              {preview.more.length ? (
                <>
                  {' '}
                  <b>Also:</b> {preview.more.join(', ')}.
                </>
              ) : null}
            </span>
            <LinkButton className="frp-mouse-btn" onClick={() => setMouseOpen(true)}>
              Mouse buttons
            </LinkButton>
          </p>
        </LayoutPreview>
      </div>
      <p className="fr-foot-note">Bambu Studio, OrcaSlicer and PrusaSlicer are products of their makers. {appName()} is not affiliated with them.</p>
      <MouseDialog open={mouseOpen} onClose={() => setMouseOpen(false)} choice={choice} onChange={onPick} />
    </div>
  )
}
