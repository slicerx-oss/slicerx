// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! UltiMaker S3, S5, S6, S7, S8, Factor 4 and the UM3 family over their local API, the way UltiMaker
//! Cura's network plugin uses it: `_ultimaker._tcp` over multicast DNS, the cluster API
//! (`/cluster-api/v1`, no login, firmware 4.0 and later) for jobs and print cores, and the printer
//! API (`/api/v1`) for temperatures and the system. Changes on the printer API need HTTP Digest with
//! the id and key from its pairing (`/api/v1/auth/request`, allowed on the touchscreen). See
//! README.md for sources and what is untested on hardware.
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use futures::stream::BoxStream;
use reqwest::multipart::{Form, Part};
use reqwest::{Client, RequestBuilder, Response};
use serde_json::{Value, json};

use crate::camera::{self, FrameStream};
use crate::digest::{Challenge, DigestAuth};
use crate::error::{Error, LoginNeed, Result};
use crate::gate::{Action, ApprovalGate, ApprovalToken, params};
use crate::http::{self, f64_at, seg, str_at};
use crate::manifest::{PluginManifest, manifest};
use crate::poll::poll_events;
use crate::types::{
    Capabilities, Capability, DiscoveredPrinter, ExtruderInfo, FilamentSlot, FilamentUnit, Image, JobFile,
    PrinterConfig, PrinterEvent, PrinterHardware, PrinterState, PrinterStatus, RemoteFile, Secrets,
    StartOptions, Temp, now_iso, secs,
};
use crate::{PrinterConnector, PrinterSession};

const SERVICE: &str = "_ultimaker._tcp.local";
/// The camera's mjpg-streamer port (Cura `ClusterPrinterStatus`).
const CAMERA_PORT: u16 = 8080;

/// Machine BOM numbers to model names, from the `bom_numbers` of UltiMaker Cura's machine
/// definitions. Cura matches the TXT `machine` value by prefix.
const BOM: [(&str, &str); 15] = [
    ("9066", "UM3"),
    ("9511", "UM3 Extended"),
    ("213482", "S3"),
    ("213483", "S3"),
    ("213484", "S3"),
    ("9051", "S5"),
    ("214475", "S5"),
    ("214476", "S5"),
    ("214477", "S5"),
    ("10700", "S6"),
    ("10701", "S6"),
    ("5078167", "S7"),
    ("5078168", "S7"),
    ("10600", "S8"),
    ("227380", "Factor 4"),
];

/// The model a TXT `machine` value (a BOM number such as `9051.0`) names.
pub(crate) fn model_from_bom(machine: &str) -> Option<&'static str> {
    let m = machine.trim();
    BOM.iter()
        .filter(|(bom, _)| m.starts_with(bom))
        .max_by_key(|(bom, _)| bom.len())
        .map(|(_, name)| *name)
}

/// The model in a `/api/v1/system` `variant` such as "Ultimaker S5" or "UltiMaker S7".
pub(crate) fn model_from_variant(variant: &str) -> String {
    let v = variant.trim();
    match v.get(..10) {
        Some(p) if p.eq_ignore_ascii_case("ultimaker ") => v.get(10..).unwrap_or(v).trim().to_owned(),
        _ => v.to_owned(),
    }
}

/// One `_ultimaker._tcp` service, read as Cura reads it: only `type=printer` entries count, and
/// `name`, `machine`, `firmware_version` and `cluster_size` fill the rest.
pub(crate) fn from_txt(host: &str, port: u16, instance: &str, txt: &[String]) -> Option<DiscoveredPrinter> {
    let get = |k: &str| {
        txt.iter().find_map(|e| {
            let (key, v) = e.split_once('=')?;
            key.eq_ignore_ascii_case(k).then(|| v.trim().to_owned())
        })
    };
    if get("type").as_deref() != Some("printer") {
        return None;
    }
    let cluster = get("cluster_size")
        .and_then(|c| c.parse::<u32>().ok())
        .is_some_and(|n| n > 1);
    let name = get("name")
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| instance.to_owned());
    Some(DiscoveredPrinter {
        plugin: "ultimaker".to_owned(),
        host: host.to_owned(),
        port: Some(port),
        // A cluster host says so, since jobs sent to it may go to another printer of the group.
        name: Some(if cluster {
            format!("{name} (group host)")
        } else {
            name
        }),
        model: get("machine")
            .as_deref()
            .and_then(model_from_bom)
            .map(str::to_owned),
        serial: None,
        firmware: get("firmware_version").filter(|f| !f.is_empty()),
        lan_only: None,
        ..DiscoveredPrinter::default()
    })
}

