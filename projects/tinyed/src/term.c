/*
 * The terminal.
 *
 * Normally the terminal is in "cooked" mode: it collects a whole line,
 * echoes what you type and handles Backspace and Ctrl-C itself. An editor
 * needs every key the moment it is pressed, so it switches to "raw" mode.
 *
 * Special keys don't arrive as one byte. The Up arrow, for example, sends
 * three: ESC [ A. key_decode() turns those escape sequences into codes.
 */
#include "tinyed.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

static struct termios original;
static int raw_enabled;

void term_raw_off(void) {
    if (!raw_enabled) return;
    /* Leave the alternate screen, so the shell's text comes back. */
    if (write(STDOUT_FILENO, "\x1b[?1049l", 8) < 0) { /* nothing more we can do */ }
    tcsetattr(STDIN_FILENO, TCSAFLUSH, &original);
    raw_enabled = 0;
}

void term_raw_on(void) {
    if (tcgetattr(STDIN_FILENO, &original) == -1) {
        perror("tinyed: not a terminal");
        exit(1);
    }
    struct termios raw = original;
    raw.c_iflag &= ~(tcflag_t)(BRKINT | ICRNL | INPCK | ISTRIP | IXON); /* no Ctrl-S/Ctrl-Q flow control, keep \r */
    raw.c_oflag &= ~(tcflag_t)OPOST;                                    /* we write \r\n ourselves */
    raw.c_cflag |= CS8;
    raw.c_lflag &= ~(tcflag_t)(ECHO | ICANON | IEXTEN | ISIG);          /* no echo, no line buffering, Ctrl-C is a key */
    raw.c_cc[VMIN] = 0;                                                 /* read() returns after... */
    raw.c_cc[VTIME] = 1;                                                /* ...at most 0.1 s, even with no input */
    if (tcsetattr(STDIN_FILENO, TCSAFLUSH, &raw) == -1) {
        perror("tinyed: tcsetattr");
        exit(1);
    }
    raw_enabled = 1;
    atexit(term_raw_off);
    if (write(STDOUT_FILENO, "\x1b[?1049h", 8) < 0) { /* alternate screen: optional */ }
}

/* Decodes one key from the start of seq. Sets *consumed to the number of
 * bytes used. */
int key_decode(const unsigned char *seq, int n, int *consumed) {
    *consumed = 1;
    if (n <= 0) return -1;
    if (seq[0] != 0x1b || n == 1) return seq[0];
    static const struct { const char *seq; int key; } table[] = {
        {"[A", KEY_UP}, {"[B", KEY_DOWN}, {"[C", KEY_RIGHT}, {"[D", KEY_LEFT},
        {"OA", KEY_UP}, {"OB", KEY_DOWN}, {"OC", KEY_RIGHT}, {"OD", KEY_LEFT},
        {"[H", KEY_HOME}, {"[F", KEY_END}, {"OH", KEY_HOME}, {"OF", KEY_END},
        {"[1~", KEY_HOME}, {"[7~", KEY_HOME}, {"[4~", KEY_END}, {"[8~", KEY_END},
        {"[3~", KEY_DELETE}, {"[5~", KEY_PAGE_UP}, {"[6~", KEY_PAGE_DOWN},
        {"[1;5C", KEY_CTRL_RIGHT}, {"[1;5D", KEY_CTRL_LEFT},
    };
    for (size_t i = 0; i < sizeof table / sizeof table[0]; i++) {
        int len = (int)strlen(table[i].seq);
        if (n - 1 >= len && memcmp(seq + 1, table[i].seq, (size_t)len) == 0) {
            *consumed = 1 + len;
            return table[i].key;
        }
    }
    return 0x1b; /* a lone Escape, or a sequence we don't know */
}

/* Waits for a key. Returns -1 if none arrived within 0.1 s (so the caller
 * can check for a window resize). */
int term_read_key(void) {
    static unsigned char pending[32];
    static int npending;
    if (npending == 0) {
        ssize_t r = read(STDIN_FILENO, pending, sizeof pending);
        if (r < 0 && errno != EAGAIN && errno != EINTR) {
            perror("tinyed: read");
            exit(1);
        }
        if (r <= 0) return -1;
        npending = (int)r;
    }
    int used;
    int key = key_decode(pending, npending, &used);
    memmove(pending, pending + used, (size_t)(npending - used));
    npending -= used;
    return key;
}

int term_size(int *rows, int *cols) {
    struct winsize ws;
    if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &ws) == -1 || ws.ws_col == 0) return -1;
    *rows = ws.ws_row;
    *cols = ws.ws_col;
    return 0;
}
