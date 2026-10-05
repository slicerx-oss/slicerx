// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The extensions make it an X.509 v3 certificate, like a printer's. Without a config naming them, LibreSSL (the
// openssl on macOS) writes a v1 certificate, which rustls refuses with UnsupportedCertVersion.
const config = (cn: string) => `[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = ${cn}
[v3]
basicConstraints = critical,CA:FALSE
subjectKeyIdentifier = hash
subjectAltName = IP:127.0.0.1,DNS:localhost
`

/** A throwaway self-signed certificate, like the one a Bambu Lab printer presents (its common name is the printer's serial number). */
export function throwawayCert(cn = 'sx-mock'): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sx-mock-tls-'))
  try {
    writeFileSync(join(dir, 'req.cnf'), config(cn))
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-config', join(dir, 'req.cnf'), '-extensions', 'v3', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1'], { stdio: 'ignore' })
    return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
