// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @slicerx/mcp: a Model Context Protocol server for SlicerX. See README.md.
import { readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { EngineCall } from '@slicerx/cad-history'
import { productName, type PermissionPolicy } from '@slicerx/contracts'
import { createApprovalBroker, normalizePolicy, type ApprovalBroker, type PilotTool } from '@slicerx/pilot'
import { createGeomCli } from '@slicerx/pilot/node'
import { createActionLog } from './actionlog'
import { DataStore, resolveDataPaths } from './data'
import type { GateDeps } from './gate'
import { loadPolicy } from './policy'
import { createDemoPrinters, createLinkPrinters, createRoutedBroker, type PrinterBackend, type PrinterMode } from './printers'
import { ProfileCatalog } from './profiles'
import { createCombinedPlanner, createKb, createProfileStore, pilotTools, servicePluginTools, toolContext } from './registry'
import { createSlicerxServer, type ServerContext } from './server'
import { createStubSlicer, type SlicerBackend } from './slicer'
import { createNodeSlicerHost } from './slicerhost'
import { cadTools } from './cad'
import { cloudTools, type CloudOptions } from './cloud'
import { Designs, designFiles, designTools } from './design'
import { paintTools } from './paint'
import { APP_DESIGN_TOOLS, routeToApp } from './app-route'
import { NO_ENGINE_HOST, designToolset } from './toolset'
import { cadFiles, geomEngine, geomTools, findSxGeom } from './geom'
import { createMcpSetupHost } from './setup'
import { createSxSlicer, findSx } from './sx'
import { sxlockTools, type SxlockOptions } from './sxlock'
import { localTools, type ProjectRef } from './tools'
import { localAiTools, type LocalAiOptions } from './localai'

export { createSlicerxServer, SERVER_NAME, SERVER_VERSION, serverTools, type ServerContext } from './server'
export { startHttp, type HttpOptions } from './http'
export { AGENT_CLIENTS, agentKeyRef, installSteps, serverEnv, SERVER_ID, type AgentClient, type AgentClientId, type InstallInput, type InstallStep } from './agents'
export { CLOUD_NOT_CONFIGURED, cloudFromEnv, type CloudOptions } from './cloud'
export { SXLOCK_NOT_CONFIGURED, sxlockFromEnv, type SxlockOptions } from './sxlock'
export { DataStore, resolveDataPaths } from './data'
export { DEFAULT_POLICY_PATH, loadPolicy } from './policy'
export { design3mf, readDesigns, type Design } from './design'

export type EngineMode = 'auto' | 'sx' | 'stub'

export interface SlicerxMcpOptions {
  dataDir?: string | undefined
  /** Directories models may be read from. Undefined: any path the process can read. */
  allowDirs?: string[] | undefined
  outDir?: string | undefined
  engine?: EngineMode | undefined
  sxBin?: string | undefined
  /** Path to sx-geom for the mesh tools (cut, split, repair and so on); default: next to sx, then PATH. */
  sxGeomBin?: string | undefined
  /** The engine designs replay on, instead of sx-geom (embedding and tests); default: sx-geom when found. */
  geomEngine?: EngineCall | undefined
  printers?: PrinterMode | undefined
  /** sx-link WebSocket URL and pairing code, for printers: 'link'. */
  linkUrl?: string | undefined
  linkCode?: string | undefined
  /** sx-link's public key (`hub-key.pub`); the hub must prove it before the code is sent. */
  linkHubKey?: string | undefined
  /** This client's own hub credential (a remembered agent key), instead of the shared agent code. */
  linkClientKey?: string | undefined
  /**
   * With printers through sx-link: run the design tools on the project open in the app while the app link answers
   * (default true; `--no-app` sets false). 'required' (`--app`) runs them only there and refuses while the link does not answer.
   */
  app?: boolean | 'required' | undefined
  /** WebSocket class for the sx-link connection; tests pass a scripted hub. */
  linkWebSocket?: typeof WebSocket | undefined
  /** Permission policy file; defaults to ~/.config/slicerx/mcp-policy.json when present. */
  policyFile?: string | undefined
  /** A policy object instead of a file (embedding and tests). */
  policy?: PermissionPolicy | undefined
  /** Action log (JSONL); defaults to <outDir>/actions.jsonl. */
  logFile?: string | undefined
  /** Where saved profile changes go; defaults to ~/.config/slicerx/profiles. */
  profilesDir?: string | undefined
  allowUrls?: boolean | undefined
  /**
   * Extra tools in the same style from outside the base kit, such as an edition's cloud slicing
   * tools. They go through the same permission gate; the base server never imports them.
   */
  extraTools?: PilotTool<never>[] | undefined
  /** The integrator's cloud slicing API. Absent: slicerx_cloud_slice and slicerx_cloud_jobs answer that cloud slicing is not configured. */
  cloud?: CloudOptions | undefined
  /** The edition's account service, for locked projects. Absent: the slicerx_sxlock_open and _export tools answer that it is not configured. */
  sxlock?: SxlockOptions | undefined
  /** Injected clock for tests. */
  now?: (() => number) | undefined
  /** Set up local AI tools (slicerx_local_ai_check, _setup, _status): an edition's switches, or test doubles. */
  localAi?: LocalAiOptions | undefined
}

/** Builds the shared context once; each MCP server instance reuses it. */
export async function createContext(opts: SlicerxMcpOptions = {}): Promise<ServerContext> {
  const now = opts.now ?? (() => Date.now())
  const store = new DataStore(resolveDataPaths(opts.dataDir))
  const profiles = new ProfileCatalog(store)
  const outDir = resolve(opts.outDir ?? join(tmpdir(), 'slicerx-mcp'))

  const engine = opts.engine ?? 'auto'
  const sxPath = engine === 'stub' ? undefined : findSx(opts.sxBin)
  let slicer: SlicerBackend | undefined
  let slicerUnavailable: string | undefined
  if (sxPath) slicer = createSxSlicer(sxPath)
  else if (engine === 'sx') slicerUnavailable = `The sx CLI was not found${opts.sxBin ? ` at ${opts.sxBin}` : ' on PATH'}. Build it (docs/install.md) or start the server with --engine stub.`
  else slicer = createStubSlicer()

  const localBroker = createApprovalBroker({ now })
  let broker: ApprovalBroker = localBroker
  const mode = opts.printers ?? 'demo'
  let printers: PrinterBackend | undefined
  if (mode === 'demo') printers = createDemoPrinters(store.paths.demoFleetFile, localBroker, now)
  else if (mode === 'link') {
    if (!opts.linkCode && !opts.linkClientKey) throw new Error('--printers link needs the hub\'s agent code: start sx-link (it writes agent-code in its state directory, see sx-link code --agent), pass --link-state-dir for another directory, or set SLICERX_MCP_LINK_CODE.')
    printers = await createLinkPrinters(opts.linkUrl ?? 'ws://127.0.0.1:47615', opts.linkClientKey ? { clientKey: opts.linkClientKey } : { code: opts.linkCode ?? '' }, opts.linkHubKey, opts.linkWebSocket)
    // Real printers verify tokens from sx-link's broker, so their approvals go through it.
    if (printers.approvals) broker = createRoutedBroker(localBroker, printers.approvals)
  }

  const project: ProjectRef = { current: undefined }
  const nodeSlicer = createNodeSlicerHost(slicer ?? createStubSlicer(), outDir, (config) => project.current?.gcodeIsShipped(config) ?? false)
  const kb = createKb()
  const policy = { allowDirs: opts.allowDirs?.map((d) => resolve(d)), outDir, allowUrls: opts.allowUrls ?? true, samplesDir: store.paths.samplesDir }
  const profileStore = createProfileStore(resolve(opts.profilesDir ?? join(homedir(), '.config', 'slicerx', 'profiles')), localBroker)
  const loaded = opts.policy ? { policy: normalizePolicy(opts.policy), path: undefined } : loadPolicy(opts.policyFile)
  const setup = createMcpSetupHost(printers?.kind === 'link' ? (printers.host as unknown as Parameters<typeof createMcpSetupHost>[0]) : undefined, localBroker)
  const geomBin = findSxGeom(opts.sxGeomBin, sxPath)
  const deps = {
    printers: printers?.host,
    setup,
    slicer: nodeSlicer,
    profiles: profileStore,
    kb,
    project,
    ...(geomBin ? { geom: createGeomCli({ binary: geomBin, timeoutMs: 5 * 60_000 }) } : {}),
    today: () => new Date(now()).toISOString().slice(0, 10),
  }
  const gate: GateDeps = {
    policy: loaded.policy,
    policyPath: loaded.path,
    broker,
    log: createActionLog(resolve(opts.logFile ?? join(outDir, 'actions.jsonl'))),
    pending: new Map(),
    ...(printers?.kind === 'demo'
      ? { annotate: (name: string) => (name.startsWith('printer.') || name === 'diagnose' ? 'These are simulated demo printers, not the user\'s own; real printers appear with --printers link and sx-link running.' : undefined) }
      : {}),
    context: (token, signal, progress) => toolContext(deps, token, signal, progress),
    now,
    waiting: new Map(),
  }
  if (printers?.handOff) {
    gate.handOff = printers.handOff
    const waiting = gate.waiting
    printers.handOff.onDone((d) => waiting?.get(d.requestId)?.(d))
  }
  const registry = [...pilotTools(createCombinedPlanner(kb)), ...(await servicePluginTools(printers?.host))]
  const local = localTools({ store, profiles, slicer: nodeSlicer, policy, project })
  const geomCall = opts.geomEngine ?? (geomBin ? geomEngine(geomBin) : undefined)
  const designs = geomCall ? new Designs({ engine: geomCall, policy }) : undefined
  const appLink = opts.app !== false ? printers?.appLink : undefined
  if (opts.app === 'required' && !appLink) throw new Error('--app needs printers through sx-link (--printers link)')
  const built = geomBin || designs ? [...geomTools({ bin: geomBin, policy, designs }), ...cadTools({ files: cadFiles({ bin: geomBin, policy }), designs }), ...(designs ? [...designTools(designs, designFiles(policy)), ...paintTools(designs)] : [])] : []
  // Without an engine here, the design tools still work on the app's project, through the link.
  const here = appLink && !designs ? [...built, ...designToolset(NO_ENGINE_HOST).filter((t) => APP_DESIGN_TOOLS.has(t.name) && !built.some((b) => b.name === t.name))] : built
  // The plate edits go to the app's shown plate too, unless this server's own project has the object.
  const serverHas = (object: string): boolean => project.current?.objects().some((o) => o.id === object || o.name === object) ?? false
  const route = (t: PilotTool<never>[]) => (appLink ? routeToApp(t, appLink, productName(), { required: opts.app === 'required', serverHas }) : t)
  const geom = route(here)
  const cloud = cloudTools({ cloud: opts.cloud, store, profiles, policy })
  const locked = sxlockTools({ sxlock: opts.sxlock, policy })
  const localAi = localAiTools(opts.localAi)
  const tools = [...registry, ...route(local), ...geom, ...cloud, ...locked, ...localAi, ...(opts.extraTools ?? [])].filter((t) => printers || t.source !== 'plugin')

  return {
    store,
    profiles,
    policy,
    slicer,
    ...(slicerUnavailable !== undefined ? { slicerUnavailable } : {}),
    printers,
    tools,
    gate,
  }
}
