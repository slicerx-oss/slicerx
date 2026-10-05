# @slicerx/fleet-sim

In-memory demo printers that implement `PrinterHost` from `../fixtures/demo-fleet.json`. Used by the browser demo and Pilot evals. It rejects side effects without a valid approval token, the same way the Rust host does.

## Public API

```ts
createFleetSim(fixture: DemoFleet, opts?: { clock?: () => number; speed?: number; verify?: TokenVerifier; approvals?: ApprovalVerifier }): FleetSim
// FleetSim = PrinterHost & { tick(ms): void; permit: { mint(action, target?, params?): ApprovalToken } }
```

Load the fixture with `import demo from '@slicerx/fleet-sim/../fixtures/demo-fleet.json'` or read `packages/connect/fixtures/demo-fleet.json`; the type is `DemoFleet` in `@slicerx/contracts`.

Fleets are optional user groups of printers: `fleets`, `createFleet`, `renameFleet`, `updateFleet`, `deleteFleet`, `addToFleet` and `removeFromFleet`. A printer can be in any number of fleets and deleting a fleet never removes printers. The demo data has one, Workshop.

Errors are `FleetSimError` (code from `PrinterErrorCode`). Side effects (`upload`, `start`, `pause`, `resume`, `cancel`, the `gcode` and `spoolman.record_usage` tools) call the verifier before anything else. The verifier receives `{action, target, params}` with the parameter shapes documented on `ApprovalAction` in `@slicerx/contracts` and may be async. The default accepts tokens from `sim.permit.mint(action, target, params?)`, single use, bound to the action and target (and to `params` when given). Pass `approvals` (a broker with `verify(token, action, target, paramsHash)`) to check real approvals, or `verify` for a custom check.

`tick(ms)` advances simulated time: preparing takes 30 s, progress and temperatures move, finished jobs fire `job_finished`. Service tools: `spoolman.list_spools`, `spoolman.get_spool`, `spoolman.record_usage`. Manifests come from `../manifests.json`, the same file the Rust crate embeds.

Tests: `pnpm --filter @slicerx/fleet-sim test` runs `src/contract-suite.ts` (exported as `@slicerx/fleet-sim/contract-suite`), the suite any `PrinterHost` must pass.

## Status

Working. Bay 5 is offline and refuses side effects with `unreachable`.
