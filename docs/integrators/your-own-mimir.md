# Your own mimir

An edition can shape the assistant it ships with: how it talks, what it knows beyond the bundled knowledge, which groups of tools it has, which models a person's own key uses, and what it remembers. These settings live under `ai.brain` in the edition config. The assistant's name, icon and accent are under `brand.assistant` and have their own page, [assistant-brand.md](assistant-brand.md).

```ts
ai: {
  brain: {
    voice: 'Plain and brief; metric units',
    knowledge: ['knowledge'],
    tools: { printers: false, web: false },
    routing: { provider: 'anthropic', base: 'claude-haiku-5-5', step: 'claude-sonnet-5-5' },
    cloud: { stepUp: 'sonnet' },
    memory: { local: true, sync: 'opt-in' },
  },
},
```

The config is checked when it loads. A bad value stops it with the setting's path and the reason.

## What works today

Every setting on this page is in effect in the app's mimir: the docked chat, the dock in the browser build, and the mimir tab. The voice goes into the assistant's instructions, your knowledge is searched and cited, switched-off tool groups are never offered, routing picks the models for a person's own key, and memory follows `memory.local` and `memory.sync` (see [Memory](#memory) for who saves notes and who only reads them). `slicerx_mimir_brain` reads back what the running app applies.

## Voice

