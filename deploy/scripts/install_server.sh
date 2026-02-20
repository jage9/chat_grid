#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${1:-/home/bestmidi/chgrid}"
SERVER_DIR="$REPO_ROOT/server"
PYTHON_SPEC="${PYTHON_SPEC:-3.13}"

if ! command -v uv >/dev/null 2>&1; then
  echo "error: uv is required but not found in PATH" >&2
  exit 1
fi

if [[ ! -d "$SERVER_DIR" ]]; then
  echo "error: server directory not found: $SERVER_DIR" >&2
  exit 1
fi
if [[ ! -f "$SERVER_DIR/pyproject.toml" ]]; then
  echo "error: missing $SERVER_DIR/pyproject.toml" >&2
  echo "       verify repository files were copied to /home/bestmidi/chgrid/server" >&2
  exit 1
fi

cd "$SERVER_DIR"

# Avoid interactive prompts: reuse existing venv; create only when missing.
if [[ ! -d .venv ]]; then
  uv venv .venv --python "$PYTHON_SPEC"
  echo "created .venv with Python $PYTHON_SPEC"
else
  echo "using existing .venv"
fi

if [[ -x .venv/bin/python ]]; then
  VENV_PYTHON_VERSION="$(
    .venv/bin/python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'
  )"
  if [[ "$VENV_PYTHON_VERSION" != "$PYTHON_SPEC" ]]; then
    echo "warning: .venv uses Python $VENV_PYTHON_VERSION (requested $PYTHON_SPEC)" >&2
    echo "         remove .venv and rerun script to recreate with Python $PYTHON_SPEC" >&2
  fi
fi

uv sync --no-dev --project "$SERVER_DIR"

if [[ ! -f config.toml ]]; then
  cp config.example.toml config.toml
  echo "created $SERVER_DIR/config.toml from template"
fi

mkdir -p runtime

echo "server install complete"
echo "next: edit $SERVER_DIR/config.toml (TLS, bind_ip, port)"
