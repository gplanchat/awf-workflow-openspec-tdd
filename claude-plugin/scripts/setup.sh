#!/usr/bin/env bash
# Checks and installs what the /flow:* commands need: awf, the openspec-tdd pack, the EGM plugin (flow-review), and zpm
# when the language registry records pass proofs (a non-empty `proofs` list in .awf/languages.yaml).
#
#   setup.sh check           one line per missing item, with the command that fixes it; exit code 1 when one is missing
#   setup.sh report          the same list for /flow:setup, after the command that runs it again; always exit code 0
#   setup.sh hook            SessionStart hook: the same check as JSON; prints nothing outside an OpenSpec project
#                            (no openspec/ folder at the root of the repository) or when nothing is missing
#   setup.sh install awf|zpm downloads the pinned release from GitHub, checks its SHA-256 and installs it in
#                            ~/.local/bin (FLOW_BIN_DIR replaces this folder)
set -euo pipefail

PACK_REPO=gplanchat/awf-workflow-openspec-tdd
PACK_VERSION=0.6.0 # the version of manifest.yaml; scripts/claude-plugin.test.mts keeps them equal
AWF_VERSION=0.11.9 # the awf_version floor of manifest.yaml
ZPM_VERSION=0.4.4  # the zpm version that tdd-gate.sh reads proofs with
BIN_DIR=${FLOW_BIN_DIR:-$HOME/.local/bin}
# ponytail: unquoted, so that the allowed-tools pattern of /flow:setup matches; a plugin root with a space breaks it.
SELF="bash ${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}/scripts/setup.sh"
# The main worktree: change worktrees link its .awf/workflow-packs (scripts/commands.sh), and the zpm base lives there.
ROOT=$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
ROOT=${ROOT:-$PWD}

# True when version $1 is lower than version $2.
older() { [[ $1 != "$2" && $(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1) == "$1" ]]; }

