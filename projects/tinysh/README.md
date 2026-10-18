# tinysh

[![CI](https://github.com/Sumitrcs/tinysh/actions/workflows/ci.yml/badge.svg)](https://github.com/Sumitrcs/tinysh/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

A small Unix shell written in C, the classic operating-systems project, done carefully and explained step by step.
It runs programs, connects them with pipes, redirects files, expands variables and wildcards, and handles Ctrl-C the way you'd expect.
That's about 1,000 lines of commented C11 with no dependencies beyond POSIX.

```text
~ $ ls *.c | wc -l
2
~ $ grep an fruits.txt | tr a-z A-Z > out.txt && cat out.txt
BANANA
~ $ X="two words"; echo $X "$X"
two words two words
~ $ nosuchcmd || echo "exit status was $?"
tinysh: nosuchcmd: command not found
exit status was 127
~ $ sleep 30
^C
~ $ echo $?
130
~ $ sleep 1 &
[3366]
~ $ echo after
after
[3366] done
```

## What it supports

| Feature | Examples |
|---|---|
| Running programs (searched in `$PATH`) | `ls -l`, `./script.sh`, `/usr/bin/env` |
| Pipelines of any length | `cat log \| grep ERROR \| sort \| uniq -c` |
| Redirections | `< in`, `> out`, `>> append`, `2> errors`, `2>&1` |
| Conditionals and sequences | `make && ./app`, `test -f x \|\| touch x`, `a; b; c` |
| Background jobs | `long-task &` (reported when done) |
| Quotes and escapes | `'literal $X'`, `"expand $X"`, `\*` |
| Variables | `X=1`, `$X`, `${X}`, `$?`, `$$`, `export`, `unset`, `NAME=v cmd` |
| Expansion | `~`, wildcards `* ? [ab]`, splitting of unquoted `$X` |
| Builtins | `cd` (also `cd -`), `pwd`, `export`, `unset`, `exit` |
| Comments, scripts | `# ...`, `tinysh script.sh`, `tinysh -c '...'` |

Not included, deliberately, to keep it readable: `if`/`for`/`while`, functions, job control (`fg`/`bg`), and here-documents. They're good exercises.

## Build and run

```bash
make                 # → build/tinysh
./build/tinysh       # interactive prompt
make test            # 70 tests, most of them compared against /bin/sh
make sanitize        # the same tests under AddressSanitizer + UBSan
```

## How it works

Every line goes through four stages, one file each:

```text
"ls *.c | wc -l > n.txt"
   │ lexer.c    tokens:    ls  *.c  |  wc  -l  >  n.txt
   │ parser.c   tree:      PIPE( CMD[ls *.c],  CMD[wc -l] with >n.txt )
   │ expand.c   words:     ls a.c b.c          (done just before running)
   ▼ exec.c     fork, pipe, dup2, execvp, waitpid
```

### 1. Lexer: where does a word end?

The lexer splits on spaces and on the operators `| || & && ; < > >> 2> 2>&1`, but **not** inside quotes.
So `echo "a | b"` is two tokens: `echo` and `"a | b"`. Quotes stay attached to the word for now, because their meaning (no splitting, no wildcards) only matters later.

### 2. Parser: precedence by layers

A recursive-descent parser builds a tree. Each grammar rule is a function, and the layering gives the precedence. `|` binds tightest, then `&&`/`||`, then `;`/`&`:

```text
list      := and_or ( (';' | '&') and_or )*
and_or    := pipeline ( ('&&' | '||') pipeline )*
pipeline  := command ( '|' command )*
command   := ( WORD | redirect )+
```

So `a | b && c ; d` means `((a | b) && c) ; d`.

### 3. Expansion: happens at run time

`$?` must be the status of the *previous* command, so words are expanded just before each command runs, not when the line is read. One word can become zero, one or many arguments:

```text
'a $b'        →  a $b            single quotes: completely literal
"a $HOME"     →  a /home/sumit   double quotes: variables, but no splitting
$X (="1 2")   →  1   2           unquoted variables split into words
*.c           →  a.c b.c         unquoted wildcards match files (glob)
"*.c"         →  *.c             ...quoted ones don't
```

### 4. Execution: fork, dup2, exec, wait

Three system calls do almost everything:

```c
pid_t pid = fork();              // copy the shell: now there are two processes
if (pid == 0) {                  // in the child:
    dup2(fd, 1);                 //   point stdout at a file or pipe
    execvp(argv[0], argv);       //   become the program (never returns if it works)
}
waitpid(pid, &status, 0);        // in the shell: wait, then read the exit status
```

- **A pipe** `a | b` is a kernel buffer with a write end and a read end. The shell forks both commands, points `a`'s stdout at the write end and `b`'s stdin at the read end, and both run at the same time. The shell must **close its own copies** of the pipe, otherwise `b` would never see end-of-file and would hang forever. That is the classic shell bug.
- **A redirection** `> out.txt` is just `open()` + `dup2()` in the child before `exec`. The program has no idea its output goes to a file.
- **Builtins** like `cd` can't run in a child: a child changing *its* directory doesn't change the shell's. So they run inside the shell, with redirections applied temporarily and then undone.
- **Exit status**: a program's exit code, or 128 + the signal number if it was killed. That's why Ctrl-C gives 130 (SIGINT is 2).

### Ctrl-C

The shell installs a handler for SIGINT instead of ignoring it.
That difference matters: an *ignored* signal stays ignored across `exec`, so the programs you run couldn't be stopped with Ctrl-C at all. A *handled* signal is reset to the default in the new program.
Pressing Ctrl-C therefore kills the running program, while the shell just prints a fresh prompt.

## How it's tested

`tests/cases.txt` holds 59 command lines covering quoting, expansion, wildcards, pipes, redirections, `&&`/`||`, `cd`, `export`, exit codes and comments.
`tests/run_tests.sh` runs each line in **both** tinysh and the system's `/bin/sh` (dash) in a fresh scratch folder, and checks that stdout and the exit status are identical.
More checks cover tinysh's own error messages, script files, stdin mode and a 12-stage pipeline (to catch descriptor leaks and deadlocks).
The whole suite also runs under AddressSanitizer and UndefinedBehaviorSanitizer, with leak detection, on gcc and clang.
Interactive behaviour (the prompt, Ctrl-C, background jobs) was checked in a real pseudo-terminal.

## What you'll learn

- How a shell really works: lexing, parsing, expansion and execution as separate stages
- Processes: `fork`, `execvp`, `waitpid`, exit statuses and signals
- File descriptors: `pipe`, `dup2`, `open`, and why forgetting `close` causes hangs
- Recursive-descent parsing with operator precedence
- POSIX details that surprise people: why `cd` must be a builtin, quoting rules, field splitting, globbing with `glob(3)`
- Differential testing: using an existing implementation as the oracle

## Try it yourself

1. **`if` and `while`.** Add `if cmd; then ...; fi`. The parser needs a new node type, and execution is a few lines.
2. **Here-documents.** Support `cat <<EOF` ... `EOF` by reading lines until the marker and feeding them through a pipe.
3. **Job control.** Put each pipeline in its own process group (`setpgid`) and implement `jobs`, `fg` and `bg` with `tcsetpgrp`.
4. **Command substitution.** Make `$(date)` run a command and insert its output. Hint: a pipe and a fork inside `expand.c`.
5. **History.** Keep the last 100 lines and support `!!` and `history`. Then add arrow keys with raw terminal mode (`termios`).

## License

MIT © Sumit ([@Sumitrcs](https://github.com/Sumitrcs))
