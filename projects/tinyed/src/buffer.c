/*
 * The text being edited, stored as an array of rows (lines).
 *
 * Every change goes through two functions: buf_insert() adds text (which
 * may contain newlines) at a position, and buf_delete() removes the text
 * between two positions. Undo is built on that: each change is recorded as
 * "inserted TEXT at POS" or "deleted TEXT at POS", and undoing it is simply
 * doing the opposite.
 */
#include "tinyed.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void *xrealloc(void *p, size_t n) {
    p = realloc(p, n ? n : 1);
    if (!p) {
        perror("tinyed: out of memory");
        exit(1);
    }
    return p;
}

int pos_cmp(Pos a, Pos b) {
    if (a.row != b.row) return a.row < b.row ? -1 : 1;
    if (a.col != b.col) return a.col < b.col ? -1 : 1;
    return 0;
}

/* ---- UTF-8 -------------------------------------------------------------
 * A character like é or न takes 2-3 bytes in UTF-8. Every byte after the
 * first looks like 10xxxxxx, so to move one *character* we skip those. */

static int is_continuation(unsigned char c) { return (c & 0xC0) == 0x80; }

int utf8_prev(const char *s, int i) {
    if (i > 0) i--;
    while (i > 0 && is_continuation((unsigned char)s[i])) i--;
    return i;
}

int utf8_next(const char *s, int len, int i) {
    if (i < len) i++;
    while (i < len && is_continuation((unsigned char)s[i])) i++;
    return i;
}

/* ---- rows ------------------------------------------------------------- */

/* Byte offset in chars → screen column (tabs are wide, UTF-8 sequences one column). */
int row_cx_to_rx(const Row *r, int cx) {
    int rx = 0;
    for (int j = 0; j < cx && j < r->len; j++) {
        unsigned char c = (unsigned char)r->chars[j];
        if (c == '\t') rx += TAB_STOP - rx % TAB_STOP;
        else if (!is_continuation(c)) rx++;
    }
    return rx;
}

int row_rx_to_cx(const Row *r, int rx) {
    int cur = 0, cx = 0;
    while (cx < r->len) {
        int next = cur + (r->chars[cx] == '\t' ? TAB_STOP - cur % TAB_STOP : 1);
        if (next > rx) break;
        cur = next;
        cx = utf8_next(r->chars, r->len, cx);
    }
    return cx;
}

/* Rebuild a row's render text and highlighting after its chars changed. */
void buf_update_row(Buffer *b, int at) {
    Row *r = &b->rows[at];
    int tabs = 0;
    for (int j = 0; j < r->len; j++) tabs += r->chars[j] == '\t';
    free(r->render);
    r->render = xrealloc(NULL, (size_t)r->len + (size_t)tabs * (TAB_STOP - 1) + 1);
    int n = 0, col = 0;
    for (int j = 0; j < r->len; j++) {
        unsigned char c = (unsigned char)r->chars[j];
        if (c == '\t') {
            do r->render[n++] = ' '; while (++col % TAB_STOP);
        } else {
            /* Control characters would confuse the terminal: show them as '?'. */
            r->render[n++] = c < 32 || c == 127 ? '?' : (char)c;
            if (!is_continuation(c)) col++;
        }
    }
    r->render[n] = '\0';
    r->rlen = n;
    syntax_update_all(b, at);
}

static void row_insert(Buffer *b, int at, const char *s, size_t len) {
    if (b->nrows == b->cap) {
        b->cap = b->cap ? b->cap * 2 : 16;
        b->rows = xrealloc(b->rows, sizeof(Row) * (size_t)b->cap);
    }
    memmove(&b->rows[at + 1], &b->rows[at], sizeof(Row) * (size_t)(b->nrows - at));
    Row *r = &b->rows[at];
    memset(r, 0, sizeof *r);
    r->chars = xrealloc(NULL, len + 1);
    memcpy(r->chars, s, len);
    r->chars[len] = '\0';
    r->len = (int)len;
    b->nrows++;
    buf_update_row(b, at);
}

static void row_free(Row *r) {
    free(r->chars);
    free(r->render);
    free(r->hl);
}

static void row_delete(Buffer *b, int at) {
    row_free(&b->rows[at]);
    memmove(&b->rows[at], &b->rows[at + 1], sizeof(Row) * (size_t)(b->nrows - at - 1));
    b->nrows--;
}

