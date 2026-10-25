#!/usr/bin/env bash
# One-time setup (devcontainer onCreateCommand, or run by hand on a fresh machine).
#
# Dependencies: NONE beyond a C++23-capable g++ (>= 13) and make. The backend is written
# against POSIX sockets + the C++23 standard library only (see docs/ARCHITECTURE.md
# "Dependency Policy"), so there is nothing else to install and nothing to fetch.
# (The browser fetches Lightweight Charts from unpkg.com at page load.)

set -euo pipefail

echo "[setup] Verifying g++ toolchain..."
if ! command -v g++ >/dev/null 2>&1; then
  echo "[setup] g++ not found; installing (needs sudo)..." >&2
  sudo apt-get update -y && sudo apt-get install -y g++ make
fi

major="$(g++ -dumpversion | cut -d. -f1)"
if [[ "${major}" -lt 13 ]]; then
  echo "[setup] g++ is version ${major}; C++23 needs >= 13. Installing g++-13..." >&2
  sudo apt-get update -y && sudo apt-get install -y g++-13
  echo "[setup] Build with: make CXX=g++-13" >&2
  CXX_BIN=g++-13
else
  CXX_BIN=g++
fi
echo "[setup] Using $(${CXX_BIN} --version | head -1)"

echo "[setup] Verifying -std=c++23 is accepted..."
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
echo '#include <expected>
#include <format>
int main(){ std::expected<int,int> e{1}; return e.value() - 1 + static_cast<int>(std::format("{}", 1).size()) - 1; }' > "${tmp}/c.cpp"
"${CXX_BIN}" -std=c++23 "${tmp}/c.cpp" -o "${tmp}/c" && "${tmp}/c"
echo "[setup] ${CXX_BIN} supports C++23 (std::expected, <format>)."

echo "[setup] Building project..."
make -C "$(dirname "$0")/.." clean build CXX="${CXX_BIN}"

echo "[setup] Done. Start the terminal with: bash scripts/run.sh   (http://localhost:8080)"
