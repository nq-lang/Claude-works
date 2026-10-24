# Skylit Heatseeker Terminal — build driver (G++ only).
#
# Deliberately a plain Makefile, not CMake: with zero external C++ dependencies
# (see docs/ARCHITECTURE.md / scripts/setup.sh) there is nothing for a
# build-system generator to find, so a Makefile keeps a fresh-checkout build
# short and with few moving parts.
#
#   make                 release build            -> build/skylit_server
#   make debug           -O0 -g3 build for gdb    -> build/debug/skylit_server
#   make asan | tsan     sanitizer builds         -> build/asan|tsan/skylit_server
#   make run             build + start on 127.0.0.1:8080
#   make test            unit + API smoke tests (no browser needed)
#   make test-e2e        Playwright browser suites (needs python3 + playwright)
#   make test-sanitize   unit tests + stress test under ASan/UBSan and TSan
#   make golden          backend math regression check (see tests/backend/golden)
#   make bench           backend micro-benchmarks
#   make clean
#
# The compiler is always g++ (override the binary, not the compiler family:
# `make CXX=g++-13`). C++23 (std::expected, <format>) needs GCC >= 13.

CXX       := g++
STD       := -std=c++23
WARN      := -Wall -Wextra -Wpedantic
INCLUDES  := -Ibackend/include
DEPFLAGS   = -MMD -MP
LDFLAGS   := -pthread

# Release: -O2 is the measured sweet spot for this workload (see docs/OPTIMIZATION.md).
# No -march=native / -ffast-math: the binary stays portable and the floating-point
# results stay bit-for-bit reproducible.
OPT_RELEASE := -O2
OPT_DEBUG   := -O0 -g3
SAN_ASAN    := -O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined
SAN_TSAN    := -O1 -g -fsanitize=thread

SRC_DIR   := backend/src
BUILD_DIR := build
SOURCES   := $(wildcard $(SRC_DIR)/*.cpp)

# build flavour -> (object dir, flags)
define FLAVOUR
$(1)_DIR := $(BUILD_DIR)$(2)
$(1)_OBJ := $$(patsubst $(SRC_DIR)/%.cpp,$$($(1)_DIR)/%.o,$(SOURCES))
$(1)_BIN := $$($(1)_DIR)/skylit_server
$$($(1)_BIN): $$($(1)_OBJ)
	$$(CXX) $$(STD) $(3) $$^ -o $$@ $$(LDFLAGS)
	@echo "[make] Built $$@"
$$($(1)_DIR)/%.o: $(SRC_DIR)/%.cpp | check-compiler
	@mkdir -p $$(@D)
	$$(CXX) $$(STD) $$(WARN) $(3) $$(INCLUDES) $$(DEPFLAGS) -c $$< -o $$@
-include $$($(1)_OBJ:.o=.d)
endef
$(eval $(call FLAVOUR,REL,,$(OPT_RELEASE)))
$(eval $(call FLAVOUR,DBG,/debug,$(OPT_DEBUG)))
$(eval $(call FLAVOUR,ASAN,/asan,$(SAN_ASAN)))
$(eval $(call FLAVOUR,TSAN,/tsan,$(SAN_TSAN)))

BIN := $(REL_BIN)

.PHONY: all build debug asan tsan clean run test test-unit test-smoke test-e2e test-sanitize \
        golden bench check-compiler

all: build
build: $(REL_BIN)
debug: $(DBG_BIN)
asan: $(ASAN_BIN)
tsan: $(TSAN_BIN)

check-compiler:
	@v=$$($(CXX) -dumpversion | cut -d. -f1); \
	if [ "$$v" -lt 13 ]; then \
	  echo "error: $(CXX) is version $$v; C++23 (std::expected, <format>) needs GCC >= 13." >&2; \
	  echo "       install g++-13 and run: make CXX=g++-13" >&2; exit 1; fi

run: build
	bash scripts/run.sh

clean:
	rm -rf $(BUILD_DIR)

# ---- tests ---------------------------------------------------------------

UNIT_BIN := $(BUILD_DIR)/projection_test
$(UNIT_BIN): tests/backend/projection_test.cpp $(wildcard backend/include/skylit/*.hpp) | check-compiler
	@mkdir -p $(BUILD_DIR)
	$(CXX) $(STD) $(WARN) $(OPT_RELEASE) $(INCLUDES) $< -o $@

# Engine-level unit tests (weighting table, clamping, data-support flagging,
# multi-Greek selection...). No server / threads involved.
test-unit: $(UNIT_BIN)
	$(UNIT_BIN)

test-smoke: build
	bash tests/backend/smoke_test.sh

test: test-unit test-smoke

test-e2e: build
	@for t in tests/e2e/pw_*.py; do echo "== $$t"; python3 $$t || exit 1; done
	python3 tests/e2e/soak_and_restart.py 30

test-sanitize: asan tsan
	@mkdir -p $(BUILD_DIR)/asan
	$(CXX) $(STD) $(WARN) $(SAN_ASAN) $(INCLUDES) tests/backend/projection_test.cpp -o $(BUILD_DIR)/asan/projection_test
	$(BUILD_DIR)/asan/projection_test
	bash tests/backend/sanitize_stress.sh

golden: build
	bash tests/backend/golden/run_golden.sh

bench: build
	bash tests/backend/bench/run_bench.sh
