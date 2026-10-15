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
//!
//! A partner app (another program the person connects, such as `LayerMate`) holds a named key from
//! `clients.create` with `partner: true`. It is an agent with less: it calls only [`PARTNER_METHODS`]
//! and raises cards only to print, pause or cancel. It may pause and cancel on its own card, as an
//! agent does, since those only stop a print; a print waits for a person and carries its work.
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
    "watch.handCheck",
    // Resume on the guard's card: the person's click is the approval (guard.rs).
    "watch.resume",
    "services.configure",
    "services.list",
    "services.check",
    "services.remove",
    "settings.set",
    "pair.listen",
    "pair.send",
    "pair.close",
    "inbox.decline",
    "push.register",
    "push.unregister",
];

const APP_ONLY_PREFIXES: &[&str] = &["clients.", "secrets.", "remote.", "appLink."];

/// Whether an app link method reads the open project or changes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LinkClass {
    Read,
    #[allow(
        dead_code,
        reason = "the first edit methods come with the design and plate methods"
    )]
    Edit,
}

/// methods on the open project and their grants. other names are refused.
/// print overrides and view preferences are available; printing, accounts,
/// printer connections and network settings stay with a person.
pub(crate) const APP_LINK_METHODS: &[(&str, LinkClass)] = &[
    ("app.info", LinkClass::Read),
    ("history.get", LinkClass::Read),
    ("history.undo", LinkClass::Edit),
    ("history.redo", LinkClass::Edit),
    ("plate.list", LinkClass::Read),
    // Moving, turning and scaling objects on the shown plate, each one undo step the person can take back.
    ("project.move", LinkClass::Edit),
    ("project.rotate", LinkClass::Edit),
    ("project.scale", LinkClass::Edit),
    ("project.object_settings", LinkClass::Edit),
    ("object.settings", LinkClass::Read),
    ("object.settings_set", LinkClass::Edit),
    // The slice preview: what it shows, and moving the layer slider, the colors and the camera.
    // Read: it changes only what the window shows, never the project.
    ("preview.get", LinkClass::Read),
    ("preview.set", LinkClass::Read),
    // The project's plates with their slice states, and showing one of them (by number, or the next or previous).
    // Read: showing a plate changes only what the window shows, never the project.
    ("plates.list", LinkClass::Read),
    ("plates.show", LinkClass::Read),
    // Two view preferences from Settings, Look and feel: Frame the view and Toolbar size, read and set.
    // Read: they change how the window behaves, never the project. No other setting is reachable.
    ("look.get", LinkClass::Read),
    ("look.set", LinkClass::Read),
    ("values.list", LinkClass::Read),
    ("values.set", LinkClass::Edit),
    ("values.remove", LinkClass::Edit),
    ("values.bind", LinkClass::Edit),
    // The design tools, run in the app on its plate, each step a history step the person can undo.
    // Opening and saving files stay with the server and the person.
    ("design.new", LinkClass::Edit),
    ("design.list", LinkClass::Read),
    ("design.steps", LinkClass::Read),
    ("design.edit_step", LinkClass::Edit),
    ("design.undo", LinkClass::Edit),
    ("design.redo", LinkClass::Edit),
    // the design timeline, and moving its marker (rolling the design back or forward)
    ("design.timeline", LinkClass::Read),
    ("design.roll", LinkClass::Edit),
    ("design.sketch", LinkClass::Edit),
    ("geom.faces", LinkClass::Read),
    ("geom.face_pick", LinkClass::Read),
    ("geom.edge_pick", LinkClass::Read),
    ("geom.sketch_check", LinkClass::Read),
    ("geom.extrude", LinkClass::Edit),
    ("geom.revolve", LinkClass::Edit),
    ("geom.push_pull", LinkClass::Edit),
    ("geom.boolean", LinkClass::Edit),
    ("geom.fillet", LinkClass::Edit),
    ("geom.chamfer", LinkClass::Edit),
    ("geom.hole", LinkClass::Edit),
    ("geom.shell", LinkClass::Edit),
    ("geom.info", LinkClass::Read),
    ("geom.measure", LinkClass::Read),
    ("geom.cut", LinkClass::Edit),
    ("geom.split", LinkClass::Edit),
    ("geom.mirror", LinkClass::Edit),
    ("geom.array", LinkClass::Edit),
    ("geom.repair", LinkClass::Edit),
    ("geom.hollow", LinkClass::Edit),
    ("geom.emboss", LinkClass::Edit),
    ("geom.build", LinkClass::Edit),
    ("geom.subtract", LinkClass::Edit),
    // A client's dimension sheet: asking puts a question in front of the person, so it edits.
    ("sheet.ask", LinkClass::Edit),
    ("sheet.get", LinkClass::Read),
    // mimir's conversations in the window, read back: what was said and what mimir did.
    ("mimir.sessions", LinkClass::Read),
    ("mimir.session", LinkClass::Read),
    // A client's message to mimir, with pictures and PDFs: it goes in the chat as the person's next message, so it edits.
    ("mimir.ask", LinkClass::Edit),
    // Today's mimir cloud use and caps for this install. The token stays in the app's keychain.
    ("mimir.quota", LinkClass::Read),
    // Whether mimir cloud keeps this install's sessions, and whether the person read the notice.
    ("mimir.share", LinkClass::Read),
    // mimir cloud at a glance: offered, in use, signed in, and today's use while in use. No key or token.
    ("mimir.status", LinkClass::Read),
    // What answers in the mimir tab (a model or the scripted stub) and its tools. No key or token.
    ("mimir.tab", LinkClass::Read),
];

