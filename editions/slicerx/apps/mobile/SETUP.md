# Setting up the SlicerX phone app

The app reads everything account- or deployment-specific from the edition config (`editions/slicerx/edition.config.ts`) and its `SLICERX_*` environment variables. Filling in the values below needs no code change.

- Bundle id (iOS) and application id (Android): `app.slicerx.mobile`
- App name: SlicerX
- Deep link scheme: `slicerx`
- Sign-in callback: `slicerx://auth/callback`
- Universal link domain: `slicerx.app`

## Local development

Create `editions/slicerx/apps/mobile/.env.local` (git ignores it; `.env.example` lists the names):

```sh
SLICERX_SUPABASE_URL=http://192.168.68.63:54321
SLICERX_SUPABASE_ANON_KEY=<anon key of the dev stack, from `supabase status` on the build machine>
# Optional
SLICERX_CLOUD_API_URL=http://192.168.68.63:8787
SLICERX_RELAY_URL=
```

Without the Supabase values the app runs on the offline example catalog and the demo printer fleet, signed in as `rv@example.com`. Magic links from the dev stack land in its mail catcher at http://192.168.68.63:54324.

Development builds can run on this Mac or on a separate build Mac ([BUILDING.md](BUILDING.md)). No Expo login or EAS project is needed for a local simulator build (`expo run:ios`).

## Morning: accounts and keys

### Expo

1. `npx eas login` with the Expo account.
2. `npx eas init` in `editions/slicerx/apps/mobile`. It prints a project id. Put it in the environment as `EXPO_PROJECT_ID`; the app needs it for push tokens.

### Apple Developer

1. Note the Team ID (10 characters, from Membership details). Set it as `apps.ios.teamId` in the edition config.
2. Register the App ID `app.slicerx.mobile` with these capabilities: Push Notifications, Sign in with Apple, Associated Domains.
3. Create an APNs key (.p8) for push. Upload it with `npx eas credentials` when push is set up.

### Sign in with Apple (through Supabase)

1. In Certificates, Identifiers and Profiles, create a Services ID, such as `app.slicerx.mobile.signin`. Enable Sign in with Apple on it:
   - Domain: `<project-ref>.supabase.co`
   - Return URL: `https://<project-ref>.supabase.co/auth/v1/callback`
2. Create a Sign in with Apple key (.p8) and note its Key ID.
3. In Supabase, go to Authentication, Providers, Apple. Enter the Services ID, the Team ID, the Key ID and the .p8 contents. Also add `app.slicerx.mobile` to the authorized client ids.
4. In the edition config, add `{ kind: 'apple', clientId: 'app.slicerx.mobile.signin' }` to `auth.providers`.

### Google

1. In Google Cloud, go to APIs and Services, Credentials, and create an OAuth client of type Web application.
   - Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`
2. Enter its client id and secret in Supabase under Authentication, Providers, Google.
3. In the edition config, add `{ kind: 'google', clientId: '<client id>' }` to `auth.providers`.

### GitHub

1. In GitHub, go to Settings, Developer settings, OAuth Apps, and create a new app.
   - Homepage URL: `https://slicerx.app`
   - Authorization callback URL: `https://<project-ref>.supabase.co/auth/v1/callback`
2. Enter its client id and secret in Supabase under Authentication, Providers, GitHub.
3. In the edition config, add `{ kind: 'github', clientId: '<client id>' }` to `auth.providers`.

### Supabase redirect URLs

Under Authentication, URL Configuration:

- Site URL: `https://slicerx.app`
- Redirect URLs: `slicerx://auth/callback`, `https://slicerx.app/auth/callback` and `http://localhost:5173/auth/callback`

### Resend (sign-in email)

1. Add and verify the sending domain `slicerx.app` in Resend (the DNS records it lists).
2. Create an API key with send access.
3. In Supabase, go to Authentication, Emails, SMTP settings. Host `smtp.resend.com`, port 465, user `resend`, password the API key, sender `SlicerX <sign-in@slicerx.app>`.
4. The magic link template must use `{{ .ConfirmationURL }}` so the link returns to `slicerx://auth/callback` on phones.

### Universal links (optional, after the Team ID)

`node packages/edition-config/src/cli.ts well-known editions/slicerx/edition.config.ts <site public dir>` writes `apple-app-site-association` from the Team ID. It writes `assetlinks.json` once `apps.android.sha256CertFingerprints` holds the signing certificate's SHA-256 (from `npx eas credentials`). The site serves both under `/.well-known/`.

### Push notifications (later)

Local notifications work now while the app is open or in the background. For alerts with the app closed, the SlicerX service sends Expo push messages:

- iOS: the APNs key from the Apple step, uploaded to EAS.
- Android: a Firebase project with Cloud Messaging and an FCM v1 service account JSON, uploaded with `npx eas credentials`.

## Values the owner provides

| Value | Where it goes |
| --- | --- |
| Apple Team ID | edition config `apps.ios.teamId` |
| Apple Services ID, Key ID, .p8 | Supabase Apple provider; Services ID also in `auth.providers` |
| Google OAuth client id and secret | Supabase Google provider; client id in `auth.providers` |
| GitHub OAuth client id and secret | Supabase GitHub provider; client id in `auth.providers` |
| Resend API key | Supabase SMTP settings |
| Expo project id | `EXPO_PROJECT_ID` |
| Production Supabase URL and anon key | `SLICERX_SUPABASE_URL`, `SLICERX_SUPABASE_ANON_KEY` |
