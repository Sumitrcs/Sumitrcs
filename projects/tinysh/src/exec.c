/*
 * Execution: walks the syntax tree and runs programs.
 *
 * The three system calls every shell is built on:
 *
 *   fork()    make a copy of this process (the "child")
 *   execvp()  replace the child with another program, e.g. /bin/ls
 *   waitpid() let the shell wait for the child and get its exit status
 *
 * Between fork and exec, the child rearranges its file descriptors (0 = stdin,
 * 1 = stdout, 2 = stderr) with dup2(). That's all a pipe or a redirection is:
 * the program itself never knows its output goes to a file or another program.
 */
#define _POSIX_C_SOURCE 200809L

#include "tinysh.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

volatile sig_atomic_t sh_child_running = 0;

/* Exit status the way sh reports it: the program's exit code, or 128 + the
 * signal number if it was killed (so Ctrl-C gives 130). */
static int status_of(int wstatus) {
    if (WIFEXITED(wstatus)) return WEXITSTATUS(wstatus);
    if (WIFSIGNALED(wstatus)) return 128 + WTERMSIG(wstatus);
    return 1;
}

static int wait_for(pid_t pid) {
    int w;
    while (waitpid(pid, &w, 0) < 0) {
        if (errno != EINTR) return 1;
    }
    return status_of(w);
}

/* Children should react to Ctrl-C normally even though the shell doesn't. */
static void child_signals(void) {
    signal(SIGINT, SIG_DFL);
    signal(SIGQUIT, SIG_DFL);
}

/* ---- redirections ---- */

/* Expands a redirection target; it must be exactly one word. */
static char *redirect_target(const Redirect *r) {
    StrList fields = {0};
    expand_word(r->target, &fields);
    char *result = NULL;
    if (fields.len == 1) {
        result = fields.items[0];
        fields.items[0] = NULL;
        fields.len = 0;
    } else {
        fprintf(stderr, "tinysh: %s: ambiguous redirect\n", r->target);
    }
    strlist_free(&fields);
    return result;
}

/* Applies redirections to this process's fds. Returns 0, or 1 on error. */
static int apply_redirects(const Redirect *r) {
    for (; r; r = r->next) {
        if (r->kind == T_ERR_DUP) {
            dup2(1, 2);
            continue;
        }
        char *file = redirect_target(r);
        if (!file) return 1;
        int flags = r->kind == T_IN ? O_RDONLY
                  : r->kind == T_APPEND ? O_WRONLY | O_CREAT | O_APPEND
                  : O_WRONLY | O_CREAT | O_TRUNC;
        int fd = open(file, flags, 0644);
        if (fd < 0) {
            fprintf(stderr, "tinysh: %s: %s\n", file, strerror(errno));
            free(file);
            return 1;
        }
        free(file);
        int target = r->kind == T_IN ? 0 : r->kind == T_ERR_OUT ? 2 : 1;
        dup2(fd, target);
        close(fd);
    }
    return 0;
}

/* ---- builtins: commands that must run inside the shell itself ---- */
/* (A child process can't change the shell's directory or variables.) */

static int builtin_cd(char **argv) {
    const char *dir = argv[1];
    int print = 0;
    if (!dir) {
        dir = getenv("HOME");
        if (!dir) {
            fprintf(stderr, "tinysh: cd: HOME not set\n");
            return 1;
        }
    } else if (strcmp(dir, "-") == 0) {
        dir = getenv("OLDPWD");
        if (!dir) {
            fprintf(stderr, "tinysh: cd: OLDPWD not set\n");
            return 1;
        }
        print = 1;
    }
    char old[PATH_MAX];
    if (!getcwd(old, sizeof old)) old[0] = '\0';
    if (chdir(dir) != 0) {
        fprintf(stderr, "tinysh: cd: %s: %s\n", dir, strerror(errno));
        return 1;
    }
    char now[PATH_MAX];
    if (getcwd(now, sizeof now)) {
        setenv("OLDPWD", old, 1);
        setenv("PWD", now, 1);
        if (print) printf("%s\n", now);
    }
    return 0;
}

