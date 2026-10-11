use std::io::Write;
use std::process::{Command, Output, Stdio};

fn run(args: &[&str], stdin: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tinyregex"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn stdout(out: &Output) -> &str {
    std::str::from_utf8(&out.stdout).unwrap()
}

const LOG: &str = "INFO start\nERROR disk full\nWARN slow\nerror: retry\n";

#[test]
fn prints_matching_lines() {
    let out = run(&["ERROR"], LOG);
    assert_eq!(stdout(&out), "ERROR disk full\n");
    assert_eq!(out.status.code(), Some(0));
}

#[test]
fn flags_combine() {
    assert_eq!(
        stdout(&run(&["-in", "^error"], LOG)),
        "2:ERROR disk full\n4:error: retry\n"
    );
    assert_eq!(stdout(&run(&["-v", "-c", "ERROR|WARN"], LOG)), "2\n");
    assert_eq!(
        stdout(&run(&["-o", r"\b[a-z]+\b"], "Disk full, retry later\n")),
        "full\nretry\nlater\n"
    );
}

#[test]
fn exit_codes_follow_grep() {
    assert_eq!(run(&["nothing"], LOG).status.code(), Some(1));
    let bad = run(&["(oops"], LOG);
    assert_eq!(bad.status.code(), Some(2));
    assert_eq!(
        String::from_utf8_lossy(&bad.stderr),
        "tinyregex: bad pattern '(oops': unclosed '(' at position 0\n"
    );
}

#[test]
fn reads_files_and_names_them() {
    let dir = std::env::temp_dir().join(format!("tinyregex-cli-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let a = dir.join("a.txt");
    let b = dir.join("b.txt");
    std::fs::write(&a, "apple\nbanana\n").unwrap();
    std::fs::write(&b, "cherry\napricot").unwrap();
    let out = run(&["^a", a.to_str().unwrap(), b.to_str().unwrap()], "");
    let text = stdout(&out).replace(dir.to_str().unwrap(), "");
    assert_eq!(text, "/a.txt:apple\n/b.txt:apricot\n");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn shows_the_compiled_program() {
    let out = run(&["--program", "ab?"], "");
    assert_eq!(
        stdout(&out),
        "   0  save 0\n   1  char 'a'\n   2  split 3, 4\n   3  char 'b'\n   4  save 1\n   5  match\n"
    );
}