`voice` is a short style note, 1 to 280 characters, such as `"Plain and brief; metric units"`. Leave it out for the stock voice. It is added as the last block of the assistant's instructions, folded onto one line, and only changes tone; it never replaces the rules above it (see [What an edition can't change](#what-an-edition-cant-change)).

## Knowledge

`knowledge` lists YAML files, or folders of them, in the same format as the bundled `knowledge/` folder. Paths are relative to the edition config file. The schema refuses absolute paths, paths that start with `~` or a drive letter, and any `..` step. A file or link that resolves outside the edition folder is refused when the files are read.

`pnpm --filter @slicerx/pilot kb:build` compiles each edition under `editions/` into its own file, `packages/pilot/src/kb/generated/edition-kb.<id>.json`, with every doc tagged with the edition id. An app build includes only the file for the edition it builds, so your docs never ship in another edition's app. If one of your docs has the same id or name as a bundled doc, the bundled doc wins.

In the app, mimir's knowledge base is the bundled docs plus your edition's file. `kb.search` and the other knowledge tools find your docs next to the bundled ones, and your sources cite with kind `edition`.

## Tool groups

`tools` switches whole groups off. There are six:

| Group | What it covers |
| --- | --- |
| `design` | Making and changing parts: `text_to_part`, `make_model`, `parts.lookup`, cut, hollow, emboss, threads and fits, the `design.` and `geom.` tools, and app commands of the design workspace |
| `slicing` | Preparing and slicing a plate: slice, estimate, arrange, orient, supports, walls, mesh checks and repair, calibration, planning and applying settings, and app commands that change the plate, the slice, a profile or a setting (plate edits such as cut and orient included) |
| `printers` | Printers, fleets and spools: every `printer.`, `printer_` and `spoolman.` tool, scheduling, diagnosis, spool fit, AMS or toolhead mapping, every tool of a printer plugin or of a connected app that works on the printers (BamBuddy, Spoolman, Home Assistant), and app commands that queue, start or set up a printer |
| `watch` | Looking at a running print through its camera and adjusting it: `check_print` and `print.adjust` |
| `paint` | Painting color, seams, supports and fuzzy skin onto a part: the `paint.` and `paint_` tools and `multicolor_assign` |
| `web` | Web search: the `web.` tools and the web search the model can run |

App commands go by their permission class: printer classes are `printers`, a change in the design workspace is `design`, and any other change is `slicing`. Commands that only read (go to a tab, step a layer) or share have no switch.

`false` turns a group off. `true`, or leaving the group out, keeps it as it is. A switch only ever removes tools, and a group name that isn't on the list is a config error. Core tools (the knowledge base, questions to the person, the project) have no switch.

Every mimir the app makes applies the switches with `applyToolGroups` from `@slicerx/pilot` (`toolGroupOf` says which group a tool is in), so a switched-off tool is not offered to the model and cannot be called. With `web: false` the app also turns web search off in mimir's config.

These switches act when the app builds mimir, for everyone on your edition. A person's own On, Ask first and Off choices in Settings > Permissions are a different layer: they set the permission policy classes (allow, ask, off) that the app and MCP clients both go through. Those choices can make a tool ask or stop, but they can't bring back a group your edition switched off.

## Routing

`routing` names the models for a person who uses their own key. `base` is the model for quick turns, and the only model when the person isn't on Auto. `step` is the model Auto moves to for deep turns. `provider` (`anthropic` or `openai`) says which key the models are for, and is required when you name `base` or `step`; a key for another provider keeps its own models.

Some things always win over routing. A model the person picks in Settings is used as picked. A ChatGPT plan sign-in keeps its own models. mimir cloud ignores routing completely, because its proxy picks the model.

The app puts your routing into mimir's config (`routing`), and `modelFor` in `@slicerx/pilot` applies these rules on each turn.

## Cloud step-up

On mimir cloud, the app never sends a model id. It sends one hint per turn (`x-sx-tier: step` for a deep turn, `base` otherwise), and the proxy decides. For a step turn the proxy looks up your edition's step-up model in its own database table, which the SlicerX team sets for each edition. With no step-up model, or none with a price, the turn runs on the base model (`cloud.base` in the read-back). A step turn that doesn't fit the daily caps also runs on the base model. The model a turn actually used comes back in the `x-sx-model` header.

The proxy knows your edition from the install's token, which the install got by registering with your edition's registration key. So `cloud.stepUp` in your config (`sonnet` or `none`, default `none`) states what you expect. Setting it can't move your edition onto a larger model or past its caps: the check runs on the server. To change your edition's step-up, ask the SlicerX team. [mimir-cloud.md](mimir-cloud.md) covers the proxy itself.

## Memory

`memory.local` (default `true`) lets the assistant keep short notes about the person (their printers, filaments, preferences, sizes and what worked) on their computer, one store per edition. mimir asks before it saves a note, unless the person turned that off in Settings > Memory, where they can also see, edit, delete, export and clear their notes. A note that looks like a key, token, access code or serial is refused. With `local: false` mimir has no memory tools and reads no notes.

The docked chat saves notes. The mimir tab reads them and can recall them, but it doesn't save new ones. MCP clients read notes with `slicerx_mimir_memory` and add them with `slicerx_mimir_memory_remember` over the app link. `slicerx_mimir_memory` is read class, so a client the person allowed to read only can read the notes, with keys, access codes and serials masked. Adding a note goes through the profile class and is refused for a read-only client.

`memory.sync` is `off` (the default) or `opt-in`. With `opt-in`, a signed-in person sees "Sync with my account" in Settings > Memory, off until they turn it on. While it is on, notes and deletions sync with their account when a chat starts and shortly after each change, with the same session the rest of the app's cloud calls use. Signed out, or with the switch off, nothing is sent.

## Reading it back

`slicerx_mimir_brain` reads the mimir the open app runs, over the app link. It needs the app open, the app link on, and the MCP server started with `--printers link`. It is a read, so a client allowed to read only can call it. It answers:

```json
{
  "name": "mimir",
  "voice": true,
  "toolGroups": { "design": true, "slicing": true, "printers": false, "watch": true, "paint": true, "web": false },
  "cloud": { "base": "claude-haiku-5-5", "stepUp": "sonnet" },
  "memory": { "local": true, "sync": "opt-in" },
  "knowledgeDocs": 2
}
```

`voice` says whether a voice is set. The answer never has the voice text or the contents of your docs. `knowledgeDocs` counts only your edition's own docs that mimir searches, in the edition file the running build carries. The bundled docs are not counted, and neither is one of yours that shares a bundled doc's id or name (the bundled doc wins). `cloud.base` is the base model mimir cloud answers with, and `cloud.stepUp` is your config's value (`null` for `none`); the proxy still decides. `toolGroups` is the set of switches every mimir in the app applies.

## What an edition can't change

- mimir's core prompt is built into `@slicerx/pilot`, and the config has no setting that replaces or removes it. The voice is a note of at most 280 characters.
- Tools that queue or start prints or change saved profiles need the person's approval. The app shows the approval card and enforces it, and the model can't approve, skip or change it. A permission policy that sets starting prints to `allow` is read as `ask`, except for pause and cancel on a printer the person confirmed in the app. Tool switches only take tools away, so no switch opens a path around an approval.
- The untrusted-data rules stay. Tool results with text from model files, file names, printers or web pages reach the model wrapped as data, with a note that the text isn't an instruction. mimir's instructions tell it to ignore requests inside that text and to tell the person it did.
- The proxy sets the cloud model and its caps, and checks them on the server.
