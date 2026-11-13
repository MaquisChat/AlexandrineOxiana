//! Folder grants (Task W6, R207). A watched folder is approved only through the shell's own native
//! folder chooser: `pick_watch_folder` (lib.rs) opens it, and the chosen path goes to the service as
//! ONE line on the standard-input pipe the shell already holds, never to the page:
//!
//!   {"type":"folder-grant","id":"<32 lowercase hex>","path":"<absolute path>"}\n
//!
//! The service keeps that path for one use, for at most 10 minutes (folder-grants.ts); the page gets
//! only the grant's id and the folder's last name, and exchanges the id at a service route (W7).
//! Every value in the line is encoded by serde_json (the JSON library this crate already uses), so
//! a folder name with quotes, back-slashes, line ends or other control characters cannot break out
//! of its string or start a second line. The service accepts exactly the text this module writes:
//! keys in this order, no spaces, serde_json's escapes (which are JavaScript's `JSON.stringify`'s).

use std::path::Path;

/// The longest grant line, in bytes, its line end included (the service reads at most 8 KiB without it).
pub const GRANT_LINE_MAX_BYTES: usize = 8192;
/// The longest path a grant may carry, in bytes of UTF-8.
pub const GRANT_PATH_MAX_BYTES: usize = 4096;
/// The longest chooser title the page may set, in characters.
pub const TITLE_MAX_CHARS: usize = 200;
const DEFAULT_TITLE: &str = "Choose a folder to watch";

/// What the page receives for a chosen folder: the grant's id and the folder's last name. Never the path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickedFolder {
    pub grant_id: String,
    pub name: String,
}

impl PickedFolder {
    /// The answer as the page reads it: `{"grantId": "...", "name": "..."}`.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "grantId": self.grant_id, "name": self.name })
    }
}

/// A new grant id: 16 bytes from the operating system's secure random source, as 32 lowercase hex.
pub fn new_grant_id() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The grant line for `path`, ended by `\n`; None when the id is not 32 lowercase hex, the path is
/// relative, not valid UTF-8, holds a NUL or is longer than GRANT_PATH_MAX_BYTES, or the line would
/// be longer than GRANT_LINE_MAX_BYTES.
pub fn grant_line(id: &str, path: &Path) -> Option<String> {
    if !valid_id(id) || !path.is_absolute() {
        return None;
    }
    let p = path.to_str()?;
    if p.is_empty() || p.contains('\0') || p.len() > GRANT_PATH_MAX_BYTES {
        return None;
    }
    let line = format!(
        "{{\"type\":\"folder-grant\",\"id\":{},\"path\":{}}}\n",
        serde_json::to_string(id).ok()?,
        serde_json::to_string(p).ok()?
    );
    (line.len() <= GRANT_LINE_MAX_BYTES).then_some(line)
}

/// The folder's last name component, as the page may show it (through `UserText`); the root has none,
/// and is named as it is.
pub fn folder_name(path: &Path) -> Option<String> {
    match path.file_name() {
        Some(n) => n.to_str().map(str::to_owned),
        None => path.to_str().map(str::to_owned),
    }
}