pub struct UltiMakerConnector {
    gate: Arc<dyn ApprovalGate>,
    /// Where the multicast DNS question goes: the mDNS group in the app, a local socket in tests.
    mdns_target: SocketAddr,
    /// The port `probe` asks: 80, another in tests.
    probe_port: u16,
}

impl UltiMakerConnector {
    pub fn new(gate: Arc<dyn ApprovalGate>) -> Self {
        Self {
            gate,
            mdns_target: (crate::mdns::MDNS_GROUP_V4, crate::mdns::MDNS_PORT).into(),
            probe_port: 80,
        }
    }

    /// Sends the multicast DNS question to `target` instead of the mDNS group.
    #[must_use]
    pub fn with_mdns_target(mut self, target: SocketAddr) -> Self {
        self.mdns_target = target;
        self
    }

    /// Probes `port` instead of 80.
    #[must_use]
    pub fn with_probe_port(mut self, port: u16) -> Self {
        self.probe_port = port;
        self
    }
}

#[async_trait]
impl PrinterConnector for UltiMakerConnector {
    fn manifest(&self) -> PluginManifest {
        manifest("ultimaker").unwrap_or_else(|| super::prusalink::unreachable_manifest("ultimaker"))
    }

    /// One multicast DNS question for `_ultimaker._tcp`, as Cura browses.
    async fn discover(&self, timeout: Duration) -> Vec<DiscoveredPrinter> {
        let mut out: Vec<DiscoveredPrinter> = Vec::new();
        for s in crate::mdns::browse(&[SERVICE], self.mdns_target, timeout).await {
            let Some(addr) = s
                .addresses
                .iter()
                .find(|a| a.is_ipv4())
                .or_else(|| s.addresses.first())
            else {
                continue;
            };
            if let Some(p) = from_txt(&addr.to_string(), s.port, &s.instance, &s.txt)
                && !out.iter().any(|o| o.host == p.host)
            {
                out.push(p);
            }
        }
        out
    }

    /// `GET /api/v1/system` on a typed address, which answers without a login: name, firmware,
    /// model (`variant`) and the printer's GUID.
    async fn probe(&self, host: &str, timeout: Duration) -> Option<DiscoveredPrinter> {
        let ip: std::net::IpAddr = host.parse().ok()?;
        let client = http::service_client().ok()?;
        let url = format!("http://{}/api/v1/system", SocketAddr::from((ip, self.probe_port)));
        let r = client.get(url).timeout(timeout).send().await.ok()?;
        if !r.status().is_success() {
            return None;
        }
        let v: Value = r.json().await.ok()?;
        let variant = str_at(&v, &["variant"])?;
        if !variant.to_ascii_lowercase().contains("ultimaker") {
            return None;
        }
        Some(DiscoveredPrinter {
            plugin: "ultimaker".to_owned(),
            host: host.to_owned(),
            port: Some(self.probe_port),
            name: str_at(&v, &["name"]).map(str::to_owned),
            model: Some(model_from_variant(variant)),
            serial: str_at(&v, &["guid"]).map(str::to_owned),
            firmware: str_at(&v, &["firmware"]).map(str::to_owned),
            lan_only: None,
            ..DiscoveredPrinter::default()
        })
    }

