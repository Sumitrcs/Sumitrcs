/*
 * Parser: tokens → syntax tree, by recursive descent. Each grammar rule is
 * one function, and the rules are layered by how tightly operators bind:
 *
 *   list      := and_or ( (';' | '&') and_or )* [';' | '&']
 *   and_or    := pipeline ( ('&&' | '||') pipeline )*
 *   pipeline  := command ( '|' command )*
 *   command   := ( WORD | redirect )+
 *   redirect  := ('<' | '>' | '>>' | '2>') WORD  |  '2>&1'
 *
 * So "a | b && c ; d" means ((a | b) && c) ; d.
 */
#include "tinysh.h"

#include <stdlib.h>
#include <string.h>

typedef struct {
    const TokenList *t;
    size_t pos;
    const char *error;
} Parser;

static Token *peek(Parser *p) { return &p->t->items[p->pos]; }
static TokenType peek_type(Parser *p) { return p->t->items[p->pos].type; }

static Node *new_node(NodeType type, Node *left, Node *right) {
    Node *n = calloc(1, sizeof *n);
    if (!n) abort();
    n->type = type;
    n->left = left;
    n->right = right;
    return n;
}

static int is_redirect(TokenType t) {
    return t == T_IN || t == T_OUT || t == T_APPEND || t == T_ERR_OUT || t == T_ERR_DUP;
}

static Node *fail(Parser *p, Node *partial, const char *msg) {
    if (!p->error) p->error = msg;
    node_free(partial);
    return NULL;
}

static Node *parse_command(Parser *p) {
    Node *cmd = new_node(N_COMMAND, NULL, NULL);
    Redirect **tail = &cmd->redirects;
    size_t cap = 0;
    for (;;) {
        TokenType t = peek_type(p);
        if (t == T_WORD) {
            if (cmd->nwords + 2 > cap) {
                cap = cap ? cap * 2 : 8;
                cmd->words = realloc(cmd->words, cap * sizeof(char *));
                if (!cmd->words) abort();
            }
            cmd->words[cmd->nwords++] = strdup(peek(p)->text);
            cmd->words[cmd->nwords] = NULL;
            p->pos++;
        } else if (is_redirect(t)) {
            Redirect *r = calloc(1, sizeof *r);
            if (!r) abort();
            r->kind = t;
            *tail = r;
            tail = &r->next;
            p->pos++;
            if (t != T_ERR_DUP) {
                if (peek_type(p) != T_WORD) return fail(p, cmd, "expected a file name after a redirection");
                r->target = strdup(peek(p)->text);
                p->pos++;
            }
        } else {
            break;
        }
    }
    if (cmd->nwords == 0 && !cmd->redirects) return fail(p, cmd, "expected a command");
    return cmd;
}

/* After | && || there must be a command, not the end or another operator. */
static int command_follows(Parser *p) {
    return peek_type(p) == T_WORD || is_redirect(peek_type(p));
}

static Node *parse_pipeline(Parser *p) {
    Node *left = parse_command(p);
    while (left && peek_type(p) == T_PIPE) {
        p->pos++;
        if (!command_follows(p)) return fail(p, left, "expected a command after |");
        Node *right = parse_command(p);
        if (!right) return fail(p, left, "expected a command after |");
        left = new_node(N_PIPE, left, right);
    }
    return left;
}

static Node *parse_and_or(Parser *p) {
    Node *left = parse_pipeline(p);
    while (left && (peek_type(p) == T_AND || peek_type(p) == T_OR)) {
        NodeType type = peek_type(p) == T_AND ? N_AND : N_OR;
        p->pos++;
        if (!command_follows(p)) return fail(p, left, type == N_AND ? "expected a command after &&" : "expected a command after ||");
        Node *right = parse_pipeline(p);
        if (!right) return fail(p, left, type == N_AND ? "expected a command after &&" : "expected a command after ||");
        left = new_node(type, left, right);
    }
    return left;
}

static Node *parse_list(Parser *p) {
    Node *left = parse_and_or(p);
    while (left && (peek_type(p) == T_SEMI || peek_type(p) == T_AMP)) {
        if (peek_type(p) == T_AMP) left = new_node(N_BACKGROUND, left, NULL);
        p->pos++;
        if (peek_type(p) == T_EOF) break; /* trailing ; or & */
        Node *right = parse_and_or(p);
        if (!right) return fail(p, left, "expected a command after ;");
        left = new_node(N_SEQUENCE, left, right);
    }
    return left;
}

Node *parse(const TokenList *tokens, const char **error) {
    Parser p = {tokens, 0, NULL};
    if (peek_type(&p) == T_EOF) {
        *error = NULL;
        return NULL; /* empty line */
    }
    Node *n = parse_list(&p);
    if (n && peek_type(&p) != T_EOF) {
        node_free(n);
        n = NULL;
        p.error = "unexpected token";
    }
    *error = n ? NULL : p.error;
    return n;
}

void node_free(Node *n) {
    if (!n) return;
    node_free(n->left);
    node_free(n->right);
    for (size_t i = 0; i < n->nwords; i++) free(n->words[i]);
    free(n->words);
    for (Redirect *r = n->redirects, *next; r; r = next) {
        next = r->next;
        free(r->target);
        free(r);
    }
    free(n);
}
