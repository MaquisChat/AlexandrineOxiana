//! The allow-listed environment the shell gives the library service (R153, R155 rule 4): never the
//! shell's own. Only the names below pass from the shell's environment; the shell then sets the
//! service's own configuration. The service passes a subset on to the media worker
//! (`workerEnv` in packages/library/src/worker-client.ts).

use std::ffi::{OsStr, OsString};
use std::path::Path;

/// Names passed from the shell's environment to the service, each with the reason.
pub const PASSED_NAMES: &[(&str, &str)] = &[
    ("PATH", "finding the system Perl that runs ExifTool, and (passed on) the worker's tools; the tools folder's bin is put first"),
    ("HOME", "the default settings folder, and the OS keychain"),
    ("USER", "user lookups by the keychain and the worker's tools"),
    ("LOGNAME", "user lookups by the keychain and the worker's tools"),
    ("TMPDIR", "temporary files"),
    ("TEMP", "temporary files (Windows)"),
    ("TMP", "temporary files (Windows)"),
    ("LANG", "the user's locale"),
    ("LANGUAGE", "the user's locale"),
    ("TZ", "the user's time zone (audit times, R93)"),
    ("DBUS_SESSION_BUS_ADDRESS", "the OS keychain on Linux (Secret Service), and browser cookie decryption by the worker's downloader"),
    ("HTTP_PROXY", "the user's proxy for lookups and downloads"),
    ("HTTPS_PROXY", "the user's proxy for lookups and downloads"),
    ("NO_PROXY", "the user's proxy for lookups and downloads"),
    ("ALL_PROXY", "the user's proxy for lookups and downloads"),
    ("http_proxy", "the user's proxy for lookups and downloads"),
    ("https_proxy", "the user's proxy for lookups and downloads"),
    ("no_proxy", "the user's proxy for lookups and downloads"),
    ("all_proxy", "the user's proxy for lookups and downloads"),
    ("SSL_CERT_FILE", "a custom certificate authority (institutional proxies)"),
    ("SSL_CERT_DIR", "a custom certificate authority (institutional proxies)"),
    ("TESSDATA_PREFIX", "OCR language data, passed on to the worker"),
];

/// Prefixes passed from the shell's environment: `LC_*` (locale) and `XDG_*` (the platform's
/// settings, cache and runtime folders on Linux; the keychain's runtime socket).
pub const PASSED_PREFIXES: &[&str] = &["LC_", "XDG_"];

/// Never passed, whatever the lists above say: each can make Node load code from outside the
/// service folder (R153), or is a secret that travels only on standard input (R98, R155).
pub const NEVER_PASSED: &[&str] = &[
    "NODE_OPTIONS",
    "NODE_PATH",
    "NAPI_RS_NATIVE_LIBRARY_PATH",
    "AO_SERVICE_TOKEN",
    "AO_WORKER_TOKEN",
    "AO_PASSPHRASE",
];

fn passes(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else { return false };
    if NEVER_PASSED.iter().any(|n| n.eq_ignore_ascii_case(name)) {
        return false;
    }
    PASSED_NAMES.iter().any(|(n, _)| *n == name) || PASSED_PREFIXES.iter().any(|p| name.starts_with(p))
}

/// What the shell configures for the service.
pub struct ServiceConfig<'a> {
    /// The packaged media worker (AO_WORKER_BIN); without one the service runs with AO_NO_WORKER=1.
    pub worker_bin: Option<&'a Path>,
    /// The tools folder (AO_TOOLS_DIR): yt-dlp, and ffmpeg/tesseract under `bin/`.
    pub tools_dir: &'a Path,
    /// The speech models folder (AO_MODELS_DIR).
    pub models_dir: &'a Path,
}