    async fn connect(&self, cfg: &PrinterConfig, secrets: &dyn Secrets) -> Result<Box<dyn PrinterSession>> {
        // A pairing is optional: the cluster API needs none. Stored as `id:key`.
        let digest = cfg
            .credential_ref
            .as_deref()
            .and_then(|r| secrets.get(r))
            .and_then(|s| {
                let (id, key) = s.split_once(':')?;
                Some(DigestAuth::new(id, key))
            });
        let inner = Arc::new(Inner {
            cfg: cfg.clone(),
            client: http::client(cfg)?,
            base: http::base_url(cfg, 80),
            gate: self.gate.clone(),
            digest,
            staged: Mutex::new(None),
            system: Mutex::new(Value::Null),
        });
        let system = http::json(&cfg.id, inner.send(inner.get("/api/v1/system")).await?).await?;
        *inner.system.lock().unwrap_or_else(PoisonError::into_inner) = system;
        // Cura needs firmware 4.0 or later, which has the cluster API.
        if inner.send(inner.get("/cluster-api/v1/printers")).await.is_err() {
            return Err(Error::not_supported(
                "ultimaker",
                "this firmware (it has no cluster API; update the printer to firmware 4.0 or later)",
            ));
        }
        if inner.digest.is_some() {
            // The only GET that checks a login.
            inner
                .send_signed(inner.client.get(format!("{}/api/v1/auth/verify", inner.base)))
                .await?;
        }
        Ok(Box::new(UltiMakerSession { inner }))
    }

    fn pairs(&self) -> bool {
        true
    }

