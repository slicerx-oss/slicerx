// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Who a paired connection is, and what it may call.
//!
//! The pairing code decides the role. The app code (`pairing-code`, shown by the app and by
//! `sx-link code`) gives `app`: the desktop app, the browser build the person paired by hand, and
//! through the app, its phones. The agent code (`agent-code`, `sx-link code --agent`) gives `agent`:
//! the MCP server and other tools that act for a model. A client can ask for `agent` with the app
//! code, never the other way round, and a remembered client keeps the role it paired with.
//!
//! An agent may read, register approval cards and run side effects with tokens it was given. The
//! hub stamps its cards with origin `mcp` whatever it sends. It may answer only its own cards, and
//! never one that starts a print, sends raw G-code or changes a running print: a person answers
//! those on the app's card or on a phone. It may not press Print, say the plate is clear, queue,
//! pair phones, manage remembered clients, secrets, printers, services or settings.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Role {
    App,
    Agent,
    /// A failure detector (`sx-watch`): frames in, findings out, nothing else.
    Watch,
}

impl Role {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Role::App => "app",
            Role::Agent => "agent",
            Role::Watch => "watch",
        }
    }
}

/// Methods an agent connection may not call at all.
const APP_ONLY: &[&str] = &[
    "print.local",
    // The head moves, a running print loses an object, a stored file starts: a person at the app.
    "jog",
    "objects.skip",
    "files.start",
    // What an AMS slot holds is the person's to say; an agent never writes it.
    "adjust.slot",
    // The light is the app's own switch, with no card a person answers.
    "adjust.light",
    "bed.confirmClear",
    "queue.add",
    "queue.remove",
    "printers.add",
    "printers.remove",
    "printers.authorize",
    // It pairs a stored credential with an address the caller chooses, so the hub would send a
    // printer's key to whoever listens there.
    "printers.test",
    "watch.autoPause",
    "watch.huginn",
    "watch.mask",
    "watch.dismiss",
    // The camera guard: its settings, the empty-plate picture and the frames it keeps.
    "watch.guard",
    "watch.guardState",
    "watch.evidence",
    "watch.plateClear",
    "watch.plateCheck",
    "watch.plateIgnore",
    "services.configure",
    "services.list",
    "services.remove",
    "settings.set",
    "pair.listen",
    "pair.send",
    "pair.close",
    "inbox.decline",
    "push.register",
    "push.unregister",
];

const APP_ONLY_PREFIXES: &[&str] = &["clients.", "secrets.", "remote."];

/// The only methods a `watch` connection may call.
const WATCH_METHODS: &[&str] = &[
    "watch.subscribe",
    "watch.unsubscribe",
    "watch.report",
    "watch.masks",
    "watch.huginnPrinters",
    "watch.grab",
    "watch.plateResult",
];

/// The role a client may ask for at pairing, given the role its code or key gives: the same or a
/// narrower one, never a wider one.
pub(crate) fn narrowed(granted: Role, asked: Option<&str>) -> Role {
    match (granted, asked) {
        (Role::App, Some("agent")) => Role::Agent,
        (Role::App | Role::Agent, Some("watch")) => Role::Watch,
        (r, _) => r,
    }
}

/// Whether `role` may call `method`. Card answers are checked separately ([`may_answer`]).
pub(crate) fn allowed(role: Role, method: &str) -> bool {
    if role == Role::Watch {
        return WATCH_METHODS.contains(&method);
    }
    role == Role::App
        || !(APP_ONLY.contains(&method) || APP_ONLY_PREFIXES.iter().any(|p| method.starts_with(p)))
}

/// Actions only a person may approve, on the app's card or a phone.
const PERSON_ONLY: &[&str] = &[
    "printer.start",
    "printer.resume",
    "printer.gcode",
    "printer.adjust",
];

