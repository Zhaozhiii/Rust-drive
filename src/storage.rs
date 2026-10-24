use std::{
    ffi::CString,
    fs::File,
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    path::{Path, PathBuf},
};
pub struct Root {
    pub path: PathBuf,
    file: File,
}
pub struct Handle {
    pub file: File,
}
impl Handle {
    pub fn proc(&self) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.file.as_raw_fd()))
    }
}
#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}
impl Root {
    pub fn new(path: impl AsRef<Path>) -> io::Result<Self> {
        std::fs::create_dir_all(&path)?;
        let path = std::fs::canonicalize(path)?;
        let file = File::open(&path)?;
        for n in [".tmp", ".uploads"] {
            let p = path.join(n);
            if p.exists() {
                let m = std::fs::symlink_metadata(&p)?;
                if !m.is_dir() || m.file_type().is_symlink() {
                    return Err(io::Error::other("internal directory must not be a symlink"));
                }
            } else {
                std::fs::create_dir(&p)?
            }
        }
        Ok(Self { path, file })
    }
    pub fn validate(p: &str) -> io::Result<()> {
        if p.starts_with('/')
            || p.contains(['\\', '\0'])
            || p.split('/')
                .any(|s| s == ".." || s == "." || s == ".tmp" || s == ".uploads")
            || (!p.is_empty() && p.split('/').any(str::is_empty))
        {
            return Err(io::Error::from_raw_os_error(libc::EINVAL));
        }
        Ok(())
    }
    pub fn open(&self, p: &str, dir: bool) -> io::Result<Handle> {
        Self::validate(p)?;
        let c = CString::new(if p.is_empty() { "." } else { p }).unwrap();
        let how = OpenHow {
            flags: (libc::O_RDONLY
                | libc::O_CLOEXEC
                | libc::O_NONBLOCK
                | if dir { libc::O_DIRECTORY } else { 0 }) as u64,
            mode: 0,
            resolve: 0x08 | 0x04,
        };
        let fd = unsafe {
            libc::syscall(
                libc::SYS_openat2,
                self.file.as_raw_fd(),
                c.as_ptr(),
                &how,
                std::mem::size_of::<OpenHow>(),
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Handle {
            file: unsafe { File::from_raw_fd(fd as i32) },
        })
    }
    pub fn dir(&self, p: &str) -> io::Result<Handle> {
        self.open(p, true)
    }
    pub fn parent(&self, p: &str) -> io::Result<(Handle, String)> {
        Self::validate(p)?;
        if p.is_empty() {
            return Err(io::Error::from_raw_os_error(libc::EINVAL));
        }
        let (parent, name) = p.rsplit_once('/').unwrap_or(("", p));
        Ok((self.dir(parent)?, name.into()))
    }
    pub fn free(&self) -> io::Result<u64> {
        let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        if unsafe { libc::fstatvfs(self.file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let stat = unsafe { stat.assume_init() };
        Ok(stat.f_bavail.saturating_mul(stat.f_frsize))
    }
}
pub fn allocated(p: &Path) -> u64 {
    std::fs::symlink_metadata(p)
        .map(|m| m.blocks().saturating_mul(512))
        .unwrap_or(0)
}
pub fn scan_size(p: &Path, root: bool) -> io::Result<u64> {
    let mut total = 0u64;
    for e in std::fs::read_dir(p)? {
        let e = e?;
        if root && [".tmp", ".uploads"].iter().any(|n| e.file_name() == *n) {
            continue;
        }
        let ft = e.file_type()?;
        if ft.is_dir() {
            total = total.saturating_add(scan_size(&e.path(), false)?)
        } else if ft.is_file() {
            total = total.saturating_add(e.metadata()?.len())
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confinement() {
        let p = std::env::temp_dir().join(format!("drive-{}", uuid::Uuid::new_v4()));
        let r = Root::new(&p).unwrap();
        std::os::unix::fs::symlink("/etc", p.join("escape")).unwrap();
        for n in [
            "../etc/passwd",
            "/etc/passwd",
            ".tmp/x",
            ".uploads/x",
            "x/../y",
            "escape/passwd",
        ] {
            assert!(r.open(n, false).is_err(), "{n}")
        }
        assert!(r.parent("").is_err());
        assert!(r.dir("").is_ok());
        drop(r);
        std::fs::remove_dir_all(p).unwrap();
    }
}