static int valid_name(const char *s, size_t len) {
    if (len == 0 || !(s[0] == '_' || (s[0] >= 'A' && s[0] <= 'Z') || (s[0] >= 'a' && s[0] <= 'z'))) return 0;
    for (size_t i = 1; i < len; i++) {
        char c = s[i];
        if (!(c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return 0;
    }
    return 1;
}

static int builtin_export(char **argv) {
    int status = 0;
    for (int i = 1; argv[i]; i++) {
        char *eq = strchr(argv[i], '=');
        size_t len = eq ? (size_t)(eq - argv[i]) : strlen(argv[i]);
        if (!valid_name(argv[i], len)) {
            fprintf(stderr, "tinysh: export: `%s': not a valid name\n", argv[i]);
            status = 1;
        } else if (eq) {
            char *name = strndup(argv[i], len);
            setenv(name, eq + 1, 1);
            free(name);
        }
    }
    return status;
}

static int run_builtin(char **argv) {
    const char *name = argv[0];
    if (strcmp(name, "cd") == 0) return builtin_cd(argv);
    if (strcmp(name, "export") == 0) return builtin_export(argv);
    if (strcmp(name, "unset") == 0) {
        for (int i = 1; argv[i]; i++) unsetenv(argv[i]);
        return 0;
    }
    if (strcmp(name, "pwd") == 0) {
        char buf[PATH_MAX];
        if (!getcwd(buf, sizeof buf)) {
            perror("tinysh: pwd");
            return 1;
        }
        printf("%s\n", buf);
        return 0;
    }
    if (strcmp(name, "exit") == 0) {
        fflush(stdout);
        exit(argv[1] ? atoi(argv[1]) & 0xff : sh_last_status);
    }
    return 1;
}

int is_builtin(const char *name) {
    static const char *names[] = {"cd", "export", "unset", "pwd", "exit", NULL};
    for (int i = 0; names[i]; i++) {
        if (strcmp(name, names[i]) == 0) return 1;
    }
    return 0;
}

/* ---- simple commands ---- */

/* "NAME=value" at the start of a command is a variable assignment. */
static int is_assignment(const char *word) {
    const char *eq = strchr(word, '=');
    return eq && valid_name(word, (size_t)(eq - word));
}

static void assign(const char *word) {
    const char *eq = strchr(word, '=');
    char *name = strndup(word, (size_t)(eq - word));
    StrList value = {0};
    expand_word(eq + 1, &value);
    /* An assignment's value is never split: join the fields back with spaces. */
    size_t total = 1;
    for (size_t i = 0; i < value.len; i++) total += strlen(value.items[i]) + 1;
    char *joined = calloc(total, 1);
    for (size_t i = 0; i < value.len; i++) {
        if (i) strcat(joined, " ");
        strcat(joined, value.items[i]);
    }
    setenv(name, joined, 1);
    free(joined);
    free(name);
    strlist_free(&value);
}

/* In a child process: set up and exec. Never returns. */
_Noreturn static void exec_in_child(Node *cmd, size_t first_word, StrList *argv) {
    for (size_t i = 0; i < first_word; i++) assign(cmd->words[i]);
    if (apply_redirects(cmd->redirects) != 0) _exit(1);
    if (argv->len == 0) _exit(0);
    if (is_builtin(argv->items[0])) {
        int status = run_builtin(argv->items);
        fflush(stdout);
        _exit(status);
    }
    execvp(argv->items[0], argv->items);
    /* Only reached if exec failed. */
    int code = errno == ENOENT ? 127 : 126;
    if (errno == ENOENT) {
        fprintf(stderr, "tinysh: %s: command not found\n", argv->items[0]);
    } else {
        fprintf(stderr, "tinysh: %s: %s\n", argv->items[0], strerror(errno));
    }
    _exit(code);
}

/* Runs one simple command. `in_child` is set inside a pipeline, where we are
 * already a forked child and must exec (or _exit) instead of returning. */
static int run_command(Node *cmd, int in_child) {
    size_t first = 0;
    while (first < cmd->nwords && is_assignment(cmd->words[first])) first++;
    StrList argv = {0};
    for (size_t i = first; i < cmd->nwords; i++) expand_word(cmd->words[i], &argv);

    if (in_child) exec_in_child(cmd, first, &argv);

    int status;
    if (argv.len == 0) {
        /* Only assignments and/or redirections, like "X=1" or "> empty.txt". */
        for (size_t i = 0; i < first; i++) assign(cmd->words[i]);
        int saved[3] = {dup(0), dup(1), dup(2)};
        status = apply_redirects(cmd->redirects);
        for (int fd = 0; fd < 3; fd++) {
            dup2(saved[fd], fd);
            close(saved[fd]);
        }
    } else if (is_builtin(argv.items[0])) {
        /* Run in the shell process, with redirections applied temporarily. */
        fflush(stdout);
        int saved[3] = {dup(0), dup(1), dup(2)};
        status = apply_redirects(cmd->redirects);
        if (status == 0) status = run_builtin(argv.items);
        fflush(stdout);
        for (int fd = 0; fd < 3; fd++) {
            dup2(saved[fd], fd);
            close(saved[fd]);
        }
    } else {
        fflush(stdout);
        pid_t pid = fork();
        if (pid < 0) {
            perror("tinysh: fork");
            status = 1;
        } else if (pid == 0) {
            child_signals();
            exec_in_child(cmd, first, &argv);
        } else {
            sh_child_running = 1;
            status = wait_for(pid);
            sh_child_running = 0;
        }
    }
    strlist_free(&argv);
    return status;
}

/* ---- pipelines ---- */

/* a | b | c parses as PIPE(PIPE(a, b), c); list the commands left to right. */
static void flatten(Node *n, Node **out, size_t *count) {
    if (n->type == N_PIPE) {
        flatten(n->left, out, count);
        flatten(n->right, out, count);
    } else {
        out[(*count)++] = n;
    }
}

static size_t pipe_length(Node *n) {
    return n->type == N_PIPE ? pipe_length(n->left) + pipe_length(n->right) : 1;
}

/*
 *   cmd0 ──pipe──► cmd1 ──pipe──► cmd2
 *   stdout→[1]  [0]→stdin  ...
 *
 * Every command runs in its own child at the same time; the shell waits for
 * all of them, and the pipeline's status is the last command's.
 */
static int run_pipeline(Node *n) {
    size_t count = 0;
    Node **cmds = malloc(pipe_length(n) * sizeof *cmds);
    pid_t *pids = malloc(pipe_length(n) * sizeof *pids);
    if (!cmds || !pids) abort();
    flatten(n, cmds, &count);

    fflush(stdout);
    int prev_read = -1;
    for (size_t i = 0; i < count; i++) {
        int fds[2] = {-1, -1};
        if (i + 1 < count && pipe(fds) != 0) {
            perror("tinysh: pipe");
            break;
        }
        pids[i] = fork();
        if (pids[i] == 0) {
            child_signals();
            if (prev_read != -1) {
                dup2(prev_read, 0);
                close(prev_read);
            }
            if (fds[1] != -1) {
                dup2(fds[1], 1);
                close(fds[1]);
                close(fds[0]);
            }
            _exit(run_command(cmds[i], 1));
        }
        /* The shell must close its copies, or readers never see end-of-file. */
        if (prev_read != -1) close(prev_read);
        if (fds[1] != -1) close(fds[1]);
        prev_read = fds[0];
    }
    sh_child_running = 1;
    int status = 0;
    for (size_t i = 0; i < count; i++) {
        if (pids[i] > 0) status = wait_for(pids[i]);
    }
    sh_child_running = 0;
    free(cmds);
    free(pids);
    return status;
}

/* ---- the tree ---- */

int run_node(Node *n) {
    if (!n) return sh_last_status;
    int status = 0;
    switch (n->type) {
    case N_COMMAND:
        status = run_command(n, 0);
        break;
    case N_PIPE:
        status = run_pipeline(n);
        break;
    case N_AND: /* run the right side only if the left succeeded */
        status = run_node(n->left);
        sh_last_status = status;
        if (status == 0) status = run_node(n->right);
        break;
    case N_OR: /* ...or only if it failed */
        status = run_node(n->left);
        sh_last_status = status;
        if (status != 0) status = run_node(n->right);
        break;
    case N_SEQUENCE:
        sh_last_status = run_node(n->left);
        status = run_node(n->right);
        break;
    case N_BACKGROUND: {
        fflush(stdout);
        pid_t pid = fork();
        if (pid == 0) {
            child_signals();
            signal(SIGINT, SIG_IGN); /* Ctrl-C is for the foreground job */
            int s = run_node(n->left);
            fflush(stdout);
            _exit(s);
        }
        if (pid > 0 && sh_interactive) fprintf(stderr, "[%ld]\n", (long)pid);
        status = pid > 0 ? 0 : 1;
        break;
    }
    }
    sh_last_status = status;
    return status;
}

int run_line(const char *line) {
    TokenList tokens = {0};
    const char *error = NULL;
    if (lex(line, &tokens, &error) != 0) {
        fprintf(stderr, "tinysh: syntax error: %s\n", error);
        tokens_free(&tokens);
        return sh_last_status = 2;
    }
    Node *tree = parse(&tokens, &error);
    tokens_free(&tokens);
    if (!tree) {
        if (error) {
            fprintf(stderr, "tinysh: syntax error: %s\n", error);
            sh_last_status = 2;
        }
        return sh_last_status;
    }
    int status = run_node(tree);
    node_free(tree);
    return status;
}
