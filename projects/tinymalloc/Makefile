CC      ?= cc
CFLAGS  ?= -O2 -std=c11 -Wall -Wextra -Wpedantic -Wshadow
BUILD   := build

.PHONY: all test sanitize demo bench clean

all: $(BUILD)/tinymalloc

$(BUILD)/tinymalloc: src/tinymalloc.c src/main.c src/tinymalloc.h | $(BUILD)
	$(CC) $(CFLAGS) -o $@ src/tinymalloc.c src/main.c

$(BUILD)/test: src/tinymalloc.c tests/test_tinymalloc.c src/tinymalloc.h | $(BUILD)
	$(CC) $(CFLAGS) -o $@ src/tinymalloc.c tests/test_tinymalloc.c

test: $(BUILD)/test
	./$(BUILD)/test

# Same tests under AddressSanitizer + UndefinedBehaviorSanitizer
sanitize: | $(BUILD)
	$(CC) -g -O1 -std=c11 -Wall -Wextra -fsanitize=address,undefined -fno-omit-frame-pointer \
		-o $(BUILD)/test-san src/tinymalloc.c tests/test_tinymalloc.c
	./$(BUILD)/test-san

demo: $(BUILD)/tinymalloc
	./$(BUILD)/tinymalloc demo

bench: $(BUILD)/tinymalloc
	for t in traces/*.txt; do ./$(BUILD)/tinymalloc trace $$t; echo; done

$(BUILD):
	mkdir -p $(BUILD)

clean:
	rm -rf $(BUILD)
