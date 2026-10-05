# TLS test fixtures

Throwaway certificates and keys made for the tests in `src/tls.rs`. None of them is used anywhere else, and none is a real credential.

- `test-ca.cert.pem`: a self-signed test CA (`SX Test CA`).
- `signed-leaf.cert.pem` and `signed-leaf.key.pem`: a leaf issued by that test CA, named like a printer serial.
- `lookalike-leaf.cert.pem`: a self-signed leaf whose issuer only copies the name of Bambu Lab's CA, so the check must reject it. No Bambu Lab key signed it.
- `v1-test.cert.pem` and `v1-test.key.pem`: a self-signed X.509 v1 certificate, the kind Bambu Lab printers present.
