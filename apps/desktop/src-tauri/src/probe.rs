//! The launch check's in-page probe (`probe.js`): compiled into debug builds only, and added to the
//! window only with NODE_ENV=test and AO_SHELL_PROBE_DIR set (R47). The folder holds the files the
//! probe attaches (`probe.png`, and when present `probe.wav` and `probe.mp4`) and receives the
//! probe's library (`library/`).

use std::path::Path;

const PROBE_JS: &str = include_str!("probe.js");

/// The probe script for the files in `dir`.
pub fn script(dir: &Path) -> String {
    let file = |name: &str| {
        let p = dir.join(name);
        p.is_file().then(|| p.to_string_lossy().into_owned())
    };
    let cfg = serde_json::json!({
        "libraryDir": dir.join("library").to_string_lossy(),
        "png": file("probe.png"),
        "wav": file("probe.wav"),
        "mp4": file("probe.mp4"),
    });
    PROBE_JS.replace("__PROBE_CONFIG__", &cfg.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeds_its_configuration_as_json() {
        let dir = std::env::temp_dir().join(format!("ao-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("probe.png"), b"x").unwrap();
        let s = script(&dir);
        assert!(!s.contains("__PROBE_CONFIG__"));
        assert!(s.contains(&format!("\"png\":{}", serde_json::to_string(&dir.join("probe.png").to_string_lossy()).unwrap())));
        assert!(s.contains("\"wav\":null"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
