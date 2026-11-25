#!/usr/bin/env bash
set -euo pipefail
umask 077

templates="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
grid="$templates/../../grid"
mkdir -p "$grid/data"
if [[ ! -e "$grid/config.toml" ]]; then
  cp -n "$templates/config.example.toml" "$grid/config.toml"
fi
if [[ ! -e "$grid/.env" ]]; then
  secret="$(openssl rand -hex 32)"
  temp="$(mktemp "$grid/.env.XXXXXX")"
  trap 'rm -f -- "$temp"' EXIT
  sed -e "s/^CHGRID_AUTH_SECRET=$/CHGRID_AUTH_SECRET=$secret/" \
      -e "s/^CHGRID_UID=1000$/CHGRID_UID=$(id -u)/" \
      -e "s/^CHGRID_GID=1000$/CHGRID_GID=$(id -g)/" \
      "$templates/.env.example" > "$temp"
  ln "$temp" "$grid/.env"
fi
echo "Grid files are ready in $grid. Set the public origin and LiveKit credentials in .env."
