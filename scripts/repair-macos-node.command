#!/bin/bash
set -euo pipefail

# Run from a repair package containing the verified official runtime/ directory.
package_dir="$(cd "$(dirname "$0")" && pwd -P)"
payload="$package_dir/runtime"
app="${1:-/Applications/Camellia.app}"
backup=""
trap 'result=$?; if [ "$result" -ne 0 ] && [ -n "$backup" ]; then printf "Repair failed. The original application backup is at:\n%s\n" "$backup" >&2; fi; exit "$result"' EXIT

if [ "$(uname -s)" != Darwin ]; then
  echo "Run this repair package on macOS." >&2
  exit 1
fi
if [ "$(uname -m)" != arm64 ] && [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" != 1 ]; then
  echo "This repair package requires an Apple Silicon Mac." >&2
  exit 1
fi
if /usr/bin/pgrep -x Camellia >/dev/null; then
  echo "Quit Camellia completely, then run this repair again." >&2
  exit 1
fi
if [ ! -d "$app/Contents/Resources/runtime" ] || [ ! -f "$payload/node" ] || [ ! -f "$payload/npm/bin/npm-cli.js" ]; then
  echo "The application or repair runtime is missing." >&2
  exit 1
fi
app="$(cd "$app" && pwd -P)"
runtime="$(cd "$app/Contents/Resources/runtime" && pwd -P)"
if [ "$runtime" != "$app/Contents/Resources/runtime" ]; then
  echo "The application runtime must be inside the Camellia application bundle." >&2
  exit 1
fi
if [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist")" != com.dsh.desktop ]; then
  echo "The selected application is not Camellia." >&2
  exit 1
fi
if [ ! -w "$runtime" ] || [ ! -w "$app/Contents" ]; then
  echo "The current user cannot write to this application. Use an application owned by your user." >&2
  exit 1
fi
for file in node NODE-LICENSE version.json; do
  if [ -L "$runtime/$file" ] || [ ! -f "$payload/$file" ]; then
    echo "Runtime files must be present in the repair package and cannot link outside the application." >&2
    exit 1
  fi
done

check_runtime() {
  local directory="$1"
  /usr/bin/env -u NODE_OPTIONS -u NODE_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin "$directory/node" -e \
    "if(process.platform!=='darwin'||process.arch!=='arm64'||process.version!=='v24.16.0')throw new Error('Unexpected Node runtime');require('node:sqlite');console.log('Node '+process.version+' / '+process.arch)"
  /usr/bin/env -u NODE_OPTIONS -u NODE_PATH -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin "$directory/node" "$directory/npm/bin/npm-cli.js" --version
}

/bin/chmod +x "$payload/node"
check_runtime "$payload"
backup_target="$HOME/Library/Application Support/Camellia Repair Backups/$(date +%Y%m%d-%H%M%S)-$$/Camellia.app"
/bin/mkdir -p "$(dirname "$backup_target")"
echo "Backing up the original application to $backup_target"
/usr/bin/ditto "$app" "$backup_target"
backup="$backup_target"

/bin/cp "$payload/node" "$runtime/node"
/bin/chmod 755 "$runtime/node"
/bin/rm -rf "$runtime/npm"
/usr/bin/ditto "$payload/npm" "$runtime/npm"
/bin/cp "$payload/NODE-LICENSE" "$runtime/NODE-LICENSE"
/bin/cp "$payload/version.json" "$runtime/version.json"
# The current Camellia development package uses ad-hoc signing. Reseal it after
# replacing its resources so macOS can validate the changed application bundle.
/usr/bin/codesign --force --deep --sign - "$app"
/usr/bin/codesign --verify --deep --strict "$app"
check_runtime "$runtime"
printf "Repair complete. Open Camellia and retry the Codex CLI download.\nOriginal application backup: %s\n" "$backup"
