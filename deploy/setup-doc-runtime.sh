#!/usr/bin/env bash
# Provisions an isolated, read-only document-processing runtime (Python venv, Node.js OOXML/PDF
# libraries, LibreOffice, Poppler, Pandoc, QPDF, Tesseract, and CJK/metric-compatible fonts)
# under DOC_RUNTIME_DIR (/opt/agy-doc-runtime by default) without polluting host Python/Node
# global directories or user home directories.
#
# AGY-ChatUI mounts DOC_RUNTIME_DIR read-only into every profile's bubblewrap sandbox so all
# profiles share the same ready-to-run environment for Anthropic docx/pptx/xlsx/pdf skills.

set -euo pipefail

DOC_RUNTIME_DIR="${DOC_RUNTIME_DIR:-/opt/agy-doc-runtime}"
INSTALL_DOC_RUNTIME="${INSTALL_DOC_RUNTIME:-auto}"
INSTALL_LIBREOFFICE="${INSTALL_LIBREOFFICE:-auto}"
ENV_FILE="${ENV_FILE:-/etc/antigravity-chat/env}"

if [[ -r "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

DOC_RUNTIME_DIR="${DOC_RUNTIME_DIR:-/opt/agy-doc-runtime}"
INSTALL_DOC_RUNTIME="${INSTALL_DOC_RUNTIME:-auto}"
INSTALL_LIBREOFFICE="${INSTALL_LIBREOFFICE:-auto}"

is_truthy() {
  case "${1,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

is_falsy() {
  case "${1,,}" in
    0|false|no|off) return 0 ;;
    *) return 1 ;;
  esac
}

if is_falsy "${INSTALL_DOC_RUNTIME}"; then
  echo "[doc-runtime] Skipping setup (INSTALL_DOC_RUNTIME=${INSTALL_DOC_RUNTIME})."
  exit 0
fi

if [[ "${INSTALL_DOC_RUNTIME,,}" == "auto" ]]; then
  TOTAL_RAM_KB="$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  if [[ "${TOTAL_RAM_KB}" -gt 0 ]] && [[ "${TOTAL_RAM_KB}" -lt 2200000 ]] && [[ ! -f "${DOC_RUNTIME_DIR}/.runtime-spec-sha256" ]]; then
    echo "[doc-runtime] Skipping automatic setup on low-RAM host (${TOTAL_RAM_KB} kB). Set INSTALL_DOC_RUNTIME=1 to enable."
    exit 0
  fi
fi

WITH_LIBREOFFICE=1
if is_falsy "${INSTALL_LIBREOFFICE}"; then
  WITH_LIBREOFFICE=0
fi

PYTHON_PACKAGES=(
  openpyxl
  pandas
  markitdown
  python-pptx
  python-docx
  Pillow
  defusedxml
  lxml
  pypdf
  pdfplumber
  reportlab
  pdf2image
  pytesseract
  pypdfium2
  matplotlib
)

NODE_PACKAGES=(
  docx
  pptxgenjs
  pdf-lib
  react
  react-dom
  react-icons
  sharp
)

APT_PACKAGES=(
  poppler-utils
  pandoc
  qpdf
  zip
  unzip
  python3
  python3-venv
  python-is-python3
  tesseract-ocr
  tesseract-ocr-jpn
  fontconfig
  fonts-noto-cjk
  fonts-liberation
  fonts-dejavu-core
)

APT_OPTIONAL_FONTS=(
  fonts-crosextra-carlito
  fonts-crosextra-caladea
)

if [[ "${WITH_LIBREOFFICE}" -eq 1 ]]; then
  APT_PACKAGES+=(
    libreoffice-impress
    libreoffice-writer
    libreoffice-calc
    libreoffice-common
  )
fi

SPEC_STRING="v1|lo=${WITH_LIBREOFFICE}|apt=${APT_PACKAGES[*]}|py=${PYTHON_PACKAGES[*]}|node=${NODE_PACKAGES[*]}"
SPEC_SHA="$(printf '%s' "${SPEC_STRING}" | sha256sum | awk '{print $1}')"
STAMP_FILE="${DOC_RUNTIME_DIR}/.runtime-spec-sha256"

if [[ -f "${STAMP_FILE}" ]] && [[ "$(cat "${STAMP_FILE}" 2>/dev/null || true)" == "${SPEC_SHA}" ]]; then
  if [[ -x "${DOC_RUNTIME_DIR}/venv/bin/python3" ]] \
    && [[ -d "${DOC_RUNTIME_DIR}/node/node_modules/pptxgenjs" ]] \
    && [[ -d "${DOC_RUNTIME_DIR}/node/node_modules/docx" ]] \
    && command -v pdftoppm >/dev/null 2>&1 \
    && command -v pandoc >/dev/null 2>&1 \
    && command -v qpdf >/dev/null 2>&1; then
    exit 0
  fi
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "[doc-runtime] ERROR: Must run as root to install OS tools and ${DOC_RUNTIME_DIR}." >&2
  exit 1
fi

echo "==> [doc-runtime] Installing isolated document runtime into ${DOC_RUNTIME_DIR} (LibreOffice=${WITH_LIBREOFFICE})..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends "${APT_PACKAGES[@]}"
apt-get install -y --no-install-recommends "${APT_OPTIONAL_FONTS[@]}" || true

if command -v fc-cache >/dev/null 2>&1; then
  fc-cache -f || true
fi

mkdir -p "${DOC_RUNTIME_DIR}"

echo "==> [doc-runtime] Provisioning isolated Python venv at ${DOC_RUNTIME_DIR}/venv..."
if [[ ! -x "${DOC_RUNTIME_DIR}/venv/bin/python3" ]]; then
  python3 -m venv "${DOC_RUNTIME_DIR}/venv"
fi
"${DOC_RUNTIME_DIR}/venv/bin/pip" install --no-cache-dir --upgrade pip
"${DOC_RUNTIME_DIR}/venv/bin/pip" install --no-cache-dir --upgrade "${PYTHON_PACKAGES[@]}"

echo "==> [doc-runtime] Provisioning isolated Node.js document packages at ${DOC_RUNTIME_DIR}/node..."
mkdir -p "${DOC_RUNTIME_DIR}/node"
cat <<'EOF' > "${DOC_RUNTIME_DIR}/node/package.json"
{
  "name": "agy-doc-runtime-node",
  "version": "1.0.0",
  "private": true
}
EOF
npm install --prefix "${DOC_RUNTIME_DIR}/node" --omit=dev --no-save --no-audit --no-fund "${NODE_PACKAGES[@]}"

chown -R root:root "${DOC_RUNTIME_DIR}"
chmod -R a+rX "${DOC_RUNTIME_DIR}"
printf '%s\n' "${SPEC_SHA}" > "${STAMP_FILE}"
chmod 644 "${STAMP_FILE}"

echo "==> [doc-runtime] Ready at ${DOC_RUNTIME_DIR}."
