// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The updater end to end against a local feed: a 0.1.0 build finds 0.2.0, downloads it and checks its signature
//! with the update key, and refuses a changed download and a feed that pairs a newer version with an older signature.
//! apps/desktop/release/test/updater-e2e.mjs makes a throwaway key, signs fake bundles with sign-updates.sh, writes
//! the feeds with latest-json.mjs, serves them and runs this test; without SX_UPDATER_E2E it is skipped. Installing
//! (replacing the app and restarting) needs a real install and is not run here.
use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};
use tauri_plugin_updater::UpdaterExt;

/// A 0.1.0 build with the release config's updater settings, reading `feed`.
fn app(feed: &str, pubkey: &str) -> tauri::App<MockRuntime> {
    let mut ctx = mock_context(noop_assets());
    assert_eq!(ctx.package_info().version.to_string(), "0.1.0");
    ctx.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({ "endpoints": [feed], "pubkey": pubkey, "requireSignedVersion": true, "dangerousInsecureTransportProtocol": true }),
    );
    mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(ctx)
        .expect("the mock app starts")
}

#[tokio::test]
async fn a_signed_update_downloads_and_a_changed_or_mislabeled_one_does_not() {
    let (Ok(dir), Ok(base)) = (
        std::env::var("SX_UPDATER_E2E"),
        std::env::var("SX_UPDATER_E2E_URL"),
    ) else {
        eprintln!("skipped: run node apps/desktop/release/test/updater-e2e.mjs");
        return;
    };
    let pubkey =
        std::fs::read_to_string(format!("{dir}/key/updater.key.pub")).expect("the throwaway public key");
    let check = |feed: &str| {
        let a = app(&format!("{base}/{feed}/latest.json"), pubkey.trim());
        async move { a.updater().expect("the updater").check().await }
    };

    // the signed release: found, its notes and links read, the download matches the bundle byte for byte
    let update = check("good")
        .await
        .expect("the feed answers")
        .expect("0.2.0 is newer than 0.1.0");
    assert_eq!(update.version, "0.2.0");
    assert_eq!(update.body.as_deref().map(|b| b.lines().count()), Some(5));
    assert!(
        update.raw_json["release_url"]
            .as_str()
            .is_some_and(|u| u.ends_with("/releases/tag/desktop-v0.2.0"))
    );
    let name = update
        .download_url
        .path_segments()
        .and_then(|mut s| s.next_back())
        .expect("a file name")
        .to_owned();
    let mut seen = 0;
    let bytes = update
        .download(|n, _| seen += n, || {})
        .await
        .expect("a download whose signature checks out");
    assert_eq!(
        bytes,
        std::fs::read(format!("{dir}/good/{name}")).expect("the bundle")
    );
    assert_eq!(seen, bytes.len());

    // the same feed and signatures over changed bytes: refused
    let changed = check("tampered")
        .await
        .expect("the feed answers")
        .expect("an update");
    assert!(
        changed.download(|_, _| {}, || {}).await.is_err(),
        "a changed download must not pass"
    );

    // 0.3.0 announced with 0.2.0's file and signature: refused, the signature names 0.2.0
    let relabeled = check("relabeled")
        .await
        .expect("the feed answers")
        .expect("an update");
    assert_eq!(relabeled.version, "0.3.0");
    let err = relabeled
        .download(|_, _| {}, || {})
        .await
        .expect_err("a relabeled release must not pass");
    assert!(err.to_string().contains("0.2.0"), "{err}");

    // a feed with the running version: nothing to do
    assert!(check("current").await.expect("the feed answers").is_none());
}
