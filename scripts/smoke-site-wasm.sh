#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${LIMEN_SITE_SMOKE_PORT:-4174}"
LOG_DIR="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$LOG_DIR"
}
trap cleanup EXIT

if [[ ! -f "$ROOT/dist-site/index.html" ]]; then
  echo "dist-site/index.html is missing; run npm run build:site first." >&2
  exit 1
fi

CHROME=""
for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
  if command -v "$candidate" >/dev/null 2>&1; then
    CHROME="$(command -v "$candidate")"
    break
  fi
done

if [[ -z "$CHROME" ]]; then
  echo "A Chromium/Chrome binary is required for the F# WASM site smoke test." >&2
  exit 1
fi

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT/dist-site"   >"$LOG_DIR/server.log" 2>&1 &
SERVER_PID="$!"

for _ in $(seq 1 40); do
  if curl --fail --silent "http://127.0.0.1:$PORT/index.html" >/dev/null; then
    break
  fi
  sleep 0.25
done

if ! curl --fail --silent "http://127.0.0.1:$PORT/index.html" >/dev/null; then
  echo "Site smoke server did not become ready." >&2
  cat "$LOG_DIR/server.log" >&2 || true
  exit 1
fi

"$CHROME"   --headless=new   --no-sandbox   --disable-gpu   --disable-dev-shm-usage   --virtual-time-budget=15000   --dump-dom   "http://127.0.0.1:$PORT/index.html"   >"$LOG_DIR/dom.html" 2>"$LOG_DIR/chrome.log"

if ! grep -Fq 'Release is not yet legal. Resolve the obligations below.' "$LOG_DIR/dom.html"; then
  echo "The real browser loaded the page, but the F# WebAssembly initialization projection did not reach the DOM." >&2
  echo "--- chrome ---" >&2
  tail -n 120 "$LOG_DIR/chrome.log" >&2 || true
  echo "--- server ---" >&2
  tail -n 120 "$LOG_DIR/server.log" >&2 || true
  exit 1
fi

if ! grep -Fq 'Test evidence unresolved' "$LOG_DIR/dom.html"; then
  echo "The F# WebAssembly engine did not project its initial obligation list." >&2
  exit 1
fi

echo "Real-browser F# WebAssembly site smoke test passed with $(basename "$CHROME")."
