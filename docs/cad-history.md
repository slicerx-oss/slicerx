# CAD history

An object edited with the CAD tools keeps what was done to it as an ordered list of steps. The person can open a step, change a number or the sketch, suppress or delete it, and the steps after it replay. It is one flat list per object: no nesting, no dependency view.

## Model

`PlateEntry.history` (absent on objects nobody has modeled on):

```
History = { version: 1, base: MeshPart[], steps: Step[], ended?: string, placed?: [x, y] }
Step    = { id, op, part, transform: Mat4, params, follow?, suppressed?, broken? }
```

- `placed` is how far the design hosts moved the object on the plate to land it on the bed, mm. The design tools give and read points in the design's own frame, the object's transform moved back by `placed`, so a step given in the frame the design was built in still meets its body after a landing. Steps and timeline sketches stay in plate coordinates: a step is moved into them when it is recorded, and a sketch is read in a design's frame through the move of what it moves with and that design's landing (cad-history `design-frame.ts`). A sketch's frame is written once, where it is drawn. Where it stands now is read from what never changes once written: the design it was drawn for with that design's transform then (`SketchItem.drawnFor`, saved with the sketch), or with no design named, the first feature drawn on it with the transform that feature was recorded at, against where that body stands now. A step drawn on a sketch is recorded where the sketch is stored, at the transform that puts it where it was made, by the design tools and by Model's own Extrude and Revolve alike, so an undo, a redo, a deleted body or a change of the first feature never rewrites a frame. A sketch with no design named and no feature left is where it was drawn. A sketch drawn for a design that waits for its body again (its only step undone) stays in the timeline under its id, and moves with the design where it waits. Model draws a finished sketch, and a projection into it is found, on the sketch's plane where it stands now.
- `base` is the object's parts at the moment the first step was recorded (as imported or created). A body made by a sketch or a shape with "New body" has an empty base and the extrude as step 1, so its sketch stays editable.
- `op` names the engine call; `params` are exactly the request that call took, in world millimeters as they were when the step ran. `transform` is the object's transform at that moment. Replay sends `{mesh: <current local mesh>, transform}` with the same params, and the engine answers in the part's local frame, so moving, turning or scaling the object later never disturbs a step.
- `part` is the part index the step works on, or -1 for every part (hollow, repair, simplify, merged array).
- Geometry references live inside `params` in the engine's own terms: a face is a pick `{at, normal}` (the triangle index is found again on the current mesh at replay: the triangle that contains `at` within 0.01 mm and faces within 0.01 degrees of `normal`); an edge is the `EdgeRef {a, b, face}` from `edge.pick` (docs/cad-fillet.md), which the engine finds again itself; a sketch or shape plane is its `FaceFrame`.
- `follow`: when a reference sat on the face that an earlier push or one-sided extrude moved (its end cap; an extrude with no frame stands on the bed, as a design's first body does), the step records `{step, distanceMm}`. If that earlier step's distance changes, the reference moves along that cap's normal by the difference. This keeps "pull the top 5 mm, then sketch on the new top" working after the 5 becomes 8. A fillet or chamfer step can follow several caps, one per direction, and `follow` is then a list. `points` lists the references that sat on the cap when only some did, two per edge (`a`, then `b`). An edge with both ends on a cap moves with it. An edge with one end there keeps its line, and that end slides along it.

Per step result, shown in the list: done, broken (with the engine's sentence, or "The face this step pulled is gone." when a pick cannot be found), skipped (after a broken step), or suppressed.

## Replay

- The object's current mesh is the replay of its steps on its base. Editing step k replays from k; suppressing or deleting replays without it.
- A failing step is marked broken with the message; every later step is skipped, and the object shows the result just before the broken step. Never a half-applied result.
- Replay runs inside the geometry worker (op `history.replay` in geom-worker.ts, same code as tests): meshes stay in the worker between steps, and the worker keeps the input of each step from the last replay, so an edit of step k starts at k. It yields between steps and stops when a newer edit for the same object arrives.
- Editing a step rolls the view back: the object shows the result before that step and the step's own tool panel opens filled in (sketch steps reopen sketch mode with the saved sketch). The tools' own previews do the live part: the push prism while dragging, the outline while typing, the fillet preview. Apply replaces the step and replays the rest.
- Looking back: a step's number shows the object as it was right after that step, rolled back the same quiet way as an edit, with no tool open and the later steps dimmed. Clicking the number again, Back to the latest, or opening any step puts the object back. The last step's number is the object as it is.
- Moving a step: the arrows run a step one place earlier or later and replay the whole list. A step that followed the end face of a step it now comes before keeps its reference where it is (as when that step is deleted). A step that no longer works in its new place is marked broken like any other; undo puts the order back.
- Kept dimensions follow: after a replay, dimension.evaluate runs on the object, with a move for an edited push.
- Undo and redo are unchanged: the history is part of the plate entry, and each history edit is one store update, so one undo step. The rollback while a step is open is not an edit and never reaches undo or autosave.

## Part numbers

A step names its part by its index in the parts list as it was when the step was made. A new body's index is the part count then, so it is added after the last part; an index that is already taken makes that part again in place.

- A suppressed step still numbers the parts as if it had run. A boolean takes its `with` parts away; suppressed, those parts stay in the design, moved to the end of the parts list. Build A and B, union them, build C, and suppress the union: the parts are A, C and B. C keeps index 1, the index it was made with, and every later step finds its part where it was made. Turning the union back on gives A joined with B, then C.
- The parts the history numbers come first; the ones a suppressed boolean set aside follow. A step made while that boolean ran names only numbered parts (or adds a body or parts right after them), so it runs on the numbered parts and the set-aside parts stay after them. A step made after the suppress names parts as they were shown then, set-aside ones among them, so it runs on every part. A new order of every part numbers them all again.
- Added parts (a clone, a merged object, an array of separate copies) name no number: they go after every part, set-aside ones included, where the app puts a part it adds without a replay. A part added in the app after a suppress stays where it was put when the design replays or opens again. The cost: parts added while the boolean ran, then named by a later step, are shown after the set-aside parts once it is suppressed, so that later step finds a set-aside part at its number.
- The other steps that change the part count add parts (a plane cut that keeps both pieces, a split). Suppressed, they number nothing, as before: they take no part away.
- A deleted step leaves nothing to number from, so this does not cover deleting a boolean: its parts come back, and a new body made after it can still take the place of one of them, as before. Suppress the step to keep every part.
- `@slicerx/cad-history` numbering.ts holds the rule. The MCP server's form lines follow the parts through the history with it, so they match the replay.

## Push beside a round

A push or pull of a face that a fillet or chamfer in the history rounds does not cut the rounded body. The round was made for the edge where it was, and a cut around it would leave its strip standing at full height. The push goes into the history just before the first fillet or chamfer step that rounds an edge of that face, and the steps from there run again: the push moves the face of the body as it was before the round, and the round is made again on the moved edge.

- A step counts when one of its edges lies on the rim of the picked face, as that face was before the step. A round that only ends on the face, such as a rounded vertical corner when the top is pushed, does not count. The face's outline already has that round in it, and the push keeps it.
- References of the later steps that sat on the face follow the new push from distance 0. They move as far as the face did, and again when the push is edited.
- The engine finds a moved edge along its line (`moved` on the `EdgeRef`, docs/cad-fillet.md), so an edge that runs into the pushed face is found at its new length.
- A push that goes through the part, such as a pocket floor pushed out the bottom, leaves no face behind. The edges that sat on that face go with it, and a step left with no edges changes nothing.
- The mesh is the result of the replay, so undo, redo and any later replay give the same bytes. If a step after the push no longer works (a round too big for the shorter face, say), the push still lands, that step is marked broken, and the message names the step and the reason.
- A top rounded all the way round is still a face to pick: it meets only strips much narrower than itself.
- Limit: a side face that leans in under the pushed face moves the edge sideways. That round breaks with a message and needs its edge picked again.

## Per tool

| Tool | Decision |
| --- | --- |
| Push and pull | step `face.push`, face pick |
| Sketch extrude, shape, text and SVG on a face | step `shape.extrude` with the typed shape, sketch or SVG, and its `pattern` when it is repeated (one step for every copy); "New body" starts a new object with history |
| Sketch revolve | step `sketch.revolve` |
| Subtract a shape (hole from the top) | step `subtract`, the solid kept in world coordinates of its transform; the result keeps the object's frame instead of being stood up again; the engine sends the cut's faces, so the hole tool and the thread tool find a hole it made, and a face the cut left whole keeps its key while a split one is found again by its place |
| Hollow, repair, simplify | steps `hollow`, `repair`, `simplify` on every part (simplify ratio is editable) |
| Merge objects, add a part | step `parts.add`: the added meshes, in this object's frame, are stored with the history; the other object's own history is not kept |
| Clone a part | step `parts.add` with the copy, placed beside the original, so the timeline stays editable |
| Array as separate copies | step `parts.add` with the copies and `arrayOf`, the name of the part copied; the first part in the list is copy 2 of the part copied, the next copy 3 and so on (parts[k], counting from 0, is copy k + 2); the part itself is copy 1 |
| Reorder parts | step `parts.order` with the new order (part i after it is part `order[i]` before it); no geometry changes, and it replays the same on meshes and on exact solids. Parts a step before it added later (at a rolled-back marker) stay after the ordered ones. Steps name parts by index as they were when the step ran, so follows map indices through order steps (`partThrough`) |
| Array merged into one object | step `array.merged`; copies (instances) are not mesh edits and record nothing |
| Repeat or mirror steps on their part (MCP `geom.array` and `geom.mirror` with `steps`) | step `pattern` with the ids of the steps it repeats, all on one part and before it, and the copies as a row or grid, a circle around an axis, or a mirror plane, world at its transform. Each copy runs those steps again at their transform moved back by the copy's move, without their face and edge keys and with a key salt of its own, so a copy lands moved whatever kind of step it is and follows any edit of the step it repeats. Steps that add, cut, round or paint from a point can be repeated; a new body cannot. Its value is the count (at most 100 copies). Rows and circles run on exact solids; a mirror runs on the mesh |
| Fillet, chamfer | steps `edge.fillet`, `edge.chamfer` with EdgeRefs; sketch corner fillets are part of the sketch |
| Hole tool, thread tool | steps `hole.apply`, `thread.apply`; a hole is found again on the part as it is now |
| Shell | step `shell` with the open faces as world points and normals, found again on the part as it is now; the wall is editable |
| Plane cut | ends history: the pieces are new objects and start without one; the cut panel says so first |
| Split to parts | ends history: the parts become the new base and the list starts with "History ends here: the object was split into parts." |
| Split to objects | ends history, as plane cut |
| Paint, move, rotate, scale, mirror, orient | not steps; paint is per triangle and is dropped by a replay, as by every mesh edit today |

## Named values

A project keeps a table of named values (Tools, Named values; `cad/values-panel.tsx`): a name and a sum for each, such as `wall = 2` and `lip = wall * 1.5`. Sums take numbers, names, `+ - * /` and parentheses, nothing else (`cad/values.ts`). `clearance` (the measured fit a side, from the hole test or half the nozzle) and `nozzle` are built in. A value may use other values but not itself through a loop, and the table says what each comes to or what is wrong with it.

Any typed size in the modeling tools and the Tools dialogs takes a name or a sum. When the main number of a step was typed that way (the push distance, an extrude's distance, a revolve's angle, a fillet's radius or a chamfer's distance, a hole's diameter, a thread's length, a hollow's or a shell's wall), the step keeps the text as `bind` and follows it. Changing a value, or something a built-in reads, gives each such step the number its sum gives now and replays the objects that changed, on the plate in view and on each other plate when it is shown (`cad/value-ops.ts`). A step whose sum no longer works keeps its number, and a toast says why. A value a step uses cannot be removed. In the history list, a step without a tool panel takes a sum in its number field too; a plain number there ends the binding.

The table is saved as `Metadata/slicerx_values.json`, `{ "version": 1, "values": [{ "name", "expr" }] }`, and each step's `bind` with its history. Both are read as untrusted: a newer version is ignored, and a bad or built-in name, a repeated one or a sum over 200 characters is left out. Opening a project into one that already has values adds only the names it does not have.

## Face keys

Each face of a mesh in a history carries a key that says where the face came from (`sx-geom` faces.rs): the faces of the base get keys from their order on the base, and the faces a step makes (its tool's faces) get keys from a salt made from the step's id, so the step makes the same keys when the tool first runs it and in every replay. Booleans carry keys to the faces they come from; a face split in two keeps its key on both parts, and faces that merge keep the smallest. The tool reserves its step's id before it calls the engine (`reserveStepId`), and the replay sends each step's salt (`keySalt`).

A push step keeps the key of the face it moved (`faceKey`), and a shell step the key of each face it opens. On replay a saved push or paint face key must resolve to one face and one connected region. A missing or split reference stops the step and its dependents for repair, preserving the last valid part. It never substitutes a neighbor or the larger split region. Exact reference failures do not fall back to the mesh. Legacy unkeyed picks still use their saved point and learn a key. The app saves a learned key into its step, and the replay cache leaves face and edge keys out of a step's cache key, so saving one does not make the next replay run the step again (a shell on a loft takes tens of seconds). A cached result is used only when each step's keys are the ones it ran with or the ones that run found; any other key runs the step again. Exact unions conservatively clear keys on coplanar operand faces that could merge; a later keyed edit requires a new pick even when the faces did not actually merge.

A fillet or chamfer edge keeps the keys of the two faces either side (`keys`, the face `face` faces first). Each key must resolve to one connected face before the engine finds their boundary. Missing or split faces and ambiguous boundaries require repair instead of selecting a fragment or falling back to the mesh. A keyed round rim must still lie on its uniquely resolved faces. Only unkeyed references use their saved geometry alone. Shell openings follow the same unique-face rule.

A mesh push preserves the source keys of the moved cap and extensions of adjacent planar walls. A moved base face therefore still reports the base as its origin, while the push appears among the steps that used it. Suppressing the push can therefore leave a later keyed fillet valid on the original edge, provided both faces still resolve uniquely. Connectivity requires shared edges: regions touching only at a vertex remain separate.

## Timeline

- One design timeline for the plate (`design.ts`), the way Fusion keeps one: sketches and features in the order they were made, across every body, and a marker that rolls it back (items before it are live).
- A sketch is its own item: its plane (the bed when it has no frame), its loops and its constraints. An extrude or revolve of it names it by id and keeps only its own fields; `featureParams` puts the sketch back in for the engine.
- A body is the object it prints as, with the parts it started from (none for one a feature made). An object's history is a view of the timeline, filtered by its body (`historyOf`), so replay and the per-object tools read it unchanged.
- Projects saved before version 3 open as one: every step merged by when it was made (its id holds the time, `madeAt`), each object's steps kept in their own order, and every sketch an extrude or revolve drew on made an item, named Sketch 1, Sketch 2 and on.
- In the app the store keeps the timeline (`timeline`, in undo with the plate). The tools still record each object's history; `plate/timeline.ts` folds each change back in (`withHistory`): a kept step stays put, an edited sketch keeps its id and name, a new step goes in at the marker, and a step past the marker stays rolled back. An object that leaves the plate takes its features (`withoutBody`); a pasted copy gets sketches of its own.
- A finished sketch goes in at the marker on its own (`withSketch`); an extrude or revolve drawn on it carries its id (`Step.sketch`) and names it instead of making a new one.
- Moving the marker (`cad/history/rollback.ts`, the timeline strip, or `design.roll` over the app link and MCP) replays each body to it. A body made after the marker leaves the plate and the slice until the marker passes it again; while rolled back, Slice, Print and Export say so ("The timeline is rolled back to step N. Slicing uses this state.") with Move to the end. Undo puts the marker back. A project saved rolled back keeps the hidden bodies and opens rolled back.
- The app saves version 3 files; `design.timeline` (MCP, app link) reads the timeline.

## Projections

A finished sketch can hold model geometry projected onto its plane (`project.ts`, `cad/project-sketch.ts`, the sketch panel's Project card and `design.sketch_project`): picked edges, a face's outline with its holes, or a body's outline seen along the sketch normal.

- The curves are plain loops after the sketch's own, each naming its projection (`projected`), so features, replay and the engine read them as any loops. A real projection's loops close profiles; a reference one's are construction and make no profile. New projections are real; either can switch, or go, later.
- A feature drawn on the sketch takes the projections that were there when it was made (`FeatureItem.projected`) and no later one, so projecting into a sketch never changes a solid already made from it. A projection a feature takes keeps following its source, and the feature with it. Saving a step drawn on the sketch keeps the projections it does not take as the sketch has them.
- Projection ids only count up (`SketchItem.nextProjection`, saved with the sketch): a removed projection's id is never handed out again, and the features that took it stop naming it. A file saved without the count gets it back from the highest id its projections, loops and features name.
- `SketchItem.projections` keeps each source in the references steps use: edges as `EdgeRef` with their faces' keys, a face as its point, normal and key, both in world mm with the body's transform when picked; an outline names only its body.
- A projection reads its body as it stands at the sketch's place in the timeline, so a later step never feeds back into the sketch; the panel, the MCP tool and replay read it the same way (`projectNow`). When a body replays, the projections from it are found again (`followProjections`); a sketch whose curves moved changes, and the bodies drawn on it replay, in the same undo step as the edit that moved them. The new curves go into the sketch as it is when the engine answers, so an edit made meanwhile stays. When the bodies drawn on the sketch cannot take the new curves, the curves and the bodies stay as they were and each projection that moved says why.
- A source that is gone (its face or edge missing or split, or the body off the plate) keeps its curves where they were and says why on the projection; nothing nearby stands in for it. It follows again once the source is back.
- A new sketch with projections goes into the timeline before the solid made from it, so the sources stay on the sketch item and never in a step. Saved files name each source's body by its 3MF object id.

## Storage

- `Metadata/slicerx_history.json`, written only when an object has history: `{version: 2, objects: [{object, base, ended?, steps}]}`, `object` the 3MF object id as in slicerx_dimensions.json. Version 2 adds face keys to steps (below); version 1 files open the same way, and their steps get keys on their first replay. A file with a higher version opens without its histories and a message says a newer SlicerX saved it (SlicerX 0.1 ignores version 2 files silently: it predates the message). Version 3 is the design: `{version: 3, sketchAnchors: 1, bodies: [{object, base, ended?, placed?}], items, marker}`, items as in the timeline with `body` the 3MF object id; each body's history is read as a version 2 object made from it, and a feature whose sketch is missing drops that body's history only. `sketchAnchors` says the file's sketches move with what they are drawn for or on. A file without it was written while a sketch stayed where it was drawn when its body moved: each sketch a feature uses opens drawn for that feature's body (the first whose object is in the file) where the object stands as the file opens, so it reads where it was shown, and moves with the body from then on. Objects that are missing are ignored; a project without the part opens as before; other slicers ignore it.
- The model part keeps the current mesh, so the file prints the same anywhere and opening needs no replay.
- Base meshes and `parts.add` meshes go in one binary part each, `Metadata/slicerx_history/<object>-<n>.bin` (little endian: magic `SXHM`, version, part count, then per part vertex count, triangle count, float32 positions, uint32 indices), named from the JSON. A binary part rather than a second model object, so no slicer can show or print the base. The size cost is measured in tests and reported with the commit.
- Text steps store the font name, not the font: fonts may not allow embedding. A text step whose custom font is not loaded on this computer replays as broken ("Pick the font again: Foo is not loaded."), fixed by editing the step.

## Revision-bound face tools

MCP clients can inspect a design with `slicerx_geom_faces` using `format: "topology"`. The manifest includes an opaque `bodyId` and `revision`, body-local face dimensions, a placement transform, representation and capabilities. Each face identifies its part, face key, surface type, ambiguity and measurement source. Area comes from tessellation; analytic surface dimensions come from the reported kernel or mesh metadata. A mesh manifest does not imply an exact solid.

Pass an inspected face to a supported tool as `face: { topology: { bodyId, revision, part, faceKey } }`, with the matching `design`. Do not combine this reference with a legacy point or face selection. Face keys are scoped to a part and revision. A missing or ambiguous key refuses instead of choosing a nearby face. A face reference cannot identify an edge.

Geometry and placement changes invalidate the reference. Undo, body replacement and reopening a project do not revive it. Reinspect after those changes. Selection and color changes alone do not invalidate the geometry revision. Revisions are session identities, not saved feature names or portable references.

Scoped push/pull and hole edits check the revision before modeling and before committing. Their `operationResult` distinguishes `refused` from `applied` and identifies the prior and resulting revisions. An atomic receipt keeps read-back bound to the committed body even if another edit follows before the response. If an edit applied but verification failed, do not blindly repeat the mutation: inspect the current body first.

Push verification measures signed world-space displacement along the original planar face normal. Hole verification checks measured shaft diameter, depth and axis. The response declares its tolerance, capped at one percent of a nonzero requested change and at 0.01 mm. Requested counterbore or countersink dimensions remain separate from measured shaft dimensions; unmeasured head geometry is explicitly unverified. Invalid pre-edit measurements refuse before mutation.

The `scopedEdits` capability means the host supports guarded commits and atomic receipts, not that all face types support all operations. Compact response manifests include `faceCount` and `truncated`; inspect again with a larger `limit` when needed. Exact edits retain the developer gate and refusal rules below.

## Limits

### Developer exact designs

`design.new` accepts `exact: true` with `SX_BREP_DEV=1` on the native MCP server, or the developer exact-solids option in the app. New app extrusions made with that option also require exact replay. Imported meshes keep their existing representation; this option does not convert STL geometry into a solid.

Required exact intent is saved as `exact: true` on the object's history and timeline body. Replay stops with a reason if a feature needs the mesh path or the kernel fails. Failed edits preserve the previous geometry and history. A damaged required exact history refuses project opening instead of discarding the history and using the saved mesh. Older applications do not understand this requirement, so reopen these development projects in a build that supports it.

The app's exact extrusion and hole tools use strict replay. Its plane cut currently keeps above or below on a single-part body, without connectors. Unsupported modeling commands refuse to replace required exact geometry. App undo restores parameter edits; `design.undo` removes the last feature and `design.redo` restores it. Measurement tools inspect the display tessellation, so their values are not kernel surface measurements.

Splitting an exact body into mesh objects, merging it with another object, or consuming it as a modifier or cutter refuses with a reason. These operations cannot preserve its exact feature history yet. The original bodies remain available for editing.

No constraint solver and no parametric expressions between steps. References are found again by position, so a step whose face an earlier edit removed or moved sideways breaks in words rather than guessing.
