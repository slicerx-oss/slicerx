# TLS test fixtures

Throwaway certificates and keys made for the tests in `src/tls.rs`. None of them is used anywhere else, and none is a real credential.

- `test-ca.cert.pem`: a self-signed test CA (`SX Test CA`).
- `signed-leaf.cert.pem` and `signed-leaf.key.pem`: a leaf issued by that test CA, named like a printer serial.
- `lookalike-leaf.cert.pem`: a self-signed leaf whose issuer only copies the name of Bambu Lab's CA, so the check must reject it. No Bambu Lab key signed it.
- `v1-test.cert.pem` and `v1-test.key.pem`: a self-signed X.509 v1 certificate, the kind Bambu Lab printers present.
- `chain-root.cert.pem`, `chain-device-ca.cert.pem` and `chain-leaf.cert.pem`: a root, a device CA it signed and a leaf the device CA signed for the same serial, the shape of the chains P2S and H2C printers present. Their keys were thrown away.

# G-code fixtures

- `u1-four-filament.gcode`: four 8 mm boxes, 0.6 mm tall, one filament each, sliced by `sx` with the Snapmaker U1 profile's own G-code (9 tool changes, 7 pre-extrude lines). One comment line of the maker's start G-code is left out. The toolhead remap tests in `src/toolhead_map.rs`, `packages/core/cli/tests/remap_toolheads.rs` and `packages/mcp/test/remap-toolheads.test.ts` use it.
