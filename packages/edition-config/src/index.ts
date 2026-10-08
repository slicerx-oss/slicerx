// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @slicerx/edition-config. Browser safe; Node loaders are in '@slicerx/edition-config/node'.
export * from './schema.ts'
export { NEUTRAL_EDITION } from './defaults.ts'
export { defineEditionConfig, parseEditionConfig, checkEditionConfig, EditionConfigError, type EditionConfigLayer } from './define.ts'
export { envLayer, ENV_VARS } from './env.ts'
export { viteDefines, geomFeatures, GEOM_FEATURES, tauriConfig, DESKTOP_CONNECT_SRC, DESKTOP_IMG_SRC, publicStorageSource, DESKTOP_WINDOW, DESKTOP_ICON_DIR, DESKTOP_ICONS, desktopFileTypes, publisherOf, DESKTOP_CAPABILITIES, allowPattern, editionPages, editionLinksCapability, expoConfig, wellKnown, sourceUrl, EDITION_GLOBAL } from './build.ts'
export { editionFromBuild, neutralEdition, looksParsed, isEnabled, printerEnabled, crashReportsRequired } from './runtime.ts'
export { SLICERX_LINKS, SLICERX_BUG_REPORTS, SLICERX_SOURCE, POWERED_BY, bugReportsLink, privacyPage, isFork, reportsUpload, crashReportsSent, UPSTREAM_REPORTS, editionLinks, attribution, mcpServerId, logoImage } from './links.ts'
export { mergeLayers } from './merge.ts'
export { fontStack, fontFaceCss, missingFonts, SANS_FALLBACK, MONO_FALLBACK, BASE_FONT_FAMILIES, type FontFace } from './fonts.ts'
