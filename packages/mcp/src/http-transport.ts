// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The SDK's streamable HTTP transport for src/http.ts. The library (dist/index.js) and runs from source import it like
// any other module, so a host that bundles the library takes it in. The server's own builds replace this file in their
// CLI entries with a dynamic import (scripts/build.mjs), so the transport and its HTTP server packages load only when
// the server is started with --http, not at every stdio start.
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

/** The transport class. */
export const httpTransport = async (): Promise<typeof StreamableHTTPServerTransport> => StreamableHTTPServerTransport
