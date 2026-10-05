# @slicerx/contracts

Every type that crosses a package boundary, the SXPV constants and `readPreview()`. No dependencies, so every package can import it. Rust mirrors these shapes with serde; `fixtures/contracts/*.json` keeps the two in step.

## Public API

```ts
import type { Host, SliceRequest, PrinterHost, Pilot } from '@slicerx/contracts'
import { readPreview, FEATURE, SLICE_STAGES, DEFAULT_POLICY, EASY_DEFAULTS } from '@slicerx/contracts'
```

Change rules: additive changes are free; tell consumers. Breaking changes need every consumer updated in the same change.

## State

First drafts; each module is reviewed by the package that uses it most.
