//! File operations the host's state files share.

use std::io;
use std::path::Path;

/// `std::fs::rename`, which on Windows is tried again for a moment when the file is busy: a
/// virus scanner or the indexer may hold a handle on a file the host just wrote, and replacing it
/// then fails with access denied or a sharing violation.
pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        const ERROR_ACCESS_DENIED: i32 = 5;
        const ERROR_SHARING_VIOLATION: i32 = 32;
        const ERROR_LOCK_VIOLATION: i32 = 33;
        // 10 + 20 + … + 320 ms: about 0.6 s in all.
        let mut wait = std::time::Duration::from_millis(10);
        for _ in 0..6 {
            match std::fs::rename(from, to) {
                Err(e)
                    if matches!(
                        e.raw_os_error(),
                        Some(ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)
                    ) =>
                {
                    std::thread::sleep(wait);
                    wait *= 2;
                }
                done => return done,
            }
        }
    }
    std::fs::rename(from, to)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renames_over_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let (from, to) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::write(&from, "new").unwrap();
        std::fs::write(&to, "old").unwrap();
        rename(&from, &to).unwrap();
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "new");
        assert!(!from.exists());
    }

    #[cfg(windows)]
    #[test]
    fn a_target_held_open_for_a_moment_is_replaced_once_it_is_let_go() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let (from, to) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::write(&from, "new").unwrap();
        std::fs::write(&to, "old").unwrap();
        // A scanner's handle: no delete sharing, so the file cannot be replaced while it is open.
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1) // FILE_SHARE_READ
            .open(&to)
            .unwrap();
        assert!(
            std::fs::rename(&from, &to).is_err(),
            "the held file was replaced: the test shows nothing"
        );
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            drop(held);
        });
        rename(&from, &to).unwrap();
        release.join().unwrap();
        assert_eq!(std::fs::read_to_string(&to).unwrap(), "new");
    }
}
