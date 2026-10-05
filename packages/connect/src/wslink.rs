// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! A WebSocket connection that stays up: connects, sends a greeting, keeps alive, hands every
//! text frame to a callback, and reconnects every two seconds after a drop. Used by the drivers
//! whose printers push status over a WebSocket (Elegoo SDCP, Creality).
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use crate::error::{Error, Result};

/// Handles one text frame and may answer with a text frame of its own.
pub(crate) type OnText = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;
/// Called with `true` after each connect and `false` after each drop.
pub(crate) type OnLink = Arc<dyn Fn(bool) + Send + Sync>;
/// Frames to send right after each connect.
pub(crate) type Greeting = Arc<dyn Fn() -> Vec<String> + Send + Sync>;

pub(crate) struct WsLinkSpec {
    pub url: String,
    pub subprotocol: Option<&'static str>,
    pub greeting: Greeting,
    /// A frame sent on an interval so idle printers keep the socket open.
    pub keepalive: Option<(Duration, String)>,
}

pub(crate) struct WsLink {
    pub out: mpsc::UnboundedSender<String>,
    task: JoinHandle<()>,
}

impl Drop for WsLink {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl WsLink {
    /// Connects once (failing with `Unreachable` if that does not work within 8 seconds) and then
    /// keeps the link up in the background.
    pub(crate) async fn start(
        printer: &str,
        spec: WsLinkSpec,
        on_text: OnText,
        on_link: OnLink,
    ) -> Result<WsLink> {
        let mut request = spec
            .url
            .as_str()
            .into_client_request()
            .map_err(|e| Error::Config(e.to_string()))?;
        if let Some(p) = spec.subprotocol {
            request.headers_mut().insert(
                "Sec-WebSocket-Protocol",
                p.parse().map_err(|_| Error::Config("subprotocol".to_owned()))?,
            );
        }
        let (out, mut out_rx) = mpsc::unbounded_channel::<String>();
        let (first_tx, first_rx) = oneshot::channel::<Result<()>>();
        let id = printer.to_owned();
        let task = tokio::spawn(async move {
            let mut first = Some(first_tx);
            loop {
                match connect_async(request.clone()).await {
                    Err(e) => {
                        if let Some(tx) = first.take() {
                            let _ = tx.send(Err(Error::unreachable(&id, e)));
                            return;
                        }
                    }
                    Ok((mut ws, _)) => {
                        on_link(true);
                        if let Some(tx) = first.take() {
                            let _ = tx.send(Ok(()));
                        }
                        for frame in (spec.greeting)() {
                            let _ = ws.send(Message::text(frame)).await;
                        }
                        let period = spec.keepalive.as_ref().map_or(Duration::from_secs(3600), |k| k.0);
                        let mut tick = tokio::time::interval(period);
                        tick.reset();
                        loop {
                            tokio::select! {
                                msg = ws.next() => match msg {
                                    Some(Ok(Message::Text(t))) => {
                                        if let Some(reply) = on_text(t.as_str())
                                            && ws.send(Message::text(reply)).await.is_err()
                                        {
                                            break;
                                        }
                                    }
                                    Some(Ok(Message::Ping(p))) => { let _ = ws.send(Message::Pong(p)).await; }
                                    Some(Ok(_)) => {}
                                    _ => break,
                                },
                                cmd = out_rx.recv() => match cmd {
                                    Some(text) => { if ws.send(Message::text(text)).await.is_err() { break; } }
                                    None => return,
                                },
                                _ = tick.tick() => {
                                    if let Some((_, frame)) = &spec.keepalive
                                        && ws.send(Message::text(frame.clone())).await.is_err()
                                    {
                                        break;
                                    }
                                }
                            }
                        }
                        on_link(false);
                    }
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        });
        match tokio::time::timeout(Duration::from_secs(8), first_rx).await {
            Ok(Ok(Ok(()))) => Ok(WsLink { out, task }),
            Ok(Ok(Err(e))) => Err(e),
            _ => {
                task.abort();
                Err(Error::unreachable(printer, "WebSocket connection timed out"))
            }
        }
    }
}
