#!/usr/bin/env bash
# Bump a plugin's version, tag it, push, and create the GitHub release.
#
# Usage: scripts/release-plugin.sh <plugin> <version> <notes...>
#
# - Sets .version in plugins/<plugin>/.claude-plugin/plugin.json
# - Updates that plugin's row in the root README version table
# - Commits both (chore: bump <plugin> to v<version>)
# - Tags <plugin>-v<version> (annotated) on the commit
# - Pushes main and the tag
# - Creates the GitHub release with --verify-tag and the given notes
#
# Notes: pass one arg per line, each becomes a "- " bullet, e.g.:
#   scripts/release-plugin.sh flightdeck 0.3.0 \
#     "New widget panel" \
#     "Fixes stale cache bug"
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "usage: $0 <plugin> <version> <note> [<note>...]" >&2
  exit 1
fi

plugin="$1"
version="$2"
shift 2
notes=("$@")

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

plugin_json="plugins/$plugin/.claude-plugin/plugin.json"
readme="README.md"
tag="${plugin}-v${version}"

[[ -f "$plugin_json" ]] || { echo "no such plugin.json: $plugin_json" >&2; exit 1; }

if [[ -n "$(git status --porcelain)" ]]; then
  echo "working tree not clean, aborting" >&2
  exit 1
fi

if git rev-parse "$tag" >/dev/null 2>&1; then
  echo "tag $tag already exists, aborting" >&2
  exit 1
fi

# Bump plugin.json version.
tmp="$(mktemp)"
jq --arg v "$version" '.version = $v' "$plugin_json" > "$tmp"
mv "$tmp" "$plugin_json"

# Bump the plugin's row in the root README version table.
# Row shape: | [`<plugin>`](plugins/<plugin>) | <old-version> | <description> |
perl -i -pe "s{(\\[\\\`\\Q$plugin\\E\\\`\\]\\(plugins/\\Q$plugin\\E\\)\\s*\\|\\s*)[0-9][0-9A-Za-z.+-]*(\\s*\\|)}{\${1}$version\${2}}" "$readme"

if ! grep -qF "[\`$plugin\`](plugins/$plugin) | $version |" "$readme"; then
  echo "README row for $plugin not updated as expected, aborting" >&2
  git checkout -- "$plugin_json"
  exit 1
fi

git add "$plugin_json" "$readme"
git commit -m "chore($plugin): bump to v$version

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"

git tag -a "$tag" -m "$plugin $version"

git push origin main
git push origin "$tag"

notes_body=""
for n in "${notes[@]}"; do
  notes_body+="- $n
"
done

gh release create "$tag" --verify-tag --title "$plugin $version" --notes "$notes_body"
