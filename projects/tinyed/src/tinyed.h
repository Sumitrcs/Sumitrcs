/*
 * tinyed: a small terminal text editor.
 *
 * The code is split so that everything except drawing and reading keys can
 * be tested without a terminal:
 *
 *   buffer.c   the text itself: rows of characters, inserting, deleting,
 *              undo/redo, loading and saving files
 *   syntax.c   syntax highlighting rules for a few languages
 *   term.c     raw mode, window size, turning key presses into key codes
 *   editor.c   the cursor, scrolling, drawing the screen, commands
 *   main.c     startup
 */
#ifndef TINYED_H
#define TINYED_H

#include <stddef.h>

/* ---- highlighting ---------------------------------------------------- */

enum Highlight {
    HL_NORMAL = 0,
    HL_COMMENT,
    HL_MLCOMMENT,
    HL_KEYWORD,  /* if, while, return ... */
    HL_TYPE,     /* int, char, str ... */
    HL_STRING,
    HL_NUMBER,
    HL_MATCH,    /* the current search result */
};

typedef struct {
    const char *name;
    const char *const *extensions;   /* ".c", ".h", or a full name like "Makefile" */
    const char *const *keywords;
    const char *const *types;
    const char *line_comment;        /* "//" or "#", NULL if none */
    const char *block_start;         /* slash-star in C, NULL if none */
    const char *block_end;
} Syntax;

/* ---- the text --------------------------------------------------------- */

typedef struct {
    char *chars;            /* the line's bytes, no newline, NUL-terminated */
    int len;
    char *render;           /* what is drawn: tabs expanded to spaces */
    int rlen;
    unsigned char *hl;      /* one Highlight per render byte */
    int open_comment;       /* does this line end inside a block comment? */
} Row;

typedef struct {
    int row, col;           /* col is a byte offset into Row.chars */
} Pos;

enum EditKind { EDIT_INSERT, EDIT_DELETE };

/* One undoable change: text inserted or deleted between `from` and `to`. */
typedef struct {
    enum EditKind kind;
    Pos from, to;
    char *text;
    size_t len;
} Edit;

typedef struct {
    Edit *items;
    int count, cap;
} EditList;

typedef struct {
    Row *rows;
    int nrows, cap;
    int dirty;              /* changes since the last save */
    int final_newline;      /* write a newline after the last line? */
    int crlf;               /* Windows line endings (\r\n)? kept when saving */
    char *filename;
    const Syntax *syntax;
    EditList undo, redo;
    int group_open;         /* may the next typed character join the last undo step? */
} Buffer;

#define TAB_STOP 4

/* buffer.c */
void buf_init(Buffer *b);
void buf_free(Buffer *b);
int buf_open(Buffer *b, const char *filename);   /* 0 ok, -1 error (errno set) */
int buf_save(Buffer *b, long *bytes_written);    /* 0 ok, -1 error (errno set) */
char *buf_to_string(const Buffer *b, size_t *len);
Pos buf_insert(Buffer *b, Pos at, const char *text, size_t len);
char *buf_delete(Buffer *b, Pos from, Pos to, size_t *len);
Pos buf_type(Buffer *b, Pos at, const char *text, size_t len);  /* insert + record for undo */
Pos buf_erase(Buffer *b, Pos from, Pos to);                    /* delete + record for undo */
int buf_undo(Buffer *b, Pos *cursor);
int buf_redo(Buffer *b, Pos *cursor);
void buf_break_undo_group(Buffer *b);
int pos_cmp(Pos a, Pos b);
int row_cx_to_rx(const Row *r, int cx);
int row_rx_to_cx(const Row *r, int rx);
int utf8_prev(const char *s, int i);
int utf8_next(const char *s, int len, int i);
int buf_find(const Buffer *b, const char *query, Pos start, int forward, Pos *found);
void buf_update_row(Buffer *b, int at);

/* syntax.c */
const Syntax *syntax_for_file(const char *filename);
int syntax_highlight(const Syntax *s, Row *row, int starts_in_comment);
void syntax_update_all(Buffer *b, int from_row);
int syntax_color(int hl);

/* term.c */
enum Key {
    KEY_BACKSPACE = 127,
    KEY_LEFT = 1000, KEY_RIGHT, KEY_UP, KEY_DOWN,
    KEY_HOME, KEY_END, KEY_PAGE_UP, KEY_PAGE_DOWN, KEY_DELETE,
    KEY_CTRL_LEFT, KEY_CTRL_RIGHT,
};
#define CTRL(k) ((k) & 0x1f)

int key_decode(const unsigned char *seq, int n, int *consumed);
void term_raw_on(void);
void term_raw_off(void);
int term_read_key(void);
int term_size(int *rows, int *cols);

/* editor.c */
int editor_run(const char *filename);

#endif