static void row_append(Row *r, const char *s, size_t len) {
    r->chars = xrealloc(r->chars, (size_t)r->len + len + 1);
    memcpy(r->chars + r->len, s, len);
    r->len += (int)len;
    r->chars[r->len] = '\0';
}

/* ---- the buffer ------------------------------------------------------- */

void buf_init(Buffer *b) {
    memset(b, 0, sizeof *b);
    b->final_newline = 1;
}

static void edits_clear(EditList *l) {
    for (int i = 0; i < l->count; i++) free(l->items[i].text);
    l->count = 0;
}

void buf_free(Buffer *b) {
    for (int i = 0; i < b->nrows; i++) row_free(&b->rows[i]);
    free(b->rows);
    edits_clear(&b->undo);
    edits_clear(&b->redo);
    free(b->undo.items);
    free(b->redo.items);
    free(b->filename);
    buf_init(b);
}

/* Where the cursor ends up after inserting text at `at`. */
static Pos pos_after(Pos at, const char *text, size_t len) {
    for (size_t i = 0; i < len; i++) {
        if (text[i] == '\n') {
            at.row++;
            at.col = 0;
        } else {
            at.col++;
        }
    }
    return at;
}

static Pos clamp(const Buffer *b, Pos p) {
    if (p.row < 0) p.row = 0;
    if (p.row >= b->nrows) p.row = b->nrows - 1;
    if (p.col < 0) p.col = 0;
    if (p.col > b->rows[p.row].len) p.col = b->rows[p.row].len;
    return p;
}

Pos buf_insert(Buffer *b, Pos at, const char *text, size_t len) {
    if (b->nrows == 0) row_insert(b, 0, "", 0);
    at = clamp(b, at);
    Row *r = &b->rows[at.row];
    /* Cut the line at the insertion point; the tail goes after the new text. */
    size_t tail_len = (size_t)(r->len - at.col);
    char *tail = xrealloc(NULL, tail_len + 1);
    memcpy(tail, r->chars + at.col, tail_len);
    r->len = at.col;
    r->chars[r->len] = '\0';

    int cur = at.row;
    size_t i = 0;
    for (;;) {
        const char *nl = memchr(text + i, '\n', len - i);
        size_t seg = nl ? (size_t)(nl - (text + i)) : len - i;
        row_append(&b->rows[cur], text + i, seg);
        if (!nl) break;
        i += seg + 1;
        cur++;
        row_insert(b, cur, "", 0);
    }
    Pos end = {cur, b->rows[cur].len};
    row_append(&b->rows[cur], tail, tail_len);
    free(tail);
    for (int k = at.row; k <= cur; k++) buf_update_row(b, k);
    b->dirty = 1;
    return end;
}

char *buf_delete(Buffer *b, Pos from, Pos to, size_t *out_len) {
    if (pos_cmp(from, to) > 0) {
        Pos t = from;
        from = to;
        to = t;
    }
    if (b->nrows == 0) {
        *out_len = 0;
        return xrealloc(NULL, 1);
    }
    from = clamp(b, from);
    to = clamp(b, to);

    /* Collect the deleted text first, so it can be undone. */
    size_t cap = 64, n = 0;
    char *text = xrealloc(NULL, cap);
    for (int row = from.row; row <= to.row; row++) {
        Row *r = &b->rows[row];
        int start = row == from.row ? from.col : 0;
        int end = row == to.row ? to.col : r->len;
        size_t piece = (size_t)(end - start) + 1;
        if (n + piece + 1 > cap) {
            while (n + piece + 1 > cap) cap *= 2;
            text = xrealloc(text, cap);
        }
        memcpy(text + n, r->chars + start, (size_t)(end - start));
        n += (size_t)(end - start);
        if (row != to.row) text[n++] = '\n';
    }
    text[n] = '\0';

    /* The first row keeps its start and gets the last row's end. */
    Row *last = &b->rows[to.row];
    size_t keep = (size_t)(last->len - to.col);
    char *rest = xrealloc(NULL, keep + 1);
    memcpy(rest, last->chars + to.col, keep);
    Row *first = &b->rows[from.row];
    first->len = from.col;
    row_append(first, rest, keep);
    free(rest);
    for (int row = to.row; row > from.row; row--) row_delete(b, row);
    buf_update_row(b, from.row);
    b->dirty = 1;
    *out_len = n;
    return text;
}

