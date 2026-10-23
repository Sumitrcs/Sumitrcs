/*
 * The editor: cursor movement, scrolling, drawing and commands.
 *
 * The main loop is the same as in every interactive program:
 *
 *     draw the screen → wait for a key → change the state → repeat
 *
 * The screen is redrawn from scratch every time. That sounds wasteful, but
 * it is a few kilobytes sent in one write(), and it means the screen can
 * never get out of sync with the text.
 */
#include "tinyed.h"

#include <ctype.h>
#include <errno.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define VERSION "1.0.0"
#define HELP "Ctrl-S save | Ctrl-Q quit | Ctrl-F find | Ctrl-Z undo | Ctrl-Y redo | Ctrl-G go to line | Ctrl-K cut line"

static struct {
    Buffer buf;
    int cx, cy;           /* cursor: byte offset in the row, row number */
    int want_rx;          /* the column to aim for when moving up/down */
    int rowoff, coloff;   /* first row/column shown */
    int rows, cols;       /* size of the text area */
    int gutter;           /* width of the line-number column */
    char message[200];
    time_t message_time;
    int quit_armed;       /* Ctrl-Q was pressed once with unsaved changes */
} E;

static volatile sig_atomic_t resized = 1;

static void on_resize(int sig) {
    (void)sig;
    resized = 1;
}

static void set_message(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(E.message, sizeof E.message, fmt, ap);
    va_end(ap);
    E.message_time = time(NULL);
}

static void update_size(void) {
    int rows = 24, cols = 80;
    term_size(&rows, &cols);
    E.rows = rows > 3 ? rows - 2 : 1; /* two lines for the status and message bars */
    E.cols = cols;
    resized = 0;
}

/* ---- the output buffer -------------------------------------------------
 * Everything for one frame is collected here and written at once, so the
 * terminal never shows a half-drawn screen (no flicker). */

typedef struct {
    char *data;
    size_t len, cap;
} Out;

static void out(Out *o, const char *s, size_t len) {
    if (o->len + len > o->cap) {
        o->cap = (o->len + len) * 2;
        o->data = realloc(o->data, o->cap);
        if (!o->data) exit(1);
    }
    memcpy(o->data + o->len, s, len);
    o->len += len;
}

static void outf(Out *o, const char *fmt, ...) {
    char tmp[256];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(tmp, sizeof tmp, fmt, ap);
    va_end(ap);
    if (n > 0) out(o, tmp, (size_t)n < sizeof tmp ? (size_t)n : sizeof tmp - 1);
}

/* ---- cursor and scrolling ----------------------------------------------- */

static Row *cur_row(void) { return E.cy < E.buf.nrows ? &E.buf.rows[E.cy] : NULL; }

static int cur_rx(void) { return cur_row() ? row_cx_to_rx(cur_row(), E.cx) : 0; }

static void set_cursor(Pos p) {
    E.cy = p.row;
    E.cx = p.col;
    E.want_rx = cur_rx();
}

static Pos cursor(void) { return (Pos){E.cy, E.cx}; }

static void scroll(void) {
    int digits = 1;
    for (int n = E.buf.nrows; n >= 10; n /= 10) digits++;
    E.gutter = digits + 2;
    int width = E.cols - E.gutter > 1 ? E.cols - E.gutter : 1;
    int rx = cur_rx();
    if (E.cy < E.rowoff) E.rowoff = E.cy;
    if (E.cy >= E.rowoff + E.rows) E.rowoff = E.cy - E.rows + 1;
    if (rx < E.coloff) E.coloff = rx;
    if (rx >= E.coloff + width) E.coloff = rx - width + 1;
}

/* After moving up or down, put the cursor in the remembered column, or at
 * the end of the line if it's shorter. */
static void snap_to_column(void) {
    Row *r = cur_row();
    E.cx = r ? row_rx_to_cx(r, E.want_rx) : 0;
}

static int is_word_char(char c) { return isalnum((unsigned char)c) || c == '_' || (unsigned char)c >= 0x80; }

