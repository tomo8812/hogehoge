#!/usr/bin/env bash
# Setup helper for Oracle Cloud Always Free Ubuntu (ARM64 A1.Flex 2 OCPU / 12 GB recommended, x86_64 supported).
# Safe and idempotent. Run as root or with sudo on a fresh Ubuntu 22.04 / 24.04 server.

set -euo pipefail

APP_USER="${APP_USER:-antigravity}"
APP_DIR="${APP_DIR:-/opt/antigravity-chat}"
DATA_DIR="${DATA_DIR:-/var/lib/antigravity-chat}"
DOC_RUNTIME_DIR="${DOC_RUNTIME_DIR:-/opt/agy-doc-runtime}"
INSTALL_DOC_RUNTIME="${INSTALL_DOC_RUNTIME:-auto}"
INSTALL_LIBREOFFICE="${INSTALL_LIBREOFFICE:-auto}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> [1/6] Installing base OS packages (python3, poppler-utils, bubblewrap, curl, ca-certificates)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  gnupg \
  git \
  python3 \
  poppler-utils \
  bubblewrap \
  acl

if command -v bwrap >/dev/null 2>&1 \
  && [[ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] \
  && [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" == "1" ]] \
  && [[ -f /etc/apparmor.d/abi/4.0 ]] \
  && ! grep -RqsE '/usr/bin/bwrap' /etc/apparmor.d/ 2>/dev/null; then
  echo "==> Configuring Ubuntu 24.04+ AppArmor userns profile for /usr/bin/bwrap..."
  cat <<'EOF' > /etc/apparmor.d/bwrap
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/bwrap>
}
EOF
  if command -v apparmor_parser >/dev/null 2>&1; then
    apparmor_parser -r -W /etc/apparmor.d/bwrap || true
  fi
fi

echo "==> [2/6] Checking Node.js 24 LTS..."
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 24 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

SETUP_DOC_SCRIPT=""
if [[ -f "${SCRIPT_DIR}/setup-doc-runtime.sh" ]]; then
  SETUP_DOC_SCRIPT="${SCRIPT_DIR}/setup-doc-runtime.sh"
elif [[ -f "${APP_DIR}/deploy/setup-doc-runtime.sh" ]]; then
  SETUP_DOC_SCRIPT="${APP_DIR}/deploy/setup-doc-runtime.sh"
fi
if [[ -n "${SETUP_DOC_SCRIPT}" ]]; then
  DOC_RUNTIME_DIR="${DOC_RUNTIME_DIR}" \
  INSTALL_DOC_RUNTIME="${INSTALL_DOC_RUNTIME}" \
  INSTALL_LIBREOFFICE="${INSTALL_LIBREOFFICE}" \
    bash "${SETUP_DOC_SCRIPT}"
fi

echo "==> [3/6] Checking official Antigravity CLI (agy -> /usr/local/bin/agy)..."
CANONICAL_AGY_BIN="/usr/local/bin/agy"
if [[ ! -x "${CANONICAL_AGY_BIN}" ]]; then
  FOUND_AGY_CANDIDATE=""
  for cand in /usr/bin/agy /bin/agy /root/.local/bin/agy /root/.antigravity/bin/agy; do
    if [[ -x "${cand}" ]]; then
      cand_real="$(readlink -f "${cand}" 2>/dev/null || echo "${cand}")"
      if [[ -f "${cand_real}" ]] && [[ "$(stat -c '%u' "${cand_real}" 2>/dev/null || echo 1)" == "0" ]]; then
        FOUND_AGY_CANDIDATE="${cand_real}"
        break
      fi
    fi
  done
  if [[ -n "${FOUND_AGY_CANDIDATE}" ]]; then
    install -m 755 "${FOUND_AGY_CANDIDATE}" "${CANONICAL_AGY_BIN}"
    echo "Unified Antigravity CLI binary to ${CANONICAL_AGY_BIN} (from ${FOUND_AGY_CANDIDATE})."
  fi
fi
if [[ ! -x "${CANONICAL_AGY_BIN}" ]]; then
  echo "INFO: '${CANONICAL_AGY_BIN}' not found."
  echo "Install the official unmodified Google Antigravity CLI for $(dpkg --print-architecture):"
  echo "  curl -fsSL https://antigravity.google/cli/install.sh | bash"
  echo "  Then unify it to a single system binary:"
  echo "  sudo install -m 755 \"\${HOME}/.local/bin/agy\" /usr/local/bin/agy && ln -sfn /usr/local/bin/agy \"\${HOME}/.local/bin/agy\""
  echo "  (Or set AGY_BIN=/full/path/to/agy inside /etc/antigravity-chat/env.)"
fi

echo "==> [4/6] Creating dedicated system user, directories, and persistent SESSION_SECRET..."
if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/${APP_USER}" --shell /bin/bash "${APP_USER}"
fi

if [[ ! -d "${APP_DIR}" ]]; then
  mkdir -p "${APP_DIR}"
  chown "${APP_USER}:${APP_USER}" "${APP_DIR}"
fi
mkdir -p "${DATA_DIR}/profiles" "${DATA_DIR}/workspaces" "${DATA_DIR}/projects" "${DATA_DIR}/uploads" "${DATA_DIR}/artifacts-cache"
chown -R "${APP_USER}:${APP_USER}" "${DATA_DIR}"
chmod 700 "${DATA_DIR}" "${DATA_DIR}/profiles" "${DATA_DIR}/workspaces" "${DATA_DIR}/projects"

mkdir -p /etc/antigravity-chat
chmod 700 /etc/antigravity-chat
if [[ ! -f /etc/antigravity-chat/env ]]; then
  SESSION_SECRET_VAL="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  printf 'SESSION_SECRET=%s\n' "${SESSION_SECRET_VAL}" > /etc/antigravity-chat/env
  chmod 600 /etc/antigravity-chat/env
  echo "Created /etc/antigravity-chat/env with persistent SESSION_SECRET."
fi

echo "==> [5/6] Configuring optional 2GB swap (critical on VM.Standard.E2.1.Micro 1GB RAM)..."
TOTAL_RAM_KB="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
if [[ "${TOTAL_RAM_KB}" -lt 2200000 ]] && [[ ! -f /swapfile ]]; then
  echo "Detected <=2GB RAM (${TOTAL_RAM_KB} kB). Creating 2GB /swapfile..."
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> [6/6] Final notes for Oracle Always Free Ubuntu + GitHub Actions + Tailscale:"
echo "Option A (Recommended, zero VM build): Deploy prebuilt bundle via GitHub Actions:"
echo "  - Enable antigravity-chat-updater.timer (public repos download the latest versioned Release"
echo "    with zero config, or set RELEASE_TAG=vX.Y.Z in /etc/antigravity-chat/env to pin/rollback;"
echo "    for private repos add GITHUB_READ_TOKEN=<Contents:Read PAT> to /etc/antigravity-chat/env),"
echo "    OR enable GitHub Actions Tailscale Push (ENABLE_TAILSCALE_DEPLOY=true)."
echo "Option B (Local build fallback): Clone & build in ${APP_DIR}: npm ci && npm run build"
echo ""
echo "Install systemd units:"
echo "  sudo cp ${APP_DIR}/deploy/antigravity-chat.service /etc/systemd/system/"
echo "  sudo cp ${APP_DIR}/deploy/antigravity-chat-updater.service /etc/systemd/system/"
echo "  sudo cp ${APP_DIR}/deploy/antigravity-chat-updater.timer /etc/systemd/system/"
echo "Expose ONLY via Tailscale HTTPS (do NOT open port 3000 in OCI/iptables):"
echo "  curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up"
echo "  sudo tailscale serve --bg http://127.0.0.1:3000"
echo "Enable services:"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable --now antigravity-chat"
echo "  sudo systemctl enable --now antigravity-chat-updater.timer"
