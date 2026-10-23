/*
 * Syntax highlighting.
 *
 * Each row is scanned left to right with a tiny state machine: are we in
 * a string, in a comment, at the start of a word? The only state carried
 * from one line to the next is "inside a block comment", because a
 * comment that starts on line 10 with slash-star can end on line 20.
 */
#include "tinyed.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

static const char *const c_ext[] = {".c", ".h", ".cpp", ".hpp", ".cc", NULL};
static const char *const c_kw[] = {
    "if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return", "goto",
    "sizeof", "typedef", "struct", "union", "enum", "static", "const", "extern", "volatile", "inline",
    "#include", "#define", "#ifdef", "#ifndef", "#endif", "#if", "#else", "NULL", "true", "false", NULL};
static const char *const c_types[] = {
    "int", "long", "short", "char", "float", "double", "void", "unsigned", "signed", "bool",
    "size_t", "ssize_t", "uint8_t", "uint32_t", "uint64_t", "int64_t", "FILE", NULL};

static const char *const py_ext[] = {".py", NULL};
static const char *const py_kw[] = {
    "if", "elif", "else", "for", "while", "break", "continue", "return", "def", "class", "import", "from",
    "as", "with", "try", "except", "finally", "raise", "pass", "lambda", "yield", "in", "is", "not", "and",
    "or", "global", "async", "await", "None", "True", "False", "self", NULL};
static const char *const py_types[] = {"int", "str", "float", "bool", "list", "dict", "tuple", "set", "bytes", NULL};

static const char *const js_ext[] = {".js", ".mjs", ".ts", ".jsx", ".tsx", NULL};
static const char *const js_kw[] = {
    "if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return",
    "function", "class", "const", "let", "var", "new", "this", "import", "export", "from", "async", "await",
    "try", "catch", "finally", "throw", "typeof", "instanceof", "of", "in", "null", "undefined", "true",
    "false", "interface", "type", NULL};
static const char *const js_types[] = {"string", "number", "boolean", "any", "unknown", "void", "never", NULL};

static const char *const go_ext[] = {".go", NULL};
static const char *const go_kw[] = {
    "if", "else", "for", "range", "switch", "case", "default", "break", "continue", "return", "func",
    "package", "import", "type", "struct", "interface", "map", "chan", "go", "defer", "select", "var",
    "const", "nil", "true", "false", NULL};
static const char *const go_types[] = {
    "int", "int64", "uint8", "byte", "rune", "string", "bool", "float64", "error", "any", NULL};

static const char *const rs_ext[] = {".rs", NULL};
static const char *const rs_kw[] = {
    "if", "else", "for", "while", "loop", "match", "break", "continue", "return", "fn", "let", "mut",
    "struct", "enum", "impl", "trait", "pub", "use", "mod", "crate", "self", "Self", "where", "as", "in",
    "ref", "move", "const", "static", "true", "false", "Some", "None", "Ok", "Err", NULL};
static const char *const rs_types[] = {
    "i32", "i64", "u8", "u32", "u64", "usize", "f64", "bool", "char", "str", "String", "Vec", "Option",
    "Result", NULL};

static const Syntax languages[] = {
    {"C", c_ext, c_kw, c_types, "//", "/*", "*/"},
    {"Python", py_ext, py_kw, py_types, "#", NULL, NULL},
    {"JavaScript", js_ext, js_kw, js_types, "//", "/*", "*/"},
    {"Go", go_ext, go_kw, go_types, "//", "/*", "*/"},
    {"Rust", rs_ext, rs_kw, rs_types, "//", "/*", "*/"},
};

const Syntax *syntax_for_file(const char *filename) {
    if (!filename) return NULL;
    const char *ext = strrchr(filename, '.');
    for (size_t i = 0; i < sizeof languages / sizeof languages[0]; i++) {
        for (const char *const *e = languages[i].extensions; *e; e++) {
            if (ext && strcmp(ext, *e) == 0) return &languages[i];
        }
    }
    return NULL;
}

static int is_separator(int c) {
    return c == '\0' || isspace(c) || strchr(",.()+-/*=~%<>[];{}:!&|^?@", c) != NULL;
}

static int starts_with(const char *s, const char *prefix) {
    return prefix && strncmp(s, prefix, strlen(prefix)) == 0;
}

