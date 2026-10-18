/*
 * Lexer: turns a line into tokens.
 *
 * Words keep their quotes for now ("a b" stays "a b" with the quotes), because
 * what quotes mean (no splitting, no globbing, maybe no $expansion) is applied
 * later, when the word is expanded. Here we only need to know where a word
 * ends: at an unquoted space or operator.
 */
#include "tinysh.h"

#include <stdlib.h>
#include <string.h>

static void push(TokenList *l, TokenType type, char *text) {
    if (l->len == l->cap) {
        l->cap = l->cap ? l->cap * 2 : 16;
        l->items = realloc(l->items, l->cap * sizeof *l->items);
        if (!l->items) abort();
    }
    l->items[l->len++] = (Token){type, text};
}

static int is_operator_char(char c) {
    return c == '|' || c == '&' || c == ';' || c == '<' || c == '>';
}

int lex(const char *s, TokenList *out, const char **error) {
    size_t i = 0;
    while (s[i]) {
        char c = s[i];
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
            i++;
            continue;
        }
        if (c == '#') { /* comment to the end of the line */
            break;
        }
        /* Operators: longest match first. */
        if (c == '2' && s[i + 1] == '>') {
            if (s[i + 2] == '&' && s[i + 3] == '1') {
                push(out, T_ERR_DUP, NULL);
                i += 4;
            } else {
                push(out, T_ERR_OUT, NULL);
                i += 2;
            }
            continue;
        }
        if (c == '|' && s[i + 1] == '|') { push(out, T_OR, NULL); i += 2; continue; }
        if (c == '&' && s[i + 1] == '&') { push(out, T_AND, NULL); i += 2; continue; }
        if (c == '>' && s[i + 1] == '>') { push(out, T_APPEND, NULL); i += 2; continue; }
        if (c == '|') { push(out, T_PIPE, NULL); i++; continue; }
        if (c == '&') { push(out, T_AMP, NULL); i++; continue; }
        if (c == ';') { push(out, T_SEMI, NULL); i++; continue; }
        if (c == '<') { push(out, T_IN, NULL); i++; continue; }
        if (c == '>') { push(out, T_OUT, NULL); i++; continue; }

        /* A word: runs until an unquoted blank or operator. */
        size_t start = i;
        while (s[i] && !strchr(" \t\n\r", s[i]) && !is_operator_char(s[i])) {
            if (s[i] == '\\') {
                i += s[i + 1] ? 2 : 1;
            } else if (s[i] == '\'') {
                const char *end = strchr(s + i + 1, '\'');
                if (!end) {
                    *error = "unterminated ' quote";
                    return -1;
                }
                i = (size_t)(end - s) + 1;
            } else if (s[i] == '"') {
                i++;
                while (s[i] && s[i] != '"') i += (s[i] == '\\' && s[i + 1]) ? 2 : 1;
                if (!s[i]) {
                    *error = "unterminated \" quote";
                    return -1;
                }
                i++;
            } else {
                i++;
            }
        }
        push(out, T_WORD, strndup(s + start, i - start));
    }
    push(out, T_EOF, NULL);
    return 0;
}

void tokens_free(TokenList *l) {
    for (size_t i = 0; i < l->len; i++) free(l->items[i].text);
    free(l->items);
    l->items = NULL;
    l->len = l->cap = 0;
}
