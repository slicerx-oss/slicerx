# Staying current

SlicerX changes many times a day, and main can be broken for a while between releases. Build your edition or integration from a release tag, not from main.

## What to watch

Release tags. Desktop releases are tagged `desktop-v<version>`, for example `desktop-v0.2.6`, and engine releases `engine-v<version>`. A tag marks one commit that passed the full test suite and the release checks. An edition builds from the newest `desktop-v` tag. An app that only ships the `sx` engine and `@slicerx/mcp` follows the `engine-v` tags. Other tags, such as `desktop-updates`, move and are not releases.

The release notes. Each desktop release has a "For editions and integrations" section that starts with one line, `Update: required`, `Update: recommended` or `Update: optional`, and then lists what changed for edition builds: configuration keys, MCP tools and their results, CLI options and build steps.

Two labels on merged pull requests, between releases:

- `urgent`: a fix people must update for, such as a safety problem, data loss, a crash on open or a security hole. It ships in a release soon after it merges. If you can't wait, cherry-pick its commit onto the tag you build from.
- `integrators`: a change to what editions and integrations build against. The pull request has an `Integrators:` line that says what to change on your side. These ride in the next release.

## Checking from a script

```sh
# the newest desktop release
gh release list --repo slicerx-oss/slicerx --exclude-drafts --json tagName \
  --jq '[.[] | select(.tagName | startswith("desktop-v"))][0].tagName'

# its notes, including "For editions and integrations"
gh release view desktop-v0.2.6 --repo slicerx-oss/slicerx --json body --jq .body

# urgent or integrators pull requests merged since your last build
gh pr list --repo slicerx-oss/slicerx --state merged --label urgent \
  --search "merged:>=2026-10-12" --json number,title,mergedAt,url
gh pr list --repo slicerx-oss/slicerx --state merged --label integrators \
  --search "merged:>=2026-10-12" --json number,title,mergedAt,url
```

Checking a few times a day is plenty. Rebuild when a new `desktop-v` tag appears, and read its notes first.
