CC      ?= cc
CFLAGS  ?= -O2 -std=c11 -Wall -Wextra -Wpedantic -Wshadow -D_POSIX_C_SOURCE=199309L
SRC     := src/dlx.c src/sudoku.c src/queens.c
BUILD   := build

.PHONY: all test sanitize bench clean

all: $(BUILD)/dlx

$(BUILD)/dlx: $(SRC) src/main.c src/*.h | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $(SRC) src/main.c

$(BUILD)/test: $(SRC) tests/test_dlx.c src/*.h | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $(SRC) tests/test_dlx.c

test: $(BUILD)/test
	./$(BUILD)/test

# Same tests under AddressSanitizer + UndefinedBehaviorSanitizer
sanitize: | $(BUILD)
	$(CC) -g -O1 -std=c11 -Wall -Wextra -D_POSIX_C_SOURCE=199309L -fsanitize=address,undefined -fno-omit-frame-pointer \
		-o $(BUILD)/test-san $(SRC) tests/test_dlx.c
	./$(BUILD)/test-san

bench: $(BUILD)/dlx
	./$(BUILD)/dlx sudoku < puzzles/hard.txt > /dev/null
	./$(BUILD)/dlx queens 12

$(BUILD):
	mkdir -p $(BUILD)

clean:
	rm -rf $(BUILD)