/// The service's whole environment: the allow-listed part of `parent`, then the shell's settings.
pub fn service_env<I>(parent: I, cfg: &ServiceConfig<'_>) -> Vec<(OsString, OsString)>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    let mut out: Vec<(OsString, OsString)> = parent.into_iter().filter(|(k, _)| passes(k)).collect();
    // The tools folder's bin comes first on PATH, so the worker finds ffmpeg and tesseract there.
    let tools_bin = cfg.tools_dir.join("bin");
    let path = match out.iter().position(|(k, _)| k == "PATH") {
        Some(i) => out.remove(i).1,
        None => OsString::new(),
    };
    let mut dirs = vec![tools_bin];
    // An empty entry would mean "the current folder": dropped.
    dirs.extend(std::env::split_paths(&path).filter(|p| !p.as_os_str().is_empty()));
    let joined = std::env::join_paths(dirs).unwrap_or(path);
    out.push(("PATH".into(), joined));
    out.push(("AO_SERVICE_PORT".into(), "0".into()));
    out.push(("AO_TOOLS_DIR".into(), cfg.tools_dir.as_os_str().to_owned()));
    out.push(("AO_MODELS_DIR".into(), cfg.models_dir.as_os_str().to_owned()));
    match cfg.worker_bin {
        Some(w) => out.push(("AO_WORKER_BIN".into(), w.as_os_str().to_owned())),
        None => out.push(("AO_NO_WORKER".into(), "1".into())),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn parent() -> Vec<(OsString, OsString)> {
        [
            ("PATH", "/usr/bin:/bin"),
            ("HOME", "/home/r"),
            ("LANG", "de_DE.UTF-8"),
            ("LC_TIME", "en_GB.UTF-8"),
            ("XDG_CONFIG_HOME", "/home/r/.config"),
            ("TZ", "Europe/Berlin"),
            ("HTTPS_PROXY", "http://proxy:3128"),
            ("NODE_OPTIONS", "--require /tmp/evil.js"),
            ("NODE_PATH", "/tmp/mods"),
            ("NAPI_RS_NATIVE_LIBRARY_PATH", "/tmp/x.node"),
            ("AO_SERVICE_TOKEN", "leaked-token-0123456789abcdef0123456789"),
            ("ao_worker_token", "leaked"),
            ("AO_PASSPHRASE", "secret"),
            ("AO_LIBRARY", "/somewhere"),
            ("AO_WORKER_BIN", "/tmp/not-ours"),
            ("NODE_ENV", "test"),
            ("SOME_APP_SECRET", "s3cret"),
            ("LD_PRELOAD", "/tmp/evil.so"),
            ("DYLD_INSERT_LIBRARIES", "/tmp/evil.dylib"),
            ("PYTHONPATH", "/tmp/py"),
        ]
        .into_iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect()
    }

    fn get<'a>(env: &'a [(OsString, OsString)], k: &str) -> Option<&'a OsString> {
        env.iter().find(|(n, _)| n == k).map(|(_, v)| v)
    }

    #[test]
    fn passes_only_the_allow_list_and_sets_the_services_configuration() {
        let tools = PathBuf::from("/data/tools");
        let models = PathBuf::from("/data/models");
        let worker = PathBuf::from("/app/ao-worker/ao-worker");
        let env = service_env(parent(), &ServiceConfig { worker_bin: Some(&worker), tools_dir: &tools, models_dir: &models });
        let mut names: Vec<String> = env.iter().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(
            names,
            ["AO_MODELS_DIR", "AO_SERVICE_PORT", "AO_TOOLS_DIR", "AO_WORKER_BIN", "HOME", "HTTPS_PROXY", "LANG", "LC_TIME", "PATH", "TZ", "XDG_CONFIG_HOME"]
        );
        assert_eq!(get(&env, "AO_SERVICE_PORT").unwrap(), "0");
        assert_eq!(get(&env, "AO_WORKER_BIN").unwrap(), "/app/ao-worker/ao-worker");
        assert_eq!(get(&env, "AO_TOOLS_DIR").unwrap(), "/data/tools");
        assert_eq!(get(&env, "AO_MODELS_DIR").unwrap(), "/data/models");
        let path: Vec<PathBuf> = std::env::split_paths(get(&env, "PATH").unwrap()).collect();
        assert_eq!(path, [PathBuf::from("/data/tools/bin"), PathBuf::from("/usr/bin"), PathBuf::from("/bin")]);
    }

    #[test]
    fn no_worker_means_ao_no_worker() {
        let tools = PathBuf::from("/t");
        let env = service_env(parent(), &ServiceConfig { worker_bin: None, tools_dir: &tools, models_dir: &tools });
        assert_eq!(get(&env, "AO_NO_WORKER").unwrap(), "1");
        assert!(get(&env, "AO_WORKER_BIN").is_none());
    }

    #[test]
    fn never_passes_a_token_or_a_code_loading_variable_even_by_prefix() {
        for (n, _) in PASSED_NAMES {
            assert!(!NEVER_PASSED.contains(n));
        }
        let parent = vec![(OsString::from("XDG_NODE_OPTIONS"), OsString::from("x")), (OsString::from("NODE_OPTIONS"), OsString::from("y"))];
        let t = PathBuf::from("/t");
        let env = service_env(parent, &ServiceConfig { worker_bin: None, tools_dir: &t, models_dir: &t });
        assert!(get(&env, "NODE_OPTIONS").is_none());
        // An XDG_ name is passed by prefix; it is not one of the redirecting names.
        assert!(get(&env, "XDG_NODE_OPTIONS").is_some());
    }

    #[test]
    fn a_missing_path_still_gets_the_tools_folder() {
        let t = PathBuf::from("/t");
        let env = service_env(Vec::new(), &ServiceConfig { worker_bin: None, tools_dir: &t, models_dir: &t });
        let path: Vec<PathBuf> = std::env::split_paths(get(&env, "PATH").unwrap()).collect();
        assert_eq!(path, [PathBuf::from("/t/bin")]);
        // Empty entries (the current folder) are dropped.
        let env = service_env(vec![(OsString::from("PATH"), OsString::from("/usr/bin::/bin:"))], &ServiceConfig { worker_bin: None, tools_dir: &t, models_dir: &t });
        let path: Vec<PathBuf> = std::env::split_paths(get(&env, "PATH").unwrap()).collect();
        assert_eq!(path, [PathBuf::from("/t/bin"), PathBuf::from("/usr/bin"), PathBuf::from("/bin")]);
    }
}
