//! The host launch guard a wake must pass: `sampleHost` + `canLaunch` (`host-guard.ts`, `routing.ts`,
//! `cgroup-memory.ts`).
//!
//! The session count cannot ask herdr or hc (their CLIs are gone from the wake path). It counts every live
//! headless broker plus every terminal pane record whose writer process is alive; an unknown or failed headless
//! observation makes it unknown (-1), as before.

use std::fs;
use std::path::Path;

use serde::Deserialize;

use super::headless;
use super::registry::int_field;
use super::util::{RECORD_LIMIT, read_limited, signalable};

/// `GuardThresholds` from the loaded config.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Guard {
    pub(super) mem_free_min_pct: f64,
    pub(super) disk_free_min_gb: f64,
    pub(super) panes_max: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Headroom {
    free_pct: f64,
}

#[derive(Debug, Default)]
struct Cgroup {
    hard: Option<Headroom>,
    high: Option<Headroom>,
}

#[derive(Debug)]
struct Sample {
    mem_free_pct: f64,
    cgroup: Option<Cgroup>,
    disk_free_gb: f64,
    panes: i64,
}

fn read(path: &str) -> Option<String> {
    read_limited(Path::new(path), RECORD_LIMIT)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

fn meminfo_kb(info: &str, key: &str) -> Option<f64> {
    info.lines().find_map(|line| {
        let rest = line.strip_prefix(key)?.strip_prefix(':')?;
        let digits = rest
            .trim_start()
            .split(|c: char| !c.is_ascii_digit())
            .next()?;
        if digits.is_empty() {
            None
        } else {
            digits.parse().ok()
        }
    })
}

/// `Math.round(available / total * 100)`, or 100 when unreadable.
fn mem_free_pct() -> f64 {
    let info = read("/proc/meminfo").unwrap_or_default();
    match (
        meminfo_kb(&info, "MemTotal"),
        meminfo_kb(&info, "MemAvailable"),
    ) {
        (Some(total), Some(available)) if total > 0.0 => (available / total * 100.0).round(),
        _ => 100.0,
    }
}

/// `df -k <path>` available space in GB (the TypeScript guard's 1024³ unit).
fn disk_free_gb(path: &Path) -> f64 {
    rustix::fs::statvfs(path).map_or(0.0, |stat| {
        let mib = stat.f_bavail.saturating_mul(stat.f_frsize) >> 20;
        f64::from(u32::try_from(mib).unwrap_or(u32::MAX)) / 1024.0
    })
}

fn decode_mount(value: &str) -> String {
    value
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

fn bytes(value: Option<&str>) -> Option<f64> {
    let text = value?.trim();
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let number: f64 = text.parse().ok()?;
    (number <= 9_007_199_254_740_991.0).then_some(number)
}

fn stat_value(stat: &str, key: &str) -> Option<f64> {
    stat.lines().find_map(|line| {
        let value = line.strip_prefix(key)?.strip_prefix(' ')?;
        bytes(Some(value))
    })
}

fn posix_join(mount: &str, relative: &str) -> String {
    let mut out: Vec<&str> = mount.split('/').filter(|p| !p.is_empty()).collect();
    for part in relative.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            part => out.push(part),
        }
    }
    format!("/{}", out.join("/"))
}

fn parent_dir(dir: &str) -> String {
    match dir.rfind('/') {
        Some(0) | None => "/".to_owned(),
        Some(at) => dir[..at].to_owned(),
    }
}

