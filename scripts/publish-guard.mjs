// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// prepublishOnly of the published packages. Their manifests point at src/ and name workspace
// packages with workspace:*; pnpm rewrites both when it packs (publishConfig, workspace
// versions), npm does not. So publish with `pnpm publish --access public`, or publish the
// tarball `pnpm pack` writes with `npm publish <file>.tgz --access public`.
const agent = process.env.npm_config_user_agent ?? ''
if (!agent.startsWith('pnpm/')) {
  console.error('publish-guard: publish this package with `pnpm publish --access public`, or `pnpm pack` and then `npm publish <file>.tgz --access public`. npm publish from the folder ships the workspace manifest.')
  process.exit(1)
}
