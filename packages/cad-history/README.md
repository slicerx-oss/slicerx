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