static void move(int key) {
    Row *r = cur_row();
    switch (key) {
    case KEY_LEFT:
        if (E.cx > 0) E.cx = utf8_prev(r->chars, E.cx);
        else if (E.cy > 0) E.cx = E.buf.rows[--E.cy].len;
        E.want_rx = cur_rx();
        break;
    case KEY_RIGHT:
        if (r && E.cx < r->len) E.cx = utf8_next(r->chars, r->len, E.cx);
        else if (E.cy < E.buf.nrows - 1) E.cy++, E.cx = 0;
        E.want_rx = cur_rx();
        break;
    case KEY_CTRL_LEFT: /* to the start of the previous word */
        if (!r || E.cx == 0) {
            move(KEY_LEFT);
            return;
        }
        while (E.cx > 0 && !is_word_char(r->chars[E.cx - 1])) E.cx--;
        while (E.cx > 0 && is_word_char(r->chars[E.cx - 1])) E.cx--;
        E.want_rx = cur_rx();
        break;
    case KEY_CTRL_RIGHT: /* to the end of the next word */
        if (!r || E.cx == r->len) {
            move(KEY_RIGHT);
            return;
        }
        while (E.cx < r->len && !is_word_char(r->chars[E.cx])) E.cx++;
        while (E.cx < r->len && is_word_char(r->chars[E.cx])) E.cx++;
        E.want_rx = cur_rx();
        break;
    case KEY_UP:
        if (E.cy > 0) E.cy--;
        snap_to_column();
        break;
    case KEY_DOWN:
        if (E.cy < E.buf.nrows - 1) E.cy++;
        snap_to_column();
        break;
    case KEY_PAGE_UP:
    case KEY_PAGE_DOWN:
        E.cy += key == KEY_PAGE_UP ? -E.rows : E.rows;
        if (E.cy < 0) E.cy = 0;
        if (E.cy > E.buf.nrows - 1) E.cy = E.buf.nrows > 0 ? E.buf.nrows - 1 : 0;
        snap_to_column();
        break;
    case KEY_HOME:
        E.cx = 0;
        E.want_rx = 0;
        break;
    case KEY_END:
        E.cx = r ? r->len : 0;
        E.want_rx = cur_rx();
        break;
    }
}

/* ---- drawing ------------------------------------------------------------- */

static void draw_row(Out *o, const Row *r, int width) {
    int col = 0, color = -1;
    for (int i = 0; i < r->rlen; i++) {
        unsigned char c = (unsigned char)r->render[i];
        int starts_char = (c & 0xC0) != 0x80;
        if (starts_char && i > 0) col++;
        if (col < E.coloff) continue;
        if (col >= E.coloff + width) break;
        int want = syntax_color(r->hl[i]);
        if (want != color) {
            outf(o, "\x1b[%dm", want);
            color = want;
        }
        out(o, (const char *)&r->render[i], 1);
    }
    out(o, "\x1b[39m", 5);
}

