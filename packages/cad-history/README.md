# @slicerx/cad-history

The CAD history of an object (docs/cad-history.md): the steps done to it, their replay on the sx-geom engine, which step made each face, and the parts a project file stores it in. No React, no store and no engine of its own: a replay takes any engine call, so the app's geometry worker, its tests and the MCP server run the same steps the same way.

```ts
import { replayHistory, historyFiles, parseHistories, type History, type Step } from '@slicerx/cad-history'
```

| Module | What it holds |
|---|---|
| types.ts | The engine's CAD shapes as a step keeps them (frames, sketches, extrude, holes, threads, edges) |
| model.ts | History, steps, face keys and references, matrix helpers |
| replay.ts | Replays a history with an injected engine call |
| provenance.ts | The step that made each face, from the face keys |
| salt.ts | The face key salt of a step |
| pattern.ts | Feature patterns on a face |
| file.ts, read.ts | `Metadata/slicerx_history.json` and its binary mesh parts, written and read |

Recording a person's edits and the timeline stay in the app (packages/app/src/cad/history).

## Using it

- `replayHistory(call, { history })` runs every step on any engine call (`(op, request) => Promise<reply>`, the sx-geom JSON ops) and returns the parts, each step's status, and the step that made each face (`madeBy`). It caches results by a hash of the base and the steps, so adding one step runs one step.
- A new step is `{ id: stepId(), part, transform, params }`; `appendStep(history, step)` adds it the way the app's tools do (steps that broke are suppressed first, and the step follows the end faces its references sit on). Replay and keep it only when its status is `done`.
- `historyFiles(objects, fileIds)` gives the project parts to write; `parseHistories(files, objectIds)` reads them back and checks every step.

## Paint

A part can carry paint (`HistoryMesh.paint`: per layer, color, seam, support or fuzzy skin, each painted triangle's 3MF text). A `paint` step stores its target in words a person uses (the whole part, faces facing a direction, a height band, a seed point with its face key, or one state for another), and replay paints it again through the engine's `paint.select`, so it holds after earlier edits. A later step that changes the part's triangles drops its paint and says so in the step's note (`PAINT_DROPPED`). Paint on stored meshes rides in the history JSON next to each part's name and slot; the binary meshes are unchanged, so older files read as before. Brush strokes stay outside the history.

## Adding a step kind

A new `op` (a paint step, say) touches five places, each checked by a test: its params in `StepParams` (model.ts), its case in `runStep` (replay.ts), its name and main number in `madeName` and `mainNumber` (model.ts), its checks in read.ts (a file whose step does not check drops that object's history, never the project), and its icon in the app's `step-icon.ts`. A file version stays 2 while new kinds are added: an older SlicerX drops only the histories that use one.

The exports above are stable; changes to them come with every consumer updated in the same pull request.
