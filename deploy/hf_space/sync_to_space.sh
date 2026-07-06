#!/usr/bin/env bash
# Copy the lean serving subset from the GitHub repo into this HF Space staging directory.
# Run from anywhere: bash deploy/hf_space/sync_to_space.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DEST="${SCRIPT_DIR}"

MODEL_FILES=(
  classifier.joblib
  anomaly_detector.joblib
  anomaly_scaler.joblib
  segmentation_kmeans.joblib
  segmentation_scaler.joblib
  customer_features.joblib
  invoice_substitutes.joblib
  demo_cases.joblib
  MODEL_CARD.md
  classifier_meta.json
)

echo "Syncing serving files from ${ROOT} -> ${DEST}"

rm -rf "${DEST}/api" "${DEST}/src" "${DEST}/models"
mkdir -p "${DEST}/models"

cp "${ROOT}/requirements.txt" "${DEST}/requirements.txt"
cp -R "${ROOT}/api" "${DEST}/api"
cp -R "${ROOT}/src" "${DEST}/src"

for file in "${MODEL_FILES[@]}"; do
  src="${ROOT}/models/${file}"
  if [[ -f "${src}" ]]; then
    cp "${src}" "${DEST}/models/${file}"
  else
    echo "WARNING: missing optional artifact ${src}" >&2
  fi
done

echo "Done. Staged files:"
find "${DEST}" -maxdepth 2 -type f | sort