/* ---- undo and redo ----------------------------------------------------
 * Typing "hello" one key at a time makes five inserts, but undo should
 * remove the whole word. So a new insert that continues exactly where the
 * last one ended is merged into it, as long as the "group" is open. Moving
 * the cursor, a newline, or an undo closes the group. */

static Edit *edits_push(EditList *l, Edit e) {
    if (l->count == l->cap) {
        l->cap = l->cap ? l->cap * 2 : 32;
        l->items = xrealloc(l->items, sizeof(Edit) * (size_t)l->cap);
    }
    l->items[l->count] = e;
    return &l->items[l->count++];
}

static char *dup_text(const char *s, size_t len) {
    char *d = xrealloc(NULL, len + 1);
    memcpy(d, s, len);
    d[len] = '\0';
    return d;
}

void buf_break_undo_group(Buffer *b) { b->group_open = 0; }

Pos buf_type(Buffer *b, Pos at, const char *text, size_t len) {
    if (b->nrows == 0) row_insert(b, 0, "", 0);
    at = clamp(b, at);
    Pos end = buf_insert(b, at, text, len);
    edits_clear(&b->redo);
    int has_newline = memchr(text, '\n', len) != NULL;
    Edit *last = b->undo.count ? &b->undo.items[b->undo.count - 1] : NULL;
    if (b->group_open && !has_newline && last && last->kind == EDIT_INSERT && pos_cmp(last->to, at) == 0) {
        last->text = xrealloc(last->text, last->len + len + 1);
        memcpy(last->text + last->len, text, len);
        last->len += len;
        last->text[last->len] = '\0';
        last->to = end;
    } else {
        edits_push(&b->undo, (Edit){EDIT_INSERT, at, end, dup_text(text, len), len});
    }
    b->group_open = !has_newline;
    return end;
}

Pos buf_erase(Buffer *b, Pos from, Pos to) {
    if (pos_cmp(from, to) > 0) {
        Pos t = from;
        from = to;
        to = t;
    }
    size_t len;
    char *text = buf_delete(b, from, to, &len);
    if (len == 0) {
        free(text);
        return from;
    }
    edits_clear(&b->redo);
    int has_newline = memchr(text, '\n', len) != NULL;
    Edit *last = b->undo.count ? &b->undo.items[b->undo.count - 1] : NULL;
    if (b->group_open && !has_newline && last && last->kind == EDIT_DELETE && last->from.row == from.row &&
        (pos_cmp(last->from, to) == 0 || pos_cmp(last->from, from) == 0)) {
        char *joined = xrealloc(NULL, last->len + len + 1);
        if (pos_cmp(last->from, to) == 0) {  /* backspace: the new text comes first */
            memcpy(joined, text, len);
            memcpy(joined + len, last->text, last->len);
            last->from = from;
        } else {                             /* delete key: it comes after */
            memcpy(joined, last->text, last->len);
            memcpy(joined + last->len, text, len);
        }
        last->len += len;
        joined[last->len] = '\0';
        free(last->text);
        last->text = joined;
        last->to = pos_after(last->from, last->text, last->len);
        free(text);
    } else {
        edits_push(&b->undo, (Edit){EDIT_DELETE, from, pos_after(from, text, len), text, len});
    }
    b->group_open = !has_newline;
    return from;
}

/* Apply an edit forwards (redo) or backwards (undo); returns the new cursor. */
static Pos apply(Buffer *b, const Edit *e, int backwards) {
    int inserting = (e->kind == EDIT_INSERT) != backwards;
    if (inserting) return buf_insert(b, e->from, e->text, e->len);
    size_t n;
    free(buf_delete(b, e->from, pos_after(e->from, e->text, e->len), &n));
    return e->from;
}

static int undo_redo(Buffer *b, EditList *from, EditList *to, int backwards, Pos *cursor) {
    if (from->count == 0) return 0;
    Edit e = from->items[--from->count];
    *cursor = apply(b, &e, backwards);
    edits_push(to, e);
    b->group_open = 0;
    return 1;
}

int buf_undo(Buffer *b, Pos *cursor) { return undo_redo(b, &b->undo, &b->redo, 1, cursor); }
int buf_redo(Buffer *b, Pos *cursor) { return undo_redo(b, &b->redo, &b->undo, 0, cursor); }

/* ---- search ----------------------------------------------------------- */

/* Finds query starting at `start` (forwards: at or after it; backwards:
 * before it), wrapping around the end of the file. */
