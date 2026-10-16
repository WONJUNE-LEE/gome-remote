//! The log file is the agent's standard output, opened by launchd in append mode. launchd
//! cannot limit its size, so the agent does: when the file passes the cap it is emptied in
//! place (the open descriptor keeps appending at the new end). There are no per-frame log
//! lines, so the cap is only reached after weeks (spec D6).
use std::os::fd::RawFd;

pub const CAP_BYTES: u64 = 5 * 1024 * 1024;

pub fn should_truncate(size: u64) -> bool {
    size > CAP_BYTES
}

/// Empties the file behind `fd` if it is a regular file larger than the cap. Returns whether
/// it did. A pipe, a terminal or a file that cannot be examined is left alone.
pub fn truncate_if_large(fd: RawFd) -> bool {
    // SAFETY: fstat writes into the zeroed struct we own; ftruncate takes the descriptor by value.
    unsafe {
        let mut stat: libc::stat = std::mem::zeroed();
        if libc::fstat(fd, &mut stat) != 0 || (stat.st_mode & libc::S_IFMT) != libc::S_IFREG {
            return false;
        }
        should_truncate(stat.st_size as u64) && libc::ftruncate(fd, 0) == 0
    }
}

// ---- tests ----

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::fd::AsRawFd;

    #[test]
    fn the_cap_is_five_mebibytes_and_exact() {
        assert!(!should_truncate(0));
        assert!(!should_truncate(CAP_BYTES));
        assert!(should_truncate(CAP_BYTES + 1));
    }

    #[test]
    fn a_large_append_only_file_is_emptied_and_keeps_accepting_writes() {
        let path = std::env::temp_dir().join(format!("gome-log-cap-{}", std::process::id()));
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path).unwrap();
        file.write_all(&vec![b'x'; (CAP_BYTES + 10) as usize]).unwrap();
        assert!(truncate_if_large(file.as_raw_fd()));
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
        file.write_all(b"after\n").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"after\n", "appends at the new end, no hole");
        assert!(!truncate_if_large(file.as_raw_fd()), "a small file is left alone");
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn a_pipe_is_never_touched() {
        let mut fds = [0 as libc::c_int; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        assert!(!truncate_if_large(fds[1]));
        assert!(!truncate_if_large(-1));
        unsafe {
            libc::close(fds[0]);
            libc::close(fds[1]);
        }
    }
}