static void draw(void) {
    scroll();
    Out o = {0};
    out(&o, "\x1b[?25l\x1b[H", 9); /* hide the cursor, go to the top left */
    int width = E.cols - E.gutter;
    for (int y = 0; y < E.rows; y++) {
        int filerow = y + E.rowoff;
        if (filerow < E.buf.nrows) {
            outf(&o, "\x1b[90m%*d \x1b[39m ", E.gutter - 2, filerow + 1);
            draw_row(&o, &E.buf.rows[filerow], width);
        } else if (E.buf.nrows == 0 && y == E.rows / 3) {
            char welcome[64];
            int n = snprintf(welcome, sizeof welcome, "tinyed %s", VERSION);
            int pad = (E.cols - n) / 2;
            outf(&o, "\x1b[90m~%*s%s\x1b[39m", pad > 1 ? pad - 1 : 0, "", welcome);
        } else {
            out(&o, "\x1b[90m~\x1b[39m", 11);
        }
        out(&o, "\x1b[K\r\n", 5); /* clear the rest of the line */
    }

    /* Status bar, in inverse video. */
    char left[160], right[80];
    int ln = snprintf(left, sizeof left, " %.80s%s - %d lines", E.buf.filename ? E.buf.filename : "[new file]",
                      E.buf.dirty ? " (modified)" : "", E.buf.nrows);
    int rn = snprintf(right, sizeof right, "%s | Ln %d, Col %d ", E.buf.syntax ? E.buf.syntax->name : "Text", E.cy + 1,
                      cur_rx() + 1);
    if (ln > E.cols - rn - 1) ln = E.cols - rn - 1; /* a long file name gives way to the position */
    if (ln < 0) ln = 0;
    if (rn > E.cols) rn = 0;
    out(&o, "\x1b[7m", 4);
    out(&o, left, (size_t)ln);
    for (int i = ln; i < E.cols; i++) {
        if (E.cols - i == rn) {
            out(&o, right, (size_t)rn);
            break;
        }
        out(&o, " ", 1);
    }
    out(&o, "\x1b[m\r\n\x1b[K", 8);

    /* Message bar: messages disappear after 5 seconds. */
    if (E.message[0] && time(NULL) - E.message_time < 5) {
        int len = (int)strlen(E.message);
        out(&o, E.message, (size_t)(len < E.cols ? len : E.cols));
    }
    outf(&o, "\x1b[%d;%dH", E.cy - E.rowoff + 1, cur_rx() - E.coloff + E.gutter + 1);
    out(&o, "\x1b[?25h", 6); /* show the cursor */
    if (write(STDOUT_FILENO, o.data, o.len) < 0) { /* the next frame will try again */ }
    free(o.data);
}

/* ---- prompts ------------------------------------------------------------ */

/* Asks for a line of text in the message bar. `on_key`, if given, is called
 * after every key (search uses it to search as you type). Returns NULL if
 * cancelled with Escape. */
static char *prompt(const char *label, void (*on_key)(const char *text, int key)) {
    size_t cap = 128, len = 0;
    char *text = malloc(cap);
    if (!text) exit(1);
    text[0] = '\0';
    int redraw = 1;
    for (;;) {
        if (resized) {
            update_size();
            redraw = 1;
        }
        if (redraw) {
            set_message("%s%s", label, text);
            draw();
        }
        int key = term_read_key();
        redraw = key != -1;
        if (key == -1) continue;
        if (key == 0x1b || key == CTRL('q')) {
            set_message("");
            if (on_key) on_key(text, 0x1b);
            free(text);
            return NULL;
        }
        if (key == '\r') {
            if (len == 0) continue;
            set_message("");
            if (on_key) on_key(text, key);
            return text;
        }
        if (key == KEY_BACKSPACE || key == CTRL('h')) {
            while (len > 0 && ((unsigned char)text[len - 1] & 0xC0) == 0x80) len--;
            if (len > 0) len--;
            text[len] = '\0';
        } else if (key < 1000 && (key >= 32 || key == '\t') && key != 127) {
            if (len + 2 > cap) {
                cap *= 2;
                text = realloc(text, cap);
                if (!text) exit(1);
            }
            text[len++] = (char)key;
            text[len] = '\0';
        }
        if (on_key) on_key(text, key);
    }
}

/* ---- search ------------------------------------------------------------- */

static struct {
    Pos start;              /* where the cursor was when the search began */
    int rowoff, coloff;
    Pos match;
    int has_match;
    int hl_row;             /* the row whose highlighting we changed, or -1 */
    unsigned char *hl_saved;
} S;

/* Index into Row.render for a byte offset into Row.chars. */
static int render_index(const Row *r, int cx) {
    int idx = 0, col = 0;
    for (int j = 0; j < cx && j < r->len; j++) {
        if (r->chars[j] == '\t') {
            int n = TAB_STOP - col % TAB_STOP;
            idx += n;
            col += n;
        } else {
            idx++;
            if (((unsigned char)r->chars[j] & 0xC0) != 0x80) col++;
        }
    }
    return idx;
}

static void unhighlight_match(void) {
    if (S.hl_row >= 0 && S.hl_row < E.buf.nrows && S.hl_saved) {
        memcpy(E.buf.rows[S.hl_row].hl, S.hl_saved, (size_t)E.buf.rows[S.hl_row].rlen);
    }
    free(S.hl_saved);
    S.hl_saved = NULL;
    S.hl_row = -1;
}

