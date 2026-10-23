/* Unit tests for everything that doesn't need a terminal. */
#include "tinyed.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int checks, failures;

#define CHECK(cond)                                                          \
    do {                                                                     \
        checks++;                                                            \
        if (!(cond)) {                                                       \
            failures++;                                                      \
            fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond); \
        }                                                                    \
    } while (0)

#define CHECK_STR(got, want)                                                 \
    do {                                                                     \
        checks++;                                                            \
        if (strcmp((got), (want)) != 0) {                                    \
            failures++;                                                      \
            fprintf(stderr, "%s:%d: got \"%s\", want \"%s\"\n", __FILE__, __LINE__, (got), (want)); \
        }                                                                    \
    } while (0)

/* The whole buffer as a string, for comparisons (freed on the next call). */
static const char *text(Buffer *b) {
    static char *s;
    size_t len;
    free(s);
    s = buf_to_string(b, &len);
    return s;
}

static Pos P(int row, int col) { return (Pos){row, col}; }

static void load(Buffer *b, const char *s) {
    buf_init(b);
    buf_insert(b, P(0, 0), s, strlen(s));
    b->final_newline = 0;
}

static void test_insert_and_delete(void) {
    Buffer b;
    load(&b, "hello world");
    Pos end = buf_insert(&b, P(0, 5), ",", 1);
    CHECK_STR(text(&b), "hello, world");
    CHECK(end.row == 0 && end.col == 6);

    end = buf_insert(&b, P(0, 6), "\nbig\n", 5);
    CHECK_STR(text(&b), "hello,\nbig\n world");
    CHECK(b.nrows == 3 && end.row == 2 && end.col == 0);

    size_t n;
    char *gone = buf_delete(&b, P(0, 6), P(2, 1), &n);
    CHECK_STR(gone, "\nbig\n ");
    CHECK(n == 6);
    free(gone);
    CHECK_STR(text(&b), "hello,world");
    CHECK(b.nrows == 1);

    gone = buf_delete(&b, P(0, 5), P(0, 0), &n); /* reversed positions are fine */
    CHECK_STR(gone, "hello");
    free(gone);
    CHECK_STR(text(&b), ",world");

    /* Positions past the end are clamped. */
    buf_insert(&b, P(9, 99), "!", 1);
    CHECK_STR(text(&b), ",world!");
    buf_free(&b);
}

static void test_insert_into_empty_buffer(void) {
    Buffer b;
    buf_init(&b);
    CHECK(b.nrows == 0);
    buf_insert(&b, P(0, 0), "a\n\nb", 4);
    CHECK(b.nrows == 3);
    CHECK_STR(b.rows[1].chars, "");
    buf_free(&b);
}

static void test_undo_groups_typing(void) {
    Buffer b;
    load(&b, "x");
    Pos c = P(0, 1);
    const char *word = " hello";
    for (const char *p = word; *p; p++) c = buf_type(&b, c, p, 1);
    CHECK_STR(text(&b), "x hello");
    CHECK(b.undo.count == 1); /* six keys, one undo step */

    buf_break_undo_group(&b); /* e.g. the cursor moved */
    c = buf_type(&b, c, "!", 1);
    CHECK(b.undo.count == 2);

    Pos cur;
    CHECK(buf_undo(&b, &cur));
    CHECK_STR(text(&b), "x hello");
    CHECK(buf_undo(&b, &cur));
    CHECK_STR(text(&b), "x");
    CHECK(cur.row == 0 && cur.col == 1);
    CHECK(!buf_undo(&b, &cur));

    CHECK(buf_redo(&b, &cur));
    CHECK_STR(text(&b), "x hello");
    CHECK(cur.col == 7);
    CHECK(buf_redo(&b, &cur));
    CHECK_STR(text(&b), "x hello!");
    CHECK(!buf_redo(&b, &cur));
    buf_free(&b);
}

static void test_newline_starts_a_new_undo_step(void) {
    Buffer b;
    load(&b, "");
    Pos c = P(0, 0);
    c = buf_type(&b, c, "a", 1);
    c = buf_type(&b, c, "b", 1);
    c = buf_type(&b, c, "\n", 1);
    c = buf_type(&b, c, "c", 1);
    CHECK_STR(text(&b), "ab\nc");
    Pos cur;
    buf_undo(&b, &cur);
    CHECK_STR(text(&b), "ab\n");
    buf_undo(&b, &cur);
    CHECK_STR(text(&b), "ab");
    buf_undo(&b, &cur);
    CHECK_STR(text(&b), "");
    buf_free(&b);
}

