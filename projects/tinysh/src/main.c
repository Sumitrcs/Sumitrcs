/*
 * tinysh entry point.
 *
 *   tinysh                 interactive prompt
 *   tinysh -c 'commands'   run one command line
 *   tinysh script.sh       run a file, one command line per line
 */
#define _POSIX_C_SOURCE 200809L

#include "tinysh.h"

#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern volatile sig_atomic_t sh_child_running;

/* The current prompt, kept ready so the signal handler can reprint it. */
static char prompt[PATH_MAX + 8];
static size_t prompt_len;

/* Ctrl-C at the prompt: start a fresh line instead of exiting the shell.
 * (A running program gets the same signal and stops; the shell carries on.)
 * Only async-signal-safe calls like write() are allowed in here. */
static void on_sigint(int sig) {
    (void)sig;
    ssize_t ignored = write(STDOUT_FILENO, "\n", 1);
    if (!sh_child_running) ignored = write(STDOUT_FILENO, prompt, prompt_len);
    (void)ignored;
}

static void print_prompt(void) {
    char cwd[PATH_MAX];
    const char *dir = getcwd(cwd, sizeof cwd) ? cwd : "?";
    const char *home = getenv("HOME");
    size_t h = home ? strlen(home) : 0;
    if (h && strncmp(dir, home, h) == 0 && (dir[h] == '/' || !dir[h])) {
        snprintf(prompt, sizeof prompt, "~%s $ ", dir + h);
    } else {
        snprintf(prompt, sizeof prompt, "%s $ ", dir);
    }
    prompt_len = strlen(prompt);
    fputs(prompt, stdout);
    fflush(stdout);
}

/* Collect background jobs that have finished, so they don't linger as zombies. */
static void reap_background(void) {
    int w;
    pid_t pid;
    while ((pid = waitpid(-1, &w, WNOHANG)) > 0) {
        if (sh_interactive) fprintf(stderr, "[%ld] done\n", (long)pid);
    }
}

static int run_stream(FILE *in) {
    char *line = NULL;
    size_t cap = 0;
    for (;;) {
        reap_background();
        if (sh_interactive) print_prompt();
        if (getline(&line, &cap, in) < 0) break;
        run_line(line);
    }
    free(line);
    if (sh_interactive) printf("exit\n");
    return sh_last_status;
}

int main(int argc, char **argv) {
    sh_pid = (long)getpid();
    if (argc >= 3 && strcmp(argv[1], "-c") == 0) {
        run_line(argv[2]);
        fflush(stdout);
        return sh_last_status;
    }
    if (argc == 2) {
        FILE *f = fopen(argv[1], "r");
        if (!f) {
            perror(argv[1]);
            return 127;
        }
        int status = run_stream(f);
        fclose(f);
        return status;
    }
    if (argc > 2) {
        fprintf(stderr, "usage: tinysh [-c 'command'] [script]\n");
        return 2;
    }
    sh_interactive = isatty(STDIN_FILENO);
    if (sh_interactive) {
        struct sigaction sa = {0};
        sa.sa_handler = on_sigint;
        sa.sa_flags = SA_RESTART;
        sigemptyset(&sa.sa_mask);
        sigaction(SIGINT, &sa, NULL);
        signal(SIGQUIT, SIG_IGN);
    }
    return run_stream(stdin);
}