/// The chooser's title from the page: plain text, control characters removed, at most
/// TITLE_MAX_CHARS characters; a default when nothing is left.
pub fn chooser_title(title: &str) -> String {
    let t: String = title.chars().filter(|c| !c.is_control()).take(TITLE_MAX_CHARS).collect();
    let t = t.trim();
    if t.is_empty() { DEFAULT_TITLE.to_string() } else { t.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const ID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn grant_line_escapes_quotes_and_newlines() {
        let path = PathBuf::from("/Users/r/a \"b\"\n\\c\u{1} é\u{2028} ﬁ/}{");
        let line = grant_line(ID, &path).unwrap();
        // The exact text folder-grants.test.ts › parseGrantLine reads back.
        assert_eq!(line, "{\"type\":\"folder-grant\",\"id\":\"0123456789abcdef0123456789abcdef\",\"path\":\"/Users/r/a \\\"b\\\"\\n\\\\c\\u0001 é\u{2028} ﬁ/}{\"}\n");
        // One line only, and the JSON reads back to the same path.
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.ends_with('\n'));
        let v: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(v["path"].as_str().unwrap(), path.to_str().unwrap());
        assert_eq!(v["type"], "folder-grant");
        assert_eq!(v["id"], ID);
        assert_eq!(v.as_object().unwrap().len(), 3);
        // A name that tries to close the string and add a key stays inside the path.
        let hostile = PathBuf::from("/x\",\"path\":\"/etc\"}\n{\"type\":\"folder-grant");
        let line = grant_line(ID, &hostile).unwrap();
        assert_eq!(line.matches('\n').count(), 1);
        let v: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(v["path"].as_str().unwrap(), hostile.to_str().unwrap());
    }

    #[test]
    fn grant_line_refuses_relative_paths() {
        for p in ["relative/folder", "./x", "../x", "~/Documents", ""] {
            assert_eq!(grant_line(ID, Path::new(p)), None, "{p}");
        }
    }

    #[test]
    fn grant_line_refuses_a_bad_id_and_a_nul() {
        for id in ["", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef", "0123456789abcdef0123456789abcdefa", "g123456789abcdef0123456789abcdef"] {
            assert_eq!(grant_line(id, Path::new("/x")), None, "{id}");
        }
        assert_eq!(grant_line(ID, Path::new("/a\0b")), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_path_that_is_not_utf8_yields_none() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let p = Path::new(OsStr::from_bytes(b"/Users/r/caf\xe9"));
        assert_eq!(grant_line(ID, p), None);
        assert_eq!(folder_name(p), None);
    }

    #[test]
    fn a_line_over_8_kib_yields_none() {
        // 4,096 bytes of path is the limit; one more is refused.
        let ok = format!("/{}", "a".repeat(GRANT_PATH_MAX_BYTES - 1));
        assert!(grant_line(ID, Path::new(&ok)).is_some());
        let long = format!("/{}", "a".repeat(GRANT_PATH_MAX_BYTES));
        assert_eq!(grant_line(ID, Path::new(&long)), None);
        // A path within 4,096 bytes whose escaped form makes the line longer than 8 KiB.
        let escaped = format!("/{}", "\u{1}".repeat(1400));
        assert!(escaped.len() <= GRANT_PATH_MAX_BYTES);
        assert_eq!(grant_line(ID, Path::new(&escaped)), None);
        // Every line made is at most 8 KiB with its line end.
        let quotes = format!("/{}", "\"".repeat(4000));
        let line = grant_line(ID, Path::new(&quotes)).unwrap();
        assert!(line.len() <= GRANT_LINE_MAX_BYTES);
    }

    #[test]
    fn grant_ids_are_32_lowercase_hex_and_new_each_time() {
        let a = new_grant_id().unwrap();
        let b = new_grant_id().unwrap();
        assert!(valid_id(&a) && valid_id(&b));
        assert_ne!(a, b);
    }

    #[test]
    fn the_page_gets_the_id_and_the_last_name_only() {
        let p = Path::new("/Users/r/Library/CloudStorage/GoogleDrive-r@x.org/My Drive/Fieldwork <b>");
        let picked = PickedFolder { grant_id: ID.into(), name: folder_name(p).unwrap() };
        let v = picked.to_json();
        assert_eq!(v, serde_json::json!({ "grantId": ID, "name": "Fieldwork <b>" }));
        assert!(!v.to_string().contains("CloudStorage"));
        assert_eq!(folder_name(Path::new("/")), Some("/".into()));
    }

    #[test]
    fn the_title_is_plain_bounded_text() {
        assert_eq!(chooser_title("Choose a folder to watch"), "Choose a folder to watch");
        assert_eq!(chooser_title("a\nb\u{0}c\u{7}"), "abc");
        assert_eq!(chooser_title(&"t".repeat(5000)).chars().count(), TITLE_MAX_CHARS);
        assert_eq!(chooser_title("  \n "), "Choose a folder to watch");
    }
}
