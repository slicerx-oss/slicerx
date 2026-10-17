// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
use std::collections::BTreeSet;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::MoonrakerSession;
use crate::error::{Error, Result};
use crate::toolhead_map::{PreparedToolheadMap, prepared_map};
use crate::{JobFile, PrinterSession, RemoteFile};

impl MoonrakerSession {
    async fn validate_choices(&self, map: &PreparedToolheadMap) -> Result<()> {
        let plan = self.plan_toolheads(&map.needs, &map.selected).await?;
        if map.selected.len() != map.needs.len() || !plan.ready || !map.matches_loaded(&plan.toolheads) {
            return Err(Error::protocol(
                self.inner.id(),
                "A selected toolhead's material or color changed. Review the mapping again",
            ));
        }
        Ok(())
    }

    pub(super) async fn validate_toolhead_upload(&self, file: &JobFile) -> Result<()> {
        let map = prepared_map(&file.data).map_err(|e| Error::protocol(self.inner.id(), &e))?;
        if let Some(map) = map {
            if crate::types::hex(&Sha256::digest(&file.data)) != file.sha256.to_ascii_lowercase() {
                return Err(Error::protocol(
                    self.inner.id(),
                    "The prepared file changed after review",
                ));
            }
            self.validate_choices(&map).await?;
        }
        Ok(())
    }

    async fn remote_toolhead_map(&self, file: &RemoteFile) -> Result<Option<PreparedToolheadMap>> {
        let fail = |message: &str| Error::protocol(self.inner.id(), message);
        if file
            .path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
            || file.path.contains('\\')
        {
            return Err(fail("The remote G-code path is invalid"));
        }
        let mut url = reqwest::Url::parse(&format!("{}/server/files/gcodes/", self.inner.base))
            .map_err(|_| fail("The printer file address is invalid"))?;
        url.path_segments_mut()
            .map_err(|()| fail("The printer file address is invalid"))?
            .pop_if_empty()
            .extend(file.path.split('/'));
        let mut response = self.inner.call(|i| i.sign(i.client.get(url.clone()))).await?;
        let mut header = Vec::new();
        let mut proof = None;
        let mut parsed = false;
        let mut digest = Sha256::new();
        let mut size = 0usize;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| fail("Could not read the remote G-code file"))?
        {
            size = size.saturating_add(chunk.len());
            if size > 512 * 1024 * 1024 {
                return Err(fail("The G-code file is too large to verify"));
            }
            digest.update(&chunk);
            if !parsed {
                let end = chunk.iter().position(|b| *b == b'\n');
                header.extend_from_slice(
                    chunk
                        .get(..end.unwrap_or(chunk.len()))
                        .ok_or_else(|| fail("Invalid G-code response chunk"))?,
                );
                if header.len() > 16_384 {
                    return Err(fail("The G-code first line is too large to verify"));
                }
                if end.is_some() {
                    proof = prepared_map(&header).map_err(|e| fail(&e))?;
                    if proof.is_none() && file.sha256.is_none() {
                        return Ok(None);
                    }
                    parsed = true;
                }
            }
        }
        if !parsed {
            proof = prepared_map(&header).map_err(|e| fail(&e))?;
        }
        if proof.is_some() && file.sha256.is_none() {
            return Err(fail("Review the prepared file before starting it"));
        }
        if let Some(expected) = file.sha256.as_deref()
            && crate::types::hex(&digest.finalize()) != expected.to_ascii_lowercase()
        {
            return Err(fail("The remote prepared file differs from the approved file"));
        }
        Ok(proof)
    }

    async fn idle_toolhead_status(&self) -> Result<Value> {
        let reply = self
            .inner
            .call_json(|i| i.get("/printer/objects/query?print_stats&print_task_config"))
            .await?;
        let state = reply
            .pointer("/result/status/print_stats/state")
            .and_then(Value::as_str);
        if !matches!(state, Some("standby" | "complete" | "cancelled")) {
            return Err(Error::protocol(
                self.inner.id(),
                "The U1 must be idle before applying toolhead choices",
            ));
        }
        reply
            .pointer("/result/status/print_task_config")
            .cloned()
            .ok_or_else(|| Error::protocol(self.inner.id(), "The U1 did not report its toolhead map"))
    }

    pub(super) async fn establish_toolhead_map(&self, file: &RemoteFile) -> Result<()> {
        if !self
            .inner
            .objects()
            .iter()
            .any(|name| name == "print_task_config")
        {
            return Ok(());
        }
        let Some(map) = self.remote_toolhead_map(file).await? else {
            return Ok(());
        };
        self.validate_choices(&map).await?;
        self.idle_toolhead_status().await?;
        let used: BTreeSet<_> = map.selected.values().copied().collect();
        let mut commands = (0..4)
            .map(|tool| format!("SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER={tool} MAP_EXTRUDER={tool}"))
            .collect::<Vec<_>>();
        commands.push(format!(
            "SET_PRINT_USED_EXTRUDERS EXTRUDERS={}",
            used.iter().map(u8::to_string).collect::<Vec<_>>().join(",")
        ));
        self.inner
            .call(|i| {
                i.post("/printer/gcode/script")
                    .query(&[("script", commands.join("\n"))])
            })
            .await?;
        let status = self.idle_toolhead_status().await?;
        let identity = (0..4).all(|tool| {
            status
                .get("extruder_map_table")
                .and_then(|v| v.get(tool))
                .and_then(Value::as_u64)
                == Some(tool as u64)
        });
        let usage = (0u8..4).all(|tool| {
            status
                .get("extruders_used")
                .and_then(|v| v.get(usize::from(tool)))
                .and_then(Value::as_bool)
                == Some(used.contains(&tool))
        });
        if !identity || !usage {
            return Err(Error::protocol(
                self.inner.id(),
                "The U1 did not confirm the selected toolheads. The print was not started",
            ));
        }
        self.validate_choices(&map).await?;
        Ok(())
    }
}
