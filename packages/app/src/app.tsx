// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { AppFeature, Host } from '@slicerx/contracts'
import type { EditionConfig } from '@slicerx/edition-config'
import { AppTooltips } from './lib/tip-host'
import { startAutoSlice } from './state/auto-slice'
import { QueueWatcher } from './queue/watcher'
import { ProfileFollow } from './shell/profile-follow'
import { Frame, keepPressedControlsInPlace, keymapFor, setMotionPreference, ThemeProvider, ToastProvider, type Theme } from '@slicerx/ui'
import { applyType, DEFAULT_THEMES, themeForScheme, themeFromFile } from '@slicerx/ui/theme'
import '@slicerx/ui/styles.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { builtinCommands, toggleRail } from './commands/builtin'
import { getCommand, registerCommands, runCommand } from './commands/registry'
import { useNativeMenu } from './commands/use-native-menu'
import { EditionContext, editionTheme, NEUTRAL, setCurrentEdition, useEdition } from './edition'
import { editionLogo } from './shell/edition-logo'
import { FeaturesContext, resolveFeatures, useFeatures } from './features'
import { HostContext, useHost } from './host'
import { inTextField, matchShortcut } from './lib/keys'
import { lookCommandFor, onControl } from './controls/global-keys'
import { WorkspaceBoundary } from './shell/boundary'
import { CommandBar } from './shell/command-bar'
import { bridgeConnector } from './link/connector'
import { ApprovalDialog, Status, ToastBridge } from './shell/overlays'
import { TopBar } from './shell/top-bar'
import { orderWorkspaces, setupCommands, useApplyLook, useLayout, useLookChoice } from './first-run/look'
import { useAskForPrinter } from './first-run/ask-printer'
import { addFileRefs } from './state/actions'
import { isDirty, startDirtyTracking } from './project/unsaved'
import { useFolderThemes } from './theme/folder'
import { get, pilotState, pushRecent, set, showsLayers, toast, useApp } from './state/store'
import { updaterRegistered } from './updates/hold'
import { toolStore } from './plate/tools'
import { startReadySignal } from './lib/ready-signal'
import { startCrashCapture } from './bugs/crash'
import { needsAgreement } from './first-run/agreement-check'
import { onboardingRerun } from './first-run/onboarding'
import { hasLegacySetupPrinters, withHandPrinters } from './lib/hand-printers'
import './styles/fonts'
import './styles/app.css'

const CalibrationDialog = lazy(() => import('./calibration/dialog').then((m) => ({ default: m.CalibrationDialog })))
const UnsavedDialog = lazy(() => import('./project/unsaved-dialog').then((m) => ({ default: m.UnsavedDialog })))
const ProjectGcodeDialog = lazy(() => import('./project/gcode-dialog').then((m) => ({ default: m.ProjectGcodeDialog })))
const ProjectOpenDialog = lazy(() => import('./project/open-dialog').then((m) => ({ default: m.ProjectOpenDialog })))
const ProjectsDialog = lazy(() => import('./project/projects-dialog').then((m) => ({ default: m.ProjectsDialog })))
const CameraPlayer = lazy(() => import('./camera/player').then((m) => ({ default: m.CameraPlayer })))
const Studio = lazy(() => import('./workspaces/studio').then((m) => ({ default: m.Studio })))
// The plate's fit check, wherever the person is (plate/fit-check.ts); its code stays out of the shell.
const FitWatch = lazy(() => import('./plate/fit-check').then((m) => ({ default: m.FitWatch })))
const Library = lazy(() => import('./workspaces/library/library').then((m) => ({ default: m.Library })))
// Not part of first paint: each loads the first time it opens. The command bar stays eager so the first keystroke after Cmd+K lands.
const SettingsDialog = lazy(() => import('./shell/settings').then((m) => ({ default: m.SettingsDialog })))
const PrintSheet = lazy(() => import('./send/print-sheet').then((m) => ({ default: m.PrintSheet })))
const AboutDialog = lazy(() => import('./shell/about').then((m) => ({ default: m.AboutDialog })))
const ShortcutsDialog = lazy(() => import('./shell/about').then((m) => ({ default: m.ShortcutsDialog })))
const FirstRun = lazy(() => import('./first-run/first-run').then((m) => ({ default: m.FirstRun })))
const ChecksDialog = lazy(() => import('./plate/checks-dialog').then((m) => ({ default: m.ChecksDialog })))
const RepairDialog = lazy(() => import('./plate/repair-dialog').then((m) => ({ default: m.RepairDialog })))
const SvgImportDialog = lazy(() => import('./cad/svg-dialog').then((m) => ({ default: m.SvgImportDialog })))
const ResumeDialog = lazy(() => import('./plate/resume-dialog').then((m) => ({ default: m.ResumeDialog })))
const Agreement = lazy(() => import('./first-run/agreement').then((m) => ({ default: m.Agreement })))
const BugReportDialog = lazy(() => import('./bugs/report-dialog').then((m) => ({ default: m.BugReportDialog })))
// In-app updates load only where the desktop shell registered an updater.
const UpdatesRoot = lazy(() => import('./updates/root').then((m) => ({ default: m.UpdatesRoot })))
const PilotDock = lazy(() => import('./features/pilot/dock').then((m) => ({ default: m.PilotDock })))

