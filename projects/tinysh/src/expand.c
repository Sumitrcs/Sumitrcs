/*
 * Expansion: what a word turns into just before a command runs.
 *
 *   word            becomes
 *   ----------      -------------------------------------------
 *   'a $b'          a $b          single quotes: completely literal
 *   "a $HOME"       a /root       double quotes: $ works, no splitting/globbing
 *   $X  (X="1 2")   1  2          unquoted variables are split into words
 *   ~/notes         /root/notes   ~ at the start is $HOME
 *   *.c             a.c b.c       unquoted * ? [ match file names
 *   \*              *             a backslash quotes one character
 *
 * We build each resulting word ("field") twice at once: `text` is the plain
 * result, and `pattern` is the same with every *quoted* special character
 * escaped, so that glob() treats "*.c" literally but *.c as a pattern.
 */
#include "tinysh.h"

#include <ctype.h>
#include <glob.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int sh_last_status = 0;
int sh_interactive = 0;
long sh_pid = 0;

void strlist_push(StrList *l, char *s) {
    if (l->len + 2 > l->cap) {
        l->cap = l->cap ? l->cap * 2 : 8;
        l->items = realloc(l->items, l->cap * sizeof(char *));
        if (!l->items) abort();
    }
    l->items[l->len++] = s;
    l->items[l->len] = NULL; /* always NULL-terminated, ready for execvp */
}

void strlist_free(StrList *l) {
    for (size_t i = 0; i < l->len; i++) free(l->items[i]);
    free(l->items);
    l->items = NULL;
    l->len = l->cap = 0;
}

/* A growable string. */
typedef struct {
    char *s;
    size_t len, cap;
} Buf;

static void buf_add(Buf *b, char c) {
    if (b->len + 2 > b->cap) {
        b->cap = b->cap ? b->cap * 2 : 32;
        b->s = realloc(b->s, b->cap);
        if (!b->s) abort();
    }
    b->s[b->len++] = c;
    b->s[b->len] = '\0';
}

typedef struct {
    Buf text, pattern;
    int started;  /* field exists even if empty (from "" or '') */
    int has_glob; /* contains an unquoted * ? or [ */
    StrList *out;
} Field;

static void add_char(Field *f, char c, int quoted) {
    buf_add(&f->text, c);
    if (quoted && strchr("*?[]\\", c)) buf_add(&f->pattern, '\\');
    buf_add(&f->pattern, c);
    if (!quoted && strchr("*?[", c)) f->has_glob = 1;
    f->started = 1;
}

static void add_string(Field *f, const char *s, int quoted) {
    for (; *s; s++) add_char(f, *s, quoted);
}

/* Ends the current field: glob it if needed and append the result(s). */
static void finish_field(Field *f) {
    if (!f->started) return;
    glob_t g;
    if (f->has_glob && glob(f->pattern.s, 0, NULL, &g) == 0) {
        for (size_t i = 0; i < g.gl_pathc; i++) strlist_push(f->out, strdup(g.gl_pathv[i]));
        globfree(&g);
    } else {
        /* No pattern, or nothing matched: the word stays as it is (like sh). */
        strlist_push(f->out, strdup(f->text.s ? f->text.s : ""));
    }
    free(f->text.s);
    free(f->pattern.s);
    *f = (Field){.out = f->out};
}

/* Reads a variable reference starting just after '$'. Returns the value (or
 * NULL if this '$' isn't a variable) and advances *p past the name. */
static const char *variable(const char **p, char *scratch, size_t scratch_len) {
    const char *s = *p;
    if (*s == '?') {
        snprintf(scratch, scratch_len, "%d", sh_last_status);
        *p = s + 1;
        return scratch;
    }
    if (*s == '$') {
        snprintf(scratch, scratch_len, "%ld", sh_pid);
        *p = s + 1;
        return scratch;
    }
    if (*s >= '0' && *s <= '9') {
        /* Positional parameters: $0 is the shell's name; tinysh doesn't take
         * script arguments, so $1 ... $9 are always empty. */
        *p = s + 1;
        return *s == '0' ? "tinysh" : "";
    }
    int braced = *s == '{';
    const char *name = s + braced;
    size_t n = 0;
    if (!(isalpha((unsigned char)name[0]) || name[0] == '_')) return NULL;
    while (isalnum((unsigned char)name[n]) || name[n] == '_') n++;
    if (braced && name[n] != '}') return NULL;
    if (n >= scratch_len) n = scratch_len - 1;
    memcpy(scratch, name, n);
    scratch[n] = '\0';
    *p = name + n + braced;
    const char *value = getenv(scratch);
    return value ? value : "";
}

void expand_word(const char *w, StrList *out) {
    Field f = {.out = out};
    char scratch[256];
    const char *p = w;

    if (p[0] == '~' && (p[1] == '/' || p[1] == '\0')) {
        const char *home = getenv("HOME");
        add_string(&f, home ? home : "~", 1);
        p++;
    }
    while (*p) {
        char c = *p++;
        if (c == '\'') {
            f.started = 1;
            while (*p && *p != '\'') add_char(&f, *p++, 1);
            if (*p) p++;
        } else if (c == '"') {
            f.started = 1;
            while (*p && *p != '"') {
                if (*p == '\\' && p[1] && strchr("$`\"\\", p[1])) {
                    add_char(&f, p[1], 1);
                    p += 2;
                } else if (*p == '$') {
                    p++;
                    const char *v = variable(&p, scratch, sizeof scratch);
                    if (v) add_string(&f, v, 1); else add_char(&f, '$', 1);
                } else {
                    add_char(&f, *p++, 1);
                }
            }
            if (*p) p++;
        } else if (c == '\\') {
            if (*p) add_char(&f, *p++, 1);
        } else if (c == '$') {
            const char *v = variable(&p, scratch, sizeof scratch);
            if (!v) {
                add_char(&f, '$', 0);
                continue;
            }
            /* Unquoted: split on blanks into separate fields. */
            for (; *v; v++) {
                if (*v == ' ' || *v == '\t' || *v == '\n') {
                    finish_field(&f);
                } else {
                    add_char(&f, *v, 0);
                }
            }
        } else {
            add_char(&f, c, 0);
        }
    }
    finish_field(&f);
}