static void on_search_key(const char *query, int key) {
    unhighlight_match();
    if (key == '\r' || key == 0x1b) return;
    int forward = 1;
    Pos from = S.start;
    if (S.has_match && (key == KEY_DOWN || key == KEY_RIGHT)) {
        from = (Pos){S.match.row, S.match.col + 1};
    } else if (S.has_match && (key == KEY_UP || key == KEY_LEFT)) {
        from = S.match;
        forward = 0;
    }
    Pos found;
    S.has_match = buf_find(&E.buf, query, from, forward, &found);
    if (!S.has_match) {
        set_cursor(S.start);
        return;
    }
    S.match = found;
    set_cursor(found);
    /* Highlight the match, remembering the old colors to put them back. */
    Row *r = &E.buf.rows[found.row];
    S.hl_row = found.row;
    S.hl_saved = malloc((size_t)r->rlen + 1);
    if (!S.hl_saved) exit(1);
    memcpy(S.hl_saved, r->hl, (size_t)r->rlen);
    int a = render_index(r, found.col), b = render_index(r, found.col + (int)strlen(query));
    memset(r->hl + a, HL_MATCH, (size_t)(b - a));
    E.rowoff = found.row > E.rows / 2 ? found.row - E.rows / 2 : 0; /* show it mid-screen */
}

static void find(void) {
    S.start = cursor();
    S.rowoff = E.rowoff;
    S.coloff = E.coloff;
    S.has_match = 0;
    S.hl_row = -1;
    char *query = prompt("Search (arrows: next/previous, Enter: stop, Esc: cancel): ", on_search_key);
    if (query) {
        if (!S.has_match) set_message("Not found: %s", query);
        free(query);
    } else {
        set_cursor(S.start); /* cancelled: go back */
        E.rowoff = S.rowoff;
        E.coloff = S.coloff;
    }
}

/* ---- commands ----------------------------------------------------------- */

static void save(void) {
    if (!E.buf.filename) {
        char *name = prompt("Save as: ", NULL);
        if (!name) {
            set_message("Not saved");
            return;
        }
        E.buf.filename = name;
        E.buf.syntax = syntax_for_file(name); /* the name may tell us the language now */
        for (int i = 0; i < E.buf.nrows; i++) {
            syntax_highlight(E.buf.syntax, &E.buf.rows[i], i > 0 ? E.buf.rows[i - 1].open_comment : 0);
        }
    }
    long bytes;
    if (buf_save(&E.buf, &bytes) == 0) set_message("Saved %s (%ld bytes)", E.buf.filename, bytes);
    else set_message("Can't save %s: %s", E.buf.filename, strerror(errno));
}

static void go_to_line(void) {
    char *text = prompt("Go to line: ", NULL);
    if (!text) return;
    int n = atoi(text);
    free(text);
    if (n < 1) n = 1;
    if (n > E.buf.nrows) n = E.buf.nrows;
    set_cursor((Pos){n > 0 ? n - 1 : 0, 0});
    E.rowoff = E.cy > E.rows / 2 ? E.cy - E.rows / 2 : 0;
}

static void insert_text(const char *s, size_t len) { set_cursor(buf_type(&E.buf, cursor(), s, len)); }

static void newline(void) {
    /* Auto-indent: start the new line with the same spaces/tabs as this one. */
    Row *r = cur_row();
    int indent = 0;
    while (r && indent < E.cx && (r->chars[indent] == ' ' || r->chars[indent] == '\t')) indent++;
    char *s = malloc((size_t)indent + 2);
    if (!s) exit(1);
    s[0] = '\n';
    if (indent) memcpy(s + 1, r->chars, (size_t)indent);
    insert_text(s, (size_t)indent + 1);
    free(s);
}

static void backspace(void) {
    Row *r = cur_row();
    if (!r) return;
    if (E.cx > 0) set_cursor(buf_erase(&E.buf, (Pos){E.cy, utf8_prev(r->chars, E.cx)}, cursor()));
    else if (E.cy > 0) set_cursor(buf_erase(&E.buf, (Pos){E.cy - 1, E.buf.rows[E.cy - 1].len}, cursor()));
}