    /// Pairing for the printer API: `POST /api/v1/auth/request`, then `GET /api/v1/auth/check/{id}`
    /// every second until someone allows it on the touchscreen. Returns `id:key` to keep in the
    /// keychain. Jobs and print cores need no pairing; only control without the cluster API does.
    async fn authorize(&self, cfg: &PrinterConfig, timeout: Duration) -> Result<Option<String>> {
        let client = http::client(cfg)?;
        let base = http::base_url(cfg, 80);
        let resp = http::send(
            &cfg.id,
            client
                .post(format!("{base}/api/v1/auth/request"))
                .form(&[("application", "SlicerX"), ("user", "SlicerX")]),
        )
        .await?;
        let v = http::json(&cfg.id, resp).await?;
        let (Some(id), Some(key)) = (str_at(&v, &["id"]), str_at(&v, &["key"])) else {
            return Err(Error::protocol(&cfg.id, "pairing reply without an id and key"));
        };
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let check = http::send(
                &cfg.id,
                client.get(format!("{base}/api/v1/auth/check/{}", seg(id))),
            )
            .await?;
            match str_at(&http::json(&cfg.id, check).await?, &["message"]) {
                Some("authorized") => return Ok(Some(format!("{id}:{key}"))),
                Some("unauthorized") => {
                    return Err(Error::Login {
                        printer: cfg.id.clone(),
                        need: LoginNeed::Declined,
                    });
                }
                _ => {}
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(Error::Auth {
                    printer: cfg.id.clone(),
                });
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}

struct Inner {
    cfg: PrinterConfig,
    client: Client,
    base: String,
    gate: Arc<dyn ApprovalGate>,
    digest: Option<DigestAuth>,
    /// The file `upload` holds until `start` sends it: an UltiMaker prints a job as soon as it
    /// arrives, so nothing goes to the printer before the start is approved.
    staged: Mutex<Option<JobFile>>,
    /// The `/api/v1/system` reply read on connect.
    system: Mutex<Value>,
}

impl Inner {
    fn id(&self) -> &str {
        &self.cfg.id
    }

    fn get(&self, path: &str) -> RequestBuilder {
        self.client.get(format!("{}{path}", self.base))
    }

    async fn send(&self, rb: RequestBuilder) -> Result<Response> {
        http::send(self.id(), rb).await
    }

    /// Sends a printer API request with the Digest login (the id and key from pairing), answering
    /// the 401 challenge once.
    async fn send_signed(&self, rb: RequestBuilder) -> Result<Response> {
        let Some(digest) = &self.digest else {
            return Err(Error::Auth {
                printer: self.id().to_owned(),
            });
        };
        let req = rb
            .build()
            .map_err(|e| Error::Config(e.without_url().to_string()))?;
        let mut retry = req.try_clone();
        let sign = |r: &mut reqwest::Request| {
            let uri = r.url().path().to_owned();
            if let Some(h) = digest
                .header(r.method().as_str(), &uri)
                .and_then(|h| h.parse().ok())
            {
                r.headers_mut().insert(reqwest::header::AUTHORIZATION, h);
            }
        };
        let mut req = req;
        sign(&mut req);
        let resp = self
            .client
            .execute(req)
            .await
            .map_err(|e| Error::unreachable(self.id(), e.without_url()))?;
        if resp.status().as_u16() != 401 {
            return http::check(self.id(), resp);
        }
        let challenge = resp
            .headers()
            .get_all(reqwest::header::WWW_AUTHENTICATE)
            .iter()
            .find_map(|v| v.to_str().ok().and_then(Challenge::parse));
        let (Some(ch), Some(again)) = (challenge, retry.as_mut()) else {
            return http::check(self.id(), resp);
        };
        digest.set_challenge(ch);
        sign(again);
        let resp = self
            .client
            .execute(retry.take().ok_or_else(|| Error::Config("request body".into()))?)
            .await
            .map_err(|e| Error::unreachable(self.id(), e.without_url()))?;
        http::check(self.id(), resp)
    }

    async fn printer(&self) -> Result<Value> {
        http::json(self.id(), self.send(self.get("/api/v1/printer")).await?).await
    }

    /// The running job, or `None` (404 when nothing runs).
    async fn print_job(&self) -> Result<Option<Value>> {
        let r = self
            .get("/api/v1/print_job")
            .send()
            .await
            .map_err(|e| Error::unreachable(self.id(), e.without_url()))?;
        if r.status().as_u16() == 404 {
            return Ok(None);
        }
        Ok(Some(http::json(self.id(), http::check(self.id(), r)?).await?))
    }

    /// The cluster's record of this printer: print cores and materials per extruder.
    async fn cluster_printer(&self) -> Option<Value> {
        let v = http::get_json(self.id(), self.get("/cluster-api/v1/printers")).await?;
        let list = v.as_array()?;
        let guid = str_at(
            &self.system.lock().unwrap_or_else(PoisonError::into_inner),
            &["guid"],
        )
        .map(str::to_owned);
        list.iter()
            .find(|p| guid.is_some() && str_at(p, &["uuid"]) == guid.as_deref())
            .or_else(|| {
                list.iter()
                    .find(|p| str_at(p, &["ip_address"]) == Some(self.cfg.host.as_str()))
            })
            .or_else(|| list.first())
            .cloned()
    }

    async fn fetch_status(&self) -> Result<PrinterStatus> {
        let printer = self.printer().await?;
        let job = self.print_job().await?;
        let cluster = self.cluster_printer().await;
        Ok(parse_status(self.id(), &printer, job.as_ref(), cluster.as_ref()))
    }

    /// The uuid of the running job, for the cluster API's actions.
    async fn job_uuid(&self) -> Result<String> {
        self.print_job()
            .await?
            .as_ref()
            .and_then(|j| str_at(j, &["uuid"]))
            .map(str::to_owned)
            .ok_or_else(|| Error::BadState {
                printer: self.id().to_owned(),
                state: "idle".to_owned(),
                action: "control a job".to_owned(),
            })
    }

    /// Pauses, resumes (`print`) or aborts the running job through the cluster API, as Cura does.
    async fn job_action(&self, action: &str) -> Result<()> {
        let uuid = self.job_uuid().await?;
        let rb = self
            .client
            .put(format!(
                "{}/cluster-api/v1/print_jobs/{}/action",
                self.base,
                seg(&uuid)
            ))
            .json(&json!({ "action": action }));
        match self.send(rb).await {
            Ok(_) => Ok(()),
            // Firmware that wants a login for it takes the printer API instead.
            Err(Error::Auth { .. }) if self.digest.is_some() => {
                // The body is the bare JSON string: "print", "pause" or "abort".
                let rb = self
                    .client
                    .put(format!("{}/api/v1/print_job/state", self.base))
                    .json(&action);
                self.send_signed(rb).await.map(|_| ())
            }
            Err(e) => Err(e),
        }
    }

    fn camera_url(&self, action: &str) -> String {
        format!(
            "http://{}:{}/?action={action}",
            self.cfg.host,
            self.cfg.camera_port.unwrap_or(CAMERA_PORT)
        )
    }
}

/// Maps `/api/v1/printer`, `/api/v1/print_job` and the cluster record to the normalized status.
///
/// Printer status: `booting`, `idle`, `printing`, `error`, `maintenance`. Job state: `none`,
/// `printing`, `pausing`, `paused`, `resuming`, `pre_print`, `post_print`, `wait_cleanup` and
/// `wait_user_action`, with `result` `Finished`, `Aborted` or `Failed` once it ended.
pub(crate) fn parse_status(
    id: &str,
    printer: &Value,
    job: Option<&Value>,
    cluster: Option<&Value>,
) -> PrinterStatus {
    let job_state = job.and_then(|j| str_at(j, &["state"])).unwrap_or("none");
    let result = job.and_then(|j| str_at(j, &["result"])).unwrap_or("");
    let mut message = None;
    let mut say = |m: &str| message = Some(m.to_owned());
    let state = match (str_at(printer, &["status"]).unwrap_or("idle"), job_state) {
        ("error", _) => {
            say("The printer reports an error; see its screen");
            PrinterState::Error
        }
        ("booting", _) => {
            say("Starting up");
            PrinterState::Idle
        }
        ("maintenance", _) => {
            say("In maintenance");
            PrinterState::Idle
        }
        (_, "printing" | "resuming" | "post_print") => PrinterState::Printing,
        (_, "pausing" | "paused") => PrinterState::Paused,
        (_, "pre_print") => PrinterState::Preparing,
        (_, "wait_user_action") => {
            say("Waiting for you on the printer's screen");
            PrinterState::Paused
        }
        (_, "wait_cleanup") => match result {
            "Aborted" => {
                say("The print was stopped. Clear the build plate and confirm on the printer");
                PrinterState::Idle
            }
            "Failed" => {
                say("The print failed. Clear the build plate and confirm on the printer");
                PrinterState::Error
            }
            _ => {
                say("Clear the build plate and confirm on the printer");
                PrinterState::Finished
            }
        },
        _ => PrinterState::Idle,
    };
    let active = matches!(
        state,
        PrinterState::Printing | PrinterState::Paused | PrinterState::Preparing | PrinterState::Finished
    );
    let temp = |v: &Value| {
        Some(Temp {
            current: f64_at(v, &["current"])?,
            target: f64_at(v, &["target"]).unwrap_or(0.0),
        })
    };
    let nozzles = printer
        .get("heads")
        .and_then(Value::as_array)
        .and_then(|h| h.first())
        .and_then(|h| h.get("extruders"))
        .and_then(Value::as_array)
        .map(|ex| {
            ex.iter()
                .filter_map(|e| e.get("hotend").and_then(|h| h.get("temperature")).and_then(temp))
                .collect()
        })
        .unwrap_or_default();
    let elapsed = job.and_then(|j| f64_at(j, &["time_elapsed"]));
    let total = job.and_then(|j| f64_at(j, &["time_total"]));
    PrinterStatus {
        printer_id: id.to_owned(),
        state,
        job_name: job
            .and_then(|j| str_at(j, &["name"]))
            .filter(|n| active && !n.is_empty())
            .map(str::to_owned),
        progress: job
            .and_then(|j| f64_at(j, &["progress"]))
            .filter(|_| active)
            .map(|p| p.clamp(0.0, 1.0)),
        layer: None,
        layer_count: None,
        time_left_s: match (total, elapsed) {
            (Some(t), Some(e)) if active && t >= e => Some(secs(t - e)),
            _ => None,
        },
        nozzles,
        bed: printer
            .get("bed")
            .and_then(|b| b.get("temperature"))
            .and_then(temp),
        chamber: None,
        slots: cluster.map(slots_from_cluster).unwrap_or_default(),
        camera_available: printer.get("camera").is_some_and(Value::is_object),
        message,
        updated_at: now_iso(),
        live: None,
    }
}

/// One slot per extruder, from the cluster record's `configuration` (material type and color).
fn slots_from_cluster(p: &Value) -> Vec<FilamentSlot> {
    p.get("configuration")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|c| {
            let n = c.get("extruder_index").and_then(Value::as_u64).unwrap_or(0);
            let m = c.get("material");
            let field = |k: &str| {
                m.and_then(|m| str_at(m, &[k]))
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && *s != "empty")
                    .map(str::to_owned)
            };
            FilamentSlot {
                id: (n + 1).to_string(),
                material: field("material"),
                color: field("color").filter(|c| c.starts_with('#')),
                ..FilamentSlot::default()
            }
        })
        .collect()
}