/// Whether a card with these `(action, target)` pairs needs a person's answer. Home Assistant
/// service calls switch power plugs and lights, so they count too.
pub(crate) fn person_only<'a>(mut actions: impl Iterator<Item = (&'a str, &'a str)>) -> bool {
    actions.any(|(a, target)| PERSON_ONLY.contains(&a) || (a == "plugin.call" && target == "home-assistant"))
}

/// Whether an agent's direct `callTool` needs a person: Home Assistant service calls.
pub(crate) fn tool_needs_person(plugin: &str, tool: &str) -> bool {
    plugin == "home-assistant" && tool.trim_start_matches("home-assistant.") != "list_entities"
}

/// Whether a connection may grant or deny a card. `own` is true when this connection registered it.
pub(crate) fn may_answer(role: Role, own: bool, needs_person: bool) -> bool {
    match role {
        Role::App => true,
        Role::Agent => own && !needs_person,
        Role::Watch => false,
    }
}

/// Whether a connection with `role` gets a hub event addressed to no one in particular.
pub(crate) fn sees_broadcast(role: Role, event: &str) -> bool {
    match role {
        // Plate checks carry two pictures for the detector; the app gets the guard's own events.
        Role::App => event != "watch.plate",
        Role::Agent => false,
        Role::Watch => matches!(event, "watch.dismissed" | "watch.plate"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agents_cannot_reach_the_person_only_methods() {
        for m in [
            "print.local",
            "bed.confirmClear",
            "queue.add",
            "clients.revoke",
            "secrets.set",
            "pair.send",
        ] {
            assert!(!allowed(Role::Agent, m), "{m}");
            assert!(allowed(Role::App, m), "{m}");
        }
        for m in [
            "list",
            "status",
            "approvals.register",
            "approvals.grant",
            "start",
            "queue.list",
            "camera.grab",
        ] {
            assert!(allowed(Role::Agent, m), "{m}");
        }
    }

    #[test]
    fn agents_answer_only_their_own_cards_and_never_a_start() {
        assert!(may_answer(Role::Agent, true, false));
        assert!(!may_answer(Role::Agent, false, false));
        assert!(!may_answer(Role::Agent, true, true));
        assert!(may_answer(Role::App, false, true));
        let p = |a: &[&'static str]| a.iter().map(|x| (*x, "bay-1")).collect::<Vec<_>>();
        assert!(person_only(p(&["printer.upload", "printer.start"]).into_iter()));
        assert!(person_only(p(&["printer.gcode"]).into_iter()));
        assert!(!person_only(
            p(&["printer.pause", "printer.cancel", "printer.upload"]).into_iter()
        ));
        assert!(person_only([("plugin.call", "home-assistant")].into_iter()));
        assert!(!person_only([("plugin.call", "spoolman")].into_iter()));
        assert!(tool_needs_person("home-assistant", "call_service"));
        assert!(!tool_needs_person("home-assistant", "list_entities"));
        assert!(!allowed(Role::Agent, "printers.test"));
        for m in ["watch.subscribe", "watch.report", "watch.masks"] {
            assert!(allowed(Role::Watch, m), "{m}");
        }
        for m in [
            "list",
            "status",
            "approvals.register",
            "start",
            "camera.grab",
            "watch.autoPause",
            "settings.get",
        ] {
            assert!(!allowed(Role::Watch, m), "{m}");
        }
        assert!(!may_answer(Role::Watch, true, false));
        assert_eq!(narrowed(Role::Watch, Some("agent")), Role::Watch, "never wider");
        assert_eq!(narrowed(Role::Agent, Some("app")), Role::Agent);
        assert_eq!(narrowed(Role::App, Some("watch")), Role::Watch);
        assert!(sees_broadcast(Role::Watch, "watch.dismissed") && !sees_broadcast(Role::Watch, "bed"));
        assert!(sees_broadcast(Role::Watch, "watch.plate") && !sees_broadcast(Role::App, "watch.plate"));
        assert!(!sees_broadcast(Role::Watch, "watch.guard") && sees_broadcast(Role::App, "watch.guard"));
    }
}
