### Added

- `slicerx_partner_devices` 1.0.0 reads the partner phones the hub answers away from home: each one's partner app name, phone name and platform, rights (`approve` stays off until the person turns it on in Devices), when it was added, whether it is connected now, its relay bytes today against the daily cap, and its push registration. Never a key. Pairing, rights and revoking stay with the person in the app.
- `slicerx_push_status` 1.0.0 reads the hub's phone alerts: whether it sends at all, and each registration without its token (provider `expo`, `apns` or `fcm`, prefs, and for a partner phone its app name, gateway host and pushes this hour against the hourly cap).