static void test_undo_backspace_and_delete(void) {
    Buffer b;
    load(&b, "abcdef\nghi");
    /* Three backspaces from the end of line 1: one undo step. */
    Pos c = P(0, 6);
    for (int i = 0; i < 3; i++) c = buf_erase(&b, P(c.row, c.col - 1), c);
    CHECK_STR(text(&b), "abc\nghi");
    CHECK(b.undo.count == 1);
    CHECK_STR(b.undo.items[0].text, "def");
    /* Two forward deletes at the start: another step. */
    buf_break_undo_group(&b);
    buf_erase(&b, P(0, 0), P(0, 1));
    buf_erase(&b, P(0, 0), P(0, 1));
    CHECK_STR(text(&b), "c\nghi");
    CHECK(b.undo.count == 2);
    CHECK_STR(b.undo.items[1].text, "ab");
    /* Joining two lines. */
    buf_erase(&b, P(0, 1), P(1, 0));
    CHECK_STR(text(&b), "cghi");

    Pos cur;
    buf_undo(&b, &cur);
    CHECK_STR(text(&b), "c\nghi");
    buf_undo(&b, &cur);
    CHECK_STR(text(&b), "abc\nghi");
    CHECK(cur.row == 0 && cur.col == 2); /* undoing a delete leaves the cursor after the restored text */
    buf_undo(&b, &cur);
    CHECK_STR(text(&b), "abcdef\nghi");
    CHECK(cur.col == 6);
    /* And all the way forward again. */
    while (buf_redo(&b, &cur)) {}
    CHECK_STR(text(&b), "cghi");
    buf_free(&b);
}

static void test_new_edit_clears_redo(void) {
    Buffer b;
    load(&b, "");
    Pos cur, c = buf_type(&b, P(0, 0), "one", 3);
    buf_undo(&b, &cur);
    CHECK(b.redo.count == 1);
    buf_type(&b, P(0, 0), "two", 3);
    CHECK(b.redo.count == 0);
    CHECK(!buf_redo(&b, &cur));
    (void)c;
    buf_free(&b);
}

/* Random edits, then undo everything: we must get the original back. */
static void test_random_edits_undo_completely(void) {
    const char *alphabet = "ab \n\tx";
    srand(1);
    for (int round = 0; round < 300; round++) {
        Buffer b;
        load(&b, "start\nof the\n\ttext");
        char *original = strdup(text(&b));
        for (int step = 0; step < 50; step++) {
            int row = rand() % b.nrows;
            Pos at = P(row, rand() % (b.rows[row].len + 1));
            if (rand() % 3) {
                char s[3];
                int n = 1 + rand() % 3;
                for (int i = 0; i < n; i++) s[i] = alphabet[rand() % 6];
                buf_type(&b, at, s, (size_t)n);
            } else {
                int row2 = row + 1 < b.nrows && rand() % 2 ? row + 1 : row;
                buf_erase(&b, at, P(row2, rand() % (b.rows[row2].len + 1)));
            }
            if (rand() % 4 == 0) buf_break_undo_group(&b);
        }
        char *edited = strdup(text(&b));
        Pos cur;
        while (buf_undo(&b, &cur)) {}
        CHECK_STR(text(&b), original);
        while (buf_redo(&b, &cur)) {}
        CHECK_STR(text(&b), edited);
        while (buf_undo(&b, &cur)) {}
        CHECK_STR(text(&b), original);
        free(original);
        free(edited);
        buf_free(&b);
    }
}

static void test_utf8_movement(void) {
    const char *s = "aé€😀b"; /* 1, 2, 3 and 4 bytes */
    int len = (int)strlen(s);
    int stops[16], n = 0;
    for (int i = 0; i < len; i = utf8_next(s, len, i)) stops[n++] = i;
    CHECK(n == 5);
    CHECK(stops[1] == 1 && stops[2] == 3 && stops[3] == 6 && stops[4] == 10);
    CHECK(utf8_prev(s, 10) == 6);
    CHECK(utf8_prev(s, 6) == 3);
    CHECK(utf8_prev(s, 0) == 0);
}

