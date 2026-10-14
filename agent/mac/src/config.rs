//! The agent's settings file and token file: parsing and the ownership rules that make
//! the agent refuse to start on a file somebody else could have rewritten (spec D2, D6).
//! File metadata is passed in as plain numbers so every rule is testable on any host.
use crate::tailnet::is_tailnet_ip;
use serde_json::Value;
use std::fmt;
use std::net::IpAddr;

pub const DEFAULT_PORT: u16 = 18471;

#[derive(Debug, PartialEq, Eq)]
pub struct ConfigError(pub String);
impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ConfigError {}
fn err<T>(message: impl Into<String>) -> Result<T, ConfigError> {
    Err(ConfigError(message.into()))
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub struct AgentConfig {
    /// The Mac's own tailnet address: the HTTP server and the media socket bind here.
    pub bind: IpAddr,
    pub port: u16,
    /// The only address HTTP connections are accepted from.
    pub gateway: IpAddr,
}

/// `{"bind":"100.64.0.20","port":18471,"gateway":"100.64.0.10"}`; `port` is optional.
pub fn parse_config(text: &str) -> Result<AgentConfig, ConfigError> {
    let value: Value = serde_json::from_str(text).map_err(|_| ConfigError("agent.json is not valid JSON".into()))?;
    let Some(object) = value.as_object() else {
        return err("agent.json must be a JSON object");
    };
    for key in object.keys() {
        if !["bind", "port", "gateway"].contains(&key.as_str()) {
            return err(format!("agent.json has an unknown setting {key:?}"));
        }
    }
    let address = |name: &str| -> Result<IpAddr, ConfigError> {
        let Some(text) = object.get(name).and_then(Value::as_str) else {
            return err(format!("agent.json needs \"{name}\" (a tailnet address)"));
        };
        let Ok(ip) = text.parse::<IpAddr>() else {
            return err(format!("\"{name}\" is not an IP address"));
        };
        if !is_tailnet_ip(ip) {
            return err(format!("\"{name}\" must be a tailnet address"));
        }
        Ok(ip)
    };
    let bind = address("bind")?;
    let gateway = address("gateway")?;
    let port = match object.get("port") {
        None => DEFAULT_PORT,
        Some(p) => match p.as_u64() {
            Some(n) if (1024..=65535).contains(&n) => n as u16,
            _ => return err("\"port\" must be a number from 1024 to 65535"),
        },
    };
    Ok(AgentConfig { bind, port, gateway })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    /// A symbolic link, a socket, anything else. Links are never followed.
    Other,
}

/// Owner and permission bits of a path, as `lstat` reports them.
#[derive(Debug, Clone, Copy)]
pub struct FileMeta {
    pub mode: u32,
    pub uid: u32,
    pub kind: Kind,
}

/// The settings file must be a regular file owned by `owner_uid` (root in the operational
/// install) that nobody else can write: the owner is what decides who may control the
/// Mac. `user_uid` is the user running the agent, who must be able to read it.
pub fn check_config_file(meta: &FileMeta, owner_uid: u32, user_uid: u32) -> Result<(), ConfigError> {
    if meta.kind != Kind::File {
        return err("agent.json must be a regular file");
    }
    if meta.uid != owner_uid {
        return err(format!("agent.json must be owned by uid {owner_uid}"));
    }
    if meta.mode & 0o022 != 0 {
        return err("agent.json must not be writable by group or others");
    }
    if meta.uid != user_uid && meta.mode & 0o004 == 0 {
        return err("agent.json must be readable by the agent's user (mode 644)");
    }
    Ok(())
}

/// The directory that holds the settings file must belong to the same owner and be closed
/// to everybody else; otherwise the file could be replaced by renaming it.
pub fn check_config_dir(meta: &FileMeta, owner_uid: u32) -> Result<(), ConfigError> {
    if meta.kind != Kind::Dir {
        return err("the settings directory must be a real directory");
    }
    if meta.uid != owner_uid {
        return err(format!("the settings directory must be owned by uid {owner_uid}"));
    }
    if meta.mode & 0o022 != 0 {
        return err("the settings directory must not be writable by group or others");
    }
    Ok(())
}

/// The token file must be a regular file, mode exactly 600, owned by the user running the agent.
pub fn check_token_file(meta: &FileMeta, user_uid: u32) -> Result<(), ConfigError> {
    if meta.kind != Kind::File {
        return err("the token file must be a regular file");
    }
    if meta.mode & 0o777 != 0o600 {
        return err("the token file must have mode 600");
    }
    if meta.uid != user_uid {
        return err("the token file must be owned by the user running the agent");
    }
    Ok(())
}

/// 32 random bytes in base64url without padding: exactly 43 characters. A trailing
/// newline (from `cat` or an editor) is tolerated.
pub fn parse_token(text: &str) -> Result<String, ConfigError> {
    let token = text.trim_end_matches(['\n', '\r']);
    let valid = token.len() == 43 && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !valid {
        return err("the token file must hold 43 base64url characters");
    }
    Ok(token.to_string())
}

// ---- tests ----

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_complete_config_parses_and_the_port_defaults() {
        let c = parse_config(r#"{"bind":"100.64.0.20","gateway":"100.64.0.10"}"#).unwrap();
        assert_eq!(c.bind, "100.64.0.20".parse::<IpAddr>().unwrap());
        assert_eq!(c.gateway, "100.64.0.10".parse::<IpAddr>().unwrap());
        assert_eq!(c.port, 18471);
        let c = parse_config(r#"{"bind":"100.64.0.20","gateway":"100.64.0.10","port":19000}"#).unwrap();
        assert_eq!(c.port, 19000);
    }

    #[test]
    fn startup_is_refused_without_a_gateway_or_on_a_non_tailnet_address() {
        for text in [
            r#"{"bind":"100.64.0.20"}"#,
            r#"{"gateway":"100.64.0.10"}"#,
            r#"{"bind":"0.0.0.0","gateway":"100.64.0.10"}"#,
            r#"{"bind":"127.0.0.1","gateway":"100.64.0.10"}"#,
            r#"{"bind":"192.168.1.5","gateway":"100.64.0.10"}"#,
            r#"{"bind":"100.64.0.20","gateway":"192.168.1.5"}"#,
            r#"{"bind":"100.64.0.20","gateway":"gateway.example"}"#,
            r#"{"bind":"100.64.0.20","gateway":"100.64.0.10","port":80}"#,
            r#"{"bind":"100.64.0.20","gateway":"100.64.0.10","port":"18471"}"#,
            r#"{"bind":"100.64.0.20","gateway":"100.64.0.10","extra":1}"#,
            r#"[]"#,
            "not json",
        ] {
            assert!(parse_config(text).is_err(), "{text}");
        }
    }

    fn meta(mode: u32, uid: u32) -> FileMeta {
        FileMeta { mode, uid, kind: Kind::File }
    }

    #[test]
    fn the_config_file_must_be_root_owned_and_not_writable_by_others() {
        assert!(check_config_file(&meta(0o644, 0), 0, 501).is_ok());
        assert!(check_config_file(&meta(0o444, 0), 0, 501).is_ok());
        assert!(check_config_file(&meta(0o644, 501), 0, 501).is_err(), "owned by the user");
        assert!(check_config_file(&meta(0o664, 0), 0, 501).is_err(), "group writable");
        assert!(check_config_file(&meta(0o646, 0), 0, 501).is_err(), "world writable");
        assert!(check_config_file(&meta(0o600, 0), 0, 501).is_err(), "root-only: the agent cannot read it");
        assert!(check_config_file(&FileMeta { mode: 0o644, uid: 0, kind: Kind::Other }, 0, 501).is_err());
    }

    #[test]
    fn a_development_config_may_belong_to_the_user() {
        assert!(check_config_file(&meta(0o600, 501), 501, 501).is_ok());
        assert!(check_config_file(&meta(0o644, 501), 501, 501).is_ok());
        assert!(check_config_file(&meta(0o666, 501), 501, 501).is_err());
        assert!(check_config_file(&meta(0o644, 0), 501, 501).is_err(), "root-owned is not the dev owner");
    }

    #[test]
    fn the_settings_directory_must_be_closed_to_everybody_but_its_owner() {
        let dir = |mode, uid| FileMeta { mode, uid, kind: Kind::Dir };
        assert!(check_config_dir(&dir(0o755, 0), 0).is_ok());
        assert!(check_config_dir(&dir(0o700, 501), 501).is_ok());
        assert!(check_config_dir(&dir(0o775, 0), 0).is_err());
        assert!(check_config_dir(&dir(0o757, 0), 0).is_err());
        assert!(check_config_dir(&dir(0o755, 501), 0).is_err());
        assert!(check_config_dir(&meta(0o755, 0), 0).is_err(), "a file is not a directory");
    }

    #[test]
    fn the_token_file_must_be_mode_600_and_the_users_own() {
        assert!(check_token_file(&meta(0o600, 501), 501).is_ok());
        for mode in [0o644, 0o640, 0o400, 0o700, 0o660] {
            assert!(check_token_file(&meta(mode, 501), 501).is_err(), "{mode:o}");
        }
        assert!(check_token_file(&meta(0o600, 0), 501).is_err());
        assert!(check_token_file(&FileMeta { mode: 0o600, uid: 501, kind: Kind::Dir }, 501).is_err());
    }

    #[test]
    fn the_token_is_43_base64url_characters() {
        let good = "A".repeat(43);
        assert_eq!(parse_token(&good).unwrap(), good);
        assert_eq!(parse_token(&format!("{good}\n")).unwrap(), good);
        assert_eq!(parse_token(&format!("{good}\r\n")).unwrap(), good);
        for bad in [
            "".to_string(),
            "A".repeat(42),
            "A".repeat(44),
            format!("{}+", "A".repeat(42)),
            format!("{}=", "A".repeat(42)),
            format!(" {}", "A".repeat(42)),
        ] {
            assert!(parse_token(&bad).is_err(), "{bad:?}");
        }
    }
}