check() {
  local missing=() version
  if ! command -v awf >/dev/null 2>&1; then
    missing+=("awf is not installed. Fix: $SELF install awf")
  else
    version=$(awf --version 2>/dev/null | sed -n '1s/^awf version //p')
    older "${version:-0}" "$AWF_VERSION" && missing+=("awf ${version:-of unknown version} is older than $AWF_VERSION, which the pack requires. Fix: awf upgrade")
    if [[ ! -d $ROOT/.awf ]]; then
      missing+=("the project has no .awf/ folder, which the pack installation needs. Fix: awf init")
    else
      version=$(cd "$ROOT" && awf workflow list 2>/dev/null | awk '$1 == "openspec-tdd" { print $2; exit }')
      if [[ -z $version ]]; then
        missing+=("the openspec-tdd pack is not installed. Fix: awf workflow install $PACK_REPO@$PACK_VERSION")
      elif older "$version" "$PACK_VERSION"; then
        missing+=("the openspec-tdd pack is $version, older than the $PACK_VERSION that the plugin calls. Fix: awf workflow install $PACK_REPO@$PACK_VERSION --force")
      fi
    fi
  fi
  # flow-review reads the EGM reviewer personas from EGM_ROOT, else from the plugin installed by Claude Code.
  if [[ -z ${EGM_ROOT:-} ]] && ! compgen -G "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/egm/egm/*/agents" >/dev/null; then
    missing+=("the EGM plugin is not installed, and flow-review reads its reviewers. Fix: claude plugin marketplace add google/elephant-goldfish-model && claude plugin install egm@egm")
  fi
  # ponytail: reads the inline form `proofs: [a, b]` only, the one of examples/languages.yaml.
  if grep -Eq '^[[:space:]]*proofs:[[:space:]]*\[[[:space:]]*[^][:space:]]' "$ROOT/.awf/languages.yaml" 2>/dev/null; then
    if ! command -v zpm >/dev/null 2>&1; then
      missing+=("zpm is not installed, and the language registry records pass proofs, which zpm stores. Fix: $SELF install zpm")
    else
      version=$(zpm version 2>&1 | sed -n 's/^zpm //p')
      older "${version:-0}" "$ZPM_VERSION" && missing+=("zpm ${version:-of unknown version} is older than $ZPM_VERSION, which tdd-gate.sh reads proofs with. Fix: zpm upgrade")
    fi
  fi
  ((${#missing[@]} == 0)) && return 0
  printf -- '- %s\n' "${missing[@]}"
  return 1
}

json_string() { sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' | awk 'BEGIN { ORS = "" } NR > 1 { print "\\n" } { print }'; }

hook() {
  [[ -d $ROOT/openspec ]] || return 0
  local report
  report=$(check) && return 0
  printf '{"systemMessage": "%s", "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "%s"}}\n' \
    "$(printf 'openspec-tdd: the /flow:* commands need tools that are missing or too old. Run /flow:setup to install them.' | json_string)" \
    "$(printf 'The /flow:* commands of the openspec-tdd pack cannot run yet:\n%s\nWhen the user asks for a /flow:* command, offer /flow:setup first: it installs these items, each after confirmation.' "$report" | json_string)"
}

install_tool() {
  local tool=${1:-} os arch asset base sums expected actual # dir stays global: the EXIT trap reads it
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case $tool in
    awf)
      case $arch in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; esac
      asset=awf_${os}_${arch}.tar.gz
      [[ $os == darwin ]] && asset=awf_${os}_${arch}.zip
      base=https://github.com/awf-project/cli/releases/download/v$AWF_VERSION
      sums=checksums.txt
      ;;
    zpm)
      [[ $arch == aarch64 ]] && arch=arm64
      asset=zpm-$os-$arch
      base=https://github.com/awf-project/zpm/releases/download/v$ZPM_VERSION
      sums=SHA256SUMS
      ;;
    *)
      echo "Usage: setup.sh install awf|zpm" >&2
      exit 2
      ;;
  esac
  dir=$(mktemp -d)
  trap 'rm -rf "$dir"' EXIT
  if ! curl -fsSL -o "$dir/sums" "$base/$sums" || ! grep -q " $asset\$" "$dir/sums"; then
    echo "No $tool release matches this system ($os $arch) at $base. Install $tool from its repository, then run /flow:setup again." >&2
    exit 1
  fi
  curl -fsSL -o "$dir/$asset" "$base/$asset" || { echo "The download of $asset failed. Check your connection, then run the same command again." >&2; exit 1; }
  expected=$(awk -v asset="$asset" '$2 == asset { print $1 }' "$dir/sums")
  actual=$({ sha256sum "$dir/$asset" 2>/dev/null || shasum -a 256 "$dir/$asset"; } | awk '{ print $1 }')
  if [[ $expected != "$actual" ]]; then
    echo "The SHA-256 of $asset does not match $sums: nothing is installed. Run the same command again; if it fails again, report it to the $tool project." >&2
    exit 1
  fi
  case $asset in
    *.tar.gz) tar -xzf "$dir/$asset" -C "$dir" awf ;;
    *.zip) unzip -q "$dir/$asset" awf -d "$dir" ;;
    *) mv "$dir/$asset" "$dir/$tool" ;;
  esac
  mkdir -p "$BIN_DIR"
  install -m 755 "$dir/$tool" "$BIN_DIR/$tool"
  echo "Installed $tool in $BIN_DIR/$tool."
  [[ :$PATH: == *":$BIN_DIR:"* ]] || echo "$BIN_DIR is not in your PATH: add it to your shell profile, then start a new session."
}

case ${1:-} in
  check) check ;;
  report)
    echo "Check again with: $SELF report"
    check || exit 0
    echo "Nothing is missing."
    ;;
  hook) hook ;;
  install) install_tool "${2:-}" ;;
  *)
    echo "Usage: setup.sh check | report | hook | install awf|zpm" >&2
    exit 2
    ;;
esac