static void test_columns_with_tabs_and_utf8(void) {
    Buffer b;
    load(&b, "\tx\xc3\xa9y");
    Row *r = &b.rows[0];
    CHECK_STR(r->render, "    x\xc3\xa9y");
    CHECK(row_cx_to_rx(r, 0) == 0);
    CHECK(row_cx_to_rx(r, 1) == 4); /* after the tab */
    CHECK(row_cx_to_rx(r, 2) == 5);
    CHECK(row_cx_to_rx(r, 4) == 6); /* é is one column */
    CHECK(row_rx_to_cx(r, 2) == 0); /* inside the tab → before it */
    CHECK(row_rx_to_cx(r, 6) == 4);
    CHECK(row_rx_to_cx(r, 99) == r->len);
    buf_free(&b);
    load(&b, "ab\tc");
    CHECK(row_cx_to_rx(&b.rows[0], 3) == 4); /* the tab only fills to the next stop */
    buf_free(&b);
}

static void test_search(void) {
    Buffer b;
    load(&b, "one two\nthree one\nfour");
    Pos f;
    CHECK(buf_find(&b, "one", P(0, 0), 1, &f) && f.row == 0 && f.col == 0);
    CHECK(buf_find(&b, "one", P(0, 1), 1, &f) && f.row == 1 && f.col == 6);
    CHECK(buf_find(&b, "one", P(1, 7), 1, &f) && f.row == 0 && f.col == 0); /* wraps around */
    CHECK(buf_find(&b, "one", P(1, 6), 0, &f) && f.row == 0 && f.col == 0); /* backwards */
    CHECK(buf_find(&b, "one", P(0, 0), 0, &f) && f.row == 1 && f.col == 6); /* backwards, wrapping */
    CHECK(buf_find(&b, "our", P(2, 0), 1, &f) && f.row == 2 && f.col == 1);
    CHECK(!buf_find(&b, "five", P(0, 0), 1, &f));
    CHECK(!buf_find(&b, "", P(0, 0), 1, &f));
    buf_free(&b);
    load(&b, "aaa");
    CHECK(buf_find(&b, "a", P(0, 1), 1, &f) && f.col == 1);
    CHECK(buf_find(&b, "a", P(0, 1), 0, &f) && f.col == 0);
    CHECK(buf_find(&b, "a", P(0, 0), 0, &f) && f.col == 2); /* wraps to the end of the same line */
    buf_free(&b);
}

static const char *hl_string(const Row *r) {
    /* One letter per character: n normal, c comment, k keyword, t type, s string, d digit */
    static char out[256];
    const char *letters = "nccktsdm";
    int i;
    for (i = 0; i < r->rlen && i < 255; i++) out[i] = letters[r->hl[i]];
    out[i] = '\0';
    return out;
}

static void test_highlighting(void) {
    Buffer b;
    buf_init(&b);
    b.syntax = syntax_for_file("x.c");
    CHECK(b.syntax && strcmp(b.syntax->name, "C") == 0);
    const char *src = "int x = 42; // hi\nchar *s = \"a\\\"b\";\n/* start\nstill */ return 0x1F;\nintx iff";
    buf_insert(&b, P(0, 0), src, strlen(src));
    CHECK_STR(hl_string(&b.rows[0]), "tttnnnnnddnnccccc");
    CHECK_STR(hl_string(&b.rows[1]), "ttttnnnnnnssssssn");
    CHECK_STR(hl_string(&b.rows[2]), "cccccccc");
    CHECK(b.rows[2].open_comment);
    CHECK_STR(hl_string(&b.rows[3]), "ccccccccnkkkkkknddddn");
    CHECK_STR(hl_string(&b.rows[4]), "nnnnnnnn"); /* not keywords: part of longer words */

    /* Closing the comment early changes the next line too. */
    buf_insert(&b, P(2, 8), " */", 3);
    CHECK(!b.rows[2].open_comment);
    CHECK(b.rows[3].hl[0] == HL_NORMAL);
    /* And deleting it brings the comment back. */
    size_t n;
    free(buf_delete(&b, P(2, 8), P(2, 11), &n));
    CHECK(b.rows[3].hl[0] == HL_MLCOMMENT);
    buf_free(&b);

    buf_init(&b);
    b.syntax = syntax_for_file("app.py");
    buf_insert(&b, P(0, 0), "def f(): return 'x'  # done", 27);
    CHECK_STR(hl_string(&b.rows[0]), "kkknnnnnnkkkkkknsssnncccccc");
    buf_free(&b);

    CHECK(syntax_for_file("notes.txt") == NULL);
    CHECK(syntax_for_file("Makefile") == NULL);
    CHECK(strcmp(syntax_for_file("main.go")->name, "Go") == 0);
    CHECK(strcmp(syntax_for_file("lib.rs")->name, "Rust") == 0);
    CHECK(strcmp(syntax_for_file("app.ts")->name, "JavaScript") == 0);
}

