# Architecture & Oracle Cloud Always Free Ubuntu Guide

## 1. System Overview & Non-Negotiable Principles

Antigravity Chat UI is an independent, ChatGPT-like Web client wrapping the **unmodified** Google Antigravity ACP binary (`agy acp`).

Absolute design boundaries upheld in every module:
1. **Not a generic LLM proxy**: Exposes no OpenAI-compatible API, no model re-hosting, and no third-party agent runner.
2. **Unmodified official binary & protocol**: Invokes official `agy acp` over stdio using `@agentclientprotocol/sdk` (`v1/stable`). Never patches Antigravity binaries, never reads/copies/parses `$HOME/.gemini/antigravity-cli/antigravity-oauth-token` or internal token files, and never calls undocumented Google internal endpoints.
3. **Zero hidden prompt injection**: Post-processes Markdown, copyable code/table/quote blocks, Mermaid diagrams, KaTeX math, and workspace file links strictly inside the Web UI & server presentation layer. Only explicit user prompts and explicit user-authored project instructions enter `session/prompt`.
4. **Web Login <-> 1:1 Isolated `agy` Profile**: Web accounts authenticate with lightweight local credentials (`scrypt` + `HttpOnly` session cookies + CSRF validation), without external Google OAuth, and bind 1:1 to a dedicated `0700` server runtime profile (`DATA_ROOT/profiles/<userId>/agy-home`). New Web users must complete official `agy` authentication (via authorization code paste) before creating ACP sessions or chatting.

---

## 2. Oracle Cloud Always Free (Ubuntu) Evaluation & Sizing

| Oracle Always Free Shape | Specs | Verdict for Antigravity Chat UI | Recommended Server Tuning |
|---|---|---|---|
| **`VM.Standard.A1.Flex` (Ampere ARM64)** | Up to **2 OCPUs, 12 GB RAM** (1,500 OCPU-hours & 9,000 GB-hours/month free), 200 GB total boot/block storage | **Strongly Recommended (provision as 1× 2 OCPU / 12 GB VM rather than splitting into two 1-OCPU VMs).** Official `agy` releases native `linux_arm64` binaries (glibc >= 2.28, supported on Ubuntu 22.04/24.04 LTS). **12 GB RAM** remains plenty for Ubuntu + Node 24 server + `vite build` + multiple `agy acp` workers (~150–350 MB each) + `pdftoppm`. **2 OCPUs** are the primary bottleneck if ACP workers invoke local builds/grep/LibreOffice in parallel, so capping concurrency at 2 keeps Web/WS/Tailscale responsive. | `MAX_CONCURRENT_ACP=2` (or `3` if streaming-only)<br>`MAX_ACP_PER_USER=2`<br>`IDLE_WORKER_MS=600000` (10m)<br>`INSTALL_LIBREOFFICE=0` (default) |
| **`VM.Standard.E2.1.Micro` (AMD x86_64)** | **1/8 OCPU (2 vCPU burstable), 1 GB RAM** | **Possible only for lightweight single-user use.** Needs a 2 GB `/swapfile` (auto-configured by `deploy/ubuntu-setup.sh`), zero heavy conversion tools, and strict ACP worker cap so concurrent processes do not OOM. | `MAX_CONCURRENT_ACP=1`<br>`MAX_ACP_PER_USER=1`<br>`IDLE_WORKER_MS=180000` (3m)<br>`INSTALL_LIBREOFFICE=0` |

### Important Oracle Cloud Always Free Operational Notes
1. **Default Ubuntu iptables**: Oracle Ubuntu images ship with restrictive `iptables` rules in `/etc/iptables/rules.v4` blocking non-SSH inbound ports even if OCI Security Lists allow them. Using **Tailscale (`tailscale serve --bg http://127.0.0.1:3000`)** completely avoids opening any public TCP port on OCI or `iptables`, gives valid automatic HTTPS certificates (`https://<node>.tailnet.ts.net`) required for mobile Safari PWA & Secure cookies, and keeps access inside your tailnet.
2. **Oracle Idle VM Reclamation**: Always Free VMs that stay below 20% CPU, network, AND (for A1) memory utilization continuously over a 7-day rolling window can be reclaimed by Oracle. Normal periodic Web/ACP usage keeps utilization healthy; keep backups off-VM and monitor Oracle Cloud notices.
3. **ARM64 Capacity & Shape Sizing**: Always Free `VM.Standard.A1.Flex` allowance is 1,500 OCPU-hours and 9,000 GB-hours/month (equivalent to 2 OCPUs + 12 GB RAM running 24/7). Allocate all 2 OCPUs and 12 GB into a single VM so the Node server and ACP workers share both cores cleanly (avoid splitting into 1 OCPU/6 GB unless isolating workloads). Note that capacity can temporarily run out in popular regions (Tokyo/Osaka); retry during off-peak hours or bootstrap on `E2.1.Micro` first.
4. **Zero Native C++ Addons**: This codebase intentionally uses Node 24 built-in `node:sqlite`, Python 3 stdlib `pty`, and Node `crypto.scrypt` so `npm ci` compiles zero native C++/Rust modules across ARM64 Ubuntu, x64 Ubuntu, Debian, and Windows.

