CC      ?= cc
CFLAGS  ?= -O2 -std=c11 -Wall -Wextra -Wpedantic -Wshadow
DEFS    := -D_POSIX_C_SOURCE=200809L -D_DEFAULT_SOURCE
CORE    := src/buffer.c src/syntax.c src/term.c
SRC     := $(CORE) src/editor.c src/main.c
BUILD   := build

.PHONY: all test sanitize clean

all: $(BUILD)/tinyed

$(BUILD)/tinyed: $(SRC) src/tinyed.h | $(BUILD)
	$(CC) $(CFLAGS) $(DEFS) -o $@ $(SRC)

$(BUILD)/test_core: tests/test_core.c $(CORE) src/tinyed.h | $(BUILD)
	$(CC) $(CFLAGS) $(DEFS) -Isrc -o $@ tests/test_core.c $(CORE)

# Unit tests for the text buffer, undo, search, highlighting and key
# decoding, then the real editor driven through a pseudo-terminal.
test: $(BUILD)/test_core $(BUILD)/tinyed
	$(BUILD)/test_core
	python3 tests/test_terminal.py $(BUILD)/tinyed

# The same tests with AddressSanitizer + UndefinedBehaviorSanitizer
sanitize: | $(BUILD)
	$(CC) -g -O1 -std=c11 -Wall -Wextra $(DEFS) -fsanitize=address,undefined -fno-omit-frame-pointer \
		-Isrc -o $(BUILD)/test_core-san tests/test_core.c $(CORE)
	$(CC) -g -O1 -std=c11 -Wall -Wextra $(DEFS) -fsanitize=address,undefined -fno-omit-frame-pointer \
		-o $(BUILD)/tinyed-san $(SRC)
	ASAN_OPTIONS=detect_leaks=1 $(BUILD)/test_core-san
	ASAN_OPTIONS=detect_leaks=1 python3 tests/test_terminal.py $(BUILD)/tinyed-san

$(BUILD):
	mkdir -p $(BUILD)

clean:
	rm -rf $(BUILD)
