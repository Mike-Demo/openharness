//! The host's log: `<home>/logs/pty-host.log`, the owner's alone, kept to a size.
//!
//! The daemon starts the host with no stdio, so `log` records (and the host's own diagnostics) would
//! go nowhere without this. Each line goes to the file and to stderr, so a host run by hand in a
//! terminal still shows them. Past [`MAX_BYTES`] the file is moved to `pty-host.log.1` (one older
//! file is kept) and a new one is started.
//!
//! One host per home holds the home's lock (`host_lock`), but a host that lost the race for it, or the
//! Windows copy that left a job (`breakaway`), may write a line or two before it exits. Appends from
//! both stay whole lines; at worst one of them rotates the file under the other.

use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The size past which the log is rotated.
pub const MAX_BYTES: u64 = 5 * 1024 * 1024;

pub fn log_dir(home: &Path) -> PathBuf {
    home.join("logs")
}

pub fn log_path(home: &Path) -> PathBuf {
    log_dir(home).join("pty-host.log")
}

/// The rotated file: `pty-host.log.1`.
pub fn rotated_path(home: &Path) -> PathBuf {
    log_dir(home).join("pty-host.log.1")
}

pub struct FileLog {
    level: log::LevelFilter,
    max_bytes: u64,
    stderr: bool,
    state: Mutex<State>,
}

struct State {
    path: PathBuf,
    rotated: PathBuf,
    /// None once the file could not be opened: lines then go to stderr only.
    file: Option<File>,
    size: u64,
}

impl FileLog {
    /// Open (or create) the log under [home]. When the file cannot be opened, the logger still
    /// writes to stderr, and the error is returned alongside so the caller can report it.
    pub fn open(home: &Path, max_bytes: u64, stderr: bool) -> (FileLog, Option<io::Error>) {
        let (path, rotated) = (log_path(home), rotated_path(home));
        let opened = open_log(home, &path);
        let (file, size, error) = match opened {
            Ok((file, size)) => (Some(file), size, None),
            Err(err) => (None, 0, Some(err)),
        };
        let level = std::env::var("HARNESS_PTY_LOG")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(log::LevelFilter::Info);
        let log = FileLog {
            level,
            max_bytes,
            stderr,
            state: Mutex::new(State {
                path,
                rotated,
                file,
                size,
            }),
        };
        (log, error)
    }

    fn write_line(&self, line: &str) {
        if self.stderr {
            let _ = io::stderr().write_all(line.as_bytes());
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.file.is_none() {
            return;
        }
        if state.size > 0 && state.size + line.len() as u64 > self.max_bytes {
            state.rotate();
        }
        let State { file, size, .. } = &mut *state;
        if let Some(file) = file
            && file.write_all(line.as_bytes()).is_ok()
        {
            *size += line.len() as u64;
        }
    }
}

impl State {
    /// `pty-host.log` → `pty-host.log.1` (replacing it), then a new, empty `pty-host.log`.
    fn rotate(&mut self) {
        self.file = None;
        let _ = crate::files::rename(&self.path, &self.rotated);
        let home = self
            .path
            .parent()
            .and_then(Path::parent)
            .map(Path::to_path_buf);
        if let Some(home) = home
            && let Ok((file, size)) = open_log(&home, &self.path)
        {
            self.file = Some(file);
            self.size = size;
        }
    }
}

impl log::Log for FileLog {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= self.level
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format!(
            "{} pid {} {} {}: {}\n",
            utc_now(),
            std::process::id(),
            record.level(),
            record.target(),
            record.args()
        );
        self.write_line(&line);
    }

    fn flush(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(file) = state.file.as_mut() {
            let _ = file.flush();
        }
    }
}

/// Install the host's logger for [home] (once per process; a second call changes nothing). A log
/// file that cannot be opened is reported, on stderr, and the host carries on without one.
pub fn install(home: &Path) {
    let (log, error) = FileLog::open(home, MAX_BYTES, true);
    let level = log.level;
    // Leaked: the logger lives as long as the process.
    if log::set_logger(Box::leak(Box::new(log))).is_ok() {
        log::set_max_level(level);
    }
    if let Some(err) = error {
        log::warn!("no log file under {}: {err}", log_dir(home).display());
    }
}

