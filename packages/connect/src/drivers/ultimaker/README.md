# UltiMaker

Plugin id `ultimaker`, port 80. Experimental. See `../../../docs/ultimaker.md` for the full description.

## Wire protocol

- Discovery: multicast DNS `_ultimaker._tcp.local`; TXT `type=printer`, `name`, `machine` (BOM number), `firmware_version`, `cluster_size`. `probe`: `GET /api/v1/system`.
- Cluster API (`/cluster-api/v1`, no login, firmware 4.0 and later): `printers` (print cores, materials), `print_jobs/` (multipart upload that prints), `print_jobs/{uuid}/action` (`pause`, `print`, `abort`).
- Printer API (`/api/v1`): `system`, `printer` (status, temperatures, camera), `print_job` (state, progress, times; 404 when idle). Changes need HTTP Digest with the `id` and `key` from `auth/request`, allowed on the touchscreen (`auth/check/{id}`).
- Upload is held in the session until the approved start, because the printer prints whatever arrives.
- Camera: mjpg-streamer on 8080.

## Sources

- UltiMaker Cura, UM3NetworkPrinting plugin: https://github.com/Ultimaker/Cura/tree/main/plugins/UM3NetworkPrinting
- Cura machine definitions (`bom_numbers`): https://github.com/Ultimaker/Cura/tree/main/resources/definitions
- Printer API description: https://gist.github.com/SimonIT/ea672554e9d642b517202125b10d3b37

## Source licenses

Cura is LGPL-3.0. It was read as a protocol reference only (endpoint paths, field names, state names, BOM numbers); this driver does not copy or translate its code.

## Unverified

Whether 7.x and later firmware wants a login on the cluster API, the job states seen during a real print, and the camera port.
