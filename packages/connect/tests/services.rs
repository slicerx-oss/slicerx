// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Spoolman and Home Assistant against their fakes.
#![allow(clippy::unwrap_used, clippy::expect_used)]
mod common;

use std::sync::Arc;

use common::{Mocks, expect_code};
use serde_json::json;
use sx_connect::services::{HomeAssistantPlugin, SpoolmanPlugin};
use sx_connect::{Action, ErrorCode, MemoryGate, ServicePlugin, params};

#[tokio::test]
async fn spoolman_reads_and_writes_with_a_token() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("spoolman", &[]).await;
    let p = SpoolmanPlugin::new(
        &format!("http://127.0.0.1:{}", mocks.port("spoolman")),
        gate.clone(),
    )
    .unwrap();

    let all = p.call("spoolman.list_spools", json!({}), None).await.unwrap();
    assert_eq!(all.as_array().unwrap().len(), 9);
    assert_eq!(all[0]["color"], "#f2f2f2");
    assert_eq!(all[0]["vendor"], "Northpine");
    let pla = p
        .call("list_spools", json!({ "material": "PLA" }), None)
        .await
        .unwrap();
    assert!(pla.as_array().unwrap().iter().all(|s| s["material"] == "PLA"));
    let one = p
        .call("spoolman.get_spool", json!({ "id": 3 }), None)
        .await
        .unwrap();
    assert_eq!(one["remainingG"], 410.0);

    expect_code(
        p.call("spoolman.record_usage", json!({ "id": 3, "grams": 10 }), None)
            .await,
        ErrorCode::ApprovalRequired,
    );
    let wrong = gate.mint(
        Action::PluginCall,
        "spoolman",
        &params::plugin("spoolman", "record_usage", &json!({ "id": 3, "grams": 99 })),
    );
    expect_code(
        p.call(
            "spoolman.record_usage",
            json!({ "id": 3, "grams": 10 }),
            Some(&wrong),
        )
        .await,
        ErrorCode::ApprovalInvalid,
    );
    let t = gate.mint(
        Action::PluginCall,
        "spoolman",
        &params::plugin("spoolman", "record_usage", &json!({ "id": 3, "grams": 10 })),
    );
    let after = p
        .call("spoolman.record_usage", json!({ "id": 3, "grams": 10 }), Some(&t))
        .await
        .unwrap();
    assert_eq!(after["remainingG"], 400.0);
    expect_code(
        p.call("spoolman.record_usage", json!({ "id": 3, "grams": 10 }), Some(&t))
            .await,
        ErrorCode::ApprovalInvalid,
    );
    expect_code(
        p.call("spoolman.nope", json!({}), None).await,
        ErrorCode::NotSupported,
    );
}

#[tokio::test]
async fn home_assistant_lists_and_calls_allowed_services_only() {
    let gate = Arc::new(MemoryGate::new());
    let mocks = Mocks::start("home-assistant", &[]).await;
    let base = format!("http://127.0.0.1:{}", mocks.port("home-assistant"));
    let bad = HomeAssistantPlugin::new(&base, "wrong".to_owned(), gate.clone()).unwrap();
    expect_code(
        bad.call("home-assistant.list_entities", json!({}), None).await,
        ErrorCode::Auth,
    );

    let p = HomeAssistantPlugin::new(&base, mocks.str("haToken"), gate.clone()).unwrap();
    let list = p
        .call(
            "home-assistant.list_entities",
            json!({ "domain": "switch" }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(list.as_array().unwrap().len(), 6);
    assert_eq!(list[0]["entityId"], "switch.bay_1_power");

    // The mock also serves lock.front_door; listing never shows a domain off the allow-list.
    let all = p
        .call("home-assistant.list_entities", json!({}), None)
        .await
        .unwrap();
    assert_eq!(all.as_array().unwrap().len(), 6);
    assert!(
        all.as_array()
            .unwrap()
            .iter()
            .all(|e| e["entityId"] != "lock.front_door")
    );
    expect_code(
        p.call("home-assistant.list_entities", json!({ "domain": "lock" }), None)
            .await,
        ErrorCode::NotSupported,
    );

    let args = json!({ "domain": "switch", "service": "turn_off", "entityId": "switch.bay_5_power" });
    expect_code(
        p.call("home-assistant.call_service", args.clone(), None).await,
        ErrorCode::ApprovalRequired,
    );
    let t = gate.mint(
        Action::PluginCall,
        "home-assistant",
        &params::plugin("home-assistant", "call_service", &args),
    );
    p.call("home-assistant.call_service", args, Some(&t))
        .await
        .unwrap();
    let state = mocks.state().await;
    assert!(
        state["log"]
            .as_array()
            .unwrap()
            .iter()
            .any(|l| l == "ha switch.turn_off switch.bay_5_power")
    );

    // Locks and scripts are outside the allow-list even with a token.
    let lock = json!({ "domain": "lock", "service": "unlock", "entityId": "lock.front_door" });
    let t = gate.mint(
        Action::PluginCall,
        "home-assistant",
        &params::plugin("home-assistant", "call_service", &lock),
    );
    expect_code(
        p.call("home-assistant.call_service", lock, Some(&t)).await,
        ErrorCode::NotSupported,
    );
}