---

## 3. Multi-Account Headless Isolation Architecture

Unlike macOS Keychain or Windows Credential Manager, headless Ubuntu Server has no D-Bus Secret Service / GNOME Keyring. In headless mode, official `agy` falls back to `FileAuthStore` inside `$HOME/.gemini/antigravity-cli/`.

To safely isolate Web users **without touching `agy` internals**:
- Each Web user receives an isolated directory `DATA_ROOT/profiles/<userId>/agy-home` (`chmod 0700`).
- Every spawned `agy` child process (`agy acp`, `agy acp --login`, `agy auth logout`, `agy -p /usage`) receives a strict **allowlist** environment (forwarding only safe locale/CA/proxy/terminal vars such as `PATH`, `LANG`, `LC_*`, `TZ`, `SSL_CERT_*`, `HTTP_PROXY`/`HTTPS_PROXY`, while stripping `SESSION_SECRET`, `GITHUB_READ_TOKEN`, `SSH_*`, `DBUS_SESSION_BUS_ADDRESS`, `GNOME_KEYRING_CONTROL`, `DISPLAY`, `WAYLAND_DISPLAY`, and `XAUTHORITY`). `HOME` / `XDG_*` point to that user's `agy-home`, `AGY_CLI_DISABLE_AUTO_UPDATE=true`, `SSH_CONNECTION=127.0.0.1`, and `NO_BROWSER=1`.
- On Linux, `SANDBOX_MODE=auto` (default; also configurable as `strict` or `off`, with legacy `ENABLE_BWRAP` fallback) wraps chat ACP workers inside a strict whitelist `bubblewrap` (`bwrap`) container — verified at startup/spawn via `probeBwrapSandbox()`:
  - **No host `/` mount**: Specifically avoids `--ro-bind / /`. Builds a minimal read-only rootfs (`/usr`, `/bin`, `/sbin`, `/lib*`, whitelisted `/etc/ssl`, `/etc/ca-certificates`, `/etc/fonts`, `/etc/libreoffice`, `/etc/resolv.conf`, synthetic 2-line `/etc/passwd` & `/etc/group`) with empty `/home`, `/root`, `/run`, private `/tmp` (`--tmpfs`), and mounts `/opt/antigravity-chat`, `/etc/antigravity-chat`, `/var/lib/antigravity-chat` database, and sibling users' directories **completely invisible**. An isolated document-processing runtime (`/opt/agy-doc-runtime`, provisioned by `deploy/setup-doc-runtime.sh`) is mounted read-only at `/opt/agy-doc-runtime` so all profiles share the Python/Node/LibreOffice/Poppler/Pandoc/QPDF/font toolchain without modifying host global site-packages or user home directories.
  - **Namespace & capability lockdown**: Uses `--unshare-pid`, `--unshare-ipc`, `--unshare-uts`, `--cap-drop ALL`, `--new-session`, `--die-with-parent`.
  - **Workspace mapping**: Binds only the active `(userId, chatId)` chat workspace read-write at `/workspace` (`--chdir /workspace`) and that user's own `agy-home` read-write (required so official `agy` OAuth credentials and session state function cleanly). `toHostWorkspacePath()` and markdown link resolution translate `/workspace/...` back to the host workspace with `realpath` containment checks.
  - **Ubuntu 24.04 AppArmor**: Because Ubuntu 24.04+ restricts unprivileged `userns`, `deploy/ubuntu-setup.sh` and `deploy/apply-bundle.sh` automatically configure `/etc/apparmor.d/bwrap` and set `NoNewPrivileges=false` on `antigravity-chat.service` when `bwrap` is present. Note that outbound network remains open inside `bwrap` so official `agy` can reach Google endpoints (Web UI still enforces session + CSRF on `127.0.0.1:3000`).

---

## 4. Auth Flow (Authorization Code Paste)

