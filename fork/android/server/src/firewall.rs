//! fork: on CachyOS, ufw is on by default and drops what comes in, so the phone could not
//! reach the server on the local network and nothing said why (Tailscale still worked: its traffic goes around ufw).
//! `status` and `invite` carry what this finds, so the window and /phone say which firewall to open and how. Read
//! without root: ufw's own files, and firewalld through `firewall-cmd`, whose queries need no privilege.

use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

/// How often `watch` looks again: a rule the user adds shows within this.
const EVERY: Duration = Duration::from_secs(30);

/// What `check` finds for `port`, kept up to date by a thread: asking firewalld takes about a second
//, too long for every `status` the window sends. Null until the first look ends.
pub fn watch(port: u16) -> Arc<Mutex<Value>> {
    let found = Arc::new(Mutex::new(Value::Null));
    let shared = found.clone();
    std::thread::spawn(move || loop {
        let now = check(port).unwrap_or(Value::Null);
        *shared.lock().unwrap() = now;
        std::thread::sleep(EVERY);
    });
    found
}

/// The firewall that may block `port` on the local network, with the command that opens it; none when no firewall
/// runs or when it lets the port in. `certain` is false when its rules could not be read.
pub fn check(port: u16) -> Option<Value> {
    ufw(port).or_else(|| firewalld(port))
}

fn ufw(port: u16) -> Option<Value> {
    let conf = std::fs::read_to_string("/etc/ufw/ufw.conf").ok()?;
    if !conf.lines().any(|line| line.trim() == "ENABLED=yes") {
        return None;
    }
    let defaults = std::fs::read_to_string("/etc/default/ufw").unwrap_or_default();
    if input_policy(&defaults) == Some("ACCEPT") {
        return None;
    }
    let certain = match std::fs::read_to_string("/etc/ufw/user.rules") {
        Ok(rules) if ufw_allows(&rules, port) => return None,
        Ok(_) => true,
        Err(_) => false,
    };
    Some(json!({ "name": "ufw", "certain": certain, "command": format!("sudo ufw allow {port}/tcp") }))
}

/// `DEFAULT_INPUT_POLICY` in /etc/default/ufw, without its quotes.
fn input_policy(defaults: &str) -> Option<&str> {
    defaults.lines().find_map(|line| {
        line.trim()
            .strip_prefix("DEFAULT_INPUT_POLICY=")
            .map(|value| value.trim_matches('"'))
    })
}

/// Whether one of ufw's rules lets TCP to `port` in, from any source. Each rule is recorded as a comment in user.rules:
/// `### tuple ### allow tcp 47392 0.0.0.0/0 any 192.168.2.0/24 in` (action, protocol, port, destination, source port,
/// source, direction); the port is `any`, a number, a list or a range `a:b`.
pub fn ufw_allows(rules: &str, port: u16) -> bool {
    rules.lines().any(|line| {
        let Some(tuple) = line.trim().strip_prefix("### tuple ###") else {
            return false;
        };
        let fields: Vec<&str> = tuple.split_whitespace().collect();
        let [action, protocol, ports, ..] = fields.as_slice() else {
            return false;
        };
        // `in`, or `in_<interface>` for a rule of one interface.
        let incoming = fields.get(6).is_none_or(|direction| direction.starts_with("in"));
        matches!(*action, "allow" | "limit")
            && incoming
            && (*protocol == "tcp" || *protocol == "any")
            && port_listed(ports, port)
    })
}

fn port_listed(ports: &str, port: u16) -> bool {
    ports == "any"
        || ports.split(',').any(|part| match part.split_once(':') {
            Some((low, high)) => matches!((low.parse::<u16>(), high.parse::<u16>()), (Ok(low), Ok(high)) if (low..=high).contains(&port)),
            None => part.parse() == Ok(port),
        })
}

fn firewalld(port: u16) -> Option<Value> {
    let state = firewall_cmd(&["--state"])?;
    if state.1.trim() != "running" {
        return None;
    }
    let certain = match firewall_cmd(&[&format!("--query-port={port}/tcp")]) {
        Some((_, answer)) if answer.trim() == "yes" => return None,
        Some((_, answer)) => answer.trim() == "no",
        None => false,
    };
    Some(json!({
        "name": "firewalld",
        "certain": certain,
        "command": format!("sudo firewall-cmd --permanent --add-port={port}/tcp && sudo firewall-cmd --reload"),
    }))
}

/// `firewall-cmd` with `args`: its exit status and output, or none when it is not installed.
fn firewall_cmd(args: &[&str]) -> Option<(bool, String)> {
    let output = Command::new("firewall-cmd")
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    Some((output.status.success(), String::from_utf8_lossy(&output.stdout).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_rules_ufw_records() {
        let rules = "### RULES ###\n\n### tuple ### allow tcp 47392 0.0.0.0/0 any 192.168.2.0/24 in\n-A ufw-user-input -p tcp --dport 47392 -s 192.168.2.0/24 -j ACCEPT\n";
        assert!(ufw_allows(rules, 47392));
        assert!(!ufw_allows(rules, 22));
        assert!(ufw_allows("### tuple ### allow any 40000:50000 0.0.0.0/0 any 0.0.0.0/0 in\n", 47392));
        assert!(ufw_allows("### tuple ### allow tcp 22,47392 0.0.0.0/0 any 0.0.0.0/0 in\n", 47392));
        assert!(ufw_allows("### tuple ### allow any any 0.0.0.0/0 any 192.168.1.0/24 in\n", 47392));
        // Denied, UDP only, or outgoing: not a way in for the phone.
        assert!(!ufw_allows("### tuple ### deny tcp 47392 0.0.0.0/0 any 0.0.0.0/0 in\n", 47392));
        assert!(!ufw_allows("### tuple ### allow udp 47392 0.0.0.0/0 any 0.0.0.0/0 in\n", 47392));
        assert!(!ufw_allows("### tuple ### allow tcp 47392 0.0.0.0/0 any 0.0.0.0/0 out\n", 47392));
        // CachyOS's rules as installed: none.
        assert!(!ufw_allows("### RULES ###\n\n### END RULES ###\n", 47392));
    }

    #[test]
    fn reads_ufws_input_policy() {
        assert_eq!(input_policy("IPV6=yes\nDEFAULT_INPUT_POLICY=\"DROP\"\n"), Some("DROP"));
        assert_eq!(input_policy("DEFAULT_INPUT_POLICY=\"ACCEPT\"\n"), Some("ACCEPT"));
        assert_eq!(input_policy("IPV6=yes\n"), None);
    }
}
