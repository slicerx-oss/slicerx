# CAD history

An object edited with the CAD tools keeps what was done to it as an ordered list of steps. The person can open a step, change a number or the sketch, suppress or delete it, and the steps after it replay. It is one flat list per object: no nesting, no dependency view.

## Model

`PlateEntry.history` (absent on objects nobody has modeled on):

```
History = { version: 1, base: MeshPart[], steps: Step[], ended?: string }
Step    = { id, op, part, transform: Mat4, params, follow?, suppressed?, broken? }
```

- `base` is the object's parts at the moment the first step was recorded (as imported or created). A body made by a sketch or a shape with "New body" has an empty base and the extrude as step 1, so its sketch stays editable.
- `op` names the engine call; `params` are exactly the request that call took, in world millimeters as they were when the step ran. `transform` is the object's transform at that moment. Replay sends `{mesh: <current local mesh>, transform}` with the same params, and the engine answers in the part's local frame, so moving, turning or scaling the object later never disturbs a step.
- `part` is the part index the step works on, or -1 for every part (hollow, repair, simplify, merged array).
- Geometry references live inside `params` in the engine's own terms: a face is a pick `{at, normal}` (the triangle index is found again on the current mesh at replay: the triangle that contains `at` within 0.01 mm and faces within 0.01 degrees of `normal`); an edge is the `EdgeRef {a, b, face}` from `edge.pick` (docs/cad-fillet.md), which the engine finds again itself; a sketch or shape plane is its `FaceFrame`.
- `follow`: when a reference sat on the face that an earlier push or one-sided extrude moved (its end cap), the step records `{step, distanceMm}`. If that earlier step's distance changes, the reference moves along that cap's normal by the difference. This keeps "pull the top 5 mm, then sketch on the new top" working after the 5 becomes 8. A fillet or chamfer step can follow several caps, one per direction, and `follow` is then a list. `points` lists the references that sat on the cap when only some did, two per edge (`a`, then `b`). An edge with both ends on a cap moves with it. An edge with one end there keeps its line, and that end slides along it.

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
| Subtract a shape (hole from the top) | step `subtract`, the solid kept in world coordinates of its transform; the result keeps the object's frame instead of being stood up again |
| Hollow, repair, simplify | steps `hollow`, `repair`, `simplify` on every part (simplify ratio is editable) |
| Merge objects, add a part | step `parts.add`: the added meshes, in this object's frame, are stored with the history; the other object's own history is not kept |
| Array merged into one object | step `array.merged`; copies (instances) are not mesh edits and record nothing |
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

A push step keeps the key of the face it moved (`faceKey`), and a shell step the key of each face it opens. On replay a step looks for its face by key first and by place only when it has no key or the key is gone, so editing an earlier step (moving a boss, making it taller) no longer breaks a later step on that face. A face found by key whose parts came apart is used by its larger part, and the step's row says "The face this step moved was split in two; picked the larger part." A step found by place gets the key of the face it found, kept from then on. Fillet and chamfer edges are still found by place; their faces' keys are a later step.

## Storage

- `Metadata/slicerx_history.json`, written only when an object has history: `{version: 2, objects: [{object, base, ended?, steps}]}`, `object` the 3MF object id as in slicerx_dimensions.json. Version 2 adds face keys to steps (below); version 1 files open the same way, and their steps get keys on their first replay. A file with a higher version opens without its histories and a message says a newer SlicerX saved it (SlicerX 0.1 ignores version 2 files silently: it predates the message). Objects that are missing are ignored; a project without the part opens as before; other slicers ignore it.
- The model part keeps the current mesh, so the file prints the same anywhere and opening needs no replay.
- Base meshes and `parts.add` meshes go in one binary part each, `Metadata/slicerx_history/<object>-<n>.bin` (little endian: magic `SXHM`, version, part count, then per part vertex count, triangle count, float32 positions, uint32 indices), named from the JSON. A binary part rather than a second model object, so no slicer can show or print the base. The size cost is measured in tests and reported with the commit.
- Text steps store the font name, not the font: fonts may not allow embedding. A text step whose custom font is not loaded on this computer replays as broken ("Pick the font again: Foo is not loaded."), fixed by editing the step.

## Limits

No constraint solver and no parametric expressions between steps. References are found again by position, so a step whose face an earlier edit removed or moved sideways breaks in words rather than guessing.