/* Highlights one row. Returns whether it ends inside a block comment. */
int syntax_highlight(const Syntax *s, Row *row, int in_comment) {
    row->hl = realloc(row->hl, (size_t)row->rlen + 1);
    memset(row->hl, HL_NORMAL, (size_t)row->rlen);
    if (!s) return row->open_comment = 0;

    const char *r = row->render;
    int prev_sep = 1;   /* is the previous character a separator (start of a word)? */
    char in_string = 0; /* the quote character that opened the current string */
    int i = 0;
    while (i < row->rlen) {
        char c = r[i];
        int prev_hl = i > 0 ? row->hl[i - 1] : HL_NORMAL;

        if (in_comment) {
            row->hl[i] = HL_MLCOMMENT;
            if (starts_with(r + i, s->block_end)) {
                memset(row->hl + i, HL_MLCOMMENT, strlen(s->block_end));
                i += (int)strlen(s->block_end);
                in_comment = 0;
                prev_sep = 1;
            } else {
                i++;
            }
            continue;
        }
        if (in_string) {
            row->hl[i] = HL_STRING;
            if (c == '\\' && i + 1 < row->rlen) {  /* an escape like \" doesn't end the string */
                row->hl[i + 1] = HL_STRING;
                i += 2;
                continue;
            }
            if (c == in_string) in_string = 0;
            i++;
            prev_sep = 1;
            continue;
        }
        if (starts_with(r + i, s->line_comment)) {
            memset(row->hl + i, HL_COMMENT, (size_t)(row->rlen - i));
            break;
        }
        if (starts_with(r + i, s->block_start)) {
            memset(row->hl + i, HL_MLCOMMENT, strlen(s->block_start));
            i += (int)strlen(s->block_start);
            in_comment = 1;
            continue;
        }
        if (c == '"' || c == '\'' || c == '`') {
            in_string = c;
            row->hl[i++] = HL_STRING;
            continue;
        }
        /* Numbers: 42, 3.14, 0x1F, 1e6 (a digit at the start of a word, and what follows it). */
        if ((isdigit((unsigned char)c) && (prev_sep || prev_hl == HL_NUMBER)) ||
            (prev_hl == HL_NUMBER && (c == '.' || c == '_' || isxdigit((unsigned char)c) || c == 'x' || c == 'X'))) {
            row->hl[i++] = HL_NUMBER;
            prev_sep = 0;
            continue;
        }
        if (prev_sep) {
            int matched = 0;
            for (int pass = 0; pass < 2 && !matched; pass++) {
                for (const char *const *kw = pass ? s->types : s->keywords; *kw; kw++) {
                    int len = (int)strlen(*kw);
                    if (starts_with(r + i, *kw) && is_separator((unsigned char)r[i + len])) {
                        memset(row->hl + i, pass ? HL_TYPE : HL_KEYWORD, (size_t)len);
                        i += len;
                        matched = 1;
                        break;
                    }
                }
            }
            if (matched) {
                prev_sep = 0;
                continue;
            }
        }
        prev_sep = is_separator((unsigned char)c);
        i++;
    }
    return row->open_comment = in_comment;
}

/* Re-highlight a row, and the rows after it for as long as the change
 * in "inside a comment?" keeps rippling down. Typing slash-star at the
 * top of a file turns everything below it into a comment. */
void syntax_update_all(Buffer *b, int at) {
    for (int i = at; i < b->nrows; i++) {
        int before = b->rows[i].open_comment;
        int starts_in = i > 0 ? b->rows[i - 1].open_comment : 0;
        syntax_highlight(b->syntax, &b->rows[i], starts_in);
        /* The row after `at` is always redone: rows may have been deleted. */
        if (i > at && b->rows[i].open_comment == before) break;
    }
}

/* ANSI foreground color for a highlight class. */
int syntax_color(int hl) {
    switch (hl) {
    case HL_COMMENT:
    case HL_MLCOMMENT: return 90; /* grey */
    case HL_KEYWORD: return 33;   /* yellow */
    case HL_TYPE: return 32;      /* green */
    case HL_STRING: return 35;    /* magenta */
    case HL_NUMBER: return 31;    /* red */
    case HL_MATCH: return 34;     /* blue */
    default: return 39;           /* the terminal's default */
    }
}
