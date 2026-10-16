use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use dupfind::{Options, PREFIX_BYTES, find_duplicates};

/// A fresh temporary directory, removed when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("dupfind-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }
    fn root(&self) -> &[PathBuf] {
        std::slice::from_ref(&self.0)
    }
    fn write(&self, rel: &str, data: &[u8]) -> PathBuf {
        let p = self.0.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, data).unwrap();
        p
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn names(paths: &[PathBuf], root: &Path) -> Vec<String> {
    paths
        .iter()
        .map(|p| {
            p.strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect()
}

fn big(seed: u8, len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
        .collect()
}

#[test]
fn finds_small_and_large_duplicates() {
    let t = TempDir::new("basic");
    t.write("a.txt", b"hello");
    t.write("sub/b.txt", b"hello");
    t.write("c.txt", b"world"); // same size, different content
    t.write("photos/1.jpg", &big(1, 100_000));
    t.write("backup/1.jpg", &big(1, 100_000));
    t.write("backup/old/1-copy.jpg", &big(1, 100_000));
    t.write("other.jpg", &big(2, 100_000)); // same size, different content

    let r = find_duplicates(t.root(), &Options::default());
    assert_eq!(r.files, 7);
    assert_eq!(r.groups.len(), 2);
    // Biggest waste first: two extra copies of the 100 kB photo.
    assert_eq!(
        names(&r.groups[0].paths, &t.0),
        ["backup/1.jpg", "backup/old/1-copy.jpg", "photos/1.jpg"]
    );
    assert_eq!(r.groups[0].wasted(), 200_000);
    assert_eq!(names(&r.groups[1].paths, &t.0), ["a.txt", "sub/b.txt"]);
    assert_eq!(r.wasted(), 200_005);
    assert_eq!(r.duplicate_files(), 3);
}

#[test]
fn same_start_but_different_end_is_not_a_duplicate() {
    let t = TempDir::new("prefix");
    let mut a = big(9, 50_000);
    let b = a.clone();
    *a.last_mut().unwrap() ^= 1; // differ only in the very last byte
    t.write("a.bin", &a);
    t.write("b.bin", &b);
    let r = find_duplicates(t.root(), &Options::default());
    assert!(r.groups.is_empty());
    assert_eq!(r.prefix_hashed, 2); // same size, so the prefix was compared...
    assert_eq!(r.fully_hashed, 2); // ...and matched, so the whole files were read
    assert_eq!(r.bytes_read, 2 * 4096 + 2 * 50_000);
}

#[test]
fn unique_sizes_are_never_read() {
    let t = TempDir::new("sizes");
    for i in 1..=20 {
        t.write(&format!("f{i}"), &vec![0u8; i * 1000]);
    }
    let r = find_duplicates(t.root(), &Options::default());
    assert!(r.groups.is_empty());
    assert_eq!((r.prefix_hashed, r.fully_hashed, r.bytes_read), (0, 0, 0));
}

#[test]
fn small_files_are_settled_by_the_prefix_stage() {
    let t = TempDir::new("small");
    let data = big(3, PREFIX_BYTES as usize);
    t.write("x", &data);
    t.write("y", &data);
    let r = find_duplicates(t.root(), &Options::default());
    assert_eq!(r.groups.len(), 1);
    assert_eq!(r.fully_hashed, 0);
}

#[test]
fn empty_files_min_size_and_skip() {
    let t = TempDir::new("options");
    t.write("e1", b"");
    t.write("e2", b"");
    t.write("node_modules/lib.js", b"same");
    t.write("src/lib.js", b"same");
    t.write("tiny1", b"ab");
    t.write("tiny2", b"ab");

    let r = find_duplicates(t.root(), &Options::default());
    assert_eq!(r.groups.len(), 2, "empty files are ignored by default");

    let r = find_duplicates(
        t.root(),
        &Options {
            min_size: 0,
            ..Options::default()
        },
    );
    assert_eq!(r.groups.len(), 3);

    let r = find_duplicates(
        t.root(),
        &Options {
            min_size: 3,
            ..Options::default()
        },
    );
    assert_eq!(r.groups.len(), 1);

    let r = find_duplicates(
        t.root(),
        &Options {
            skip: vec!["node_modules".into()],
            ..Options::default()
        },
    );
    assert_eq!(r.groups.len(), 1);
    assert_eq!(names(&r.groups[0].paths, &t.0), ["tiny1", "tiny2"]);
}

#[cfg(unix)]
#[test]
fn hard_links_and_symlinks_are_not_duplicates() {
    let t = TempDir::new("links");
    let original = t.write("original.dat", &big(4, 10_000));
    fs::hard_link(&original, t.0.join("hardlink.dat")).unwrap();
    std::os::unix::fs::symlink(&original, t.0.join("symlink.dat")).unwrap();
    std::os::unix::fs::symlink(&t.0, t.0.join("loop")).unwrap(); // must not recurse forever
    let r = find_duplicates(t.root(), &Options::default());
    assert_eq!(
        r.files, 1,
        "hard links are one file; symlinks are not followed"
    );
    assert!(r.groups.is_empty());
}

#[test]
fn overlapping_roots_count_each_file_once() {
    let t = TempDir::new("roots");
    t.write("a/x", b"data");
    t.write("a/y", b"data");
    let r = find_duplicates(
        &[t.0.clone(), t.0.join("a"), t.0.join("a/x")],
        &Options::default(),
    );
    assert_eq!(r.files, 2);
    assert_eq!(r.groups.len(), 1);
    assert_eq!(r.groups[0].paths.len(), 2);
}

#[test]
fn missing_root_is_reported_not_fatal() {
    let t = TempDir::new("missing");
    t.write("a", b"1");
    let r = find_duplicates(&[t.0.join("nope"), t.0.clone()], &Options::default());
    assert_eq!(r.files, 1);
    assert_eq!(r.errors.len(), 1);
}

#[test]
fn single_thread_and_many_threads_agree() {
    let t = TempDir::new("threads");
    for i in 0..60 {
        t.write(&format!("d{}/f{i}", i % 7), &big((i % 5) as u8, 20_000));
    }
    let one = find_duplicates(
        t.root(),
        &Options {
            threads: 1,
            ..Options::default()
        },
    );
    let many = find_duplicates(
        t.root(),
        &Options {
            threads: 16,
            ..Options::default()
        },
    );
    assert_eq!(one.groups, many.groups);
    assert_eq!(one.groups.len(), 5);
    assert_eq!(one.duplicate_files(), 55);
}

fn dupfind(args: &[&str], dir: &Path) -> (i32, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_dupfind"))
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    (
        out.status.code().unwrap(),
        String::from_utf8(out.stdout).unwrap(),
        String::from_utf8(out.stderr).unwrap(),
    )
}

#[test]
fn cli_text_and_json() {
    let t = TempDir::new("cli");
    t.write("a.txt", b"same text");
    t.write("b \"quoted\".txt", b"same text");
    let (code, out, _) = dupfind(&[], &t.0);
    assert_eq!(code, 0);
    assert!(out.contains("2 copies of 9 B (9 B wasted)"), "{out}");
    assert!(
        out.contains("1 group of duplicates, 1 extra copy: 9 B could be freed."),
        "{out}"
    );

    let (_, json, _) = dupfind(&["--json", "."], &t.0);
    assert!(
        json.starts_with(
            "{\"files\":2,\"bytes\":18,\"wasted\":9,\"groups\":[{\"size\":9,\"sha256\":\""
        ),
        "{json}"
    );
    assert!(json.contains(r#""./b \"quoted\".txt""#), "{json}");

    let (code, _, err) = dupfind(&["--min-size", "lots"], &t.0);
    assert_eq!(code, 2);
    assert!(err.contains("bad size \"lots\""));
}

#[test]
fn cli_hash_and_check() {
    let t = TempDir::new("sums");
    t.write("abc.txt", b"abc");
    let (code, out, _) = dupfind(&["hash", "abc.txt"], &t.0);
    assert_eq!(code, 0);
    assert_eq!(
        out,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  abc.txt\n"
    );

    t.write("SUMS", out.as_bytes());
    assert_eq!(
        dupfind(&["check", "SUMS"], &t.0),
        (0, "abc.txt: OK\n".into(), String::new())
    );

    t.write("abc.txt", b"abd");
    let (code, out, err) = dupfind(&["check", "SUMS"], &t.0);
    assert_eq!((code, out.as_str()), (1, "abc.txt: FAILED\n"));
    assert!(err.contains("1 computed checksum did NOT match"));
}