/// `sampleCgroupMemory()` over the visible hierarchy.
fn cgroup() -> Cgroup {
    let mut result = Cgroup::default();
    let (Some(membership), Some(mountinfo)) =
        (read("/proc/self/cgroup"), read("/proc/self/mountinfo"))
    else {
        return result;
    };
    let memberships: Vec<(&str, &str, &str)> = membership
        .lines()
        .filter_map(|line| {
            let (id, rest) = line.split_once(':')?;
            let (controllers, path) = rest.split_once(':')?;
            Some((id, controllers, path))
        })
        .collect();
    let legacy = memberships
        .iter()
        .find(|g| g.1.split(',').any(|c| c == "memory"));
    let Some(group) = legacy.or_else(|| memberships.iter().find(|g| g.0 == "0" && g.1.is_empty()))
    else {
        return result;
    };
    let v1 = legacy.is_some();
    let path = group.2;
    if !path.starts_with('/') || path.split('/').any(|p| p == "..") {
        return result;
    }
    let mut candidates: Vec<(String, String)> = mountinfo
        .lines()
        .filter_map(|line| {
            let (left, right) = line.split_once(" - ")?;
            let fields: Vec<&str> = left.split(' ').collect();
            let fs: Vec<&str> = right.split(' ').collect();
            let (root, mount) = (fields.get(3)?, fields.get(4)?);
            let kind_ok = if v1 {
                fs.first() == Some(&"cgroup")
                    && fs
                        .get(2)
                        .is_some_and(|o| o.split(',').any(|c| c == "memory"))
            } else {
                fs.first() == Some(&"cgroup2")
            };
            let (root, mount) = (decode_mount(root), decode_mount(mount));
            (kind_ok
                && root.starts_with('/')
                && mount.starts_with('/')
                && (root == "/" || path == root || path.starts_with(&format!("{root}/"))))
            .then_some((root, mount))
        })
        .collect();
    candidates.sort_by_key(|(root, _)| root.len());
    let Some((root, mount)) = candidates.into_iter().next() else {
        return result;
    };
    let relative = path.strip_prefix(root.as_str()).unwrap_or(path);
    let leaf = posix_join(&mount, relative);
    let mut dir = leaf.clone();
    loop {
        let at_root = dir == mount;
        let hierarchy = if v1 {
            read(&format!("{dir}/memory.use_hierarchy")).map(|h| h.trim().to_owned())
        } else {
            Some("1".to_owned())
        };
        if !v1 || dir == leaf || hierarchy.as_deref() == Some("1") {
            sample_level(&mut result, &dir, v1, at_root, hierarchy.as_deref());
        }
        if at_root || dir == "/" {
            break;
        }
        dir = parent_dir(&dir);
    }
    result
}

/// Clean, unmapped file cache that can be reclaimed: shared, mapped and in-flight pages are not budget.
fn reclaimable(dir: &str, v1: bool, hierarchy: Option<&str>, used: f64) -> f64 {
    let stat = read(&format!("{dir}/memory.stat")).unwrap_or_default();
    let keys: Vec<String> = if v1 {
        ["cache", "shmem", "mapped_file", "dirty", "writeback"]
            .iter()
            .map(|k| {
                if hierarchy == Some("1") {
                    format!("total_{k}")
                } else {
                    (*k).to_owned()
                }
            })
            .collect()
    } else {
        [
            "file",
            "shmem",
            "file_mapped",
            "file_dirty",
            "file_writeback",
        ]
        .iter()
        .map(|k| (*k).to_owned())
        .collect()
    };
    let counts: Option<Vec<f64>> = keys.iter().map(|k| stat_value(&stat, k)).collect();
    match counts {
        Some(counts) if matches!(hierarchy, Some("0" | "1")) => {
            let net = counts.iter().skip(1).fold(counts[0], |n, v| n - v);
            used.min(net.max(0.0))
        }
        _ => 0.0,
    }
}

/// One cgroup level's hard (`memory.max`/`limit_in_bytes`) and high headroom, keeping the tightest seen.
fn sample_level(result: &mut Cgroup, dir: &str, v1: bool, at_root: bool, hierarchy: Option<&str>) {
    let limits: &[&str] = if v1 {
        &["memory.limit_in_bytes"]
    } else {
        &["memory.max", "memory.high"]
    };
    let current = read(&format!(
        "{dir}/{}",
        if v1 {
            "memory.usage_in_bytes"
        } else {
            "memory.current"
        }
    ));
    let mut reclaim: Option<f64> = None;
    for (index, file) in limits.iter().enumerate() {
        let text = read(&format!("{dir}/{file}")).map(|t| t.trim().to_owned());
        if (at_root && !v1 && text.is_none()) || (!v1 && text.as_deref() == Some("max")) {
            continue;
        }
        if v1
            && text
                .as_deref()
                .is_some_and(|t| t.parse::<u128>().is_ok_and(|n| n >= 1 << 60))
        {
            continue;
        }
        let (Some(limit), Some(used)) = (bytes(text.as_deref()), bytes(current.as_deref())) else {
            continue;
        };
        let reclaim = *reclaim.get_or_insert_with(|| reclaimable(dir, v1, hierarchy, used));
        let free_pct = if limit == 0.0 {
            0.0
        } else {
            ((limit - used + reclaim) / limit * 100.0).max(0.0)
        };
        let slot = if index == 0 {
            &mut result.hard
        } else {
            &mut result.high
        };
        if slot.is_none_or(|seen| free_pct < seen.free_pct) {
            *slot = Some(Headroom { free_pct });
        }
    }
}

