# @slicerx/link-client

A `PrinterHost` that talks to `sx-link` (`../link/README.md`) over a WebSocket. The web host uses it when `capabilities.printers` is `'link'`.

```ts
const host = await connectLink({ url: 'ws://127.0.0.1:47615', code: 'ABCD-EFGH' })
await host.addPrinter({ id: 'bay-4', name: 'Bay 4', plugin: 'moonraker', host: '192.168.1.40' })
const status = await host.status('bay-4')
```

`connectLink` checks the hub's signed `hello`, then pairs through the code exchange in `src/cpace.ts` (CPace over ristretto255, the same exchange as the Rust crate `sx-cpace`; `packages/connect/cpace/vectors.json` pins the two together). The code never goes on the socket, and the hub must prove it holds the code before the client reports its key for pinning.

Failures reject with `LinkError` (`code` is a `PrinterErrorCode`, `bad_request`, `unauthorized`, `locked` or `closed`). Beyond `PrinterHost` it exposes `discover` (scan the local network for printers), `addPrinter`, `removePrinter`, `configureService`, `listServices`, `removeService`, `setSecret`, `hasSecret`, `deleteSecret`, `sendGcode` and `close`. There is no way to read a secret back.

## Tests

`pnpm --filter @slicerx/link-client test` starts the real `target/debug/sx-link` binary against the mock printers. Build it first with `cargo build -p sx-link`; the tests skip when it is missing.