int buf_find(const Buffer *b, const char *query, Pos start, int forward, Pos *found) {
    if (!*query || b->nrows == 0) return 0;
    /* Visit every row once, plus the starting row a second time for the
     * part of it on the other side of the start (after wrapping around). */
    for (int i = 0; i <= b->nrows; i++) {
        int row = ((forward ? start.row + i : start.row - i) % b->nrows + b->nrows) % b->nrows;
        const char *line = b->rows[row].chars;
        int lo = 0, hi = b->rows[row].len;  /* allowed range for the match's column */
        if (i == 0 && forward) lo = start.col;
        if (i == 0 && !forward) hi = start.col - 1;
        if (i == b->nrows && forward) hi = start.col - 1;
        if (i == b->nrows && !forward) lo = start.col;
        int hit = -1;
        for (const char *m = strstr(line, query); m; m = strstr(m + 1, query)) {
            int col = (int)(m - line);
            if (col > hi) break;
            if (col < lo) continue;
            hit = col;
            if (forward) break;  /* the first one; backwards keeps the last */
        }
        if (hit >= 0) {
            *found = (Pos){row, hit};
            return 1;
        }
    }
    return 0;
}

/* ---- files ------------------------------------------------------------ */

int buf_open(Buffer *b, const char *filename) {
    free(b->filename);
    b->filename = strdup(filename);
    b->syntax = syntax_for_file(filename);
    FILE *f = fopen(filename, "rb");
    if (!f) {
        if (errno == ENOENT) return 0;  /* a new file: created on first save */
        return -1;
    }
    char *line = NULL;
    size_t cap = 0;
    ssize_t n;
    int last_had_newline = 1, first = 1;
    while ((n = getline(&line, &cap, f)) != -1) {
        last_had_newline = n > 0 && line[n - 1] == '\n';
        if (last_had_newline) n--;
        if (first && last_had_newline && n > 0 && line[n - 1] == '\r') b->crlf = 1;
        if (b->crlf && last_had_newline && n > 0 && line[n - 1] == '\r') n--;
        first = 0;
        row_insert(b, b->nrows, line, (size_t)n);
    }
    free(line);
    int err = ferror(f);
    fclose(f);
    if (err) return -1;
    b->final_newline = last_had_newline;
    b->dirty = 0;
    return 0;
}

char *buf_to_string(const Buffer *b, size_t *len) {
    const char *eol = b->crlf ? "\r\n" : "\n";
    size_t eol_len = strlen(eol), total = 0;
    for (int i = 0; i < b->nrows; i++) total += (size_t)b->rows[i].len + eol_len;
    char *s = xrealloc(NULL, total + 1), *p = s;
    for (int i = 0; i < b->nrows; i++) {
        memcpy(p, b->rows[i].chars, (size_t)b->rows[i].len);
        p += b->rows[i].len;
        if (i < b->nrows - 1 || b->final_newline) {
            memcpy(p, eol, eol_len);
            p += eol_len;
        }
    }
    *p = '\0';
    *len = (size_t)(p - s);
    return s;
}

/* Saving writes a temporary file and renames it over the original. If the
 * disk fills up or the power fails halfway, the old file is still intact:
 * a rename either happens completely or not at all. */
int buf_save(Buffer *b, long *bytes_written) {
    if (!b->filename) {
        errno = EINVAL;
        return -1;
    }
    size_t len;
    char *text = buf_to_string(b, &len);
    size_t name_len = strlen(b->filename) + 16;
    char *tmp = xrealloc(NULL, name_len);
    snprintf(tmp, name_len, "%s.tinyed~", b->filename);

    struct stat st;
    mode_t mode = stat(b->filename, &st) == 0 ? st.st_mode & 07777 : 0644;
    int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, mode);
    int ok = fd != -1;
    for (size_t done = 0; ok && done < len;) {
        ssize_t w = write(fd, text + done, len - done);
        if (w < 0) ok = 0;
        else done += (size_t)w;
    }
    if (ok && fsync(fd) != 0) ok = 0;
    if (fd != -1 && close(fd) != 0) ok = 0;
    if (ok && rename(tmp, b->filename) != 0) ok = 0;
    int saved_errno = errno;
    if (!ok) unlink(tmp);
    free(tmp);
    free(text);
    if (!ok) {
        errno = saved_errno;
        return -1;
    }
    b->dirty = 0;
    if (bytes_written) *bytes_written = (long)len;
    return 0;
}
