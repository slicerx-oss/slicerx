# Duet (RepRapFirmware 3)

Plugin id `duet`, default port 80. `rr_connect` with the password from the keychain (`reprap`, the firmware default, when none is set).

## Endpoints used

`GET /rr_connect`, `GET /rr_model?flags=d99vn` (state, job, heat, tools), `GET /rr_gcode?gcode=...`, `POST /rr_upload?name=0:/gcodes/...`. Start is `M32 "0:/gcodes/name"`, pause `M25`, resume `M24`, cancel `M0`. DuetWebServer on single board computer setups answers the same endpoints.

RepRapFirmware has no finished state: after a job the machine is idle, so the event stream reports a job as finished when progress was at least 98 percent.

## Sources

- RepRapFirmware HTTP requests: https://github.com/Duet3D/RepRapFirmware/wiki/HTTP-requests

## Unverified

Session keys (`sessionKey=yes`, RRF 3.4 and newer) and `rr_disconnect` are not used, so the board's session slots time out on their own. The DSF REST API (`/machine/...`) is not used.