/**
 * The whole app. `theme` rebrands it (colors, fonts, radii); without one the user's light or dark choice
 * applies. `logo` fills the app bar's logo slot; without one an edition other than SlicerX shows its own
 * (brand.logo in its config).
 */
export function SlicerXApp({ host, features = [], theme, edition = NEUTRAL, logo }: { host: Host; features?: readonly AppFeature[]; theme?: Theme; edition?: EditionConfig; logo?: ReactNode }) {
  // Text outside React (toasts, errors, menus) names the app through appName(); set before anything renders.
  setCurrentEdition(edition)
  const brandLogo = useMemo(() => logo ?? editionLogo(edition), [logo, edition])
  const scheme = useApp((s) => s.scheme)
  const themeIds = useApp((s) => s.themeIds)
  const userThemes = useApp((s) => s.userThemes)
  const folderThemes = useApp((s) => s.folderThemes)
  const themeCache = useApp((s) => s.themeCache)
  const fonts = useApp((s) => s.fonts)
  const contrast = useApp((s) => s.appearance.contrast)
  const colorVision = useApp((s) => s.appearance.colorVision)
  const textSize = useApp((s) => s.appearance.textSize)
  const fontWeight = useApp((s) => s.appearance.fontWeight)
  const chosen = useMemo(() => themeFromFile(themeForScheme(scheme, themeIds, [...themeCache, ...userThemes, ...folderThemes]), fonts, { contrast, colorVision }), [scheme, themeIds, themeCache, userThemes, folderThemes, fonts, contrast, colorVision])
  // A chosen bundled theme the app has no file for yet (a profile from before the cache) loads once from the theme bundle.
  useEffect(() => {
    const have = new Set([...DEFAULT_THEMES, ...themeCache, ...userThemes, ...folderThemes].map((t) => t.id))
    if (have.has(themeIds.dark) && have.has(themeIds.light)) return
    void import('./theme/cache').then((m) => m.cacheThemes(themeIds))
  }, [themeIds, themeCache, userThemes, folderThemes])
  const active = theme ?? editionTheme(edition, scheme, chosen)
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }))
  // The assistant off means off everywhere: no commands, no panel. Not yet connected keeps both, and the panel shows the connect step.
  const pilotEnabled = useApp((s) => pilotState(s) !== 'off')
  const featureSet = useMemo(() => resolveFeatures(host, pilotEnabled ? features : features.filter((f) => f.id !== 'pilot')), [host, features, pilotEnabled])
  // A pre-alpha build asks for the agreement before anything else, and catches crashes from the first frame.
  useState(() => {
    if (needsAgreement(edition, host, get().agreement)) set({ agreementOpen: true })
    // A release that changed onboarding opens setup again: all of it, prefilled, before beta; only the new steps after.
    const rerun = get().setup ? null : onboardingRerun(edition.release.stage, get().firstRun)
    if (rerun) set({ setup: { step: 'welcome', rerun: true, ...rerun } })
  })
  // Printers added by hand join the host's printers; setup's old list moves into the store once.
  useState(() => {
    if (host.printers) host.printers = withHandPrinters(host.printers)
    if (hasLegacySetupPrinters()) void import('./first-run/setup-host').then((m) => m.migrateSetupPrinters())
  })
  // Crashes are caught from the start; the report code loads after the first frame and takes the early ones.
  useEffect(() => startCrashCapture(), [])
  useEffect(() => {
    let stop: (() => void) | null = null
    let gone = false
    void import('./bugs/reports').then((m) => {
      if (!gone) stop = m.startBugReports(host, edition)
    })
    return () => {
      gone = true
      stop?.()
    }
  }, [host, edition])
  // Settings > Appearance > Motion, else the edition's default, on the root before paint (ui motion.ts)
  const motion = useApp((s) => s.motion) ?? edition.firstRun.defaultMotion ?? 'full'
  useLayoutEffect(() => setMotionPreference(motion), [motion])
  // Settings > Look and feel > Text size and Font weight move the type tokens on the root
  useLayoutEffect(() => applyType(textSize, fontWeight), [textSize, fontWeight])
  return (
    <HostContext value={host}>
      <EditionContext value={edition}>
      <FeaturesContext value={featureSet}>
        <QueryClientProvider client={client}>
          <ThemeProvider theme={active} logo={brandLogo}>
            <ToastProvider>
              <Shell />
              <ToastBridge />
            </ToastProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </FeaturesContext>
      </EditionContext>
    </HostContext>
  )
}

