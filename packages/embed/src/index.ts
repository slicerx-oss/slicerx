// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @slicerx/embed: SlicerX pieces for other apps. See README.md and CHANGELOG.md.
export { Viewport, type ViewportProps } from './viewport'
export { EMBED_ACTIONS, type EmbedAction, type EmbedTool } from './tools'
export { SettingsPanel, type SettingsPanelProps, type SettingsChange } from './settings-panel'
export { defineSlicerXElements } from './elements'
export { injectStyles, EMBED_CSS } from './styles'
export { decodeStl, decodeQuantized, type DecodedModel } from './mesh'
export { EmbedTheme, sceneFor, type EmbedThemeProps } from './theme'
export { LocalAiSetup, useLocalAi, type LocalAiSetupProps, type UseLocalAiOptions, type LocalAiState, type LocalAiJob, type LocalAiReady, type Hardware, type LocalModel, type LocalNet, type Runner } from './local-ai'
export { Agreement, acceptAgreement, agreementNeeded, readAgreement, AGREEMENT_KEY, AGREEMENT_VERSION, RELEASE, type AgreementProps, type AgreementRecord, type AgreementStorage, type Release, type ReleaseStage } from './agreement'
// The theme API, so an app themes the pieces without a second package.
export { createTheme, subban, subbanLight, nocturne, nocturneLight, themeToCss } from '@slicerx/ui/theme'
export type { Theme, ThemeInput, ThemeColors, ThemeGradient, ThemeFonts, ThemeRadius, ThemeScene } from '@slicerx/ui/theme'
export type { BedOutline, TransformEvent, ViewportTheme } from '@slicerx/viewport'
