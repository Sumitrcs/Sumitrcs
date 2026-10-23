#include "tinyed.h"

#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc > 2 || (argc == 2 && (strcmp(argv[1], "-h") == 0 || strcmp(argv[1], "--help") == 0))) {
        fprintf(argc > 2 ? stderr : stdout,
                "usage: tinyed [FILE]\n\n"
                "  Ctrl-S save        Ctrl-F find           Ctrl-Z undo\n"
                "  Ctrl-Q quit        Ctrl-G go to line     Ctrl-Y redo\n"
                "  Ctrl-K cut line    Ctrl-Left/Right move by word\n");
        return argc > 2 ? 2 : 0;
    }
    if (!isatty(STDIN_FILENO) || !isatty(STDOUT_FILENO)) {
        fprintf(stderr, "tinyed: needs a terminal\n");
        return 1;
    }
    return editor_run(argc == 2 ? argv[1] : NULL);
}
