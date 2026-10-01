# textdiff

The core of `diff`, `patch` and `git merge`, re-implemented in TypeScript with
zero dependencies:

- **Myers' O(ND) diff** — shortest edit scripts, verified against an LCS oracle
- **Unified diff output** byte-compatible with GNU `diff -u` / `git diff`, including
  hunk merging and `\ No newline at end of file`
- **Patch application** that tolerates offsets, like GNU `patch`
- **Three-way merge (diff3)** with git-style conflict markers
- **Word- and character-level inline diffs** for highlighting changes within a line

```ts
import { unifiedDiff, applyPatch, merge3, diffWords } from "textdiff";

const patch = unifiedDiff(oldText, newText, { oldName: "a/invoice.txt", newName: "b/invoice.txt" });
applyPatch(oldText, patch) === newText;            // true

const { text, conflicts } = merge3(base, ours, theirs);
diffWords("The quick brown fox", "The quick red fox!");
// [ equal "The quick ", delete "brown", insert "red", equal " fox", insert "!" ]
```

## CLI

```
$ textdiff old.txt new.txt
--- old.txt
+++ new.txt
@@ -1,4 +1,5 @@
 GST rate: 18%
 HSN: 998314
-Amount: 45000
-Client: Acme
+Amount: 52000
+Client: Acme Traders
+Due: 15 days
```

```bash
textdiff old.txt new.txt -U 1 -w        # 1 line of context, ignore whitespace
textdiff old.txt new.txt --words        # inline word diff (coloured)
textdiff --apply old.txt change.diff    # apply a patch (yours or from git/GNU diff)
textdiff --merge ours.txt base.txt theirs.txt
```

Exit codes follow `diff(1)`: `0` identical, `1` different, `2` usage error.

## How it works

**Myers diff.** Picture an edit graph where moving right deletes a line of
A, moving down inserts a line of B, and diagonals (equal lines) are free.
The algorithm explores diagonals `k = x − y` in order of edit distance `d`,
keeping only the furthest-reaching point on each diagonal, and follows
"snakes" of equal lines greedily. It is O((N+M)·D): fast when files are
similar. Common prefixes and suffixes are trimmed first, so a one-line change
in a 50,000-line file is instant.

**Unified hunks.** Changes closer together than twice the context size are
merged into one hunk, exactly like `diff -u`. A missing final newline is
treated as part of the last line's identity, so `"b"` vs `"b\n"` shows up
as a change, and round-trips through `applyPatch`.

**Patching with offsets.** Each hunk is tried at its recorded line first,
then 1, 2, 3 … lines above and below. Drift from earlier hunks is carried
forward, so patches still apply after unrelated edits elsewhere.

**diff3 merge.** Both versions are diffed against the common ancestor. Lines
kept by *both* sides are stable anchors; between anchors, a chunk changed on
only one side takes that side, identical changes are taken once, and anything
else becomes a conflict with `<<<<<<<`, `|||||||`, `=======`, `>>>>>>>` markers.

## Tests

```bash
npm test
```

- 300 random pairs: edit distance equals `|A| + |B| − 2·LCS` (computed by a separate DP)
- 200 random round-trips through `unifiedDiff` → `applyPatch` with context 0–3 and missing trailing newlines
- **Interop**: patches from GNU `diff -u` apply with `applyPatch`, and patches from
  `unifiedDiff` apply with GNU `patch` (skipped automatically if the tools aren't installed)
- Offset application, malformed hunks, three-way merge cases, word diffs, and a 50k-line performance check

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
