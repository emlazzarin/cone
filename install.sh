#!/bin/sh
set -eu

version=${CONE_VERSION:-0.2.0}
release_base=${CONE_RELEASE_BASE:-https://github.com/emlazzarin/cone/releases/download}
bin_dir=${CONE_BIN_DIR:-"$HOME/.local/bin"}
network=
hermes=false
restart=true
peer=
peer_name=
agent_name=hermes
while [ "$#" -gt 0 ]; do
  case "$1" in
    --hermes) hermes=true; shift ;;
    --no-restart) restart=false; shift ;;
    --env|--connect|--name|--agent-name)
      [ "$#" -ge 2 ] || { echo "Missing value for $1" >&2; exit 1; }
      case "$1" in
        --env) network=$2 ;; --connect) peer=$2 ;; --name) peer_name=$2 ;; --agent-name) agent_name=$2 ;;
      esac
      shift 2 ;;
    *) echo "Usage: install.sh [--hermes] [--connect <peer>] [--name <contact-name>] [--agent-name <name>] [--env production|dev] [--no-restart]" >&2; exit 1 ;;
  esac
done
case "$version" in ''|*[!A-Za-z0-9.-]*) echo "Invalid Cone version" >&2; exit 1 ;; esac
case "$network" in ''|production|dev|local) ;; *) echo "Invalid XMTP environment" >&2; exit 1 ;; esac
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) target=darwin-arm64 ;;
  Linux/x86_64) target=linux-x64 ;;
  Linux/aarch64|Linux/arm64) target=linux-arm64 ;;
  *) echo "No Cone executable for $(uname -s)/$(uname -m). See the source installation instructions." >&2; exit 1 ;;
esac
command -v curl >/dev/null || { echo "curl is required to download Cone" >&2; exit 1; }
temporary=$(mktemp -d)
staged=
trap 'rm -rf "$temporary"; if [ -n "$staged" ]; then rm -f "$staged"; fi' EXIT
trap 'exit 1' HUP INT TERM
archive="cone-$version-$target.tar.gz"
url="$release_base/v$version"
printf 'Downloading Cone %s for %s…\n' "$version" "$target" >&2
curl --fail --show-error --silent --location "$url/$archive" -o "$temporary/$archive"
curl --fail --show-error --silent --location "$url/SHA256SUMS" -o "$temporary/SHA256SUMS"
expected=$(awk -v file="$archive" '$2 == file {print $1}' "$temporary/SHA256SUMS")
[ "${#expected}" -eq 64 ] || { echo "Release checksum is missing or invalid" >&2; exit 1; }
if command -v sha256sum >/dev/null; then
  actual=$(sha256sum "$temporary/$archive" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$temporary/$archive" | awk '{print $1}')
fi
[ "$actual" = "$expected" ] || { echo "Cone download failed checksum verification" >&2; exit 1; }
tar -xOzf "$temporary/$archive" cone > "$temporary/cone"
tar -xOzf "$temporary/$archive" LICENSE > "$temporary/LICENSE"
tar -xOzf "$temporary/$archive" THIRD_PARTY_NOTICES.txt > "$temporary/THIRD_PARTY_NOTICES.txt"
mkdir -p "$bin_dir"
staged="$bin_dir/.cone-$version-$$"
install -m 755 "$temporary/cone" "$staged"
[ "$("$staged" --version)" = "cone $version" ] || { echo "Release executable has the wrong version" >&2; exit 1; }
mv -f "$staged" "$bin_dir/cone"
staged=
binary="$bin_dir/cone"
license_dir=${CONE_HOME:-"$HOME/.local/share/cone"}/licenses
mkdir -p "$license_dir"
install -m 644 "$temporary/LICENSE" "$license_dir/Cone.txt"
install -m 644 "$temporary/THIRD_PARTY_NOTICES.txt" "$license_dir/THIRD_PARTY_NOTICES.txt"
if [ -n "$network" ]; then "$binary" init --env "$network"; else "$binary" init; fi
if [ -n "$peer" ]; then
  if [ -n "$peer_name" ]; then "$binary" connect "$peer" --name "$peer_name";
  else "$binary" connect "$peer"; fi
fi
if [ "$hermes" = true ]; then
  if [ "$restart" = true ]; then "$binary" integrate hermes --binary "$binary" --name "$agent_name";
  else "$binary" integrate hermes --binary "$binary" --name "$agent_name" --no-restart; fi
fi
printf 'Installed %s\n' "$binary" >&2
