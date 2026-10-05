// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Event stream for drivers without a push channel.
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use futures::stream::{self, BoxStream, StreamExt};

use crate::error::Result;
use crate::types::{PrinterEvent, PrinterState, PrinterStatus};

struct PollState<F> {
    fetch: Arc<F>,
    printer: String,
    interval: Duration,
    prev: Option<PrinterStatus>,
    queue: Vec<PrinterEvent>,
    first: bool,
}

/// Polls `fetch` every `interval` and yields `Status` when something other than the timestamp
/// changed, plus `JobFinished` when a job ends and one `Error` when polling starts failing.
pub(crate) fn poll_events<F, Fut>(
    printer: String,
    interval: Duration,
    fetch: Arc<F>,
) -> BoxStream<'static, PrinterEvent>
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<PrinterStatus>> + Send + 'static,
{
    let st = PollState {
        fetch,
        printer,
        interval,
        prev: None,
        queue: Vec::new(),
        first: true,
    };
    stream::unfold(st, |mut st| async move {
        loop {
            if let Some(e) = st.queue.pop() {
                return Some((e, st));
            }
            if !st.first {
                tokio::time::sleep(st.interval).await;
            }
            st.first = false;
            let next = match (st.fetch)().await {
                Ok(s) => s,
                Err(e) => {
                    let mut offline = PrinterStatus::offline(&st.printer);
                    offline.message = Some(e.to_string());
                    let was_offline = st.prev.as_ref().is_some_and(|p| p.state == PrinterState::Offline);
                    st.prev = Some(offline.clone());
                    if !was_offline {
                        st.queue.push(PrinterEvent::Status { status: offline });
                        st.queue.push(PrinterEvent::Error {
                            printer_id: st.printer.clone(),
                            code: format!("{:?}", e.code()).to_lowercase(),
                            message: e.to_string(),
                        });
                    }
                    continue;
                }
            };
            let mut out = Vec::new();
            if let Some(prev) = &st.prev {
                let was_active = matches!(
                    prev.state,
                    PrinterState::Printing | PrinterState::Paused | PrinterState::Preparing
                );
                if was_active
                    && matches!(
                        next.state,
                        PrinterState::Finished | PrinterState::Idle | PrinterState::Error
                    )
                {
                    out.push(PrinterEvent::JobFinished {
                        printer_id: st.printer.clone(),
                        job_name: prev.job_name.clone().unwrap_or_default(),
                        // Duet and some firmware go straight to idle after the last layer.
                        ok: next.state == PrinterState::Finished || prev.progress.is_some_and(|p| p >= 0.98),
                    });
                }
            }
            if changed(st.prev.as_ref(), &next) {
                out.push(PrinterEvent::Status { status: next.clone() });
            }
            st.prev = Some(next);
            // Popped from the back: Status is delivered before JobFinished.
            st.queue = out;
        }
    })
    .boxed()
}

fn changed(prev: Option<&PrinterStatus>, next: &PrinterStatus) -> bool {
    match prev {
        None => true,
        Some(p) => {
            let mut a = p.clone();
            let mut b = next.clone();
            a.updated_at.clear();
            b.updated_at.clear();
            a != b
        }
    }
}
