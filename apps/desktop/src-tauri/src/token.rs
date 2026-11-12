//! The service's access token (R155 rule 5): made from the operating system's secure random source,
//! new on every launch, 64 characters, and never written to disk, a log or a command line. It
//! travels only on the service's standard input and into the page's initialization script.

/// 32 random bytes from the operating system, as 64 lowercase hexadecimal characters (the service
/// accepts 32 to 512 characters from `A–Z a–z 0–9 . _ ~ + / = -`).
pub fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "the system's secure random source could not be read".to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_64_hex_characters_and_new_each_time() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, b);
    }
}
