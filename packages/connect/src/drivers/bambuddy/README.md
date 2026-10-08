# BamBuddy

Plugin id `bambuddy`, default port 8000. `host` is the BamBuddy computer, `credentialRef` is an API key sent as `X-API-Key`, and `serial` is BamBuddy's printer id. Discover returns nothing.

A printer BamBuddy reaches through a bridge is the same id. This driver does not speak Moonraker or the Bambu LAN protocol.

## Endpoints used

`GET /api/v1/printers/{id}/status`. Upload is `POST /api/v1/library/files` (multipart field `file`). Before that post, `GET /api/v1/printers/{id}` supplies `model`. A failed lookup fails the upload. A file that is not already a Bambu profile is stamped with that model (`printer_model`, `printer_model_id`, `printer_agent`) and the motion G-code is left alone. A Bambu profile that matches the printer is uploaded unchanged. A Bambu profile for a different model is refused, not relabeled. An empty `model` on a successful reply stamps a non-Bambu profile as `Bambu Lab A1 Mini` / `N1`. The approval hash is the sha256 of the bytes that are posted. Start is `POST /api/v1/queue/` with `library_file_id`, `printer_id` and `manual_start` false. Pause, resume and cancel are `POST /api/v1/printers/{id}/print/pause|resume|stop`. A slot write is `POST /api/v1/printers/{id}/slots/{ams}/{tray}/configure`.

`remaining_time` is minutes. `progress` is a percent. AMS units 0 to 3 are slots A1 to D4. The virtual tray is slot `1`.

## Sources

- BamBuddy HTTP API: https://github.com/maziggy/bambuddy

## Unverified

Not run against a live BamBuddy. The queue create body omits options the sheet did not set. Nozzle mapping is not on that create call.