/// Live sessions this host runs, or -1 when a headless broker cannot be observed.
async fn sessions(state: &Path) -> i64 {
    let Ok(hosts) = headless::hosts(state).await else {
        return -1;
    };
    if hosts
        .iter()
        .any(|(_, seen)| seen.status == "unknown" || seen.status == "error")
    {
        return -1;
    }
    let mut count = i64::try_from(hosts.len()).unwrap_or(i64::MAX);
    if let Ok(entries) = fs::read_dir(state.join("sessions")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(std::ffi::OsStr::to_str) != Some("json") {
                continue;
            }
            let Ok(raw) = read_limited(&path, RECORD_LIMIT) else {
                continue;
            };
            let Ok(pane) = serde_json::from_slice::<super::json::Json>(&raw) else {
                continue;
            };
            if int_field(&pane, "pid").is_some_and(signalable) {
                count += 1;
            }
        }
    }
    count
}

async fn sample(state: &Path, cwd: &Path) -> Sample {
    Sample {
        mem_free_pct: mem_free_pct(),
        cgroup: cfg!(target_os = "linux").then(cgroup),
        disk_free_gb: disk_free_gb(cwd),
        panes: sessions(state).await,
    }
}

/// `canLaunch(sample, thresholds).reasons`.
fn reasons(sample: &Sample, guard: &Guard) -> Vec<String> {
    let mut reasons = Vec::new();
    if sample.mem_free_pct < guard.mem_free_min_pct {
        reasons.push("memory".to_owned());
    }
    if let Some(cgroup) = &sample.cgroup {
        for budget in [cgroup.hard, cgroup.high].into_iter().flatten() {
            if budget.free_pct < guard.mem_free_min_pct {
                reasons.push("cgroup".to_owned());
            }
        }
    }
    if sample.disk_free_gb < guard.disk_free_min_gb {
        reasons.push("disk".to_owned());
    }
    let panes = i32::try_from(sample.panes).map_or(f64::MAX, f64::from);
    if guard.panes_max > 0.0 && sample.panes < 0 {
        reasons.push("session count unknown".to_owned());
    }
    if guard.panes_max > 0.0 && panes >= guard.panes_max {
        reasons.push("panes".to_owned());
    }
    reasons
}

/// `canLaunch(await sampleHost(run, cwd, rts), guard).ok`.
pub(super) async fn can_launch(state: &Path, cwd: &Path, guard: &Guard) -> bool {
    reasons(&sample(state, cwd).await, guard).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard() -> Guard {
        Guard {
            mem_free_min_pct: 20.0,
            disk_free_min_gb: 50.0,
            panes_max: 20.0,
        }
    }

    #[test]
    fn launch_reasons_match_can_launch() {
        let ok = Sample {
            mem_free_pct: 50.0,
            cgroup: Some(Cgroup {
                hard: Some(Headroom { free_pct: 30.0 }),
                high: None,
            }),
            disk_free_gb: 100.0,
            panes: 3,
        };
        assert_eq!(reasons(&ok, &guard()), [] as [&str; 0]);
        let full = Sample { panes: 20, ..ok };
        assert_eq!(reasons(&full, &guard()), ["panes"]);
        let unknown = Sample { panes: -1, ..full };
        assert_eq!(reasons(&unknown, &guard()), ["session count unknown"]);
        let squeezed = Sample {
            cgroup: Some(Cgroup {
                hard: None,
                high: Some(Headroom { free_pct: 5.0 }),
            }),
            panes: 0,
            ..unknown
        };
        assert_eq!(reasons(&squeezed, &guard()), ["cgroup"]);
    }

    #[test]
    fn meminfo_and_paths() {
        let info = "MemTotal:       1000 kB\nMemAvailable:    250 kB\n";
        assert_eq!(meminfo_kb(info, "MemTotal"), Some(1000.0));
        assert_eq!(meminfo_kb(info, "MemFree"), None);
        assert_eq!(
            posix_join("/sys/fs/cgroup", "/user.slice/a"),
            "/sys/fs/cgroup/user.slice/a"
        );
        assert_eq!(parent_dir("/sys/fs"), "/sys");
        assert_eq!(decode_mount("/a\\040b"), "/a b");
    }
}
