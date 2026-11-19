//! What both ends of a file transfer agree on.

/// The largest file either way: what the engine copies for an attachment (`MAX_COPY_BYTES`, file-attachments.ts) and
/// reads back for a download (`MAX_READ_BYTES`, rpc-builtins.ts). A file goes in pieces, so the 64 MiB limit of a
/// protocol line does not bound it.
pub const MAX_FILE: u64 = 100 * 1024 * 1024;

/// The last component of `name`, whatever separator the sender uses, with control characters replaced; never empty,
/// `.` or `..`, and not longer than a file name can be.
pub fn safe_name(name: &str) -> Result<String, String> {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .map(|c| if c.is_control() { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.len() > 200 {
        return Err("this file name is too long".into());
    }
    Ok(match cleaned {
        "" | "." | ".." => "file".to_string(),
        other => other.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_one_safe_component() {
        assert_eq!(safe_name("a.pdf").unwrap(), "a.pdf");
        assert_eq!(safe_name("../../etc/passwd").unwrap(), "passwd");
        assert_eq!(safe_name("C:\\Users\\x\\y.zip").unwrap(), "y.zip");
        assert_eq!(safe_name("dir/").unwrap(), "file");
        assert_eq!(safe_name("..").unwrap(), "file");
        assert_eq!(safe_name("a\nb\0c").unwrap(), "a_b_c");
        assert!(safe_name(&"x".repeat(201)).is_err());
    }
}