static void delete_forward(void) {
    Row *r = cur_row();
    if (!r) return;
    if (E.cx < r->len) buf_erase(&E.buf, cursor(), (Pos){E.cy, utf8_next(r->chars, r->len, E.cx)});
    else if (E.cy < E.buf.nrows - 1) buf_erase(&E.buf, cursor(), (Pos){E.cy + 1, 0});
}

/* Ctrl-K: delete the whole current line. */
static void cut_line(void) {
    if (E.buf.nrows == 0) return;
    buf_break_undo_group(&E.buf);
    Pos from = {E.cy, 0}, to = {E.cy + 1, 0};          /* the line and its newline */
    if (E.cy == E.buf.nrows - 1) {                       /* the last line has no newline after it, */
        to = (Pos){E.cy, E.buf.rows[E.cy].len};          /* so take the one before it instead */
        if (E.cy > 0) from = (Pos){E.cy - 1, E.buf.rows[E.cy - 1].len};
    }
    buf_erase(&E.buf, from, to);
    buf_break_undo_group(&E.buf);
    set_cursor((Pos){from.row, 0});
}

/* Returns 0 when the editor should exit. */
static int handle_key(int key) {
    if (key != CTRL('q')) E.quit_armed = 0;
    switch (key) {
    case CTRL('q'):
        if (E.buf.dirty && !E.quit_armed) {
            set_message("Unsaved changes! Press Ctrl-Q again to quit without saving, or Ctrl-S to save.");
            E.quit_armed = 1;
            return 1;
        }
        return 0;
    case CTRL('s'): save(); break;
    case CTRL('f'): buf_break_undo_group(&E.buf); find(); break;
    case CTRL('g'): go_to_line(); break;
    case CTRL('k'): cut_line(); break;
    case CTRL('z'): {
        Pos p;
        if (buf_undo(&E.buf, &p)) set_cursor(p);
        else set_message("Nothing to undo");
        break;
    }
    case CTRL('y'): {
        Pos p;
        if (buf_redo(&E.buf, &p)) set_cursor(p);
        else set_message("Nothing to redo");
        break;
    }
    case '\r': newline(); break;
    case KEY_BACKSPACE:
    case CTRL('h'): backspace(); break;
    case KEY_DELETE: delete_forward(); break;
    case KEY_LEFT: case KEY_RIGHT: case KEY_UP: case KEY_DOWN: case KEY_HOME: case KEY_END:
    case KEY_PAGE_UP: case KEY_PAGE_DOWN: case KEY_CTRL_LEFT: case KEY_CTRL_RIGHT:
        buf_break_undo_group(&E.buf);
        move(key);
        break;
    case 0x1b:
    case CTRL('l'): break;
    default:
        if (key == '\t' || (key >= 32 && key < 1000 && key != 127)) {
            char c = (char)key;
            insert_text(&c, 1);
        }
    }
    /* Keep the cursor inside the text. */
    if (E.cy >= E.buf.nrows) E.cy = E.buf.nrows > 0 ? E.buf.nrows - 1 : 0;
    if (cur_row() && E.cx > cur_row()->len) E.cx = cur_row()->len;
    return 1;
}

int editor_run(const char *filename) {
    buf_init(&E.buf);
    if (filename && buf_open(&E.buf, filename) != 0) {
        fprintf(stderr, "tinyed: can't open %s: %s\n", filename, strerror(errno));
        return 1;
    }
    term_raw_on();
    signal(SIGWINCH, on_resize);
    set_message(HELP);
    int redraw = 1;
    for (;;) {
        if (resized) {
            update_size();
            redraw = 1;
        }
        if (redraw) draw();
        int key = term_read_key();
        if (key == -1) {
            /* No key for 0.1 s. Redraw only if an old message should disappear. */
            redraw = E.message[0] && time(NULL) - E.message_time >= 5;
            if (redraw) E.message[0] = '\0';
            continue;
        }
        redraw = 1;
        if (!handle_key(key)) break;
    }
    if (write(STDOUT_FILENO, "\x1b[2J\x1b[H", 7) < 0) { /* exiting anyway */ }
    term_raw_off();
    buf_free(&E.buf);
    return 0;
}
