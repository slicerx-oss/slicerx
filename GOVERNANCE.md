# Governance

SlicerX is maintained by Sean Leonard, who started the engine and the CAD layer and has final say on what ships. Decisions are made in the open on GitHub.

## How decisions are made

Changes come in as pull requests and are discussed in issues. A maintainer merges a pull request when it passes CI, keeps G-code output byte-identical unless the change is meant to alter it, and fits the direction in the roadmap. Larger changes (new settings, new printer families, changes to the engine's public API) start as an issue so the design can be agreed on before code is written.

If maintainers disagree, the project maintainer decides and writes down why in the issue.

## Maintainers

Contributors who land steady, careful work can be invited as maintainers. Maintainers can review and merge, triage issues and cut releases. The list lives in MAINTAINERS.md once there is more than one.

## Releases

Releases are tagged from main. Each release lists its changes, ships installers for macOS, Windows and Linux plus the browser build, and passes the full test suite and the cross-platform output checks first.

## Security

Security reports follow SECURITY.md and are handled privately until a fix is released.

## Funding

Money the project receives (grants, sponsorships, donations) is listed in funding.json, along with what it pays for. Funding does not buy control over the roadmap or the license.

## Code of conduct

Everyone in the project follows CODE_OF_CONDUCT.md.
