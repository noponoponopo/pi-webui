#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
command -v bun >/dev/null 2>&1 || { echo 'Install Bun first: https://bun.sh' >&2; exit 1; }
command -v pi >/dev/null 2>&1 || { echo 'Install and configure official Pi separately: https://pi.dev' >&2; exit 1; }
case "$(uname -s)" in
  Darwin|Linux) ;;
  *) echo 'pi-webui supports macOS and Linux.' >&2; exit 1 ;;
esac
if [ -d src ]; then
  bun install --frozen-lockfile
  bun run build
else
  bun install --production --frozen-lockfile
fi
bun dist/cli.js setup "$@"