static void test_key_decoding(void) {
    struct { const char *bytes; int key, used; } cases[] = {
        {"a", 'a', 1}, {"\x1b[A", KEY_UP, 3}, {"\x1b[B", KEY_DOWN, 3}, {"\x1b[C", KEY_RIGHT, 3},
        {"\x1b[D", KEY_LEFT, 3}, {"\x1bOA", KEY_UP, 3}, {"\x1b[H", KEY_HOME, 3}, {"\x1b[4~", KEY_END, 4},
        {"\x1b[3~", KEY_DELETE, 4}, {"\x1b[5~", KEY_PAGE_UP, 4}, {"\x1b[6~", KEY_PAGE_DOWN, 4},
        {"\x1b[1;5C", KEY_CTRL_RIGHT, 6}, {"\x1b", 0x1b, 1}, {"\x1b[Z", 0x1b, 1}, {"\x11", CTRL('q'), 1},
        {"\x1b[Ax", KEY_UP, 3},
    };
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        int used;
        int key = key_decode((const unsigned char *)cases[i].bytes, (int)strlen(cases[i].bytes), &used);
        CHECK(key == cases[i].key);
        CHECK(used == cases[i].used);
    }
}

static void test_files(void) {
    char dir[] = "/tmp/tinyed-test-XXXXXX";
    CHECK(mkdtemp(dir) != NULL);
    char path[128];
    struct { const char *content; int lines; } files[] = {
        {"one\ntwo\n", 2},
        {"no newline at the end", 1},
        {"", 0},
        {"\n\n", 2},
        {"windows\r\nline endings\r\n", 2},
        {"tab\there\n", 1},
    };
    for (size_t i = 0; i < sizeof files / sizeof files[0]; i++) {
        snprintf(path, sizeof path, "%s/f%zu.txt", dir, i);
        FILE *f = fopen(path, "wb");
        fputs(files[i].content, f);
        fclose(f);
        Buffer b;
        buf_init(&b);
        CHECK(buf_open(&b, path) == 0);
        CHECK(b.nrows == files[i].lines);
        CHECK(!b.dirty);
        CHECK(buf_save(&b, NULL) == 0);
        f = fopen(path, "rb");
        char got[256] = {0};
        size_t n = fread(got, 1, sizeof got - 1, f);
        fclose(f);
        CHECK(n == strlen(files[i].content));
        CHECK_STR(got, files[i].content); /* saving unchanged gives the same bytes */
        buf_free(&b);
    }
    /* CRLF lines are edited without the \r, and saved with it. */
    snprintf(path, sizeof path, "%s/f4.txt", dir);
    Buffer b;
    buf_init(&b);
    buf_open(&b, path);
    CHECK_STR(b.rows[0].chars, "windows");
    buf_type(&b, P(0, 7), "!", 1);
    CHECK(b.dirty);
    buf_save(&b, NULL);
    CHECK(!b.dirty);
    buf_free(&b);
    FILE *f = fopen(path, "rb");
    char got[64] = {0};
    CHECK(fread(got, 1, sizeof got - 1, f) > 0);
    fclose(f);
    CHECK_STR(got, "windows!\r\nline endings\r\n");

    /* A file that doesn't exist yet is fine: it's created when saved. */
    snprintf(path, sizeof path, "%s/new.c", dir);
    buf_init(&b);
    CHECK(buf_open(&b, path) == 0);
    CHECK(b.nrows == 0 && b.syntax != NULL);
    buf_type(&b, P(0, 0), "int main;", 9);
    long bytes;
    CHECK(buf_save(&b, &bytes) == 0 && bytes == 10);
    buf_free(&b);
    /* Saving into a missing folder fails cleanly. */
    buf_init(&b);
    b.filename = strdup("/nonexistent-folder/x.txt");
    CHECK(buf_save(&b, NULL) == -1);
    buf_free(&b);

    char cmd[160];
    snprintf(cmd, sizeof cmd, "rm -rf %s", dir);
    CHECK(system(cmd) == 0);
}

int main(void) {
    test_insert_and_delete();
    test_insert_into_empty_buffer();
    test_undo_groups_typing();
    test_newline_starts_a_new_undo_step();
    test_undo_backspace_and_delete();
    test_new_edit_clears_redo();
    test_random_edits_undo_completely();
    test_utf8_movement();
    test_columns_with_tabs_and_utf8();
    test_search();
    test_highlighting();
    test_key_decoding();
    test_files();
    printf("%d checks, %d failed\n", checks, failures);
    return failures != 0;
}