1. User logs into Web UI using their server-managed Web account.
2. If their bound `agy` profile is unauthenticated, the backend blocks chat creation/prompts and renders the Antigravity Binding screen.
3. User clicks **「認証リンクを発行」** -> Server launches `python3 server/scripts/agy_pty_login.py agy acp --login` inside that user's isolated `HOME` (`COLUMNS=2400` prevents Google OAuth URL wrapping).
4. Backend parses the `https://accounts.google.com/...` URL from PTY stdout and pushes it to that user's Web UI.
5. User opens the link in their PC or iPhone browser, signs into Google, grants permission, and copies the resulting authorization code.
6. User pastes the authorization code into the Web UI and submits -> backend sends it over stdin to the waiting PTY -> `agy` finishes login natively and exits with code `0`.
7. Backend marks the profile authenticated after optional ACP `initialize` / capability check and broadcasts profile status across all connected devices of that Web user.

---

## 5. Multi-Format Previews & Path Security

- **Workspaces & Artifacts**: Every `(userId, chatId)` receives an isolated workspace at `DATA_ROOT/workspaces/<userId>/<chatId>`. ChatUI renders links to files in that workspace and the chat's Antigravity `brain`, `scratch`, and `playground` directories. The file endpoints read from those directories directly. ACP payloads delivered only as inline bytes are saved for preview and download.
- **Project Shared Files**: Uploaded read-only to `DATA_ROOT/projects/<userId>/<projectId>/files`. When a chat joins/starts in a project or the user explicitly clicks 「共有資料を最新化」, files are copied using CoW (`fs.copyFileSync` / `--reflink=auto` style) into `<workspace>/.project-context/` (or explicit sync folder) and tracked by `project_context_version` so edits inside a chat never alter the project originals or peer chats.
- **Path Containment**: Chat file links, previews, and downloads use `fs.realpathSync` to keep reads within the authorized chat's workspace, brain, scratch, or playground root.
- **Active Content Sandboxing**: HTML/JS artifacts render inside `<iframe sandbox="allow-scripts">` (specifically **omitting `allow-same-origin`** so the artifact origin is opaque and cannot read Web cookies or call APIs) accompanied by strict CSP headers when served from `/api/files/:id/sandbox`. SVGs are sanitized with DOMPurify and rendered inside `<img>` / sanitized viewer rather than inline DOM injection.
- **Quota Transparency**: Quota snapshots are fetched via official `agy -p /usage --output-format json` (falling back to plain `agy -p /usage` and parsing 4-column TSV / structured JSON) on manual refresh or infrequent TTL-gated auto-refresh (minimum 5-minute server cooldown on `ok` snapshots, 2 minutes on errors — never rapid polling, never scraping tokens). If `agy` is unavailable or returns an unparseable/unsupported structure, UI displays `取得不可` honestly without fabricating numbers.
- **Safe Auto-Updates & Zero-VM-Build CI/CD**: Clients compare server `buildId` and `version` (from `index.html`, stamped `sw.js`, `app.js`, and `BUILD_INFO.json` via `/api/health`, `/api/auth/bootstrap`, WebSocket `hello`) and listen for Service Worker `controllerchange` updates, reloading automatically only when idle. On GitHub, `.github/workflows/ci-deploy.yml` runs `scripts/version.mjs` to auto-compute the next SemVer tag (`vX.Y.Z`) from Conventional Commits, runs `typecheck`, `test`, `build`, stamps `sw.js` & `BUILD_INFO.json`, packages an architecture-independent pure-JS server runtime + `web/dist` tarball (~41 MB unpacked, zero native C++ addons) onto a versioned GitHub Release (`vX.Y.Z`), and either pushes immediately over Tailscale (`deploy-tailscale`) or lets `deploy/antigravity-chat-updater.timer` pull and extract the latest SemVer-tagged bundle atomically via `deploy/apply-bundle.sh` while preserving `/etc/antigravity-chat/env`.

---

## 6. ToS & Usage Compliance Checklist (§12.15)

- [x] **No binary/source modification** of `agy`.
- [x] **No token file scraping/decoding** (`antigravity-oauth-token` is never opened by Node/Python application code).
- [x] **No internal private APIs** (`retrieveUserQuotaSummary`, `loadCodeAssist`, etc. are never called directly).
- [x] **No OpenAI proxy / generic model API** endpoints.
- [x] **Honest ACP client identity**: `clientInfo = { name: "antigravity-chat-ui", version: "<resolved app version>" }`.
- [x] **Consumer `oauth-personal` caveat surfaced to operators**: `oauth-personal` forbids third-party `multi-user serving` (commercial/external hosting). Restrict personal Oracle instances to your own accounts / household, or use approved organizational/API-key auth if hosting external teams.
