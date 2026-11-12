// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// apt-install.sh and playwright-chromium.sh against stand-ins for apt-get, dpkg, sudo and pnpm, so each path runs with
// no package mirror and nothing installed: packages already there, a warm cache of .deb files, a cold cache with the
// mirror up, a mirror that cannot be reached (and the fallback mirror), and Playwright's list of missing packages. Also
// apt-seed.sh, which downloads those files for a hosted image with apt state of its own.
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const STUBS = {
  sudo: 'exec "$@"',
  sleep: ':',
  // the packages listed in $STATE/installed ("name" or "name version", 1.0 by default) are installed
  'dpkg-query': [
    'p=${@: -1}; line=$(grep -E "^$p( |$)" "$STATE/installed" 2>/dev/null | tail -1); [ -n "$line" ] || exit 1',
    'case "$2" in *Version*) v=${line#* }; [ "$v" = "$line" ] && v=1.0; printf "%s" "$v" ;; *) printf "ii " ;; esac',
  ].join('\n'),
  // a stand-in .deb is a text file of "Field: value" lines
  'dpkg-deb': 'grep "^$3: " "$2" | cut -d" " -f2-',
  dpkg: [
    'if [ "$1" = --compare-versions ]; then [ "$2" != "$4" ] && [ "$(printf "%s\\n%s\\n" "$2" "$4" | sort -V | tail -1)" = "$2" ]; exit; fi',
    'shift; echo "dpkg -i $(for f in "$@"; do grep "^Package: " "$f" | cut -d" " -f2-; grep "^Version: " "$f" | cut -d" " -f2-; done | paste -sd" ")" >> "$STATE/log"',
    'for f in "$@"; do grep "^Package: " "$f" | cut -d" " -f2- >> "$STATE/installed"; done',
  ].join('\n'),
  // apt-get logs its call; APT_UPDATE_FAIL and APT_INSTALL_FAIL are how many updates or installs fail first
  'apt-get': [
    'echo "apt-get $*" >> "$STATE/log"',
    // the sources each call read: apt-install.sh names its own list with -o, apt-seed.sh through APT_CONFIG
    'for a in "$@"; do case $a in Dir::Etc::sourcelist=*) cp "${a#*=}" "$STATE/sources"; cat "${a#*=}" >> "$STATE/sources.all" ;; esac; done',
    'if [ -n "${APT_CONFIG:-}" ]; then grep -h "^deb" "$(awk -F\\" "/^Dir::Etc::sourcelist /{print \\$2}" "$APT_CONFIG")" > "$STATE/sources"; fi',
    'n() { c=$(cat "$STATE/$1" 2>/dev/null || echo 0); echo $((c + 1)) > "$STATE/$1"; [ "$c" -lt "${2:-0}" ]; }',
    'case " $* " in',
    '  *" update "*) n updates "${APT_UPDATE_FAIL:-0}" && exit 100; exit 0 ;;',
    '  *" install "*) n installs "${APT_INSTALL_FAIL:-0}" && exit 100',
    '    seen=0; for a in "$@"; do [ $seen = 1 ] && case $a in -*) ;; *) echo "$a" >> "$STATE/installed" ;; esac; [ "$a" = install ] && seen=1; done; exit 0 ;;',
    'esac',
  ].join('\n'),
  // playwright through pnpm: the report in $STATE/report for a dry run
  pnpm: [
    'echo "pnpm $*" >> "$STATE/log"',
    '[ -z "${PLAYWRIGHT_HOST_PLATFORM_OVERRIDE:-}" ] || echo "platform $PLAYWRIGHT_HOST_PLATFORM_OVERRIDE" >> "$STATE/log"',
    'case " $* " in *" --dry-run "*) cat "$STATE/report"; exit "${PW_DRY_STATUS:-0}" ;; esac',
  ].join('\n'),
}

