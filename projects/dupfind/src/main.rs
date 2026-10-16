use std::fs::File;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use dupfind::sha256::{Sha256, to_hex};
use dupfind::{Options, Report, find_duplicates, hash_files, human_size, parse_size};

const USAGE: &str = "\
usage: dupfind [OPTIONS] [DIR...]          find duplicate files (default: current directory)
       dupfind hash FILE...                print SHA-256 sums, like sha256sum
       dupfind check SUMS_FILE             verify files against a sums file

options:
  --min-size SIZE   ignore files smaller than SIZE (e.g. 100K, 1M; default 1 byte)
  --skip NAME       skip directories with this name, e.g. --skip .git (repeatable)
  --threads N       hashing threads (default: one per CPU core)
  --json            machine-readable output
  -h, --help        show this help";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("hash") => cmd_hash(&args[1..]),
        Some("check") => cmd_check(&args[1..]),
        Some("-h" | "--help") => {
            println!("{USAGE}");
            Ok(true)
        }
        _ => cmd_find(&args),
    };
    match result {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(e) if e.kind() == io::ErrorKind::BrokenPipe => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("dupfind: {e}");
            ExitCode::from(2)
        }
    }
}

fn usage_error(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, format!("{msg}\n\n{USAGE}"))
}

fn cmd_find(args: &[String]) -> io::Result<bool> {
    let mut opts = Options::default();
    let mut json = false;
    let mut roots = Vec::new();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| usage_error(&format!("{name} needs a value")))
        };
        match arg.as_str() {
            "--json" => json = true,
            "--min-size" => {
                let v = value("--min-size")?;
                opts.min_size =
                    parse_size(&v).ok_or_else(|| usage_error(&format!("bad size {v:?}")))?;
            }
            "--skip" => opts.skip.push(value("--skip")?),
            "--threads" => {
                let v = value("--threads")?;
                opts.threads = v
                    .parse()
                    .map_err(|_| usage_error(&format!("bad thread count {v:?}")))?;
            }
            s if s.starts_with('-') && s.len() > 1 => {
                return Err(usage_error(&format!("unknown option {s}")));
            }
            _ => roots.push(PathBuf::from(arg)),
        }
    }
    if roots.is_empty() {
        roots.push(PathBuf::from("."));
    }

    let report = find_duplicates(&roots, &opts);
    let mut out = BufWriter::new(io::stdout().lock());
    if json {
        write_json(&mut out, &report)?;
    } else {
        write_text(&mut out, &report)?;
    }
    out.flush()?;
    for (path, err) in &report.errors {
        eprintln!("dupfind: {}: {err}", path.display());
    }
    Ok(true)
}

fn write_text(out: &mut impl Write, r: &Report) -> io::Result<()> {
    writeln!(
        out,
        "Scanned {} files ({}) in {:.2}s, reading only {} of it.",
        r.files,
        human_size(r.bytes),
        r.elapsed.as_secs_f64(),
        human_size(r.bytes_read)
    )?;
    if r.groups.is_empty() {
        return writeln!(out, "No duplicates found.");
    }
    for g in &r.groups {
        writeln!(
            out,
            "\n{} copies of {} ({} wasted)  sha256:{}…",
            g.paths.len(),
            human_size(g.size),
            human_size(g.wasted()),
            &to_hex(&g.hash)[..12]
        )?;
        for p in &g.paths {
            writeln!(out, "  {}", p.display())?;
        }
    }
    writeln!(
        out,
        "\n{} group{} of duplicates, {} extra cop{}: {} could be freed.",
        r.groups.len(),
        if r.groups.len() == 1 { "" } else { "s" },
        r.duplicate_files(),
        if r.duplicate_files() == 1 { "y" } else { "ies" },
        human_size(r.wasted())
    )
}

