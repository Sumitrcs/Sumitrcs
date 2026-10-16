//! dupfind — find duplicate files without reading more than necessary.
//!
//! Hashing every byte of every file would work, but it is slow on a big disk.
//! Most files can be ruled out much more cheaply, so the search narrows down
//! in three stages, and each stage only looks at files that are still "suspects":
//!
//! ```text
//!  all files ──► same size? ──► same first 4 KiB? ──► same SHA-256? ──► duplicates
//!              (free: from        (reads 4 KiB         (reads the whole file,
//!               the directory)     per file)            only for the few left)
//! ```

pub mod sha256;

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use sha256::{Digest, Sha256};

/// How much of each file stage 2 reads.
pub const PREFIX_BYTES: u64 = 4096;

#[derive(Debug, Clone)]
pub struct Options {
    /// Ignore files smaller than this. Empty files are all "identical", which
    /// is rarely interesting, so the default is 1.
    pub min_size: u64,
    /// Directory names to skip anywhere in the tree, like ".git" or "node_modules".
    pub skip: Vec<String>,
    /// Hashing threads; 0 means one per CPU core.
    pub threads: usize,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            min_size: 1,
            skip: Vec::new(),
            threads: 0,
        }
    }
}

/// Files with identical content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub size: u64,
    pub hash: Digest,
    pub paths: Vec<PathBuf>,
}

impl Group {
    /// Space that deleting all but one copy would free.
    pub fn wasted(&self) -> u64 {
        self.size * (self.paths.len() as u64 - 1)
    }
}

#[derive(Debug, Default)]
pub struct Report {
    pub groups: Vec<Group>,
    pub files: usize,
    pub bytes: u64,
    /// How many files each stage had to read, to show how much work was saved.
    pub prefix_hashed: usize,
    pub fully_hashed: usize,
    /// Bytes actually read from disk, compared with `bytes` in total.
    pub bytes_read: u64,
    pub errors: Vec<(PathBuf, String)>,
    pub elapsed: Duration,
}

impl Report {
    pub fn wasted(&self) -> u64 {
        self.groups.iter().map(Group::wasted).sum()
    }
    pub fn duplicate_files(&self) -> usize {
        self.groups.iter().map(|g| g.paths.len() - 1).sum()
    }
}

#[derive(Debug, Clone)]
struct Candidate {
    path: PathBuf,
    size: u64,
}

/// Searches `roots` (directories or files) for files with identical content.
pub fn find_duplicates(roots: &[PathBuf], opts: &Options) -> Report {
    let start = Instant::now();
    let mut report = Report::default();

    // Stage 0: list every file once.
    let files = walk(roots, opts, &mut report);
    report.files = files.len();
    report.bytes = files.iter().map(|f| f.size).sum();

    // Stage 1: only files that share their size with another file can be duplicates.
    let mut by_size: HashMap<u64, Vec<Candidate>> = HashMap::new();
    for f in files.into_iter().filter(|f| f.size >= opts.min_size) {
        by_size.entry(f.size).or_default().push(f);
    }
    let suspects: Vec<Candidate> = by_size
        .into_values()
        .filter(|g| g.len() > 1)
        .flatten()
        .collect();

    // Stage 2: hash the first 4 KiB. For small files this is the whole file,
    // so those are finished here.
    report.prefix_hashed = suspects.len();
    report.bytes_read = suspects.iter().map(|c| c.size.min(PREFIX_BYTES)).sum();
    let prefix = regroup(suspects, PREFIX_BYTES, opts.threads, &mut report.errors);
    let (small, large): (Vec<_>, Vec<_>) = prefix
        .into_iter()
        .partition(|(c, _)| c.size <= PREFIX_BYTES);

    // Stage 3: full SHA-256 for the large files whose start matched.
    let large: Vec<Candidate> = large.into_iter().map(|(c, _)| c).collect();
    report.fully_hashed = large.len();
    report.bytes_read += large.iter().map(|c| c.size).sum::<u64>();
    let full = regroup(large, u64::MAX, opts.threads, &mut report.errors);

    let mut groups: HashMap<(u64, Digest), Vec<PathBuf>> = HashMap::new();
    for (c, hash) in small.into_iter().chain(full) {
        groups.entry((c.size, hash)).or_default().push(c.path);
    }
    report.groups = groups
        .into_iter()
        .filter(|(_, paths)| paths.len() > 1)
        .map(|((size, hash), mut paths)| {
            paths.sort();
            Group { size, hash, paths }
        })
        .collect();
    // Biggest savings first; ties broken by path so output is stable.
    report.groups.sort_by(|a, b| {
        b.wasted()
            .cmp(&a.wasted())
            .then_with(|| a.paths.cmp(&b.paths))
    });
    report.elapsed = start.elapsed();
    report
}

