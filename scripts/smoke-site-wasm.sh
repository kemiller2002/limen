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

if [[ ! -f "$ROOT/dist-site/index.html" || ! -f "$ROOT/dist-site/federation.html" ]]; then
  echo "dist-site is missing required pages; run npm run build:site first." >&2
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

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT/dist-site" >"$LOG_DIR/server.log" 2>&1 &
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

dump_until_marker() {
  local page="$1"
  local marker="$2"
  local label="$3"
  local output="$LOG_DIR/${page%.html}.html"
  local chrome_log="$LOG_DIR/${page%.html}-chrome.log"

  for attempt in 1 2 3; do
    if "$CHROME"       --headless=new       --no-sandbox       --disable-gpu       --disable-dev-shm-usage       --virtual-time-budget=20000       --dump-dom       "http://127.0.0.1:$PORT/$page"       >"$output" 2>"$chrome_log"; then
      if grep -Fq "$marker" "$output"; then
        return 0
      fi
    fi
    sleep 0.5
  done

  echo "$label did not reach the expected DOM marker after three bounded attempts." >&2
  echo "--- page status ---" >&2
  grep -n -E 'federation-proof-status|data-federation-proof|federation-runtime-ids' "$output" >&2 || true
  echo "--- chrome ---" >&2
  tail -n 160 "$chrome_log" >&2 || true
  echo "--- server ---" >&2
  tail -n 160 "$LOG_DIR/server.log" >&2 || true
  return 1
}

dump_until_marker   "index.html"   "Release is not yet legal. Resolve the obligations below."   "The main F# WebAssembly initialization projection"

if ! grep -Fq "Test evidence unresolved" "$LOG_DIR/index.html"; then
  echo "The main F# WebAssembly engine did not project its initial obligation list." >&2
  exit 1
fi

dump_until_marker   "federation.html"   'data-federation-proof="passed"'   "The two-module F# WebAssembly federation proof"

if ! grep -Fq '"status": "Completed"' "$LOG_DIR/federation.html"; then
  echo "The source F# module did not own the completed transition state." >&2
  exit 1
fi

if ! grep -Fq '"stateVersion": 1' "$LOG_DIR/federation.html"; then
  echo "The target F# module did not advance and expose its independent state version." >&2
  exit 1
fi

echo "Real-browser F# WebAssembly site + two-module federation smoke test passed with $(basename "$CHROME")."
