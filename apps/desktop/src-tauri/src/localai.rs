// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//! Set up local AI: what the machine can give a local model (the GPU and its memory, system
//! memory, cores), and the model lists of a running Ollama or LM Studio. Reads stay on this
//! machine; the only requests are GETs to those two servers on 127.0.0.1. Pulls and the tool
//! check go through llm.rs, whose transport also only reaches 127.0.0.1 for a local model.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    pub name: String,
    /// What a model may use: dedicated memory, or for unified memory the share the system lets the GPU wire.
    pub vram_mb: Option<u64>,
    pub unified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub gpu: Option<Gpu>,
    pub ram_mb: Option<u64>,
    pub cores: Option<u32>,
}

/// The two listings the helper reads. Anything else is refused.
const ALLOWED_GETS: [&str; 2] = [
    "http://127.0.0.1:11434/api/tags",
    "http://127.0.0.1:1234/v1/models",
];

/// The GPU, memory and cores, read once per call on a blocking thread.
#[tauri::command]
pub async fn local_ai_hardware() -> Hardware {
    tauri::async_runtime::spawn_blocking(read_hardware)
        .await
        .unwrap_or(Hardware {
            gpu: None,
            ram_mb: None,
            cores: None,
        })
}

/// A running server's model list, or null when nothing answers there.
#[tauri::command]
pub async fn local_ai_get(url: String) -> Option<String> {
    if !ALLOWED_GETS.contains(&url.as_str()) {
        return None;
    }
    sx_llm::local_get(&url).await.ok()
}

fn read_hardware() -> Hardware {
    let cores = std::thread::available_parallelism()
        .ok()
        .and_then(|n| u32::try_from(n.get()).ok());
    let (gpu, ram_mb) = platform::read();
    Hardware { gpu, ram_mb, cores }
}

/// Apple Silicon: the GPU may wire about two thirds of memory up to 36 GB and three quarters
/// above, as Metal's recommended working set reports, unless `iogpu.wired_limit_mb` was raised.
pub fn apple_gpu_budget_mb(ram_mb: u64, wired_limit_mb: u64) -> u64 {
    if wired_limit_mb > 0 {
        return wired_limit_mb.min(ram_mb);
    }
    if ram_mb <= 36 * 1024 {
        ram_mb * 2 / 3
    } else {
        ram_mb * 3 / 4
    }
}

/// `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`: the card with the most memory.
#[cfg(any(target_os = "linux", test))]
pub fn parse_nvidia_smi(out: &str) -> Option<Gpu> {
    out.lines()
        .filter_map(|line| {
            let (name, mb) = line.rsplit_once(',')?;
            Some(Gpu {
                name: name.trim().to_owned(),
                vram_mb: Some(mb.trim().parse().ok()?),
                unified: false,
            })
        })
        .max_by_key(|g| g.vram_mb)
}