fn write_json(out: &mut impl Write, r: &Report) -> io::Result<()> {
    write!(
        out,
        "{{\"files\":{},\"bytes\":{},\"wasted\":{},\"groups\":[",
        r.files,
        r.bytes,
        r.wasted()
    )?;
    for (i, g) in r.groups.iter().enumerate() {
        let paths: Vec<String> = g
            .paths
            .iter()
            .map(|p| json_string(&p.to_string_lossy()))
            .collect();
        write!(
            out,
            "{}{{\"size\":{},\"sha256\":\"{}\",\"paths\":[{}]}}",
            if i > 0 { "," } else { "" },
            g.size,
            to_hex(&g.hash),
            paths.join(",")
        )?;
    }
    writeln!(out, "]}}")
}

/// Quotes a string for JSON: backslash, quote and control characters are escaped.
fn json_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `dupfind hash FILE...` prints "<sha256>  <name>", the format sha256sum uses.
fn cmd_hash(files: &[String]) -> io::Result<bool> {
    if files.is_empty() {
        return Err(usage_error(
            "hash needs at least one file (or - for standard input)",
        ));
    }
    let mut ok = true;
    let mut out = BufWriter::new(io::stdout().lock());
    let paths: Vec<&Path> = files.iter().filter(|f| *f != "-").map(Path::new).collect();
    let mut hashes = hash_files(&paths, u64::MAX, 0).into_iter();
    for name in files {
        let result = if name == "-" {
            Sha256::digest_reader(io::stdin().lock(), u64::MAX)
        } else {
            hashes.next().unwrap()
        };
        match result {
            Ok(h) => writeln!(out, "{}  {name}", to_hex(&h))?,
            Err(e) => {
                eprintln!("dupfind: {name}: {e}");
                ok = false;
            }
        }
    }
    out.flush()?;
    Ok(ok)
}

/// `dupfind check SUMS` re-hashes every file listed in a sha256sum-style file.
fn cmd_check(args: &[String]) -> io::Result<bool> {
    let [sums] = args else {
        return Err(usage_error("check needs exactly one sums file"));
    };
    let reader = BufReader::new(
        File::open(sums).map_err(|e| io::Error::new(e.kind(), format!("{sums}: {e}")))?,
    );
    let mut entries = Vec::new();
    let mut malformed = 0;
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        // "<64 hex>  name" (text mode) or "<64 hex> *name" (binary mode).
        match (line.get(..64), line.get(64..66)) {
            (Some(hex), Some("  " | " *")) if hex.bytes().all(|b| b.is_ascii_hexdigit()) => {
                entries.push((hex.to_ascii_lowercase(), line[66..].to_string()));
            }
            _ => malformed += 1,
        }
    }
    let paths: Vec<&Path> = entries.iter().map(|(_, n)| Path::new(n.as_str())).collect();
    let results = hash_files(&paths, u64::MAX, 0);
    let (mut failed, mut unreadable) = (0, 0);
    let mut out = BufWriter::new(io::stdout().lock());
    for ((want, name), got) in entries.iter().zip(results) {
        match got {
            Ok(h) if to_hex(&h) == *want => writeln!(out, "{name}: OK")?,
            Ok(_) => {
                writeln!(out, "{name}: FAILED")?;
                failed += 1;
            }
            Err(_) => {
                writeln!(out, "{name}: FAILED open or read")?;
                unreadable += 1;
            }
        }
    }
    out.flush()?;
    if malformed > 0 {
        eprintln!(
            "dupfind: WARNING: {malformed} line{} badly formatted",
            if malformed == 1 { " is" } else { "s are" }
        );
    }
    if unreadable > 0 {
        eprintln!(
            "dupfind: WARNING: {unreadable} listed file{} could not be read",
            if unreadable == 1 { "" } else { "s" }
        );
    }
    if failed > 0 {
        eprintln!(
            "dupfind: WARNING: {failed} computed checksum{} did NOT match",
            if failed == 1 { "" } else { "s" }
        );
    }
    Ok(failed == 0 && unreadable == 0 && malformed == 0 && !entries.is_empty())
}
