use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use rzip::{Options, compress_with, decompress};

const USAGE: &str = "usage:
  rzip [-1..-9] <file>          compress to <file>.rz
  rzip -d <file.rz> [out]       decompress
  rzip -t <file.rz>             test integrity
  rzip --bench <file>           compare levels 1, 6 and 9";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("rzip: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: &[String]) -> Result<(), String> {
    let mut level = 6u8;
    let mut mode = "c";
    let mut files = Vec::new();
    for a in args {
        match a.as_str() {
            "-d" => mode = "d",
            "-t" => mode = "t",
            "--bench" => mode = "b",
            "-h" | "--help" => {
                println!("{USAGE}");
                return Ok(());
            }
            s if s.len() == 2 && s.starts_with('-') && s.as_bytes()[1].is_ascii_digit() => {
                level = s[1..].parse().map_err(|_| "bad level")?;
            }
            s => files.push(PathBuf::from(s)),
        }
    }
    let input = files.first().ok_or(USAGE)?;
    let data = fs::read(input).map_err(|e| format!("{}: {e}", input.display()))?;

    match mode {
        "c" => {
            let t = Instant::now();
            let out = compress_with(&data, Options::level(level));
            let dest = files.get(1).cloned().unwrap_or_else(|| append_ext(input));
            fs::write(&dest, &out).map_err(|e| format!("{}: {e}", dest.display()))?;
            report(input, &dest, data.len(), out.len(), t);
        }
        "d" => {
            let t = Instant::now();
            let out = decompress(&data).map_err(|e| e.to_string())?;
            let dest = files.get(1).cloned().unwrap_or_else(|| strip_ext(input));
            if dest == *input {
                return Err("refusing to overwrite input; pass an output path".into());
            }
            fs::write(&dest, &out).map_err(|e| format!("{}: {e}", dest.display()))?;
            println!(
                "{} -> {} ({} bytes, {:.0} ms)",
                input.display(),
                dest.display(),
                out.len(),
                t.elapsed().as_secs_f64() * 1e3
            );
        }
        "t" => {
            let out = decompress(&data).map_err(|e| e.to_string())?;
            println!(
                "{}: OK ({} bytes, CRC verified)",
                input.display(),
                out.len()
            );
        }
        _ => {
            println!(
                "{:<7}{:>12}{:>9}{:>12}{:>12}",
                "level", "size", "ratio", "comp MB/s", "decomp MB/s"
            );
            for lvl in [1u8, 6, 9] {
                let t = Instant::now();
                let c = compress_with(&data, Options::level(lvl));
                let ct = t.elapsed().as_secs_f64();
                let t = Instant::now();
                let d = decompress(&c).map_err(|e| e.to_string())?;
                let dt = t.elapsed().as_secs_f64();
                assert_eq!(d, data);
                let mb = data.len() as f64 / 1e6;
                println!(
                    "{:<7}{:>12}{:>8.1}%{:>12.1}{:>12.1}",
                    lvl,
                    c.len(),
                    100.0 * c.len() as f64 / data.len().max(1) as f64,
                    mb / ct,
                    mb / dt
                );
            }
        }
    }
    Ok(())
}

fn append_ext(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(".rz");
    PathBuf::from(s)
}

fn strip_ext(p: &Path) -> PathBuf {
    if p.extension().is_some_and(|e| e == "rz") {
        p.with_extension("")
    } else {
        p.to_path_buf()
    }
}

fn report(src: &Path, dst: &Path, before: usize, after: usize, t: Instant) {
    println!(
        "{} -> {}: {} -> {} bytes ({:.1}%), {:.0} ms",
        src.display(),
        dst.display(),
        before,
        after,
        100.0 * after as f64 / before.max(1) as f64,
        t.elapsed().as_secs_f64() * 1e3
    );
}
