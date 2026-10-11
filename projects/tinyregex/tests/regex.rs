use std::time::{Duration, Instant};

use tinyregex::Regex;

/// (pattern, text, expected match as a byte range)
type Case = (&'static str, &'static str, Option<(usize, usize)>);

const FIND: &[Case] = &[
    // literals and concatenation
    ("abc", "xxabcxx", Some((2, 5))),
    ("abc", "ab", None),
    ("", "abc", Some((0, 0))),
    // alternation is leftmost-first, like Perl/Python, not longest
    ("a|ab", "ab", Some((0, 1))),
    ("ab|a", "ab", Some((0, 2))),
    ("cat|dog", "hotdog", Some((3, 6))),
    // repetition
    ("a*", "aaab", Some((0, 3))),
    ("a+", "baaa", Some((1, 4))),
    ("colou?r", "color colour", Some((0, 5))),
    ("a{3}", "aaaa", Some((0, 3))),
    ("a{2,}", "a aaaaa", Some((2, 7))),
    ("a{2,3}", "aaaa", Some((0, 3))),
    ("x{0}y", "xy", Some((1, 2))),
    // lazy repetition
    ("<.+>", "<a><b>", Some((0, 6))),
    ("<.+?>", "<a><b>", Some((0, 3))),
    ("a{2,4}?", "aaaa", Some((0, 2))),
    ("a??b", "ab", Some((0, 2))),
    // dot and classes
    ("a.c", "abc", Some((0, 3))),
    ("a.c", "a\nc", None),
    ("(?s)a.c", "a\nc", Some((0, 3))),
    ("[0-9]+", "abc 2026", Some((4, 8))),
    ("[^aeiou ]+", "a rhythm", Some((2, 8))),
    ("[]a]+", "x]a]", Some((1, 4))),
    ("[a-]+", "x-a-", Some((1, 4))),
    (r"[\d.]+", "v1.2.3", Some((1, 6))),
    (r"\d+", "abc123", Some((3, 6))),
    (r"\w+", "  hello_42!", Some((2, 10))),
    (r"\s+", "a \t\nb", Some((1, 4))),
    (r"\S+", "  ab ", Some((2, 4))),
    // anchors
    ("^abc", "abc", Some((0, 3))),
    ("^abc", "xabc", None),
    ("abc$", "abcabc", Some((3, 6))),
    ("^$", "", Some((0, 0))),
    ("(?m)^b", "a\nb", Some((2, 3))),
    ("^b", "a\nb", None),
    ("(?m)a$", "a\nb", Some((0, 1))),
    (r"\bcat\b", "concat cat", Some((7, 10))),
    (r"\Bcat", "cat concat", Some((7, 10))),
    // case-insensitive
    ("(?i)hello", "Say HeLLo", Some((4, 9))),
    ("(?i)[a-c]+", "xABCa", Some((1, 5))),
    ("(?i)[^a]", "Ab", Some((1, 2))),
    ("(?i)straße", "STRASSE straße", Some((8, 15))),
    // escapes
    (r"a\.b", "axb a.b", Some((4, 7))),
    (r"\x41\x{1F600}", "A😀", Some((0, 5))),
    (r"\(\)", "f()", Some((1, 3))),
    // literal braces that are not repetitions
    ("a{x}", "a{x}", Some((0, 4))),
    // unicode: offsets are bytes, but . matches a whole character
    ("é.", "café!", Some((3, 6))),
    ("[α-ω]+", "abc λx", Some((4, 6))),
];

#[test]
fn find_table() {
    for &(pattern, text, want) in FIND {
        let re = Regex::new(pattern).unwrap_or_else(|e| panic!("{pattern}: {e}"));
        let got = re.find(text).map(|m| (m.start(), m.end()));
        assert_eq!(got, want, "pattern {pattern:?} on {text:?}");
    }
}

#[test]
fn captures_by_number_and_name() {
    let re = Regex::new(r"(?<year>\d{4})-(?<month>\d{2})-(\d{2})").unwrap();
    let caps = re.captures("due 2026-10-11!").unwrap();
    assert_eq!(&caps[0], "2026-10-11");
    assert_eq!(&caps["year"], "2026");
    assert_eq!(&caps["month"], "10");
    assert_eq!(&caps[3], "11");
    assert_eq!(caps.len(), 4);
    assert_eq!(
        re.capture_names().collect::<Vec<_>>(),
        vec![None, Some("year"), Some("month"), None]
    );
}

#[test]
fn groups_that_do_not_take_part() {
    let caps = Regex::new("(a)|(b)").unwrap().captures("b").unwrap();
    assert!(caps.get(1).is_none());
    assert_eq!(caps.get(2).unwrap().range(), 0..1);
}

#[test]
fn a_repeated_group_keeps_its_last_iteration() {
    let caps = Regex::new("(?:(a|b))+").unwrap().captures("abba").unwrap();
    assert_eq!(&caps[1], "a");
    let caps = Regex::new(r"(\w)+").unwrap().captures("xyz").unwrap();
    assert_eq!(caps.get(1).unwrap().range(), 2..3);
}

