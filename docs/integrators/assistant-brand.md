# Name and style your assistant

An edition can give its assistant a name, image and accent separately from the product brand. Add `assistant` inside the edition config's `brand` object:

```json
{
  "assistant": {
    "name": "yourmate",
    "icon": "./yourmate.svg",
    "accent": { "light": "#006b65", "dark": "#63e6d4" }
  }
}
```

The name appears in chat, Settings, first-run text, tips and assistant prompts. Names keep their capitalization, except `mimir`, which always appears lowercase. A name must contain 1 to 40 characters without control characters.

The icon can be an SVG, PNG, JPEG or WebP file relative to the config, an HTTPS image URL, an image data URL, or `builtin:mimir`. Local images are included in the build. Prefer a local image so the assistant's mark also works offline. Use an image with enough contrast in both themes.

The optional accent is a six-digit hex color for both themes, or separate `light` and `dark` colors. It colors the assistant's controls and built-in mark. Custom images retain their authored colors. Status and warning colors retain their meanings. Without an accent, the assistant follows the app theme. Omitting `assistant` retains the name `mimir` and its built-in mark.

This does not change the product name, provider IDs, tool names, command flags or saved preference keys. Keep the existing SlicerX credit and its link.

## Embedded packages without an edition config

Set the name before rendering the embedded app:

```ts
import { setAssistantName } from '@slicerx/embed'

setAssistantName('yourmate')
```

The call updates display text, including tips and prompts. It preserves the current icon and accent. An explicit edition config supplies its own assistant identity when the app loads it.

For an MCP server in your own Node process, set the same name before creating the server:

```ts
import { setAssistantName, createContext, createSlicerxServer } from '@slicerx/mcp'

setAssistantName('yourmate')
const context = await createContext(options)
const server = createSlicerxServer(context)
```

Each process has its own identity. Setting the name in a renderer does not configure a separate Node child process. The command-line server reads `brand.assistant` from the resolved edition file named by `SLICERX_CONFIG`.

## Read back the open app's identity

Call `slicerx_app_assistant` with `{}` over MCP, or use the command-line server:

```sh
slicerx-mcp --printers link call app_assistant
```

The result includes `name`, `icon`, optional `accent`, and `enabled`. It reads the open app through its app link, so it reports that app's identity even when the server has a different configuration. The person must have enabled the app link and granted the client access. An unavailable link returns `not_configured`; an older app without identity read-back returns `not_supported`.

The client needs a remembered agent credential. Partner app keys cannot read the open project. The command-line keychain reader currently supports macOS and Linux; Windows callers can use the programmatic server with a remembered agent credential through its existing link options.