function setup({ installed = [], report = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apt-install-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(join(root, 'installed'), installed.map((p) => `${p}\n`).join(''))
  writeFileSync(join(root, 'report'), report)
  return root
}

// a cached .deb; the cache records the release it was filled for (noble, the release run() gives by default)
function deb(dir, pkg, version, release = 'noble') {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${pkg}_${version}_amd64.deb`), `Package: ${pkg}\nVersion: ${version}\n`)
  if (release !== null) writeFileSync(join(dir, 'release'), `${release}\n`)
}

function run(root, script, args, env = {}) {
  const r = spawnSync('bash', [join(here, script), ...args], {
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, STATE: root, HOME: root, SX_APT_ETC: join(root, 'etc'), SX_APT_SUITE: 'noble', ...env },
    encoding: 'utf8',
  })
  const log = existsSync(join(root, 'log')) ? readFileSync(join(root, 'log'), 'utf8').trim().split('\n').filter(Boolean) : []
  return { status: r.status, out: r.stdout + r.stderr, log }
}

describe('apt-install.sh', () => {
  it('asks no mirror when every package is installed', () => {
    const root = setup({ installed: ['a', 'b'] })
    const r = run(root, 'apt-install.sh', ['--cache', join(root, 'cache'), 'a', 'b'])
    assert.equal(r.status, 0, r.out)
    assert.deepEqual(r.log, [])
    assert.match(r.out, /all 2 packages are installed already/)
  })

  it('installs from a warm cache with no mirror, the newest file of each package, never an older one', () => {
    const root = setup({ installed: ['c 9.0'] })
    const cache = join(root, 'cache')
    deb(cache, 'a', '1.0')
    deb(cache, 'a', '1.2')
    deb(cache, 'b', '2.0')
    deb(cache, 'c', '9.0')
    const r = run(root, 'apt-install.sh', ['--cache', cache, 'a', 'b', 'c'])
    assert.equal(r.status, 0, r.out)
    assert.equal(r.log.length, 1, r.log.join('\n'))
    assert.match(r.log[0], /^dpkg -i /)
    assert.match(r.log[0], /\ba 1\.2\b/)
    assert.match(r.log[0], /\bb 2\.0\b/)
    assert.doesNotMatch(r.log[0], /\ba 1\.0\b|\bc 9\.0\b/)
    assert.match(r.out, /installed from the cache, with no mirror/)
  })

  it('empties a cache filled for another release and installs from the mirror, never its files', () => {
    const root = setup()
    const cache = join(root, 'cache')
    deb(cache, 'a', '1.5.2', 'noble')
    const r = run(root, 'apt-install.sh', ['--cache', cache, 'a'], { SX_APT_SUITE: 'resolute' })
    assert.equal(r.status, 0, r.out)
    assert.ok(!r.log.some((l) => l.startsWith('dpkg -i')), r.log.join('\n'))
    assert.match(r.out, /the cache holds 1 files for noble, not resolute: emptied/)
    assert.ok(!existsSync(join(cache, 'a_1.5.2_amd64.deb')))
    assert.equal(readFileSync(join(cache, 'release'), 'utf8').trim(), 'resolute')
    assert.match(r.log.at(-1), / install -f -y --no-install-recommends a$/)
  })

  it('treats a cache that records no release as another release', () => {
    const root = setup()
    const cache = join(root, 'cache')
    deb(cache, 'a', '1.0', null)
    const r = run(root, 'apt-install.sh', ['--cache', cache, 'a'])
    assert.equal(r.status, 0, r.out)
    assert.ok(!r.log.some((l) => l.startsWith('dpkg -i')), r.log.join('\n'))
    assert.match(r.out, /for a release it does not record, not noble: emptied/)
    assert.equal(readFileSync(join(cache, 'release'), 'utf8').trim(), 'noble')
  })

  it('downloads into the cache on a cold one when the mirror answers', () => {
    const root = setup()
    const cache = join(root, 'cache')
    const r = run(root, 'apt-install.sh', ['--cache', cache, 'a'])
    assert.equal(r.status, 0, r.out)
    assert.equal(r.log.length, 2, r.log.join('\n'))
    assert.match(r.log[0], /update --error-on=any$/)
    assert.ok(r.log[1].includes(` Dir::Cache::archives=${cache} `), r.log[1])
    assert.match(r.log[1], / install -f -y --no-install-recommends a$/)
    assert.ok(existsSync(join(cache, 'partial')))
    // with no mirror list on the runner, the Ubuntu hosts for the runner's release
    assert.match(readFileSync(join(root, 'sources'), 'utf8'), /^deb \[signed-by=\S+\] http:\/\/archive\.ubuntu\.com\/ubuntu noble main restricted universe multiverse$/m)
  })

  it("reads only the Ubuntu pockets, from the runner's mirrors and then the fallback alone, and edits nothing under /etc/apt", () => {
    const root = setup()
    const etc = join(root, 'etc')
    mkdirSync(join(etc, 'sources.list.d'), { recursive: true })
    const mirrors = 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\n'
    const ubuntu = 'Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates\n'
    const other = 'deb [arch=amd64] https://packages.microsoft.com/ubuntu/24.04/prod noble main\n'
    writeFileSync(join(etc, 'apt-mirrors.txt'), mirrors)
    writeFileSync(join(etc, 'sources.list.d', 'ubuntu.sources'), ubuntu)
    writeFileSync(join(etc, 'sources.list.d', 'microsoft-prod.list'), other)
    const r = run(root, 'apt-install.sh', ['a'], { APT_UPDATE_FAIL: '1' })
    assert.equal(r.status, 0, r.out)
    assert.deepEqual(r.log.map((l) => l.split(' ').slice(-1)[0]), ['--error-on=any', '--error-on=any', 'a'])
    for (const l of r.log) assert.match(l, / -o Dir::Etc::sourceparts=\S+ -o Dir::State::Lists=\S+ /)
    const all = readFileSync(join(root, 'sources.all'), 'utf8').trim().split('\n')
    assert.equal(all.length, 12, all.join('\n'))
    const pockets = (host) => ['noble', 'noble-updates', 'noble-backports', 'noble-security'].map((s) => `deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] ${host} ${s} main restricted universe multiverse`)
    // the first update, the second (the fallback alone), and the install with the second's lists
    assert.deepEqual(all.slice(0, 4), pockets(`mirror+file:${etc}/apt-mirrors.txt`))
    assert.deepEqual(all.slice(4, 8), pockets('http://mirrors.edge.kernel.org/ubuntu'))
    assert.deepEqual(all.slice(8), pockets('http://mirrors.edge.kernel.org/ubuntu'))
    assert.equal(readFileSync(join(etc, 'apt-mirrors.txt'), 'utf8'), mirrors)
    assert.equal(readFileSync(join(etc, 'sources.list.d', 'ubuntu.sources'), 'utf8'), ubuntu)
    assert.equal(readFileSync(join(etc, 'sources.list.d', 'microsoft-prod.list'), 'utf8'), other)
  })

  it('takes an upgrade the cache holds for an installed package, as apt would for the asked ones', () => {
    const root = setup({ installed: ['lib 1.0', 'tool 3.0'] })
    const cache = join(root, 'cache')
    deb(cache, 'lib', '1.1')
    deb(cache, 'tool', '2.0')
    deb(cache, 'a', '1.0')
    const r = run(root, 'apt-install.sh', ['--cache', cache, 'a'])
    assert.equal(r.status, 0, r.out)
    assert.equal(r.log.length, 1, r.log.join('\n'))
    assert.match(r.log[0], /\blib 1\.1\b/)
    assert.match(r.log[0], /\ba 1\.0\b/)
    assert.doesNotMatch(r.log[0], /\btool\b/)
  })

  it('stops with one line and no install tries when neither mirror gives lists', () => {
    const root = setup()
    mkdirSync(join(root, 'etc'))
    const r = run(root, 'apt-install.sh', ['a', 'b'], { APT_UPDATE_FAIL: '9' })
    assert.equal(r.status, 1)
    assert.equal(r.log.filter((l) => / update /.test(l)).length, 2)
    assert.equal(r.log.filter((l) => / install /.test(l)).length, 0)
    assert.match(r.out, /apt-install: no package mirror answered \(the runner's or the fallback\) and the cache does not hold a b/)
  })

  it('fails after three installs when the lists come but the downloads do not, saying which packages', () => {
    const root = setup()
    const r = run(root, 'apt-install.sh', ['a', 'b'], { APT_INSTALL_FAIL: '9' })
    assert.equal(r.status, 1)
    assert.equal(r.log.filter((l) => / install /.test(l)).length, 3)
    assert.match(r.out, /apt-install: a b did not install/)
  })
})

describe('playwright-chromium.sh', () => {
  it('runs no apt when Playwright finds every system package installed', () => {
    const root = setup({ report: 'All system dependencies are installed.\n' })
    const r = run(root, 'playwright-chromium.sh', [])
    assert.equal(r.status, 0, r.out)
    assert.deepEqual(r.log, ['pnpm --filter @slicerx/web exec playwright install chromium', 'pnpm --filter @slicerx/web exec playwright install-deps --dry-run chromium'])
  })

  it('installs only the packages Playwright lists as missing, and keeps the list with the cache', () => {
    const root = setup({ report: 'Missing system dependencies (2):\n  fonts-wqy-zenhei\n  xvfb\n' })
    const r = run(root, 'playwright-chromium.sh', [], { PW_DRY_STATUS: '1' })
    assert.equal(r.status, 0, r.out)
    assert.match(r.log.at(-1) ?? '', /install -f -y --no-install-recommends fonts-wqy-zenhei xvfb$/)
    assert.equal(readFileSync(join(root, '.cache', 'sx-apt', 'playwright', 'packages.txt'), 'utf8'), 'fonts-wqy-zenhei\nxvfb\n')
  })

  it('uses the kept list when Playwright cannot make one, and installs as --with-deps did with none', () => {
    const failed = "Error: 'apt-get install -s' exited with code 100\n"
    const kept = setup({ report: failed })
    const cache = join(kept, '.cache', 'sx-apt', 'playwright')
    deb(cache, 'xvfb', '2:21.1')
    writeFileSync(join(cache, 'packages.txt'), 'xvfb\n')
    let r = run(kept, 'playwright-chromium.sh', [], { PW_DRY_STATUS: '1' })
    assert.equal(r.status, 0, r.out)
    assert.match(r.log.at(-1) ?? '', /^dpkg -i xvfb 2:21\.1$/)
    const none = setup({ report: failed })
    r = run(none, 'playwright-chromium.sh', [], { PW_DRY_STATUS: '1' })
    assert.equal(r.status, 0, r.out)
    assert.equal(r.log.at(-1), 'pnpm --filter @slicerx/web exec playwright install-deps chromium')
  })

  it('installs only the browser on a self-hosted runner', () => {
    const root = setup({ report: 'Missing system dependencies (1):\n  xvfb\n' })
    const r = run(root, 'playwright-chromium.sh', [], { RUNNER_ENVIRONMENT: 'self-hosted' })
    assert.equal(r.status, 0, r.out)
    assert.deepEqual(r.log, ['pnpm --filter @slicerx/web exec playwright install chromium'])
  })
})

describe('apt-seed.sh', () => {
  it("downloads with the image's status and sources of its own, and keeps the asked packages", () => {
    const root = setup()
    writeFileSync(join(root, 'status'), 'Package: x\n')
    const dir = join(root, 'seed')
    const r = run(root, 'apt-seed.sh', ['resolute', join(root, 'status'), dir, 'a', 'b'])
    assert.equal(r.status, 0, r.out)
    assert.equal(r.log.length, 2, r.log.join('\n'))
    assert.match(r.log[0], /update --error-on=any$/)
    assert.match(r.log[1], /install --download-only -y --no-install-recommends a b$/)
    assert.match(readFileSync(join(root, 'sources'), 'utf8'), /^deb \[signed-by=\S+\] http:\/\/security\.ubuntu\.com\/ubuntu resolute-security main universe$/m)
    assert.equal(readFileSync(join(dir, 'packages.txt'), 'utf8'), 'a\nb\n')
  })

  it('tries the fallback mirror for every pocket when the Ubuntu hosts give no lists', () => {
    const root = setup()
    const r = run(root, 'apt-seed.sh', ['noble', join(root, 'status'), join(root, 'seed'), 'a'], { APT_UPDATE_FAIL: '1' })
    assert.equal(r.status, 0, r.out)
    assert.equal(r.log.filter((l) => / update /.test(l)).length, 2)
    const sources = readFileSync(join(root, 'sources'), 'utf8').trim().split('\n')
    assert.equal(sources.length, 3)
    for (const line of sources) assert.match(line, / http:\/\/mirrors\.edge\.kernel\.org\/ubuntu noble(-updates|-security)? main universe$/)
  })

  it('stops with one line when no mirror gives lists', () => {
    const root = setup()
    const r = run(root, 'apt-seed.sh', ['noble', join(root, 'status'), join(root, 'seed'), 'a'], { APT_UPDATE_FAIL: '9' })
    assert.equal(r.status, 1)
    assert.equal(r.log.filter((l) => / install /.test(l)).length, 0)
    assert.match(r.out, /apt-seed: no package lists for noble/)
  })

  it("takes Playwright's list for the image's platform", () => {
    const root = setup({ report: 'Missing system dependencies (2):\n  fonts-wqy-zenhei\n  xfonts-utils\n' })
    const dir = join(root, 'seed')
    const r = run(root, 'apt-seed.sh', ['resolute', join(root, 'status'), dir, '--playwright'], { PW_DRY_STATUS: '1' })
    assert.equal(r.status, 0, r.out)
    assert.ok(r.log.includes('platform ubuntu26.04-x64'), r.log.join('\n'))
    assert.match(r.log.at(-1) ?? '', /install --download-only -y --no-install-recommends fonts-wqy-zenhei xfonts-utils$/)
    assert.equal(readFileSync(join(dir, 'packages.txt'), 'utf8'), 'fonts-wqy-zenhei\nxfonts-utils\n')
  })
})
