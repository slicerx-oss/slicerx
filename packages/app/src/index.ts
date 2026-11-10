// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @slicerx/app: the SlicerX shell and base workspaces. Features (the app's own
// in src/features, and edition features elsewhere) use only this entry point.
export { SlicerXApp } from './app'
export { useHost } from './host'
export { registerChatGpt, type ChatGptHost, type ChatGptAccount } from './pilot-connect/chatgpt'
export { registerMimirCloud, type MimirCloudHost, type MimirQuota } from './pilot-connect/cloud'
export { registerLocalAi, type LocalAiHost } from './pilot-connect/local-ai-host'
export type { Hardware, LocalNet } from '@slicerx/pilot/local-ai'
// Not re-exported here, so they load with the screens and calls that use them instead of with the startup code: the
// preset import (@slicerx/app/first-run/preset-import), the shell's CPU answer (@slicerx/app/link/watch-support), the
// sealed phone stores (@slicerx/app/features/phone/sealed), and LayerArt and Swatch (parts.tsx).
// The agent list (registerAgentInstall, registerAgentMarks) comes from @slicerx/app/pilot-connect/agents, so it loads
// with Connect your AI agent instead of riding in the startup shell.
export { registerCommand, registerCommands, listCommands, searchCommands, runCommand, commandTools, commandIdForTool } from './commands/registry'
export { fuzzyScore } from './commands/fuzzy'
export { setWorkspace, toast, useApp } from './state/store'
export { sizeText } from './cad/units'
export { openModelBytes, loadDemoModel, askApproval, buildApproval } from './state/actions'
export { DEMO_MODELS, DEFAULT_MODEL, type DemoModel } from './lib/demo-models'
export { setVendorMarks, VendorMark } from './lib/vendor-mark'
export { useEdition, editionTheme, appName, branded, setCurrentEdition } from './edition'
export { editionLogo, EditionMark } from './shell/edition-logo'
export { useTabLabel } from './first-run/look'
export { setSliceNote } from './lib/slice-note'
export { setExportIdentity } from './export/identity'
export type { ModelSource } from './state/store'
export { registerLinkOpener, registerPrinterPageOpener } from './lib/links'
export { reportSignInResult, type SignInResult } from './lib/sign-in-result'
export { onWindowTitle } from './project/title'
export { registerNativeMenu, type CommandEntry, type MenuEntry, type MenuSection, type NativeMenu } from './commands/menu'
export { configureRelayTokens, pushAccountToken } from './features/phone/relay-tokens'
export { setPairStorage, type PairStorage } from './features/phone/pair-slot'
export { setPhoneAccess, type PhoneAccess, type PhoneState, type PhoneDevice } from './lib/phone'
export { closeSettings, openSettings } from './state/store'
export { connectPinned, shellLinkOptions, HUB_MISMATCH, HubMismatchError, localHubPins, testHubUrl, type HubPins } from './link/hub-pin'
export { setBridgeConnector, type BridgeConnector } from './link/connector'
export type { BridgeSetup, ConnectedBridge } from './link/bridge'
export { confirmDiscard, isDirty, onDirtyChange } from './project/unsaved'
export { registerShellGpu } from './viewport/shell-gpu'
export { holdUpdates, registerUpdater } from './updates/hold'
export type { FoundUpdate, UpdaterHost } from './updates/updates'
export { registerCrashHost, type CrashHost, type NativeCrash, type NativeCrashes, type RunsFrom } from './bugs/crash'
export type { ViewCrash } from './project/view-crash'
export { setPrefsMirror } from './state/prefs'
export { registerStepWasm } from './state/import-step'
export { startGeomFor } from './geom/client'
export { coverForFile, coverInColors, currentProjectUpload, fileModel, projectHasModels, projectModel, vaultCreatorsInFile, type CoverImage, type DerivedColors, type ProjectUpload, type UploadModel } from './export/upload-entry'
