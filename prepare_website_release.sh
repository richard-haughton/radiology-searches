#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOWNLOAD_DIR="$ROOT_DIR/website/downloads"

mkdir -p "$DOWNLOAD_DIR"
rm -f "$DOWNLOAD_DIR/.DS_Store" "$DOWNLOAD_DIR/SHA256SUMS.txt"

if [[ -f "$ROOT_DIR/dist/Searches-macOS.zip" ]]; then
  cp "$ROOT_DIR/dist/Searches-macOS.zip" "$DOWNLOAD_DIR/Searches-macOS.zip"
else
  echo "Warning: dist/Searches-macOS.zip not found. Build the app first."
fi

cp "$ROOT_DIR/dist_templates/radiology_search_patterns.h5" "$DOWNLOAD_DIR/radiology_search_patterns.h5"
cp "$ROOT_DIR/dist_templates/study_times.csv" "$DOWNLOAD_DIR/study_times.csv"

if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 \
    "$DOWNLOAD_DIR/Searches-macOS.zip" \
    "$DOWNLOAD_DIR/radiology_search_patterns.h5" \
    "$DOWNLOAD_DIR/study_times.csv" \
    > "$DOWNLOAD_DIR/SHA256SUMS.txt"
fi

echo "Website release assets are ready in: $DOWNLOAD_DIR"
