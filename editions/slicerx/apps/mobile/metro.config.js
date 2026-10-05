// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app lives in the pnpm workspace: Metro watches the repository so the shared
// @slicerx packages (TypeScript sources behind symlinks) bundle without a build step.
const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../../../..')

const config = getDefaultConfig(projectRoot)
config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules'), path.resolve(workspaceRoot, 'node_modules')]
config.resolver.unstable_enableSymlinks = true
config.resolver.unstable_enablePackageExports = true
// Keep other apps' build output and Rust targets out of the file map.
const escape = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const under = (dir) => new RegExp(`^${escape(path.join(workspaceRoot, dir))}\\/.*`)
config.resolver.blockList = [under('target'), under('apps/web/dist'), under('apps/desktop/src-tauri')]

module.exports = config