/// The class of an app link method, or None when the link has no such method.
pub(crate) fn link_class(method: &str) -> Option<LinkClass> {
    APP_LINK_METHODS
        .iter()
        .find(|(m, _)| *m == method)
        .map(|(_, c)| *c)
}

/// The only methods a `watch` connection may call.
const WATCH_METHODS: &[&str] = &[
    "watch.subscribe",
    "watch.unsubscribe",
    "watch.report",
    "watch.masks",
    "watch.huginnPrinters",
    "watch.grab",
    "watch.plateResult",
    "watch.lookResult",
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

/// The only methods a partner app may call: reading, stills and live view, preparing a file, its own
/// cards, and pause and cancel with the token of its own card. Every other token taker is missing.
const PARTNER_METHODS: &[&str] = &[
    "plugins",
    "list",
    "status",
    "subscribe",
    "unsubscribe",
    "snapshot",
    "camera.grab",
    "camera.open",
    "camera.close",
    "camera.quality",
    "camera.probe",
    "camera.webrtc",
    "prepareUpload",
    "files.list",
    "history.list",
    "issues.list",
    "objects.list",
    "bed.state",
    "adjust.limits",
    "fleets.list",
    "queue.list",
    "inbox.list",
    "approvals.register",
    "approvals.grant",
    "approvals.deny",
    "approvals.pending",
    "pause",
    "cancel",
];

/// Whether a partner app may call `method`.
pub(crate) fn partner_allowed(method: &str) -> bool {
    PARTNER_METHODS.contains(&method) && allowed(Role::Agent, method)
}

/// Card actions a partner may ask a person for: a print (upload and start), pause or cancel.
const PARTNER_ACTIONS: &[&str] = &[
    "printer.upload",
    "printer.start",
    "printer.pause",
    "printer.cancel",
];

/// Whether a partner may raise a card with these actions.
pub(crate) fn partner_may_ask<'a>(mut actions: impl Iterator<Item = &'a str>) -> bool {
    actions.all(|a| PARTNER_ACTIONS.contains(&a))
}

