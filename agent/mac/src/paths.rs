//! Where the settings and the token live. Fixed at build time: the agent takes no
//! command-line argument and reads no environment variable (spec D2), so nobody who can
//! only start the program can point it at a settings file of their own.
//!
//! The operational build reads the root-owned `/usr/local/etc/gome-remote-agent/agent.json`.
//! A `dev-install` build (spec O4) reads a user-owned directory instead, so the binary
//! can be replaced during development without administrator rights.
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigOwner {
    Root,
    CurrentUser,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Paths {
    pub config: PathBuf,
    pub token: PathBuf,
    pub config_owner: ConfigOwner,
}

#[cfg(not(feature = "dev-install"))]
pub fn locate(home: &Path) -> Paths {
    Paths {
        config: PathBuf::from("/usr/local/etc/gome-remote-agent/agent.json"),
        token: home.join("Library/Application Support/Gome Remote Agent/token"),
        config_owner: ConfigOwner::Root,
    }
}

#[cfg(feature = "dev-install")]
pub fn locate(home: &Path) -> Paths {
    let dir = home.join("Library/Application Support/Gome Remote Agent Dev");
    Paths { config: dir.join("agent.json"), token: dir.join("token"), config_owner: ConfigOwner::CurrentUser }
}

/// The home directory from the password database, not from `$HOME`.
pub fn home_dir() -> Option<PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;
    // SAFETY: getpwuid_r writes into the buffer we own and returns pointers into it;
    // the directory string is copied out before the buffer goes away.
    unsafe {
        let mut passwd: libc::passwd = std::mem::zeroed();
        let mut buffer = vec![0 as libc::c_char; 4096];
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        let rc = libc::getpwuid_r(libc::getuid(), &mut passwd, buffer.as_mut_ptr(), buffer.len(), &mut result);
        if rc != 0 || result.is_null() || passwd.pw_dir.is_null() {
            return None;
        }
        let dir = CStr::from_ptr(passwd.pw_dir);
        Some(PathBuf::from(std::ffi::OsStr::from_bytes(dir.to_bytes())))
    }
}

// ---- tests ----

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(feature = "dev-install"))]
    #[test]
    fn the_operational_build_reads_the_root_owned_config_and_a_token_under_the_user_home() {
        let p = locate(Path::new("/Users/user"));
        assert_eq!(p.config, PathBuf::from("/usr/local/etc/gome-remote-agent/agent.json"));
        assert_eq!(p.token, PathBuf::from("/Users/user/Library/Application Support/Gome Remote Agent/token"));
        assert_eq!(p.config_owner, ConfigOwner::Root);
    }

    #[cfg(feature = "dev-install")]
    #[test]
    fn the_development_build_keeps_everything_under_a_separate_user_directory() {
        let p = locate(Path::new("/Users/user"));
        assert!(p.config.starts_with("/Users/user/Library/Application Support/Gome Remote Agent Dev"));
        assert!(p.token.starts_with("/Users/user/Library/Application Support/Gome Remote Agent Dev"));
        assert_eq!(p.config_owner, ConfigOwner::CurrentUser);
    }

    #[test]
    fn the_home_directory_comes_from_the_password_database() {
        assert!(home_dir().map(|d| d.is_absolute()).unwrap_or(false));
    }
}
