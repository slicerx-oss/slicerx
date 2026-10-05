// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How the eval drives each coding agent headless: one call per developer turn, resuming the same
// session, with tools limited to the app folder, npm, node and the agent's own MCP setup command.
// Every agent gets the same message and nothing else. Only `claude` has been run so far; the others
// follow each CLI's documented non-interactive mode and need a first run to confirm.
import { appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

/** Commands an agent may run. Nothing that pushes, publishes, deploys or leaves the app folder (and, for Path A, the clone). */
const ALLOWED_BASH = ['npm', 'npx', 'node', 'pnpm', 'ls', 'cat', 'mkdir', 'cp', 'mv', 'rm', 'tar', 'head', 'tail', 'grep', 'find', 'pwd', 'which', 'claude mcp', 'curl', 'echo', 'test', 'wc', 'sed', 'diff', 'cd']
/** Path A builds an edition in a clone: the Rust toolchain, binaryen, read-only git and the variable form of the build. */
const ALLOWED_BASH_EDITION = ['cargo', 'rustc', 'rustup', 'wasm-opt', 'sh scripts/install-binaryen.sh', 'git clone', 'git remote', 'git fetch', 'git status', 'git log', 'git diff', 'SLICERX_CONFIG=', 'SX_WASM_OPT=', 'export SLICERX_CONFIG', 'export SX_WASM_OPT']
const DENIED_BASH = ['git push', 'npm publish', 'pnpm publish', 'npm login', 'vercel', 'netlify', 'gh', 'wget', 'ssh', 'scp', 'sudo']

function run(cmd, args, cwd, input) {
  const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 45 * 60_000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message }
}

export const AGENTS = {
  /** Claude Code: claude -p with stream-json, resumed by session id. */
  claude: {
    turn({ cwd, message, session, model, budget, transcript, readDirs = [], edition = false }) {
      const bash = [...ALLOWED_BASH, ...(edition ? ALLOWED_BASH_EDITION : [])]
      const args = [
        '-p', message,
        '--model', model,
        '--output-format', 'stream-json', '--verbose',
        '--max-budget-usd', String(budget),
        '--permission-mode', 'acceptEdits',
        // Only the kit is context: no user settings, memory files or MCP servers from this machine.
        '--setting-sources', 'project,local',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        // only these tools exist for the agent, and no skills or slash commands from this machine
        '--tools', 'Read,Write,Edit,Glob,Grep,Bash',
        '--disable-slash-commands',
        '--allowedTools', 'Read', 'Write', 'Edit', 'Glob', 'Grep', ...bash.map((c) => `Bash(${c}:*)`),
        // AskUserQuestion cannot be answered in print mode, so questions go in plain text; Task would start helpers outside the limits.
        '--disallowedTools', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'AskUserQuestion', ...DENIED_BASH.map((c) => `Bash(${c}:*)`),
        ...readDirs.flatMap((d) => ['--add-dir', d]),
        ...(session ? ['--resume', session] : []),
      ]
      const r = run('claude', args, cwd)
      appendFileSync(transcript, r.stdout)
      let text = ''
      let cost
      let id = session
      let error = r.error ?? (r.status !== 0 ? r.stderr.slice(0, 500) || `exit ${r.status}` : undefined)
      for (const line of r.stdout.split('\n')) {
        if (!line.startsWith('{')) continue
        const ev = JSON.parse(line)
        if (ev.session_id) id = ev.session_id
        if (ev.type === 'result') {
          text = ev.result ?? ''
          cost = ev.total_cost_usd
          if (ev.is_error && ev.subtype !== 'success') error = ev.subtype
        }
      }
      return { session: id, text, cost, error }
    },
  },

  /** Codex CLI: codex exec --json, resumed with codex exec resume <id>. Not run yet. */
  codex: {
    turn({ cwd, message, session, model, transcript }) {
      const args = session ? ['exec', 'resume', session, '--json', message] : ['exec', '--json', '--sandbox', 'workspace-write', ...(model ? ['--model', model] : []), message]
      const r = run('codex', args, cwd)
      appendFileSync(transcript, r.stdout)
      let id = session
      let text = ''
      for (const line of r.stdout.split('\n')) {
        if (!line.startsWith('{')) continue
        const ev = JSON.parse(line)
        id = ev.thread_id ?? ev.session_id ?? id
        if (ev.item?.type === 'agent_message') text = ev.item.text ?? text
      }
      return { session: id, text, error: r.status === 0 ? undefined : r.stderr.slice(0, 500) }
    },
  },

  /** Cursor CLI: cursor-agent -p --output-format json, resumed with --resume. Not run yet. */
  cursor: {
    turn({ cwd, message, session, model, transcript }) {
      const args = ['-p', message, '--output-format', 'json', ...(model ? ['--model', model] : []), ...(session ? ['--resume', session] : [])]
      const r = run('cursor-agent', args, cwd)
      appendFileSync(transcript, `${r.stdout}\n`)
      const ev = r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : {}
      return { session: ev.session_id ?? session, text: ev.result ?? '', error: r.status === 0 ? undefined : r.stderr.slice(0, 500) }
    },
  },

  /** opencode: opencode run, continuing the last session in the folder. Not run yet. */
  opencode: {
    turn({ cwd, message, session, model, transcript }) {
      const args = ['run', ...(session ? ['--continue'] : []), ...(model ? ['--model', model] : []), message]
      const r = run('opencode', args, cwd)
      appendFileSync(transcript, `${JSON.stringify({ type: 'opencode', stdout: r.stdout })}\n`)
      return { session: 'last', text: r.stdout.slice(-4000), error: r.status === 0 ? undefined : r.stderr.slice(0, 500) }
    },
  },
}
