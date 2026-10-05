# OctoPrint

Plugin id `octoprint`, default port 5000, `X-Api-Key` header.

## Endpoints used

`GET /api/version` (auth check), `GET /api/printer` (409 means OctoPrint is up but the printer is not connected, reported as offline), `GET /api/job`, `POST /api/files/local` (multipart), `POST /api/files/local/{name}` with `{"command":"select","print":true}`, `POST /api/job` (`start`, `pause` with `action` pause or resume, `cancel`), `POST /api/printer/command`, `GET /api/settings` for the webcam snapshot URL.

Events are polled. OctoPrint reports no layer counts without plugins.

## Sources

- OctoPrint REST API: https://docs.octoprint.org/en/master/api/

## Unverified

The SockJS push channel is not used.