/// Hashes up to `limit` bytes of each candidate and keeps only the ones that
/// share (size, hash) with at least one other candidate.
fn regroup(
    candidates: Vec<Candidate>,
    limit: u64,
    threads: usize,
    errors: &mut Vec<(PathBuf, String)>,
) -> Vec<(Candidate, Digest)> {
    let paths: Vec<&Path> = candidates.iter().map(|c| c.path.as_path()).collect();
    let hashes = hash_files(&paths, limit, threads);
    let mut groups: HashMap<(u64, Digest), Vec<Candidate>> = HashMap::new();
    for (c, result) in candidates.into_iter().zip(hashes) {
        match result {
            Ok(h) => groups.entry((c.size, h)).or_default().push(c),
            Err(e) => errors.push((c.path, e.to_string())),
        }
    }
    groups
        .into_iter()
        .filter(|(_, g)| g.len() > 1)
        .flat_map(|((_, h), g)| g.into_iter().map(move |c| (c, h)))
        .collect()
}

/// Hashes many files in parallel. Each worker thread repeatedly takes the
/// next unclaimed index from a shared counter, so a few huge files can't
/// leave the other cores idle.
pub fn hash_files(paths: &[&Path], limit: u64, threads: usize) -> Vec<io::Result<Digest>> {
    let threads = if threads == 0 {
        std::thread::available_parallelism().map_or(4, |n| n.get())
    } else {
        threads
    };
    let next = AtomicUsize::new(0);
    let mut results: Vec<Option<io::Result<Digest>>> = (0..paths.len()).map(|_| None).collect();

    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..threads.min(paths.len()).max(1))
            .map(|_| {
                scope.spawn(|| {
                    let mut done = Vec::new();
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        if i >= paths.len() {
                            return done;
                        }
                        done.push((
                            i,
                            File::open(paths[i]).and_then(|f| Sha256::digest_reader(f, limit)),
                        ));
                    }
                })
            })
            .collect();
        for worker in workers {
            for (i, r) in worker.join().expect("hashing thread panicked") {
                results[i] = Some(r);
            }
        }
    });
    results
        .into_iter()
        .map(|r| r.expect("every index is hashed exactly once"))
        .collect()
}

/// Lists regular files under the roots. Symbolic links are not followed (they
/// would cause loops and double counting), and hard links to the same file
/// are counted once, because they don't use extra space.
fn walk(roots: &[PathBuf], opts: &Options, report: &mut Report) -> Vec<Candidate> {
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    let mut stack: Vec<PathBuf> = roots.to_vec();
    while let Some(path) = stack.pop() {
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) => {
                report.errors.push((path, e.to_string()));
                continue;
            }
        };
        if meta.is_dir() {
            match fs::read_dir(&path) {
                Ok(entries) => {
                    for entry in entries.flatten() {
                        let child = entry.path();
                        let skipped = entry.file_type().is_ok_and(|t| t.is_dir())
                            && opts
                                .skip
                                .iter()
                                .any(|s| child.file_name().is_some_and(|n| n == s.as_str()));
                        if !skipped {
                            stack.push(child);
                        }
                    }
                }
                Err(e) => report.errors.push((path, e.to_string())),
            }
        } else if meta.is_file() && seen.insert(file_id(&path, &meta)) {
            files.push(Candidate {
                size: meta.len(),
                path,
            });
        }
    }
    files
}

/// Identifies the file itself rather than its name: (device, inode) on Unix.
#[cfg(unix)]
fn file_id(_path: &Path, meta: &fs::Metadata) -> (u64, u64, PathBuf) {
    use std::os::unix::fs::MetadataExt;
    (meta.dev(), meta.ino(), PathBuf::new())
}

#[cfg(not(unix))]
fn file_id(path: &Path, _meta: &fs::Metadata) -> (u64, u64, PathBuf) {
    (
        0,
        0,
        fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()),
    )
}

/// "1.5 MiB", "820 B" — binary units, like `ls -h`.
pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 6] = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// Parses "4096", "10K", "1.5M", "2G" (powers of 1024).
pub fn parse_size(text: &str) -> Option<u64> {
    let t = text.trim();
    let (num, mult) = match t.char_indices().find(|(_, c)| c.is_ascii_alphabetic()) {
        Some((i, _)) => {
            let mult = match t[i..]
                .to_ascii_uppercase()
                .trim_end_matches("IB")
                .trim_end_matches('B')
            {
                "" => 1u64,
                "K" => 1 << 10,
                "M" => 1 << 20,
                "G" => 1 << 30,
                "T" => 1 << 40,
                _ => return None,
            };
            (&t[..i], mult)
        }
        None => (t, 1),
    };
    let value: f64 = num.trim().parse().ok()?;
    (value >= 0.0 && value.is_finite()).then(|| (value * mult as f64).round() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes() {
        assert_eq!(human_size(0), "0 B");
        assert_eq!(human_size(1023), "1023 B");
        assert_eq!(human_size(1536), "1.5 KiB");
        assert_eq!(human_size(5 << 30), "5.0 GiB");
        assert_eq!(parse_size("4096"), Some(4096));
        assert_eq!(parse_size("10K"), Some(10240));
        assert_eq!(parse_size("1.5M"), Some(1572864));
        assert_eq!(parse_size("2gib"), Some(2 << 30));
        assert_eq!(parse_size("1kb"), Some(1024));
        assert_eq!(parse_size("ten"), None);
        assert_eq!(parse_size("5X"), None);
    }
}
