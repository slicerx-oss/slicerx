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

The config accepts every setting on this page, the knowledge build compiles your docs, and `slicerx_mimir_brain` reports what your edition set. The chat doesn't apply the voice, your knowledge, the tool switches, the routing or the memory settings yet. Each section below says what is in place now.

## Voice

`voice` is a short style note, 1 to 280 characters, such as `"Plain and brief; metric units"`. Leave it out for the stock voice. It is meant as a note on tone added to the assistant's instructions, never a replacement for them (see [What an edition can't change](#what-an-edition-cant-change)). For now the config holds it and nothing reads it.

## Knowledge

`knowledge` lists YAML files, or folders of them, in the same format as the bundled `knowledge/` folder. Paths are relative to the edition config file. The schema refuses absolute paths, paths that start with `~` or a drive letter, and any `..` step. A file or link that resolves outside the edition folder is refused when the files are read.

`pnpm --filter @slicerx/pilot kb:build` compiles the knowledge of every edition under `editions/` into `packages/pilot/src/kb/generated/edition-kb.json`, and tags each doc with its edition id. A knowledge base built for one edition takes the bundled docs plus that edition's own, so one edition never finds or cites another's. If one of your docs has the same id or name as a bundled doc, the bundled doc wins. Your sources cite with kind `edition`.

The app doesn't load the edition index into mimir's search yet.

## Tool groups

`tools` switches whole groups off. There are six:

| Group | What it covers |
| --- | --- |
| `design` | Making and changing parts: `text_to_part`, `make_model`, `parts.lookup`, cut, hollow, emboss, threads and fits, and the `design.` and `geom.` tools |
| `slicing` | Preparing and slicing a plate: slice, estimate, arrange, orient, supports, walls, mesh checks and repair, calibration, and planning and applying settings |
| `printers` | Printers, fleets and spools: every `printer.`, `printer_` and `spoolman.` tool, plus scheduling, diagnosis, spool fit and AMS or toolhead mapping |
| `watch` | Looking at a running print through its camera and adjusting it: `check_print` and `print.adjust` |
| `paint` | Painting color, seams, supports and fuzzy skin onto a part: the `paint.` and `paint_` tools and `multicolor_assign` |
| `web` | Web search |

`false` turns a group off. `true`, or leaving the group out, keeps it as it is. A switch only ever removes tools, and a group name that isn't on the list is a config error. Core tools (the knowledge base, questions to the person, the project) have no switch.

`applyToolGroups` and `toolGroupOf` in `@slicerx/pilot` do the filtering. The chat doesn't call them yet.

## Routing

`routing` names the models for a person who uses their own key. `base` is the model for quick turns, and the only model when the person isn't on Auto. `step` is the model Auto moves to for deep turns. `provider` limits the routing to a key for `anthropic` or `openai`; leave it out and it applies to either.

Some things always win over routing. A model the person picks in Settings is used as picked. A ChatGPT plan sign-in keeps its own models. mimir cloud ignores routing completely, because its proxy picks the model.

`modelFor` in `@slicerx/pilot` follows these rules. The app doesn't pass your edition's routing into mimir's config yet.

## Cloud step-up

On mimir cloud, the app never sends a model id. It sends one hint per turn (`x-sx-tier: step` for a deep turn, `base` otherwise), and the proxy decides. For a step turn the proxy looks up your edition's step-up model in its own database table, which the SlicerX team sets for each edition. With no step-up model, or none with a price, the turn runs on the base model, Haiku 5.5. A step turn that doesn't fit the daily caps also runs on the base model. The model a turn actually used comes back in the `x-sx-model` header.

The proxy knows your edition from the install's token, which the install got by registering with your edition's registration key. So `cloud.stepUp` in your config (`sonnet` or `none`, default `none`) states what you expect. Setting it can't move your edition onto a larger model or past its caps: the check runs on the server. To change your edition's step-up, ask the SlicerX team. [mimir-cloud.md](mimir-cloud.md) covers the proxy itself.

## Memory

`memory.local` (default `true`) lets the assistant remember what the person tells it, on their computer. `memory.sync` is `off` (the default) or `opt-in`, which copies those memories to the person's account only after they turn it on. In this release these are config values only.

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

`voice` says whether a voice is set. The answer never has the voice text or the contents of your docs. `knowledgeDocs` counts your edition's docs in the compiled edition index. `cloud.stepUp` is your config's value, `null` for `none`, and the proxy still decides. `toolGroups` comes from the config until the chat filters its tools by them.

## What an edition can't change

- mimir's core prompt is built into `@slicerx/pilot`, and the config has no setting that replaces or removes it. The voice is a note of at most 280 characters.
- Tools that queue or start prints or change saved profiles need the person's approval. The app shows the approval card and enforces it, and the model can't approve, skip or change it. A permission policy that sets starting prints to `allow` is read as `ask`, except for pause and cancel on a printer the person confirmed in the app. Tool switches only take tools away, so no switch opens a path around an approval.
- The untrusted-data rules stay. Tool results with text from model files, file names, printers or web pages reach the model wrapped as data, with a note that the text isn't an instruction. mimir's instructions tell it to ignore requests inside that text and to tell the person it did.
- The proxy sets the cloud model and its caps, and checks them on the server.