/// Whether a partner may answer its own card with these actions: only one that pauses or cancels.
pub(crate) fn partner_may_grant<'a>(actions: impl Iterator<Item = &'a str>) -> bool {
    let mut any = false;
    for a in actions {
        if !matches!(a, "printer.pause" | "printer.cancel") {
            return false;
        }
        any = true;
    }
    any
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
        // Plate checks and looks carry pictures for the detector; the app gets the guard's own events.
        Role::App => !matches!(event, "watch.plate" | "watch.look"),
        Role::Agent => false,
        Role::Watch => matches!(event, "watch.dismissed" | "watch.plate" | "watch.look"),
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
            // connected apps are added, listed and removed by a person in the app
            "services.configure",
            "services.list",
            "services.check",
            "services.remove",
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
            "callTool",
        ] {
            assert!(allowed(Role::Agent, m), "{m}");
        }
    }

    // new methods are pinned here with their reviewed class.
    const PINNED_APP_METHODS: &[(&str, LinkClass)] = &[
        ("app.info", LinkClass::Read),
        ("history.get", LinkClass::Read),
        ("history.undo", LinkClass::Edit),
        ("history.redo", LinkClass::Edit),
        ("plate.list", LinkClass::Read),
        ("project.move", LinkClass::Edit),
        ("project.rotate", LinkClass::Edit),
        ("project.scale", LinkClass::Edit),
        ("project.object_settings", LinkClass::Edit),
        ("object.settings", LinkClass::Read),
        ("object.settings_set", LinkClass::Edit),
        ("preview.get", LinkClass::Read),
        ("preview.set", LinkClass::Read),
        ("plates.list", LinkClass::Read),
        ("plates.show", LinkClass::Read),
        ("look.get", LinkClass::Read),
        ("look.set", LinkClass::Read),
        ("values.list", LinkClass::Read),
        ("values.set", LinkClass::Edit),
        ("values.remove", LinkClass::Edit),
        ("values.bind", LinkClass::Edit),
        ("design.new", LinkClass::Edit),
        ("design.list", LinkClass::Read),
        ("design.steps", LinkClass::Read),
        ("design.edit_step", LinkClass::Edit),
        ("design.undo", LinkClass::Edit),
        ("design.redo", LinkClass::Edit),
        ("design.timeline", LinkClass::Read),
        ("design.roll", LinkClass::Edit),
        ("design.sketch", LinkClass::Edit),
        ("geom.faces", LinkClass::Read),
        ("geom.face_pick", LinkClass::Read),
        ("geom.edge_pick", LinkClass::Read),
        ("geom.sketch_check", LinkClass::Read),
        ("geom.extrude", LinkClass::Edit),
        ("geom.revolve", LinkClass::Edit),
        ("geom.push_pull", LinkClass::Edit),
        ("geom.boolean", LinkClass::Edit),
        ("geom.fillet", LinkClass::Edit),
        ("geom.chamfer", LinkClass::Edit),
        ("geom.hole", LinkClass::Edit),
        ("geom.shell", LinkClass::Edit),
        ("geom.info", LinkClass::Read),
        ("geom.measure", LinkClass::Read),
        ("geom.cut", LinkClass::Edit),
        ("geom.split", LinkClass::Edit),
        ("geom.mirror", LinkClass::Edit),
        ("geom.array", LinkClass::Edit),
        ("geom.repair", LinkClass::Edit),
        ("geom.hollow", LinkClass::Edit),
        ("geom.emboss", LinkClass::Edit),
        ("geom.build", LinkClass::Edit),
        ("geom.subtract", LinkClass::Edit),
        ("sheet.ask", LinkClass::Edit),
        ("sheet.get", LinkClass::Read),
        ("mimir.sessions", LinkClass::Read),
        ("mimir.session", LinkClass::Read),
        ("mimir.ask", LinkClass::Edit),
        ("mimir.quota", LinkClass::Read),
        ("mimir.share", LinkClass::Read),
        ("mimir.status", LinkClass::Read),
        ("mimir.tab", LinkClass::Read),
    ];

    #[test]
    fn the_app_link_has_exactly_its_pinned_methods_and_none_a_person_keeps() {
        assert_eq!(APP_LINK_METHODS, PINNED_APP_METHODS);
        for (m, _) in APP_LINK_METHODS {
            assert!(!APP_ONLY.contains(m), "{m}");
            for word in [
                "print", "queue", "start", "send", "upload", "gcode", "approv", "grant", "sign_in", "signin",
                "login", "auth", "buy", "purchase", "delete", "remove", "secret", "printer", "setting",
                "pair", "client",
            ] {
                // mesh repair does not pair clients.
                let mesh_repair = *m == "geom.repair" && word == "pair";
                assert!(
                    mesh_repair
                        || !m.to_ascii_lowercase().contains(word)
                        || (*m == "values.remove" && word == "remove"),
                    "{m} looks like something a person keeps ({word})"
                );
            }
        }
        assert_eq!(link_class("plate.list"), Some(LinkClass::Read));
        assert_eq!(link_class("geom.extrude"), Some(LinkClass::Edit));
        // removing a project value is an edit, never a file or printer action.
        assert_eq!(link_class("values.remove"), Some(LinkClass::Edit));
        for m in ["design.open", "design.save"] {
            assert_eq!(link_class(m), None, "{m} reads or writes files");
        }
        assert_eq!(link_class("print.local"), None);
        assert_eq!(link_class(""), None);
        // The app's side of the link is the app's alone.
        for m in [
            "appLink.host",
            "appLink.reply",
            "appLink.answer",
            "appLink.grants",
            "appLink.revoke",
        ] {
            assert!(!allowed(Role::Agent, m), "{m}");
            assert!(!allowed(Role::Watch, m), "{m}");
            assert!(allowed(Role::App, m), "{m}");
        }
        assert!(allowed(Role::Agent, "app.call"));
        assert!(
            !partner_allowed("app.call"),
            "partner apps stay off the open project"
        );
        assert!(!allowed(Role::Watch, "app.call"));
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
        assert_eq!(narrowed(Role::Agent, Some("watch")), Role::Watch);
        assert_eq!(narrowed(Role::Watch, Some("agent")), Role::Watch, "never wider");
        assert_eq!(narrowed(Role::Agent, Some("app")), Role::Agent);
        assert_eq!(narrowed(Role::App, Some("watch")), Role::Watch);
        assert!(sees_broadcast(Role::Watch, "watch.dismissed") && !sees_broadcast(Role::Watch, "bed"));
        assert!(sees_broadcast(Role::Watch, "watch.plate") && !sees_broadcast(Role::App, "watch.plate"));
        assert!(!sees_broadcast(Role::Watch, "watch.guard") && sees_broadcast(Role::App, "watch.guard"));
    }

    #[test]
    fn partners_call_only_their_list_and_grant_only_pause_and_cancel() {
        for m in [
            "list",
            "status",
            "camera.grab",
            "prepareUpload",
            "approvals.register",
            "approvals.grant",
            "approvals.deny",
            "approvals.pending",
            "pause",
            "cancel",
        ] {
            assert!(partner_allowed(m), "{m}");
        }
        for m in [
            "start",
            "resume",
            "gcode",
            "upload",
            "adjust",
            "adjust.slot",
            "adjust.light",
            "callTool",
            "print.local",
            "files.start",
            "objects.skip",
            "jog",
            "queue.add",
            "fleets.create",
            "fleets.delete",
            "discover",
            "watch.report",
            "watch.resume",
            "clients.create",
            "clients.revoke",
            "secrets.set",
            "remote.status",
            "settings.set",
            "printers.add",
        ] {
            assert!(!partner_allowed(m), "{m}");
        }
        assert!(partner_may_ask(["printer.upload", "printer.start"].into_iter()));
        assert!(partner_may_ask(["printer.pause"].into_iter()));
        assert!(partner_may_ask(["printer.cancel"].into_iter()));
        for a in [
            "printer.resume",
            "printer.gcode",
            "printer.adjust",
            "plugin.call",
            "printer.config",
        ] {
            assert!(!partner_may_ask(["printer.pause", a].into_iter()), "{a}");
        }
        assert!(partner_may_grant(["printer.pause"].into_iter()));
        assert!(partner_may_grant(["printer.cancel"].into_iter()));
        assert!(!partner_may_grant(std::iter::empty()));
        for a in [
            "printer.upload",
            "printer.start",
            "printer.resume",
            "printer.gcode",
            "printer.adjust",
            "plugin.call",
        ] {
            assert!(!partner_may_grant(["printer.pause", a].into_iter()), "{a}");
        }
    }
}
