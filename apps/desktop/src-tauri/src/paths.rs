//! Where the helpers are. In a packaged app they are in the app's resources:
//!
//! ```text
//! <resources>/node/node            the Node.js 22 program the service folder was built for (node.exe on Windows)
//! <resources>/library-service/     the built service folder (apps/library-service/dist/library-service, ADR 0013)
//! <resources>/ao-worker/ao-worker  the packaged media worker (Task 37d; optional: without it the
//!                                  service runs with AO_NO_WORKER=1)
//! ```
//!
//! In a development (debug) build each can be given instead by a variable of the shell's own
//! environment: AO_DESKTOP_NODE, AO_DESKTOP_SERVICE_DIR, AO_DESKTOP_WORKER_BIN. A release build
//! ignores them: a variable that changes which program runs with the user's keys is exactly what
//! R153 keeps out of a shipped app.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperPaths {
    pub node: PathBuf,
    pub service_dir: PathBuf,
    pub worker_bin: Option<PathBuf>,
}

/// Development overrides (honoured only in debug builds; see the module comment).
#[derive(Debug, Default, Clone)]
pub struct Overrides {
    pub node: Option<PathBuf>,
    pub service_dir: Option<PathBuf>,
    pub worker_bin: Option<PathBuf>,
}

impl Overrides {
    pub fn from_env() -> Self {
        if !cfg!(debug_assertions) {
            return Self::default();
        }
        let get = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
        Self { node: get("AO_DESKTOP_NODE"), service_dir: get("AO_DESKTOP_SERVICE_DIR"), worker_bin: get("AO_DESKTOP_WORKER_BIN") }
    }
}

const NODE_EXE: &str = if cfg!(windows) { "node.exe" } else { "node" };
const WORKER_EXE: &str = if cfg!(windows) { "ao-worker.exe" } else { "ao-worker" };

/// Finds the helpers. The error is a plain sentence for the user, without a path (R96).
pub fn resolve(resources: Option<&Path>, ov: &Overrides) -> Result<HelperPaths, String> {
    let from_res = |rel: &[&str]| resources.map(|r| rel.iter().fold(r.to_path_buf(), |p, s| p.join(s)));
    let node = ov.node.clone().or_else(|| from_res(&["node", NODE_EXE]));
    let service_dir = ov.service_dir.clone().or_else(|| from_res(&["library-service"]));
    let worker_bin = ov.worker_bin.clone().or_else(|| from_res(&["ao-worker", WORKER_EXE]).filter(|p| p.is_file()));
    let node = node.filter(|p| p.is_file()).ok_or("The app's copy of Node.js, which runs the library service, is missing. Reinstall the app.")?;
    let service_dir = service_dir
        .filter(|d| d.join("service.mjs").is_file())
        .ok_or("The library service is missing from the app. Reinstall the app.")?;
    if let Some(w) = &worker_bin {
        if !w.is_file() {
            return Err("The media helper is missing from the app. Reinstall the app.".into());
        }
    }
    Ok(HelperPaths { node, service_dir, worker_bin })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ao-desktop-paths-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn touch(p: &Path) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, b"").unwrap();
    }

    #[test]
    fn finds_the_packaged_layout_in_the_resources() {
        let r = tmp("packaged");
        touch(&r.join("node").join(NODE_EXE));
        touch(&r.join("library-service").join("service.mjs"));
        touch(&r.join("ao-worker").join(WORKER_EXE));
        let p = resolve(Some(&r), &Overrides::default()).unwrap();
        assert_eq!(p.node, r.join("node").join(NODE_EXE));
        assert_eq!(p.service_dir, r.join("library-service"));
        assert_eq!(p.worker_bin, Some(r.join("ao-worker").join(WORKER_EXE)));
        fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn the_worker_is_optional_but_node_and_the_service_are_not() {
        let r = tmp("partial");
        touch(&r.join("node").join(NODE_EXE));
        touch(&r.join("library-service").join("service.mjs"));
        assert_eq!(resolve(Some(&r), &Overrides::default()).unwrap().worker_bin, None);
        fs::remove_file(r.join("library-service").join("service.mjs")).unwrap();
        let e = resolve(Some(&r), &Overrides::default()).unwrap_err();
        assert!(e.contains("library service is missing"), "{e}");
        assert!(!e.contains(r.to_str().unwrap()));
        fs::remove_file(r.join("node").join(NODE_EXE)).unwrap();
        assert!(resolve(Some(&r), &Overrides::default()).unwrap_err().contains("Node.js"));
        assert!(resolve(None, &Overrides::default()).is_err());
        fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn overrides_win_over_the_resources() {
        let r = tmp("override");
        let node = r.join("bin").join("node22");
        let svc = r.join("svc");
        let worker = r.join("w").join("run-worker");
        touch(&node);
        touch(&svc.join("service.mjs"));
        touch(&worker);
        let ov = Overrides { node: Some(node.clone()), service_dir: Some(svc.clone()), worker_bin: Some(worker.clone()) };
        let p = resolve(None, &ov).unwrap();
        assert_eq!(p, HelperPaths { node, service_dir: svc, worker_bin: Some(worker) });
        let missing = Overrides { worker_bin: Some(r.join("nope")), ..ov };
        assert!(resolve(None, &missing).unwrap_err().contains("media helper"));
        fs::remove_dir_all(&r).unwrap();
    }
}