/// The nozzle size in a print core id such as `AA 0.4` or `BB 0.8`.
fn core_diameter(core: &str) -> Option<f64> {
    core.split_whitespace().last()?.parse().ok()
}

/// The model, firmware and GUID from `/api/v1/system`, and the print cores from the cluster record.
pub(crate) fn ultimaker_hardware(system: &Value, cluster: Option<&Value>) -> PrinterHardware {
    let text = |k: &str| {
        str_at(system, &[k])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let cores: Vec<&Value> = cluster
        .and_then(|c| c.get("configuration"))
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    let extruders = if cores.is_empty() {
        vec![
            ExtruderInfo {
                tool: 0,
                position: Some("left".into()),
                ..ExtruderInfo::default()
            },
            ExtruderInfo {
                tool: 1,
                position: Some("right".into()),
                ..ExtruderInfo::default()
            },
        ]
    } else {
        cores
            .iter()
            .map(|c| {
                let tool = c.get("extruder_index").and_then(Value::as_u64).unwrap_or(0);
                ExtruderInfo {
                    tool: u8::try_from(tool).unwrap_or(0),
                    position: Some(if tool == 0 { "left" } else { "right" }.to_owned()),
                    nozzle_diameter_mm: str_at(c, &["print_core_id"]).and_then(core_diameter),
                    ..ExtruderInfo::default()
                }
            })
            .collect()
    };
    let slots = cluster.map(slots_from_cluster).unwrap_or_default();
    PrinterHardware {
        model: text("variant").map(|v| model_from_variant(&v)),
        firmware: text("firmware"),
        serial: text("guid"),
        extruders,
        filament_units: if slots.is_empty() {
            Vec::new()
        } else {
            vec![FilamentUnit {
                id: "external".to_owned(),
                kind: "external".to_owned(),
                tool: None,
                slots,
            }]
        },
        ..PrinterHardware::default()
    }
}

pub struct UltiMakerSession {
    inner: Arc<Inner>,
}

impl UltiMakerSession {
    async fn require(&self, action: &str, ok: &[PrinterState]) -> Result<()> {
        let s = self.inner.fetch_status().await?.state;
        if ok.contains(&s) {
            Ok(())
        } else {
            Err(Error::BadState {
                printer: self.inner.id().to_owned(),
                state: s.to_string(),
                action: action.to_owned(),
            })
        }
    }
}

#[async_trait]
impl PrinterSession for UltiMakerSession {
    fn capabilities(&self) -> Capabilities {
        vec![
            Capability::Status,
            Capability::Events,
            Capability::Upload,
            Capability::Start,
            Capability::Pause,
            Capability::Resume,
            Capability::Cancel,
            Capability::Camera,
            Capability::FilamentSlots,
        ]
    }

    async fn status(&self) -> Result<PrinterStatus> {
        self.inner.fetch_status().await
    }

    fn events(&self) -> BoxStream<'static, PrinterEvent> {
        let inner = self.inner.clone();
        let interval = Duration::from_millis(inner.cfg.poll_ms.unwrap_or(2000).max(50));
        poll_events(
            inner.cfg.id.clone(),
            interval,
            Arc::new(move || {
                let inner = inner.clone();
                async move { inner.fetch_status().await }
            }),
        )
    }

    async fn hardware(&self) -> Result<Option<PrinterHardware>> {
        let system = self
            .inner
            .system
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let cluster = self.inner.cluster_printer().await;
        Ok(Some(ultimaker_hardware(&system, cluster.as_ref())))
    }

    /// Holds the file in SlicerX. An UltiMaker starts a job as soon as it arrives, so the file goes to
    /// the printer only with the approved start. One file is held at a time.
    async fn upload(&self, file: JobFile, token: &ApprovalToken) -> Result<RemoteFile> {
        self.inner.gate.check(
            token,
            Action::Upload,
            self.inner.id(),
            &params::upload(self.inner.id(), &file.name, &file.sha256),
        )?;
        if file.name.contains(['/', '\\']) || file.name.is_empty() {
            return Err(Error::protocol(self.inner.id(), "unsafe file name"));
        }
        let remote = RemoteFile {
            printer_id: self.inner.id().to_owned(),
            path: file.name.clone(),
            name: file.name.clone(),
            sha256: Some(file.sha256.clone()),
        };
        *self.inner.staged.lock().unwrap_or_else(PoisonError::into_inner) = Some(file);
        Ok(remote)
    }

    /// Sends the held file to the cluster queue (`POST /cluster-api/v1/print_jobs/`, multipart
    /// `owner` and `file`, as Cura sends it), which prints it on this printer.
    async fn start(&self, file: &RemoteFile, opts: StartOptions, token: &ApprovalToken) -> Result<()> {
        opts.refuse_slot_map("ultimaker")?;
        self.inner.gate.check(
            token,
            Action::Start,
            self.inner.id(),
            &params::start(self.inner.id(), file, &opts),
        )?;
        let staged = self
            .inner
            .staged
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let Some(job) = staged.filter(|j| j.name == file.path && Some(&j.sha256) == file.sha256.as_ref())
        else {
            return Err(Error::NotFound {
                printer: self.inner.id().to_owned(),
                what: "the file to start (send it again; SlicerX holds the file sent last until the start)"
                    .to_owned(),
            });
        };
        self.require("start a job", &[PrinterState::Idle]).await?;
        let mut form = Form::new()
            .text("owner", "SlicerX")
            .part("file", Part::bytes(job.data).file_name(job.name));
        // A group host routes the job to the printer it is meant for.
        if let Some(unique) = self
            .inner
            .cluster_printer()
            .await
            .as_ref()
            .and_then(|p| str_at(p, &["unique_name"]))
        {
            form = form.text("require_printer_name", unique.to_owned());
        }
        let rb = self
            .inner
            .client
            .post(format!("{}/cluster-api/v1/print_jobs/", self.inner.base))
            .timeout(Duration::from_secs(120))
            .multipart(form);
        self.inner.send(rb).await?;
        *self.inner.staged.lock().unwrap_or_else(PoisonError::into_inner) = None;
        Ok(())
    }

    async fn pause(&self, token: &ApprovalToken) -> Result<()> {
        self.inner.gate.check(
            token,
            Action::Pause,
            self.inner.id(),
            &params::printer(self.inner.id()),
        )?;
        self.require("pause", &[PrinterState::Printing]).await?;
        self.inner.job_action("pause").await
    }

    async fn resume(&self, token: &ApprovalToken) -> Result<()> {
        self.inner.gate.check(
            token,
            Action::Resume,
            self.inner.id(),
            &params::printer(self.inner.id()),
        )?;
        self.require("resume", &[PrinterState::Paused]).await?;
        // The cluster API's old action endpoint resumes with `print` (Cura's ClusterApiClient).
        self.inner.job_action("print").await
    }

    async fn cancel(&self, token: &ApprovalToken) -> Result<()> {
        self.inner.gate.check(
            token,
            Action::Cancel,
            self.inner.id(),
            &params::printer(self.inner.id()),
        )?;
        self.require(
            "cancel",
            &[
                PrinterState::Printing,
                PrinterState::Paused,
                PrinterState::Preparing,
            ],
        )
        .await?;
        self.inner.job_action("abort").await
    }

    /// The camera's mjpg-streamer on port 8080.
    async fn snapshot(&self) -> Result<Option<Image>> {
        Ok(http::mjpeg_frame(&self.inner.client, &self.inner.camera_url("snapshot")).await)
    }

    async fn stream(&self) -> Result<Option<FrameStream>> {
        Ok(camera::mjpeg_stream(&self.inner.client, &self.inner.camera_url("stream")).await)
    }

    /// The local API has no G-code console.
    async fn send_gcode(&self, _line: &str, _token: &ApprovalToken) -> Result<()> {
        Err(Error::not_supported("ultimaker", "the G-code console"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn txt_records_are_read_as_cura_reads_them() {
        let txt = |v: &[&str]| v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        let p = from_txt(
            "192.0.2.7",
            80,
            "ultimakersystem-ccbdd30044ec",
            &txt(&[
                "type=printer",
                "name=Bay 7",
                "machine=9051.0",
                "firmware_version=7.4.1",
                "cluster_size=1",
            ]),
        )
        .unwrap();
        assert_eq!(p.name.as_deref(), Some("Bay 7"));
        assert_eq!(p.model.as_deref(), Some("S5"));
        assert_eq!(p.firmware.as_deref(), Some("7.4.1"));
        let host = from_txt(
            "192.0.2.8",
            80,
            "x",
            &txt(&["type=printer", "machine=5078167.0", "cluster_size=3"]),
        )
        .unwrap();
        assert_eq!(host.model.as_deref(), Some("S7"));
        assert!(host.name.unwrap().contains("group host"));
        assert!(from_txt("192.0.2.9", 80, "x", &txt(&["type=material_station"])).is_none());
        assert_eq!(model_from_bom("213482.1"), Some("S3"));
        assert_eq!(model_from_bom("1234"), None);
        assert_eq!(model_from_variant("Ultimaker S5"), "S5");
        assert_eq!(model_from_variant("UltiMaker Factor 4"), "Factor 4");
    }

    #[test]
    fn job_states_map() {
        let printer = json!({ "status": "printing", "camera": { "feed": "http://x:8080/?action=stream" },
            "bed": { "temperature": { "current": 60.0, "target": 60.0 } },
            "heads": [{ "extruders": [
                { "hotend": { "id": "AA 0.4", "temperature": { "current": 210.0, "target": 210.0 } } },
                { "hotend": { "id": "BB 0.4", "temperature": { "current": 30.0, "target": 0.0 } } }
            ] }] });
        let job = |state: &str, result: &str| json!({ "state": state, "result": result, "name": "cube", "progress": 0.5, "time_elapsed": 600, "time_total": 1800, "uuid": "u" });
        let s = parse_status("p", &printer, Some(&job("printing", "")), None);
        assert_eq!(s.state, PrinterState::Printing);
        assert_eq!(
            (s.nozzles.len(), s.time_left_s, s.camera_available),
            (2, Some(1200), true)
        );
        assert_eq!(
            parse_status("p", &printer, Some(&job("paused", "")), None).state,
            PrinterState::Paused
        );
        assert_eq!(
            parse_status("p", &printer, Some(&job("pre_print", "")), None).state,
            PrinterState::Preparing
        );
        let idle = json!({ "status": "idle" });
        let done = parse_status("p", &idle, Some(&job("wait_cleanup", "Finished")), None);
        assert_eq!(done.state, PrinterState::Finished);
        assert!(done.message.unwrap().contains("Clear the build plate"));
        assert_eq!(
            parse_status("p", &idle, Some(&job("wait_cleanup", "Aborted")), None).state,
            PrinterState::Idle
        );
        assert_eq!(
            parse_status("p", &idle, Some(&job("wait_cleanup", "Failed")), None).state,
            PrinterState::Error
        );
        assert_eq!(
            parse_status("p", &json!({ "status": "error" }), None, None).state,
            PrinterState::Error
        );
        assert_eq!(parse_status("p", &idle, None, None).state, PrinterState::Idle);
    }

    #[test]
    fn hardware_from_the_system_and_the_cluster() {
        let system =
            json!({ "variant": "Ultimaker S5", "firmware": "7.4.1", "guid": "e6a1", "name": "Bay 7" });
        let cluster = json!({ "configuration": [
            { "extruder_index": 0, "print_core_id": "AA 0.4", "material": { "material": "PLA", "color": "#ffc924", "brand": "Ultimaker", "guid": "g" } },
            { "extruder_index": 1, "print_core_id": "BB 0.8", "material": { "material": "PVA", "color": "Natural" } }
        ] });
        let h = ultimaker_hardware(&system, Some(&cluster));
        assert_eq!(
            (h.model.as_deref(), h.serial.as_deref()),
            (Some("S5"), Some("e6a1"))
        );
        assert_eq!(h.extruders[1].nozzle_diameter_mm, Some(0.8));
        let slots = &h.filament_units[0].slots;
        assert_eq!(
            (slots[0].material.as_deref(), slots[0].color.as_deref()),
            (Some("PLA"), Some("#ffc924"))
        );
        assert_eq!(slots[1].color, None);
    }
}
