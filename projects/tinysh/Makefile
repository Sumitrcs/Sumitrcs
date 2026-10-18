CC      ?= cc
CFLAGS  ?= -O2 -std=c11 -Wall -Wextra -Wpedantic -Wshadow
SRC     := src/lexer.c src/parser.c src/expand.c src/exec.c src/main.c
BUILD   := build

.PHONY: all test sanitize clean

all: $(BUILD)/tinysh

$(BUILD)/tinysh: $(SRC) src/tinysh.h | $(BUILD)
	$(CC) $(CFLAGS) -D_POSIX_C_SOURCE=200809L -o $@ $(SRC)

test: $(BUILD)/tinysh
	sh tests/run_tests.sh $(BUILD)/tinysh

# The same tests with AddressSanitizer + UndefinedBehaviorSanitizer
sanitize: | $(BUILD)
	$(CC) -g -O1 -std=c11 -Wall -Wextra -D_POSIX_C_SOURCE=200809L -fsanitize=address,undefined -fno-omit-frame-pointer \
		-o $(BUILD)/tinysh-san $(SRC)
	ASAN_OPTIONS=detect_leaks=1 sh tests/run_tests.sh $(BUILD)/tinysh-san

$(BUILD):
	mkdir -p $(BUILD)

clean:
	rm -rf $(BUILD)
