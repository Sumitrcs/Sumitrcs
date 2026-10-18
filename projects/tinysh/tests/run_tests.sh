#!/bin/sh
# Differential tests: every line of cases.txt is run by tinysh and by the
# system /bin/sh; stdout and exit status must match. Then a few checks of
# behaviour that is tinysh-specific (error messages).
#
#   sh tests/run_tests.sh build/tinysh

SHELL_UNDER_TEST=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
pass=0
fail=0

setup() {
    rm -rf "$WORK/box"
    mkdir -p "$WORK/box/sub"
    cd "$WORK/box" || exit 1
    : > a.c; : > b.c; : > notes.txt
    printf 'echo hi\n' > not-executable.sh
}

check() { # name, expected, actual
    if [ "$2" = "$3" ]; then
        pass=$((pass + 1))
    else
        fail=$((fail + 1))
        printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' "$1" "$2" "$3"
    fi
}

# 1. Differential tests against /bin/sh.
while IFS= read -r line; do
    case $line in ''|'#'*) continue ;; esac
    setup
    want=$(HOME=/home/tester /bin/sh -c "$line" 2>/dev/null; echo "exit=$?")
    setup
    got=$(HOME=/home/tester "$SHELL_UNDER_TEST" -c "$line" 2>/dev/null; echo "exit=$?")
    check "$line" "$want" "$got"
done < "$HERE/cases.txt"

# 2. tinysh's own messages and features.
setup
check "command not found message" \
    "tinysh: nope: command not found" "$("$SHELL_UNDER_TEST" -c 'nope' 2>&1)"
check "syntax error: dangling pipe" \
    "tinysh: syntax error: expected a command after |" "$("$SHELL_UNDER_TEST" -c 'echo a |' 2>&1)"
check "syntax error: unterminated quote" \
    "tinysh: syntax error: unterminated \" quote" "$("$SHELL_UNDER_TEST" -c 'echo "abc' 2>&1)"
check "syntax error status" "2" "$("$SHELL_UNDER_TEST" -c '&& echo x' 2>/dev/null; echo $?)"
check "missing redirect target" \
    "tinysh: syntax error: expected a file name after a redirection" "$("$SHELL_UNDER_TEST" -c 'echo >' 2>&1)"
check "ambiguous redirect" \
    "tinysh: *.c: ambiguous redirect" "$("$SHELL_UNDER_TEST" -c 'echo x > *.c' 2>&1)"
check "cd -" "$WORK/box" "$(cd "$WORK/box/sub" && "$SHELL_UNDER_TEST" -c 'cd ..; cd sub; cd - ' 2>&1)"
check "invalid export name" \
    "tinysh: export: \`1x=2': not a valid name" "$("$SHELL_UNDER_TEST" -c 'export 1x=2' 2>&1)"

# 3. Running a script file, line by line.
printf 'echo line one\nX=two\necho line $X\nfalse\n' > script.sh
check "script file" "line one
line two
exit=1" "$("$SHELL_UNDER_TEST" script.sh; echo "exit=$?")"

# 4. Commands from standard input (not a terminal: no prompt).
check "stdin mode" "piped" "$(echo 'echo piped' | "$SHELL_UNDER_TEST")"

# 5. A long pipeline must not deadlock or leak descriptors.
check "long pipeline" "7" "$("$SHELL_UNDER_TEST" -c 'seq 100000 | cat | cat | cat | cat | cat | cat | tail -1 | wc -c | tr -d " " | cat | cat')"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