function Shell() {
  const host = useHost()
  useAskForPrinter()
  // Background slicing after edits (Settings > Auto slice).
  useEffect(() => startAutoSlice(host), [host])
  // The page says when it is ready, so scripts wait on that and not on a fixed time.
  useEffect(() => startReadySignal(), [])
  // Closing the tab with unsaved changes asks first. The desktop app asks through confirmDiscard.
  useEffect(() => {
    startDirtyTracking()
    const ask = (e: BeforeUnloadEvent) => {
      if (!isDirty()) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  }, [])
  // Work that was never saved is autosaved a few seconds after each change and offered back at the next start.
  useEffect(() => {
    let stop = () => {}
    let gone = false
    void import('./project/autosave').then((m) => {
      if (gone) return
      stop = m.startAutosave()
      void m.findRecovery().then((r) => {
        if (r && !gone && get().plates.every((p) => p.objects.length === 0) && get().plate.length === 0) set({ projectsDialog: 'recover' })
      })
    })
    return () => {
      gone = true
      stop()
    }
  }, [])
  const projectsOpen = useApp((s) => s.projectsDialog !== null)
  const unsavedOpen = useApp((s) => s.unsavedPrompt !== null)
  const projectGcodeOpen = useApp((s) => s.projectGcode?.asking === true)
  const projectOpenAsk = useApp((s) => s.projectOpenAsk !== null)
  const settingsOpen = useApp((s) => s.settingsOpen)
  const printSheetOpen = useApp((s) => s.printSheet !== null)
  const aboutOpen = useApp((s) => s.aboutOpen)
  const shortcutsOpen = useApp((s) => s.shortcutsOpen)
  const { features, workspaces: available } = useFeatures()
  const layout = useLayout()
  const workspaces = useMemo(() => orderWorkspaces(available, layout), [available, layout])
  const setup = useApp((s) => s.setup)
  const agreementOpen = useApp((s) => s.agreementOpen)
  const bugReportOpen = useApp((s) => s.bugReportOpen)
  // Setup and the agreement cover the whole window; the workspace (and its viewport) starts once they close.
  const covered = (setup !== null || agreementOpen) && host.kind !== 'embedded'
  const calibrationOpen = useApp((s) => s.calibrationOpen)
  const cameraOpen = useApp((s) => s.cameraPlayer !== null)
  const stored = useApp((s) => s.workspace)
  const current = workspaces.find((w) => w.id === stored) ?? workspaces[0]
  const workspace = current?.id ?? 'prepare'

  useEffect(() => registerCommands(builtinCommands(host, workspaces)), [host, workspaces])
  useEffect(() => registerCommands(features.flatMap((f) => f.commands?.(host) ?? [])), [host, features])
  useEffect(() => registerCommands(setupCommands()), [])
  // The desktop app starts its own bridge and connects to it without asking.
  useEffect(() => {
    if (bridgeConnector()?.automatic) void import('./link/bridge').then((m) => m.connectBridge(host))
  }, [host])
  // Presets in use come back at startup; the preset code loads only when there is one.
  useEffect(() => {
    if (Object.keys(get().activePresets).length) void import('./presets/presets').then((m) => m.restorePresets()).catch(() => undefined)
  }, [])
  useApplyLook()
  useFolderThemes(host)
  useGlobalKeys(workspaces.map((w) => w.id))
  useNativeMenu()
  useFileDrops()

  useEffect(() => {
    if (stored !== workspace) set({ workspace })
  }, [stored, workspace])

  const edition = useEdition()
  useEffect(() => {
    document.title = edition.brand.name
  }, [edition])

  useEffect(() => {
    performance.mark('sx-interactive')
  }, [])
  // A pressed radio, tab, switch, checkbox, select or section header never moves: what it changes settles around it.
  useEffect(() => keepPressedControlsInPlace(), [])

  const Feature = current?.component ?? null
  return (
    <>
      <Frame bar={<TopBar />} status={<Status />} className="app" data-workspace={workspace}>
        <WorkspaceBoundary name={current?.label ?? 'This workspace'}>
          {covered ? null : (
            <Suspense fallback={<div className="ws-loading" aria-busy="true" />}>
              {workspace === 'prepare' ? <Studio /> : null}
              {workspace === 'library' ? <Library /> : null}
              {Feature ? <Feature /> : null}
            </Suspense>
          )}
        </WorkspaceBoundary>
        {covered ? null : (
          <Suspense fallback={null}>
            <PilotDock />
          </Suspense>
        )}
      </Frame>
      <CommandBar />
      <Suspense fallback={null}>
        <ResumeDialog />
      </Suspense>
      <Suspense fallback={null}>
        <RepairDialog />
      </Suspense>
      <Suspense fallback={null}>
        <ChecksDialog />
      </Suspense>
      <Suspense fallback={null}>
        <SvgImportDialog />
      </Suspense>
      {printSheetOpen ? (
        <Suspense fallback={null}>
          <PrintSheet />
        </Suspense>
      ) : null}
      <ApprovalDialog />
      {settingsOpen ? (
        <Suspense fallback={null}>
          <SettingsDialog />
        </Suspense>
      ) : null}
      <AppTooltips />
      <QueueWatcher />
      <ProfileFollow />
      <Suspense fallback={null}>
        <FitWatch />
      </Suspense>
      {aboutOpen ? (
        <Suspense fallback={null}>
          <AboutDialog />
        </Suspense>
      ) : null}
      {shortcutsOpen ? (
        <Suspense fallback={null}>
          <ShortcutsDialog />
        </Suspense>
      ) : null}
      {cameraOpen ? (
        <Suspense fallback={null}>
          <CameraPlayer />
        </Suspense>
      ) : null}
      {updaterRegistered() ? (
        <Suspense fallback={null}>
          <UpdatesRoot />
        </Suspense>
      ) : null}
      {unsavedOpen ? (
        <Suspense fallback={null}>
          <UnsavedDialog />
        </Suspense>
      ) : null}
      {projectGcodeOpen ? (
        <Suspense fallback={null}>
          <ProjectGcodeDialog />
        </Suspense>
      ) : null}
      {projectOpenAsk ? (
        <Suspense fallback={null}>
          <ProjectOpenDialog />
        </Suspense>
      ) : null}
      {projectsOpen ? (
        <Suspense fallback={null}>
          <ProjectsDialog />
        </Suspense>
      ) : null}
      {calibrationOpen ? (
        <Suspense fallback={null}>
          <CalibrationDialog />
        </Suspense>
      ) : null}
      {bugReportOpen ? (
        <Suspense fallback={null}>
          <BugReportDialog />
        </Suspense>
      ) : null}
      {agreementOpen && host.kind !== 'embedded' ? (
        <Suspense fallback={<div className="fr-loading" aria-busy="true" />}>
          <Agreement />
        </Suspense>
      ) : setup && host.kind !== 'embedded' ? (
        <Suspense fallback={<div className="fr-loading" aria-busy="true" />}>
          <FirstRun />
        </Suspense>
      ) : null}
    </>
  )
}

function runShortcut(id: string): void {
  if (!getCommand(id)) return
  pushRecent(id)
  void runCommand(id).then((r) => {
    if (!r.ok) toast(r.message)
  })
}

function useGlobalKeys(order: readonly string[]): void {
  const key = order.join(',')
  const choice = useLookChoice()
  const choiceRef = useRef(choice)
  choiceRef.current = choice
  useEffect(() => {
    const ids = key.split(',')
    const onKey = (e: KeyboardEvent) => {
      // Nothing runs behind the agreement.
      if (get().agreementOpen) return
      if (matchShortcut(e, 'Mod+K')) {
        e.preventDefault()
        set((s) => ({ commandOpen: !s.commandOpen }))
        return
      }
      const s = get()
      if (s.setup) return
      if (s.commandOpen || s.approval || s.aboutOpen || s.settingsOpen || s.shortcutsOpen) return
      for (let i = 0; i < ids.length && i < 9; i++) {
        if (matchShortcut(e, `Mod+${i + 1}`)) {
          e.preventDefault()
          set({ workspace: ids[i] ?? 'prepare' })
          return
        }
      }
      if (matchShortcut(e, 'Mod+B')) {
        e.preventDefault()
        toggleRail('left')
        return
      }
      if (matchShortcut(e, 'Mod+Alt+B')) {
        e.preventDefault()
        toggleRail('right')
        return
      }
      if (inTextField(e)) return
      for (const [shortcut, id] of [
        ['Mod+Enter', 'slice'],
        ['Mod+O', 'plate-open'],
        ['Mod+N', 'project-new'],
        ['Mod+Shift+S', 'project-save-as'],
        ['Mod+=', 'zoom-in'],
        ['Mod+-', 'zoom-out'],
        ['Mod+Shift+0', 'view-reset'],
      ] as const) {
        if (matchShortcut(e, shortcut)) {
          e.preventDefault()
          runShortcut(id)
          return
        }
      }
      // The look's own keys: Mod+G slices in the Bambu Studio style, Space opens the command bar in the OrcaSlicer style.
      const c = choiceRef.current
      const look = lookCommandFor(e, keymapFor(c.id, c.overrides?.keys ?? {}), { layers: showsLayers(s), onControl: onControl(e.target) })
      if (look) {
        e.preventDefault()
        if (look === 'palette') set({ commandOpen: true })
        else runShortcut(look)
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && s.workspace === 'prepare' && s.selection) {
        e.preventDefault()
        // With the brim ears tool on, Delete removes the selected ears, never the object (Orca's gizmo does the same).
        if (toolStore.getState().tool === 'brim') void import('./plate/brim-ears').then((m) => m.removeSelectedEars(s.selection!))
        else void runCommand('plate-remove')
      } else if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.defaultPrevented) {
        set({ shortcutsOpen: true })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [key])
}

/** Files dropped on the window or opened by file association go onto the plate. */
function useFileDrops(): void {
  const host = useHost()
  useEffect(() => {
    let depth = 0
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      depth++
      set({ dragging: true })
    }
    const leave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) set({ dragging: false })
    }
    const drop = () => {
      depth = 0
      set({ dragging: false })
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    // A drop adds to the plate; a file the system hands over starts a new project.
    const off = host.files.onOpenRequest((refs, how) => {
      set({ workspace: 'prepare' })
      void addFileRefs(host, refs, { fresh: how !== 'drop' })
    })
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      off()
    }
  }, [host])
}
