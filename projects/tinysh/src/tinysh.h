/*
 * tinysh — a small Unix shell.
 *
 * A command line goes through four stages, one file each:
 *
 *   "ls *.c | wc -l > n.txt"
 *        │ lexer.c   split into tokens:   ls  *.c  |  wc  -l  >  n.txt
 *        │ parser.c  build a tree:        PIPE(CMD[ls *.c], CMD[wc -l] >n.txt)
 *        │ expand.c  per word, at run time: $VARS, ~, quotes, *.c → a.c b.c
 *        ▼ exec.c    fork, wire up pipes and files, exec the programs, wait
 */
#ifndef TINYSH_H
#define TINYSH_H

#include <stddef.h>

/* ---- tokens (lexer.c) ---- */

typedef enum {
    T_WORD,     /* anything else, quotes still inside: "a b"c is one word */
    T_PIPE,     /* |  */
    T_AND,      /* && */
    T_OR,       /* || */
    T_SEMI,     /* ;  */
    T_AMP,      /* &  */
    T_IN,       /* <  */
    T_OUT,      /* >  */
    T_APPEND,   /* >> */
    T_ERR_OUT,  /* 2> */
    T_ERR_DUP,  /* 2>&1 */
    T_EOF
} TokenType;

typedef struct {
    TokenType type;
    char *text; /* only for T_WORD */
} Token;

typedef struct {
    Token *items;
    size_t len, cap;
} TokenList;

/* Returns 0, or -1 with *error set to a static message. */
int lex(const char *line, TokenList *out, const char **error);
void tokens_free(TokenList *tokens);

/* ---- syntax tree (parser.c) ---- */

typedef struct Redirect {
    TokenType kind; /* T_IN, T_OUT, T_APPEND, T_ERR_OUT or T_ERR_DUP */
    char *target;   /* file name word (unexpanded); NULL for 2>&1 */
    struct Redirect *next;
} Redirect;

typedef enum { N_COMMAND, N_PIPE, N_AND, N_OR, N_SEQUENCE, N_BACKGROUND } NodeType;

typedef struct Node {
    NodeType type;
    struct Node *left, *right; /* operands; right may be NULL for "a;" */
    /* N_COMMAND only: */
    char **words;   /* unexpanded words, NULL-terminated */
    size_t nwords;
    Redirect *redirects;
} Node;

/* Returns the tree (NULL for an empty line), or NULL with *error set. */
Node *parse(const TokenList *tokens, const char **error);
void node_free(Node *n);

/* ---- expansion (expand.c) ---- */

typedef struct {
    char **items;
    size_t len, cap;
} StrList;

void strlist_push(StrList *l, char *s); /* takes ownership of s */
void strlist_free(StrList *l);

/* Expands one word: quotes, $VAR ${VAR} $? $$, ~, field splitting of unquoted
 * variables, and globbing of unquoted * ? [. Appends the resulting fields. */
void expand_word(const char *word, StrList *out);

/* The shell's state that expansion and builtins need. */
extern int sh_last_status;   /* $? */
extern int sh_interactive;
extern long sh_pid;          /* $$ (stays the shell's pid inside subshells) */

/* ---- execution (exec.c) ---- */

int run_node(Node *n);       /* returns the exit status */
int run_line(const char *line);
int is_builtin(const char *name);

#endif
