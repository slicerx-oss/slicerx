// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! The Home Assistant connector against a real Home Assistant, for the real-device check before it leaves
//! Experimental. Ignored by default; run it with an instance that has the demo integration and an
//! `input_boolean.printing_lights` helper:
//!
//! `SX_HA_URL=http://127.0.0.1:8123 SX_HA_TOKEN=... cargo test -p sx-connect --test home_assistant_live -- --ignored`
//!
//! The token comes from the environment and is never printed.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::sync::Arc;

use serde_json::{Value, json};
use sx_connect::services::HomeAssistantPlugin;
use sx_connect::{Action, ErrorCode, MemoryGate, ServicePlugin, params};

fn plugin(gate: Arc<MemoryGate>) -> HomeAssistantPlugin {
    let url = std::env::var("SX_HA_URL").expect("set SX_HA_URL");
    let token = std::env::var("SX_HA_TOKEN").expect("set SX_HA_TOKEN");
    HomeAssistantPlugin::new(&url, token, gate).unwrap()
}

async fn state(p: &HomeAssistantPlugin, entity: &str) -> String {
    let domain = entity.split_once('.').unwrap().0;
    let list = p
        .call("home-assistant.list_entities", json!({ "domain": domain }), None)
        .await
        .unwrap();
    list.as_array()
        .unwrap()
        .iter()
        .find(|e| e["entityId"] == entity)
        .unwrap_or_else(|| panic!("{entity} is not listed"))["state"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Calls a service with a token minted for exactly these arguments, then checks the same token fails again.
async fn call(p: &HomeAssistantPlugin, gate: &MemoryGate, domain: &str, service: &str, entity: &str) {
    let args = json!({ "domain": domain, "service": service, "entityId": entity });
    let err = p
        .call("home-assistant.call_service", args.clone(), None)
        .await
        .unwrap_err();
    assert_eq!(
        err.code(),
        ErrorCode::ApprovalRequired,
        "{domain}.{service} ran without approval"
    );
    let t = gate.mint(
        Action::PluginCall,
        "home-assistant",
        &params::plugin("home-assistant", "call_service", &args),
    );
    p.call("home-assistant.call_service", args.clone(), Some(&t))
        .await
        .unwrap();
    let again = p
        .call("home-assistant.call_service", args, Some(&t))
        .await
        .unwrap_err();
    assert_eq!(
        again.code(),
        ErrorCode::ApprovalInvalid,
        "an approval worked twice"
    );
}

async fn settle() {
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
}

#[tokio::test]
#[ignore = "needs a real Home Assistant (SX_HA_URL, SX_HA_TOKEN)"]
async fn a_real_home_assistant_lists_and_switches_the_allowed_domains() {
    let gate = Arc::new(MemoryGate::new());
    let p = plugin(gate.clone());

    // A wrong token is refused as an auth error, not a crash or an empty list.
    let url = std::env::var("SX_HA_URL").unwrap();
    let bad = HomeAssistantPlugin::new(&url, "not-a-token".to_owned(), gate.clone()).unwrap();
    assert_eq!(
        bad.call("home-assistant.list_entities", json!({}), None)
            .await
            .unwrap_err()
            .code(),
        ErrorCode::Auth
    );

    // Listing: every allowed domain shows up, and nothing else does.
    let all = p
        .call("home-assistant.list_entities", json!({}), None)
        .await
        .unwrap();
    let ids: Vec<&str> = all
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["entityId"].as_str().unwrap())
        .collect();
    for d in ["switch", "light", "fan", "input_boolean", "button"] {
        assert!(
            ids.iter().any(|i| i.starts_with(&format!("{d}."))),
            "no {d} entity listed: {ids:?}"
        );
    }
    assert!(
        ids.iter()
            .all(|i| ["switch.", "light.", "fan.", "input_boolean.", "button."]
                .iter()
                .any(|d| i.starts_with(d))),
        "a domain off the allow-list was listed: {ids:?}"
    );
    assert!(
        all.as_array()
            .unwrap()
            .iter()
            .all(|e| e["name"].is_string() && e["state"].is_string())
    );
    println!("listed {} entities", ids.len());

    let first = |d: &str| {
        ids.iter()
            .find(|i| i.starts_with(&format!("{d}.")))
            .unwrap()
            .to_string()
    };

    // Each domain's calls change the real state.
    let sw = first("switch");
    call(&p, &gate, "switch", "turn_off", &sw).await;
    settle().await;
    assert_eq!(state(&p, &sw).await, "off");
    call(&p, &gate, "switch", "turn_on", &sw).await;
    settle().await;
    assert_eq!(state(&p, &sw).await, "on");

    let light = first("light");
    call(&p, &gate, "light", "turn_off", &light).await;
    settle().await;
    assert_eq!(state(&p, &light).await, "off");

    let fan = first("fan");
    call(&p, &gate, "fan", "turn_on", &fan).await;
    settle().await;
    assert_eq!(state(&p, &fan).await, "on");

    let flag = "input_boolean.printing_lights";
    let before = state(&p, flag).await;
    call(&p, &gate, "input_boolean", "toggle", flag).await;
    settle().await;
    assert_ne!(state(&p, flag).await, before);

    // A button's state is the time it was last pressed.
    let button = first("button");
    let was = state(&p, &button).await;
    call(&p, &gate, "button", "press", &button).await;
    settle().await;
    assert_ne!(state(&p, &button).await, was);

    // Off the allow-list, even with a token minted for it.
    let script = json!({ "domain": "script", "service": "turn_on", "entityId": "script.anything" });
    let t = gate.mint(
        Action::PluginCall,
        "home-assistant",
        &params::plugin("home-assistant", "call_service", &script),
    );
    assert_eq!(
        p.call("home-assistant.call_service", script, Some(&t))
            .await
            .unwrap_err()
            .code(),
        ErrorCode::NotSupported
    );
    // A service Home Assistant does not have comes back as an error, not a success.
    let nope = json!({ "domain": "switch", "service": "launch", "entityId": sw });
    let t = gate.mint(
        Action::PluginCall,
        "home-assistant",
        &params::plugin("home-assistant", "call_service", &nope),
    );
    let r: Result<Value, _> = p.call("home-assistant.call_service", nope, Some(&t)).await;
    println!(
        "unknown service: {}",
        match &r {
            Ok(_) => "ok".to_owned(),
            Err(e) => format!("{:?}", e.code()),
        }
    );
}