/// `<home>/logs/`, the owner's alone (0700 on Unix, the run directory's user-only DACL on Windows),
/// then the log in it, opened to append: created 0600 on Unix (and made so, whatever an older file
/// had), on Windows with the user-only DACL from its creation, and shared, so it can be read (and
/// rotated) while it is open.
fn open_log(home: &Path, path: &Path) -> io::Result<(File, u64)> {
    let dir = log_dir(home);
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        let file = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .open(path)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file
    };
    #[cfg(windows)]
    let file = {
        std::fs::create_dir_all(home)?;
        crate::transport::windows::secure_dir(&dir)?;
        crate::transport::windows::open_private_append(path)?
    };
    let size = file.metadata()?.len();
    Ok((file, size))
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ`, with no date crate.
fn utc_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format_utc(now.as_secs(), now.subsec_millis())
}

fn format_utc(secs: u64, millis: u32) -> String {
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Howard Hinnant's civil_from_days.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use log::Log;

    fn record(log: &FileLog, level: log::Level, message: &str) {
        log.log(
            &log::Record::builder()
                .level(level)
                .target("harness_pty::test")
                .args(format_args!("{message}"))
                .build(),
        );
    }

    #[test]
    fn formats_utc_times() {
        assert_eq!(format_utc(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_utc(951_782_400, 7), "2000-02-29T00:00:00.007Z");
        assert_eq!(format_utc(1_791_893_045, 999), "2026-10-13T12:04:05.999Z");
    }

    #[test]
    fn writes_lines_to_an_owner_only_file_and_appends_across_opens() {
        let home = tempfile::tempdir().unwrap();
        let (log, error) = FileLog::open(home.path(), MAX_BYTES, false);
        assert!(error.is_none(), "{error:?}");
        record(&log, log::Level::Info, "first");
        record(&log, log::Level::Debug, "not at info");
        drop(log);
        let (log, _) = FileLog::open(home.path(), MAX_BYTES, false);
        record(&log, log::Level::Error, "second");
        let text = std::fs::read_to_string(log_path(home.path())).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2, "{text}");
        assert!(
            lines[0].ends_with("INFO harness_pty::test: first"),
            "{text}"
        );
        assert!(
            lines[1].ends_with("ERROR harness_pty::test: second"),
            "{text}"
        );
        assert!(lines[1].contains(&format!(" pid {} ", std::process::id())));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&log_dir(home.path())), 0o700);
            assert_eq!(mode(&log_path(home.path())), 0o600);
        }
        #[cfg(windows)]
        {
            use crate::transport::windows::file_dacl;
            file_dacl(&log_dir(home.path())).assert_users_alone(true);
            file_dacl(&log_path(home.path())).assert_only_user_entries();
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_older_log_readable_by_others_is_made_the_owners_alone() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(log_dir(home.path())).unwrap();
        std::fs::write(log_path(home.path()), "old\n").unwrap();
        std::fs::set_permissions(
            log_path(home.path()),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let (_log, error) = FileLog::open(home.path(), MAX_BYTES, false);
        assert!(error.is_none());
        let mode = std::fs::metadata(log_path(home.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn rotates_at_the_cap_and_keeps_one_older_file() {
        let home = tempfile::tempdir().unwrap();
        // Lines of 101 to 150 bytes (the pid's digits vary): two fit under the cap, three do not.
        let (log, _) = FileLog::open(home.path(), 300, false);
        let message = "x".repeat(60);
        for _ in 0..3 {
            record(&log, log::Level::Info, &message);
        }
        // The third did not fit beside the first two: they were moved aside.
        let older = std::fs::read_to_string(rotated_path(home.path())).unwrap();
        let current = std::fs::read_to_string(log_path(home.path())).unwrap();
        assert_eq!(older.lines().count(), 2, "{older}");
        assert_eq!(current.lines().count(), 1, "{current}");
        for _ in 0..2 {
            record(&log, log::Level::Info, &message);
        }
        // Rotated again: the oldest file is replaced, not kept beside.
        assert_eq!(
            std::fs::read_to_string(rotated_path(home.path()))
                .unwrap()
                .lines()
                .count(),
            2
        );
        assert_eq!(
            std::fs::read_to_string(log_path(home.path()))
                .unwrap()
                .lines()
                .count(),
            1
        );
        let names: Vec<_> = std::fs::read_dir(log_dir(home.path()))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(log_path(home.path()))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn a_log_that_cannot_be_opened_leaves_stderr() {
        let home = tempfile::tempdir().unwrap();
        // `logs` is a file: no directory can be made there.
        std::fs::write(log_dir(home.path()), "").unwrap();
        let (log, error) = FileLog::open(home.path(), MAX_BYTES, false);
        assert!(error.is_some());
        record(&log, log::Level::Error, "still fine");
    }
}