#[test]
fn empty_iterations_match_backtracking_engines() {
    // Python, Perl and JavaScript all give an empty match here.
    let re = Regex::new("(|a)*").unwrap();
    let caps = re.captures("aa").unwrap();
    assert_eq!(caps.get(0).unwrap().range(), 0..0);
    assert_eq!(caps.get(1).unwrap().range(), 0..0);
    let caps = Regex::new("(a*)*").unwrap().captures("b").unwrap();
    assert_eq!(caps.get(1).unwrap().range(), 0..0);
}

#[test]
fn find_iter_and_empty_matches() {
    let words: Vec<&str> = Regex::new(r"\w+")
        .unwrap()
        .find_iter("one, two;three")
        .map(|m| m.as_str())
        .collect();
    assert_eq!(words, ["one", "two", "three"]);

    // Same positions as Python's re.finditer('a*', 'baaa').
    let spans: Vec<_> = Regex::new("a*")
        .unwrap()
        .find_iter("baaa")
        .map(|m| m.range())
        .collect();
    assert_eq!(spans, [0..0, 1..4, 4..4]);

    // An empty pattern matches between every character, never inside one.
    let spans: Vec<_> = Regex::new("")
        .unwrap()
        .find_iter("é😀")
        .map(|m| m.start())
        .collect();
    assert_eq!(spans, [0, 2, 6]);
}

#[test]
fn find_at_still_sees_the_text_before_start() {
    let re = Regex::new(r"\bb").unwrap();
    assert_eq!(re.find_at("ab b", 1).map(|m| m.start()), Some(3));
    assert!(Regex::new("^b").unwrap().find_at("ab", 1).is_none());
}

#[test]
fn replace_and_split() {
    let re = Regex::new(r"(?<d>\d{2})/(?<m>\d{2})/(?<y>\d{4})").unwrap();
    assert_eq!(
        re.replace_all("from 11/10/2026 to 31/12/2026", "$y-$m-$d"),
        "from 2026-10-11 to 2026-12-31"
    );
    assert_eq!(re.replace_all("11/10/2026", "${y}${m}"), "202610");
    assert_eq!(
        re.replace("11/10/2026 01/01/2027", "<$0>"),
        "<11/10/2026> 01/01/2027"
    );
    assert_eq!(
        Regex::new("x").unwrap().replace_all("axb", "$$5 $9 $"),
        "a$5  $b"
    );

    let re = Regex::new(r"\s*,\s*").unwrap();
    assert_eq!(re.split("a , b,c ,d"), ["a", "b", "c", "d"]);
    assert_eq!(Regex::new("").unwrap().split("abc"), ["a", "b", "c"]);
}

#[test]
fn errors_point_at_the_problem() {
    for (pattern, message) in [
        ("(a", "unclosed '(' at position 0"),
        ("a)", "unmatched ')' at position 1"),
        ("[abc", "unclosed '[' at position 0"),
        (
            "+a",
            "nothing to repeat before this quantifier at position 0",
        ),
        (
            "a(?i)b",
            "flags like (?i) are only supported at the very start of the pattern at position 3",
        ),
        ("(?<n>a)(?<n>b)", "duplicate group name 'n' at position 10"),
        (
            r"\xZZ",
            "invalid \\x escape; use \\x41 or \\x{1F600} at position 0",
        ),
        (
            r"[a-\d]",
            "a range cannot end in a class like \\d at position 2",
        ),
    ] {
        assert_eq!(
            Regex::new(pattern).unwrap_err().to_string(),
            message,
            "{pattern}"
        );
    }
}

/// The reason to build a Pike VM: these patterns take exponential time in a
/// backtracking engine (try them in Python with n = 30), but run in linear
/// time here.
#[test]
fn no_catastrophic_backtracking() {
    let n = 30;
    let evil = [
        (format!("(?:a?){{{n}}}a{{{n}}}"), "a".repeat(n)),
        ("(a|a)*b".to_string(), "a".repeat(5000)),
        ("(a+)+$".to_string(), format!("{}!", "a".repeat(5000))),
        (
            r"^(\w+\s?)*$".to_string(),
            format!("{}!", "word ".repeat(1000)),
        ),
    ];
    for (pattern, text) in evil {
        let started = Instant::now();
        let _ = Regex::new(&pattern).unwrap().is_match(&text);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{pattern} took {:?}",
            started.elapsed()
        );
    }
}

#[test]
fn time_grows_linearly_with_input() {
    let re = Regex::new("(a|aa)*c").unwrap();
    let time = |n: usize| {
        let text = "a".repeat(n);
        let started = Instant::now();
        assert!(!re.is_match(&text));
        started.elapsed()
    };
    time(1000); // warm up
    let small = time(20_000);
    let large = time(80_000);
    // 4× the input should take roughly 4× the time; allow plenty of noise.
    assert!(
        large < small * 16 + Duration::from_millis(50),
        "{small:?} vs {large:?}"
    );
}

#[test]
fn regex_can_be_shared_between_threads() {
    let re = std::sync::Arc::new(Regex::new(r"\d+").unwrap());
    let handles: Vec<_> = (0..4)
        .map(|i| {
            let re = re.clone();
            std::thread::spawn(move || {
                re.find(&format!("t{i}x{}", i * 111))
                    .unwrap()
                    .as_str()
                    .to_string()
            })
        })
        .collect();
    let results: Vec<String> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results, ["0", "1", "2", "3"]);
}
