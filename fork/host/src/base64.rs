//! Standard base64 (RFC 4648, with padding) for the file transfers between the phone and the PC: the JSON lines of the protocol carry bytes as text. Written here to keep the approved dependency list as it is.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

fn value(byte: u8) -> Option<u32> {
    match byte {
        b'A'..=b'Z' => Some(u32::from(byte - b'A')),
        b'a'..=b'z' => Some(u32::from(byte - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(byte - b'0') + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Decodes padded base64; refuses any other character (white space included), a wrong length, padding anywhere but
/// the end, and non-zero bits after the data (so two texts never mean the same bytes).
pub fn decode(text: &str) -> Result<Vec<u8>, String> {
    let bytes = text.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err("not base64: the length is not a multiple of 4".into());
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let blocks = bytes.len() / 4;
    for (index, block) in bytes.chunks(4).enumerate() {
        let last = index + 1 == blocks;
        let padding = block.iter().rev().take_while(|&&b| b == b'=').count();
        if padding > 2 || (padding > 0 && !last) {
            return Err("not base64: misplaced padding".into());
        }
        let mut n = 0u32;
        for (position, &byte) in block.iter().enumerate() {
            let digit = if position >= 4 - padding {
                0
            } else {
                value(byte).ok_or("not base64: unexpected character")?
            };
            n = (n << 6) | digit;
        }
        let kept = 3 - padding;
        let [_, a, b, c] = n.to_be_bytes();
        out.extend_from_slice(&[a, b, c][..kept]);
        // The unused bits must be zero.
        if (padding == 1 && c != 0) || (padding == 2 && (b != 0 || c != 0)) {
            return Err("not base64: bits after the data".into());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_rfc_vectors() {
        for (plain, coded) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(encode(plain.as_bytes()), coded);
            assert_eq!(decode(coded).unwrap(), plain.as_bytes());
        }
    }

    #[test]
    fn round_trips_every_byte_value_and_length() {
        let bytes: Vec<u8> = (0..=255u8).cycle().take(1000).collect();
        for length in 0..bytes.len() {
            assert_eq!(decode(&encode(&bytes[..length])).unwrap(), &bytes[..length]);
        }
    }

    #[test]
    fn refuses_what_is_not_canonical_base64() {
        for bad in ["Zg=", "Zg", "Zm9v\n", "Zm 9v", "Zg==Zg==", "=Zg=", "Zh==", "Zm9=", "Zm9v====", "Zm9*", "é\u{e9}ab"] {
            assert!(decode(bad).is_err(), "{bad:?} should be refused");
        }
    }
}
