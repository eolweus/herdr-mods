#!/usr/bin/env bash
# Links every mod in this repo into the Herdr app, so a git pull updates them.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
app=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
mkdir -p "$app/mods" "$app/layouts"

for dir in "$here"/mods/*/; do
  name=$(basename "$dir")
  target="$app/mods/$name"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "skipped $name: $target already exists and isn't a link"
    continue
  fi
  ln -sfn "${dir%/}" "$target"
  echo "linked $name"
done

# Herdr writes live panel state into the layout file, so it gets a copy rather than a link.
if [ ! -e "$app/layouts/workbench.json" ]; then
  cp "$here/examples/workbench.json" "$app/layouts/workbench.json"
  echo "added the workbench layout"
fi

echo
echo "Done. In Herdr, switch to the workbench layout (Ctrl+Shift+L), or open the Plugins page from its sidebar."
echo "Keyboard shortcuts the mods expect are in examples/keys.json; merge the ones you want into $app/keys.json."
