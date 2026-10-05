// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! State for printers that push telemetry: a merged JSON object, a normalized status derived from
//! it, and a broadcast of `status` and `job_finished` events.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use futures::stream::{self, BoxStream, StreamExt};
use serde_json::{Map, Value};
use tokio::sync::{broadcast, watch};

use crate::types::{PrinterEvent, PrinterState, PrinterStatus};

pub(crate) struct PushState {
    printer: String,
    parse: fn(&str, &Value) -> PrinterStatus,
    state: Mutex<Value>,
    connected: AtomicBool,
    events: broadcast::Sender<PrinterEvent>,
    have_state: watch::Sender<bool>,
    last: Mutex<Option<PrinterStatus>>,
}

impl PushState {
    pub(crate) fn new(printer: &str, parse: fn(&str, &Value) -> PrinterStatus) -> Self {
        let (events, _) = broadcast::channel(64);
        let (have_state, _) = watch::channel(false);
        Self {
            printer: printer.to_owned(),
            parse,
            state: Mutex::new(Value::Object(Map::new())),
            connected: AtomicBool::new(false),
            events,
            have_state,
            last: Mutex::new(None),
        }
    }

    pub(crate) fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    /// Records a connect or a drop. A drop publishes the printer as offline.
    pub(crate) fn set_link(&self, up: bool) {
        self.connected.store(up, Ordering::Relaxed);
        if !up {
            self.publish_changes();
        }
    }

    pub(crate) fn snapshot(&self) -> PrinterStatus {
        if !self.is_connected() {
            return PrinterStatus::offline(&self.printer);
        }
        (self.parse)(
            &self.printer,
            &self.state.lock().unwrap_or_else(PoisonError::into_inner),
        )
    }

    /// One member of the merged state.
    pub(crate) fn value(&self, key: &str) -> Option<Value> {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(key)
            .cloned()
    }

    /// Merges the members of `update` into the state and publishes what changed.
    pub(crate) fn merge(&self, update: &Map<String, Value>) {
        {
            let mut st = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(obj) = st.as_object_mut() {
                for (k, v) in update {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }
        let _ = self.have_state.send(true);
        self.publish_changes();
    }

    /// Waits until the first telemetry arrived.
    pub(crate) async fn first_state(&self, timeout: Duration) -> bool {
        let mut rx = self.have_state.subscribe();
        matches!(
            tokio::time::timeout(timeout, rx.wait_for(|v| *v)).await,
            Ok(Ok(_))
        )
    }

    fn publish_changes(&self) {
        let now = self.snapshot();
        let mut last = self.last.lock().unwrap_or_else(PoisonError::into_inner);
        let strip = |s: &PrinterStatus| {
            let mut c = s.clone();
            c.updated_at.clear();
            c
        };
        if let Some(prev) = last.as_ref() {
            let was_active = matches!(
                prev.state,
                PrinterState::Printing | PrinterState::Paused | PrinterState::Preparing
            );
            if was_active
                && matches!(
                    now.state,
                    PrinterState::Finished | PrinterState::Idle | PrinterState::Error
                )
            {
                let _ = self.events.send(PrinterEvent::JobFinished {
                    printer_id: self.printer.clone(),
                    job_name: prev.job_name.clone().unwrap_or_default(),
                    ok: now.state == PrinterState::Finished || prev.progress.is_some_and(|p| p >= 0.98),
                });
            }
            if strip(prev) == strip(&now) {
                return;
            }
        }
        let _ = self.events.send(PrinterEvent::Status { status: now.clone() });
        *last = Some(now);
    }

    /// The current status first, then every later event.
    pub(crate) fn events(&self) -> BoxStream<'static, PrinterEvent> {
        let first = self.snapshot();
        let rx = self.events.subscribe();
        let head = stream::once(async move { PrinterEvent::Status { status: first } });
        let tail = stream::unfold(rx, |mut rx| async move {
            loop {
                match rx.recv().await {
                    Ok(e) => return Some((e, rx)),
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        });
        head.chain(tail).boxed()
    }
}
