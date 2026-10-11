#!/usr/bin/env bash
# Bump a plugin's version, tag it, push, and create the GitHub release.
#
# Usage: scripts/release-plugin.sh <plugin> <version> <notes...>
#
# - Sets .version in plugins/<plugin>/.claude-plugin/plugin.json, preserving its
#   existing formatting (jq's trailing newline is dropped if the file didn't have one)
# - Updates that plugin's row in the root README version table
# - Commits whichever of those actually changed (chore: bump <plugin> to v<version>);
#   skipped entirely if a prior PR already shipped both at this version
# - Tags <plugin>-v<version> (annotated) on the resulting commit (or on HEAD, if nothing
#   needed committing)
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

# Bump plugin.json version, unless a prior commit (e.g. a merged PR) already set it:
# then leave the file untouched rather than re-churn it under jq's formatting.
current_version="$(jq -r '.version' "$plugin_json")"
if [[ "$current_version" != "$version" ]]; then
  tmp="$(mktemp)"
  jq --arg v "$version" '.version = $v' "$plugin_json" > "$tmp"
  # jq always appends a trailing newline; match the original file if it had none.
  if [[ -n "$(tail -c1 "$plugin_json")" ]]; then
    printf '%s' "$(cat "$tmp")" > "$tmp.notrail"
    mv "$tmp.notrail" "$tmp"
  fi
  mv "$tmp" "$plugin_json"
else
  echo "plugin.json already at $version, leaving it as is" >&2
fi

# Bump the plugin's row in the root README version table.
# Row shape: | [`<plugin>`](plugins/<plugin>) | <old-version> | <description> |
perl -i -pe "s{(\\[\\\`\\Q$plugin\\E\\\`\\]\\(plugins/\\Q$plugin\\E\\)\\s*\\|\\s*)[0-9][0-9A-Za-z.+-]*(\\s*\\|)}{\${1}$version\${2}}" "$readme"

if ! grep -qF "[\`$plugin\`](plugins/$plugin) | $version |" "$readme"; then
  echo "README row for $plugin not updated as expected, aborting" >&2
  git checkout -- "$plugin_json" "$readme"
  exit 1
fi

if [[ -n "$(git status --porcelain -- "$plugin_json" "$readme")" ]]; then
  git add "$plugin_json" "$readme"
  git commit -m "chore($plugin): bump to v$version

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
else
  echo "$plugin is already at v$version everywhere, nothing to commit" >&2
fi

git tag -a "$tag" -m "$plugin $version"

git push origin main
git push origin "$tag"

notes_body=""
for n in "${notes[@]}"; do
  notes_body+="- $n
"
done

gh release create "$tag" --verify-tag --title "$plugin $version" --notes "$notes_body"
