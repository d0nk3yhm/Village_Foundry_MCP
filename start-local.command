#!/bin/bash
# Run from this folder even when opened by Finder or from another directory.
cd -- "$(dirname -- "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Village Foundry needs Node.js 20 or newer."
  echo "Install Node.js from https://nodejs.org/ and open this launcher again."
  if [ -t 0 ]; then read -r -p "Press Return to close..."; fi
  exit 1
fi
node ./scripts/local-server.mjs "$@"
foundry_exit=$?
if [ "$foundry_exit" -ne 0 ] && [ -t 0 ]; then
  echo "Village Foundry stopped with an error. The message is shown above."
  read -r -p "Press Return to close..."
fi
exit "$foundry_exit"