/// MemTotal from /proc/meminfo, in MB.
#[cfg(any(target_os = "linux", test))]
pub fn parse_meminfo(text: &str) -> Option<u64> {
    let line = text.lines().find(|l| l.starts_with("MemTotal:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb / 1024)
}

/// The first display controller `lspci` names, by its marketing name in brackets when it has one.
#[cfg(any(target_os = "linux", test))]
pub fn parse_lspci(out: &str) -> Option<String> {
    let line = out
        .lines()
        .find(|l| l.contains("VGA compatible controller") || l.contains("3D controller"))?;
    let (_, name) = line.split_once("controller: ")?;
    let name = name.trim();
    let bracketed = name
        .strip_suffix(']')
        .and_then(|n| n.rsplit_once('['))
        .map(|(_, inner)| inner);
    Some(bracketed.unwrap_or(name).to_owned())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{Gpu, apple_gpu_budget_mb, run};

    fn sysctl(name: &str) -> Option<String> {
        run("/usr/sbin/sysctl", &["-n", name])
    }

    pub fn read() -> (Option<Gpu>, Option<u64>) {
        let ram_mb = sysctl("hw.memsize")
            .and_then(|s| s.parse::<u64>().ok())
            .map(|b| b / (1024 * 1024));
        let apple = sysctl("hw.optional.arm64").as_deref() == Some("1");
        let gpu = match (apple, ram_mb) {
            (true, Some(ram)) => {
                let wired = sysctl("iogpu.wired_limit_mb")
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                Some(Gpu {
                    name: sysctl("machdep.cpu.brand_string").unwrap_or_else(|| "Apple Silicon".to_owned()),
                    vram_mb: Some(apple_gpu_budget_mb(ram, wired)),
                    unified: true,
                })
            }
            // Intel Macs: the models that fit their GPUs are too small to be useful.
            _ => None,
        };
        (gpu, ram_mb)
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{Gpu, parse_lspci, parse_meminfo, parse_nvidia_smi, run};

    /// The largest `mem_info_vram_total` an amdgpu card reports, in MB.
    fn amd_vram_mb() -> Option<u64> {
        std::fs::read_dir("/sys/class/drm")
            .ok()?
            .filter_map(|e| {
                let text = std::fs::read_to_string(e.ok()?.path().join("device/mem_info_vram_total")).ok()?;
                text.trim().parse::<u64>().ok().map(|b| b / (1024 * 1024))
            })
            .max()
    }

    pub fn read() -> (Option<Gpu>, Option<u64>) {
        let ram_mb = std::fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|t| parse_meminfo(&t));
        let gpu = run(
            "nvidia-smi",
            &["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
        )
        .and_then(|o| parse_nvidia_smi(&o))
        .or_else(|| {
            let name = run("lspci", &[]).and_then(|o| parse_lspci(&o));
            let vram_mb = amd_vram_mb();
            (name.is_some() || vram_mb.is_some()).then(|| Gpu {
                name: name.unwrap_or_else(|| "Graphics card".to_owned()),
                vram_mb,
                unified: false,
            })
        });
        (gpu, ram_mb)
    }
}

#[cfg(windows)]
mod platform {
    use super::Gpu;
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIFactory1};
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    /// The hardware adapter with the most dedicated memory, from DXGI (WMI caps it at 4 GB).
    fn dxgi() -> Option<Gpu> {
        // SAFETY: plain DXGI calls on interfaces this function owns.
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ok()?;
        let mut best: Option<Gpu> = None;
        for i in 0.. {
            let Ok(adapter) = (unsafe { factory.EnumAdapters1(i) }) else {
                break;
            };
            let Ok(desc) = (unsafe { adapter.GetDesc1() }) else {
                continue;
            };
            if desc.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
                continue;
            }
            let len = desc
                .Description
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(desc.Description.len());
            let vram_mb = (desc.DedicatedVideoMemory as u64) / (1024 * 1024);
            if best.as_ref().is_none_or(|b| b.vram_mb.unwrap_or(0) < vram_mb) {
                best = Some(Gpu {
                    name: String::from_utf16_lossy(desc.Description.get(..len).unwrap_or_default()),
                    vram_mb: Some(vram_mb),
                    unified: false,
                });
            }
        }
        best
    }

    fn ram_mb() -> Option<u64> {
        let mut status = MEMORYSTATUSEX {
            dwLength: size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        // SAFETY: `status` is a valid MEMORYSTATUSEX with its length set.
        unsafe { GlobalMemoryStatusEx(&mut status) }.ok()?;
        Some(status.ullTotalPhys / (1024 * 1024))
    }

    pub fn read() -> (Option<Gpu>, Option<u64>) {
        // Integrated adapters report a small carve-out, not memory a model can use.
        (dxgi().filter(|g| g.vram_mb.unwrap_or(0) >= 1024), ram_mb())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod platform {
    pub fn read() -> (Option<super::Gpu>, Option<u64>) {
        (None, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apple_budget_follows_the_working_set_and_a_raised_limit() {
        assert_eq!(apple_gpu_budget_mb(16 * 1024, 0), 10922);
        assert_eq!(apple_gpu_budget_mb(36 * 1024, 0), 24576);
        assert_eq!(apple_gpu_budget_mb(64 * 1024, 0), 49152);
        assert_eq!(apple_gpu_budget_mb(64 * 1024, 56 * 1024), 56 * 1024);
        assert_eq!(apple_gpu_budget_mb(16 * 1024, 64 * 1024), 16 * 1024);
    }

    #[test]
    fn nvidia_smi_picks_the_largest_card() {
        let out = "NVIDIA GeForce RTX 3060, 12288\nNVIDIA GeForce RTX 5080, 16303\n";
        assert_eq!(
            parse_nvidia_smi(out),
            Some(Gpu {
                name: "NVIDIA GeForce RTX 5080".into(),
                vram_mb: Some(16303),
                unified: false
            })
        );
        assert_eq!(parse_nvidia_smi("No devices were found"), None);
    }

    #[test]
    fn meminfo_and_lspci() {
        assert_eq!(
            parse_meminfo("MemTotal:       32768000 kB\nMemFree: 1 kB\n"),
            Some(32000)
        );
        assert_eq!(parse_meminfo("nothing"), None);
        let lspci = "00:00.0 Host bridge: Intel Corporation Device\n03:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31 [Radeon RX 7900 XTX]\n";
        assert_eq!(parse_lspci(lspci).as_deref(), Some("Radeon RX 7900 XTX"));
    }

    #[tokio::test]
    async fn only_the_two_listings_are_fetched() {
        for url in [
            "http://127.0.0.1:11434/api/pull",
            "http://127.0.0.1:8080/api/tags",
            "https://ollama.com/download",
            "http://localhost:11434/api/tags",
        ] {
            assert_eq!(local_ai_get(url.into()).await, None, "{url}");
        }
    }

    #[test]
    fn reads_this_machine() {
        let hw = read_hardware();
        assert!(hw.cores.unwrap_or(0) >= 1);
        #[cfg(any(target_os = "macos", target_os = "linux", windows))]
        assert!(hw.ram_mb.unwrap_or(0) > 512, "{hw:?}");
    }
}
