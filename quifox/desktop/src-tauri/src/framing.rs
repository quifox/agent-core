use serde_json::Value;

#[derive(Default)]
pub struct Frames {
    bytes: Vec<u8>,
}

impl Frames {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>, String> {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() > 32 * 1024 * 1024 {
            return Err("Engine frame exceeds the bridge limit.".into());
        }
        let mut frames = Vec::new();
        while let Some(end) = self.bytes.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.bytes.drain(..=end).collect();
            let value: Value =
                serde_json::from_slice(&line).map_err(|_| "Invalid engine JSONL frame.")?;
            match value.get("kind").and_then(Value::as_str) {
                Some("ready" | "response" | "event" | "fatal" | "presentation" | "presentation-cancel") => frames.push(value),
                _ => return Err("Unknown engine frame kind.".into()),
            }
        }
        Ok(frames)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffers_partial_utf8_and_multiple_lines() {
        let mut frames = Frames::default();
        let line = "{\"kind\":\"event\",\"text\":\"狐狸\"}\n".as_bytes();
        let split = line.iter().position(|byte| *byte >= 128).unwrap() + 1;
        assert!(frames.push(&line[..split]).unwrap().is_empty());
        let mut rest = line[split..].to_vec();
        rest.extend_from_slice(b"{\"kind\":\"ready\",\"protocol\":1}\n");
        let result = frames.push(&rest).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0]["text"], "狐狸");
    }

    #[test]
    fn presentation_frames_cross_the_same_jsonl_bridge() {
        let result = Frames::default().push(b"{\"kind\":\"presentation\",\"request\":{\"id\":\"one\"}}\n{\"kind\":\"presentation-cancel\",\"requestId\":\"one\"}\n").unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0]["request"]["id"], "one");
        assert_eq!(result[1]["requestId"], "one");
    }

    #[test]
    fn rejects_complete_corrupt_or_unknown_frames() {
        assert!(Frames::default().push(b"broken\n").is_err());
        assert!(Frames::default().push(b"{\"kind\":\"unknown\"}\n").is_err());
    }
}
