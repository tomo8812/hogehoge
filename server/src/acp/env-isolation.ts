import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppConfig } from '../config.js';
import type { SandboxStatus } from '../types.js';

const require = createRequire(import.meta.url);

export const SANDBOX_WORKSPACE_MOUNT = '/workspace';
export const SANDBOX_HOME_MOUNT = '/home/sandbox';
export const SANDBOX_DOC_RUNTIME_MOUNT = '/opt/agy-doc-runtime';

export function getChatBrainHostDir(profileDir: string, workspaceDir?: string | null): string {
  const profileAbs = path.resolve(profileDir);
  const wsKey = workspaceDir ? path.basename(path.resolve(workspaceDir)) : 'default';
  return path.join(profileAbs, '.chat-brains', wsKey || 'default');
}

export interface IsolatedEnvOptions {
  profileDir: string;
  geminiApiKey?: string | null;
  includeMockVars?: boolean;
  sandboxTmpDir?: string | null;
  extraEnv?: Record<string, string | undefined>;
}

const SAFE_HOST_ENV_ALLOWLIST = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'COLORTERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

const SYSTEM_MOUNT_ROOTS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32'] as const;

const ETC_WHITELIST_DIRS = [
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/pki',
  '/etc/ld.so.conf.d',
  '/etc/alternatives',
  '/etc/terminfo',
  '/etc/fonts',
  '/etc/libreoffice',
  '/etc/ImageMagick-6',
  '/etc/ImageMagick-7',
] as const;

const ETC_WHITELIST_FILES = [
  '/etc/resolv.conf',
  '/etc/hosts',
  '/etc/nsswitch.conf',
  '/etc/gai.conf',
  '/etc/host.conf',
  '/etc/services',
  '/etc/protocols',
  '/etc/ca-certificates.conf',
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/localtime',
  '/etc/timezone',
  '/etc/os-release',
  '/etc/lsb-release',
  '/etc/mime.types',
] as const;

export function buildIsolatedAgyEnv(opts: IsolatedEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of SAFE_HOST_ENV_ALLOWLIST) {
    const val = process.env[key];
    if (typeof val === 'string' && val.length > 0) {
      env[key] = val;
    }
  }
  if (!env.PATH) {
    env.PATH = '/usr/local/bin:/usr/bin:/bin';
  }
  if (opts.includeMockVars && process.env.MOCK_ALLOW_UNAUTH !== undefined) {
    env.MOCK_ALLOW_UNAUTH = process.env.MOCK_ALLOW_UNAUTH;
  }
  if (opts.includeMockVars && process.env.MOCK_CLIENT_INFO_PATH !== undefined) {
    env.MOCK_CLIENT_INFO_PATH = process.env.MOCK_CLIENT_INFO_PATH;
  }

  const profileAbs = path.resolve(opts.profileDir);
  const xdgConfig = path.join(profileAbs, '.config');
  const xdgData = path.join(profileAbs, '.local', 'share');
  const xdgState = path.join(profileAbs, '.local', 'state');
  const xdgCache = path.join(profileAbs, '.cache');
  const hostTmpDir = path.join(profileAbs, '.tmp');

  for (const dir of [profileAbs, xdgConfig, xdgData, xdgState, xdgCache, hostTmpDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const effectiveTmpDir = opts.sandboxTmpDir || hostTmpDir;

  env.HOME = profileAbs;
  env.USERPROFILE = profileAbs;
  env.XDG_CONFIG_HOME = xdgConfig;
  env.XDG_DATA_HOME = xdgData;
  env.XDG_STATE_HOME = xdgState;
  env.XDG_CACHE_HOME = xdgCache;
  env.TMPDIR = effectiveTmpDir;
  env.TEMP = effectiveTmpDir;
  env.TMP = effectiveTmpDir;
  env.USER = 'sandbox';
  env.LOGNAME = 'sandbox';
  env.SHELL = '/bin/bash';
  env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';
  env.NO_BROWSER = '1';
  env.SSH_CONNECTION = '127.0.0.1 0 127.0.0.1 22';
  env.TERM = 'xterm-256color';

  if (opts.geminiApiKey) {
    env.GEMINI_API_KEY = opts.geminiApiKey;
  }

  if (opts.extraEnv) {
    for (const [k, v] of Object.entries(opts.extraEnv)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
  return env;
}

export function resolveHostExecutable(bin: string, searchPath = process.env.PATH): string | null {
  const trimmed = bin.trim();
  if (!trimmed) return null;

  const tryCandidate = (candidate: string): string | null => {
    try {
      const st = fs.statSync(candidate);
      if (!st.isFile()) return null;
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      return null;
    }
  };

  if (trimmed.includes('/')) {
    return tryCandidate(path.resolve(trimmed));
  }

  for (const dir of (searchPath || '/usr/local/bin:/usr/bin:/bin').split(path.delimiter)) {
    if (!dir) continue;
    const hit = tryCandidate(path.join(dir, trimmed));
    if (hit) return hit;
  }
  return null;
}

export const SYSTEM_STANDARD_BIN_DIRS = ['/usr/local/bin', '/usr/bin', '/bin'] as const;

/**
 * Resolves the single canonical `agy` executable path so that server startup,
 * sandboxed ACP workers, non-sandboxed login/quota calls, and updaters all use
 * the exact same binary rather than drifting across user/shell PATH differences.
 */
export function resolveCanonicalAgyBin(
  configuredBin: string,
  searchPath = process.env.PATH,
  systemDirs: readonly string[] = SYSTEM_STANDARD_BIN_DIRS
): string {
  const trimmed = configuredBin.trim() || 'agy';
  if (trimmed.includes('/')) {
    return resolveHostExecutable(trimmed, searchPath) ?? path.resolve(trimmed);
  }
  if (trimmed === 'agy') {
    const systemSearchPath = systemDirs.filter(Boolean).join(path.delimiter);
    const systemHit = systemSearchPath ? resolveHostExecutable(trimmed, systemSearchPath) : null;
    if (systemHit) return systemHit;
  }
  return resolveHostExecutable(trimmed, searchPath) ?? trimmed;
}

function isInsideSystemMountTree(targetPath: string, mountedDirs: Set<string>): boolean {
  for (const dir of mountedDirs) {
    if (targetPath === dir || targetPath.startsWith(`${dir}/`)) {
      return true;
    }
  }
  return false;
}

function ensureSyntheticSandboxPasswdFiles(profileAbs: string): { passwdPath: string; groupPath: string } {
  const sandboxEtcDir = path.join(path.dirname(profileAbs), '.sandbox-etc');
  fs.mkdirSync(sandboxEtcDir, { recursive: true, mode: 0o700 });

  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;

  const passwdPath = path.join(sandboxEtcDir, 'passwd');
  const groupPath = path.join(sandboxEtcDir, 'group');

  const passwdContent = `root:x:0:0:root:/root:/bin/sh\nsandbox:x:${uid}:${gid}:Sandbox:${SANDBOX_WORKSPACE_MOUNT}:/bin/bash\n`;
  const groupContent = `root:x:0:\nsandbox:x:${gid}:\n`;

  fs.writeFileSync(passwdPath, passwdContent, { mode: 0o644 });
  fs.writeFileSync(groupPath, groupContent, { mode: 0o644 });

  return { passwdPath, groupPath };
}

function buildCoreBwrapRootfsArgs(): { args: string[]; mountedSystemDirs: Set<string> } {
  const args: string[] = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--hostname',
    'agy-sandbox',
    '--cap-drop',
    'ALL',
  ];

  const mountedSystemDirs = new Set<string>();
  for (const sysPath of SYSTEM_MOUNT_ROOTS) {
    try {
      const lst = fs.lstatSync(sysPath);
      if (lst.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(sysPath);
        args.push('--symlink', linkTarget, sysPath);
      } else if (lst.isDirectory()) {
        args.push('--ro-bind', sysPath, sysPath);
        mountedSystemDirs.add(sysPath);
      }
    } catch {
      // Skip absent system paths (e.g. /lib32 on arm64)
    }
  }

  args.push(
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/var',
    '--tmpfs',
    '/var/tmp',
    '--dir',
    '/run',
    '--dir',
    '/home',
    '--dir',
    '/root',
    '--dir',
    '/etc'
  );

  const mountedEtcDirs: string[] = [];
  for (const dirPath of ETC_WHITELIST_DIRS) {
    try {
      const real = fs.realpathSync(dirPath);
      if (fs.statSync(real).isDirectory()) {
        args.push('--ro-bind', real, dirPath);
        mountedEtcDirs.push(dirPath);
      }
    } catch {
      // Ignore absent optional /etc subdirectories
    }
  }

  const mountEtcFile = (filePath: string) => {
    if (mountedEtcDirs.some((d) => filePath.startsWith(`${d}/`))) {
      return;
    }
    try {
      const real = fs.realpathSync(filePath);
      if (fs.statSync(real).isFile()) {
        args.push('--ro-bind', real, filePath);
      }
    } catch {
      // Ignore absent optional /etc files
    }
  };

  for (const filePath of ETC_WHITELIST_FILES) {
    mountEtcFile(filePath);
  }
  for (const envVar of ['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']) {
    const val = process.env[envVar];
    if (val && path.isAbsolute(val) && val.startsWith('/etc/')) {
      mountEtcFile(val);
    }
  }

  return { args, mountedSystemDirs };
}

export interface SpawnCommandSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  sandboxed: boolean;
  sandboxWorkspaceRoot: string;
}

const sandboxProbeCache = new Map<string, SandboxStatus>();

export function clearSandboxProbeCache(): void {
  sandboxProbeCache.clear();
}

export function probeBwrapSandbox(config: AppConfig, useCache = true): SandboxStatus {
  if (config.agyMode === 'mock') {
    return {
      mode: config.sandboxMode,
      active: false,
      backend: 'mock',
      reason: 'モックモード（AGY_MODE=mock）で動作中です。',
      remediation: null,
    };
  }
  if (config.sandboxMode === 'off') {
    return {
      mode: 'off',
      active: false,
      backend: 'none',
      reason: '設定（SANDBOX_MODE=off）によりOSレベルの隔離が無効化されています。',
      remediation: '/etc/antigravity-chat/env から SANDBOX_MODE=off / ENABLE_BWRAP=false を外して再起動してください。',
    };
  }
  if (process.platform !== 'linux') {
    return {
      mode: config.sandboxMode,
      active: false,
      backend: 'none',
      reason: `bubblewrap サンドボックスは Linux 専用です（現在: ${process.platform}）。`,
      remediation: null,
    };
  }

  const cacheKey = `${config.sandboxMode}|${config.agyMode}|${config.bwrapBin}`;
  if (useCache) {
    const cached = sandboxProbeCache.get(cacheKey);
    if (cached) return cached;
  }

  const bwrapResolved = resolveHostExecutable(config.bwrapBin);
  if (!bwrapResolved) {
    const res: SandboxStatus = {
      mode: config.sandboxMode,
      active: false,
      backend: 'none',
      reason: `bubblewrap (${config.bwrapBin}) が見つかりません。`,
      remediation: 'Ubuntu サーバーで sudo apt-get update && sudo apt-get install -y bubblewrap を実行してください。',
    };
    sandboxProbeCache.set(cacheKey, res);
    return res;
  }

  const trueBin = resolveHostExecutable('true');
  const shBin = trueBin ? null : resolveHostExecutable('sh');
  const probeExec = trueBin ?? shBin;
  if (!probeExec) {
    const res: SandboxStatus = {
      mode: config.sandboxMode,
      active: false,
      backend: 'none',
      reason: 'サンドボックス検証用バイナリ（true / sh）が見つかりません。',
      remediation: null,
    };
    sandboxProbeCache.set(cacheKey, res);
    return res;
  }

  const { args: rootArgs } = buildCoreBwrapRootfsArgs();
  const probeArgs = [
    ...rootArgs,
    '--tmpfs',
    SANDBOX_WORKSPACE_MOUNT,
    '--chdir',
    SANDBOX_WORKSPACE_MOUNT,
    '--',
    probeExec,
    ...(trueBin ? [] : ['-c', 'exit 0']),
  ];

  let res: SandboxStatus;
  try {
    execFileSync(bwrapResolved, probeArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
    });
    res = {
      mode: config.sandboxMode,
      active: true,
      backend: 'bwrap',
      reason: null,
      remediation: null,
    };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = (e.stderr ? String(e.stderr) : e.message ?? '').trim();
    const isPermissionIssue = /permission denied|operation not permitted|uid map|uid_map|apparmor|userns/i.test(stderr);
    res = {
      mode: config.sandboxMode,
      active: false,
      backend: 'none',
      reason: isPermissionIssue
        ? 'Ubuntu AppArmor またはカーネル名前空間の制限により bubblewrap の起動が拒否されました。'
        : `bubblewrap の起動テストに失敗しました: ${stderr.slice(0, 180) || 'unknown error'}`,
      remediation: isPermissionIssue
        ? 'Ubuntu サーバーで最新の sudo bash deploy/ubuntu-setup.sh を実行し、/etc/apparmor.d/bwrap の作成と systemd の NoNewPrivileges=false を反映してください。'
        : 'sudo systemctl restart antigravity-chat と bubblewrap の動作を確認してください。',
    };
  }

  sandboxProbeCache.set(cacheKey, res);
  return res;
}

function getTsxImportUrl(): string {
  const resolved = require.resolve('tsx');
  return pathToFileURL(resolved).href;
}

function symlinkIfMissing(targetPath: string, linkPath: string): void {
  if (!fs.existsSync(targetPath)) return;
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink() || st.isFile() || st.isDirectory()) return;
  } catch {
    // does not exist
  }
  try {
    fs.symlinkSync(targetPath, linkPath);
  } catch {
    // ignore if created concurrently
  }
}

export function prepareAgyUsageHome(profileDir: string, usageHome: string): void {
  const profile = path.resolve(profileDir);
  for (const name of ['.mock-agy-auth.json', '.config', '.local', '.cache']) {
    symlinkIfMissing(path.join(profile, name), path.join(usageHome, name));
  }

  // Share credentials and other CLI data, while letting the one-shot command
  // normalize only its own copy of settings.json.
  const settingsDir = path.join('.gemini', 'antigravity-cli');
  for (const relativeDir of ['.gemini', settingsDir]) {
    const source = path.join(profile, relativeDir);
    const destination = path.join(usageHome, relativeDir);
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    const entries = fs.existsSync(source) ? fs.readdirSync(source) : [];
    for (const name of entries) {
      const from = path.join(source, name);
      const to = path.join(destination, name);
      if (relativeDir === '.gemini' && name === 'antigravity-cli') continue;
      if (relativeDir === settingsDir && name === 'settings.json') {
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      } else {
        symlinkIfMissing(from, to);
      }
    }
  }
}

export function ensurePerChatHomeDir(profileDir: string, workspaceDir: string): string {
  const profileAbs = path.resolve(profileDir);
  const workspaceAbs = path.resolve(workspaceDir);
  const wsKey = path.basename(workspaceAbs) || 'default';
  const chatHomeDir = path.join(profileAbs, '.chat-homes', wsKey);
  const chatBrainHostDir = getChatBrainHostDir(profileAbs, workspaceAbs);
  const chatScratchHostDir = path.join(profileAbs, '.chat-scratch', wsKey);
  const chatPlaygroundHostDir = path.join(profileAbs, '.chat-playground', wsKey);

  fs.mkdirSync(chatHomeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(chatBrainHostDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(chatScratchHostDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(chatPlaygroundHostDir, { recursive: true, mode: 0o700 });

  // Symlink top-level shared auth/XDG items from profileAbs
  for (const name of ['.mock-agy-auth.json', '.config', '.local', '.cache']) {
    symlinkIfMissing(path.join(profileAbs, name), path.join(chatHomeDir, name));
  }

  // Isolate .gemini per chat while sharing auth/config/skills
  const profileGemini = path.join(profileAbs, '.gemini');
  const chatGemini = path.join(chatHomeDir, '.gemini');
  fs.mkdirSync(chatGemini, { recursive: true, mode: 0o700 });

  const isolatedVendorDirs = new Set(['antigravity', 'antigravity-cli', 'jetski']);
  const isolatedLeafDirs = new Set(['brain', 'scratch', 'playground']);

  if (fs.existsSync(profileGemini)) {
    for (const entry of fs.readdirSync(profileGemini, { withFileTypes: true })) {
      if (isolatedVendorDirs.has(entry.name) || isolatedLeafDirs.has(entry.name)) continue;
      symlinkIfMissing(path.join(profileGemini, entry.name), path.join(chatGemini, entry.name));
    }
  }

  symlinkIfMissing(chatBrainHostDir, path.join(chatGemini, 'brain'));
  symlinkIfMissing(chatScratchHostDir, path.join(chatGemini, 'scratch'));
  symlinkIfMissing(chatPlaygroundHostDir, path.join(chatGemini, 'playground'));

  for (const vendor of isolatedVendorDirs) {
    const chatVendorDir = path.join(chatGemini, vendor);
    const profileVendorDir = path.join(profileGemini, vendor);
    fs.mkdirSync(chatVendorDir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(profileVendorDir)) {
      for (const entry of fs.readdirSync(profileVendorDir, { withFileTypes: true })) {
        if (isolatedLeafDirs.has(entry.name)) continue;
        symlinkIfMissing(path.join(profileVendorDir, entry.name), path.join(chatVendorDir, entry.name));
      }
    }
    symlinkIfMissing(chatBrainHostDir, path.join(chatVendorDir, 'brain'));
    symlinkIfMissing(chatScratchHostDir, path.join(chatVendorDir, 'scratch'));
    symlinkIfMissing(chatPlaygroundHostDir, path.join(chatVendorDir, 'playground'));
  }

  return chatHomeDir;
}

export function buildAgyCommandSpec(params: {
  config: AppConfig;
  subcommandArgs: string[];
  profileDir: string;
  workspaceDir?: string;
  geminiApiKey?: string | null;
  enableSandboxBwrap?: boolean;
}): SpawnCommandSpec {
  const workspaceFallback = path.resolve(params.workspaceDir ?? params.profileDir);

  const isProbeWorkspace =
    !params.workspaceDir || path.basename(path.resolve(params.workspaceDir)) === '.probe';

  if (params.config.agyMode === 'mock') {
    const effectiveHome = !isProbeWorkspace
      ? ensurePerChatHomeDir(params.profileDir, params.workspaceDir!)
      : params.profileDir;
    const env = buildIsolatedAgyEnv({
      profileDir: params.profileDir,
      geminiApiKey: params.geminiApiKey,
      includeMockVars: true,
      extraEnv: !isProbeWorkspace
        ? {
            HOME: effectiveHome,
            USERPROFILE: effectiveHome,
          }
        : undefined,
    });
    const mockArgs = params.config.mockAgentPath.endsWith('.ts')
      ? ['--import', getTsxImportUrl(), params.config.mockAgentPath, ...params.subcommandArgs]
      : [params.config.mockAgentPath, ...params.subcommandArgs];
    return {
      command: process.execPath,
      args: mockArgs,
      env,
      sandboxed: false,
      sandboxWorkspaceRoot: workspaceFallback,
    };
  }

  const agyArgs =
    params.subcommandArgs[0] === 'acp'
      ? [...params.subcommandArgs, '--disable-telemetry']
      : params.subcommandArgs;

  const docRuntime = resolveDocRuntimeLayout(params.config.docRuntimeDir);

  const wantsSandbox =
    Boolean(params.enableSandboxBwrap) &&
    params.config.sandboxMode !== 'off' &&
    process.platform === 'linux' &&
    Boolean(params.workspaceDir);

  if (wantsSandbox) {
    const profileAbs = path.resolve(params.profileDir);
    const workspaceAbs = path.resolve(params.workspaceDir!);
    const bwrapCommand = resolveHostExecutable(params.config.bwrapBin) ?? params.config.bwrapBin;

    const env = buildIsolatedAgyEnv({
      profileDir: profileAbs,
      geminiApiKey: params.geminiApiKey,
      sandboxTmpDir: '/tmp',
      extraEnv: {
        HOME: SANDBOX_HOME_MOUNT,
        USERPROFILE: SANDBOX_HOME_MOUNT,
        XDG_CONFIG_HOME: `${SANDBOX_HOME_MOUNT}/.config`,
        XDG_DATA_HOME: `${SANDBOX_HOME_MOUNT}/.local/share`,
        XDG_STATE_HOME: `${SANDBOX_HOME_MOUNT}/.local/state`,
        XDG_CACHE_HOME: `${SANDBOX_HOME_MOUNT}/.cache`,
      },
    });

    const { args: rootArgs, mountedSystemDirs } = buildCoreBwrapRootfsArgs();
    const { passwdPath, groupPath } = ensureSyntheticSandboxPasswdFiles(profileAbs);

    const bwrapArgs: string[] = [
      ...rootArgs,
      '--ro-bind',
      passwdPath,
      '/etc/passwd',
      '--ro-bind',
      groupPath,
      '/etc/group',
    ];

    try {
      const fontCacheReal = fs.realpathSync('/var/cache/fontconfig');
      if (fs.statSync(fontCacheReal).isDirectory()) {
        bwrapArgs.push('--dir', '/var/cache', '--ro-bind', fontCacheReal, '/var/cache/fontconfig');
      }
    } catch {
      // Ignore absent host fontconfig cache
    }

    let optDirMounted = false;
    const ensureOptDir = () => {
      if (!optDirMounted) {
        bwrapArgs.push('--dir', '/opt');
        optDirMounted = true;
      }
    };

    if (docRuntime) {
      ensureOptDir();
      bwrapArgs.push('--ro-bind', docRuntime.hostDir, SANDBOX_DOC_RUNTIME_MOUNT);
      applyDocRuntimeToEnv(env, SANDBOX_DOC_RUNTIME_MOUNT, docRuntime);
    }

    const resolvedAgy = resolveCanonicalAgyBin(params.config.agyBin, env.PATH);
    let sandboxAgyCommand = resolvedAgy;

    if (resolvedAgy.includes('/')) {
      if (isInsideSystemMountTree(resolvedAgy, mountedSystemDirs)) {
        sandboxAgyCommand = resolvedAgy;
      } else {
        ensureOptDir();
        bwrapArgs.push('--dir', '/opt/agy', '--ro-bind', resolvedAgy, '/opt/agy/agy');
        env.PATH = `/opt/agy:${env.PATH || '/usr/local/bin:/usr/bin:/bin'}`;
        sandboxAgyCommand = '/opt/agy/agy';
      }
    }

    const chatBrainHostDir = getChatBrainHostDir(profileAbs, workspaceAbs);
    const wsKey = path.basename(workspaceAbs) || 'default';
    const chatScratchHostDir = path.join(profileAbs, '.chat-scratch', wsKey);
    const chatPlaygroundHostDir = path.join(profileAbs, '.chat-playground', wsKey);
    fs.mkdirSync(chatBrainHostDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(chatScratchHostDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(chatPlaygroundHostDir, { recursive: true, mode: 0o700 });
    const brainSubdirs = [
      ['.gemini', 'antigravity-cli', 'brain'],
      ['.gemini', 'antigravity', 'brain'],
      ['.gemini', 'jetski', 'brain'],
      ['.gemini', 'brain'],
    ] as const;
    const scratchSubdirs = [
      ['.gemini', 'antigravity-cli', 'scratch'],
      ['.gemini', 'antigravity', 'scratch'],
      ['.gemini', 'jetski', 'scratch'],
      ['.gemini', 'scratch'],
    ] as const;
    const playgroundSubdirs = [
      ['.gemini', 'antigravity', 'playground'],
      ['.gemini', 'jetski', 'playground'],
      ['.gemini', 'playground'],
    ] as const;
    for (const rel of [...brainSubdirs, ...scratchSubdirs, ...playgroundSubdirs]) {
      fs.mkdirSync(path.join(profileAbs, ...rel), { recursive: true, mode: 0o700 });
    }
    for (const hiddenDir of ['.chat-brains', '.chat-homes', '.chat-scratch', '.chat-playground']) {
      fs.mkdirSync(path.join(profileAbs, hiddenDir), { recursive: true, mode: 0o700 });
    }

    bwrapArgs.push(
      '--bind',
      profileAbs,
      SANDBOX_HOME_MOUNT,
      '--tmpfs',
      `${SANDBOX_HOME_MOUNT}/.chat-brains`,
      '--tmpfs',
      `${SANDBOX_HOME_MOUNT}/.chat-homes`,
      '--tmpfs',
      `${SANDBOX_HOME_MOUNT}/.chat-scratch`,
      '--tmpfs',
      `${SANDBOX_HOME_MOUNT}/.chat-playground`,
      '--bind',
      chatBrainHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/antigravity-cli/brain`,
      '--bind',
      chatBrainHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/antigravity/brain`,
      '--bind',
      chatBrainHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/jetski/brain`,
      '--bind',
      chatBrainHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/brain`,
      '--bind',
      chatScratchHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/antigravity-cli/scratch`,
      '--bind',
      chatScratchHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/antigravity/scratch`,
      '--bind',
      chatScratchHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/jetski/scratch`,
      '--bind',
      chatScratchHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/scratch`,
      '--bind',
      chatPlaygroundHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/antigravity/playground`,
      '--bind',
      chatPlaygroundHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/jetski/playground`,
      '--bind',
      chatPlaygroundHostDir,
      `${SANDBOX_HOME_MOUNT}/.gemini/playground`,
      '--bind',
      workspaceAbs,
      SANDBOX_WORKSPACE_MOUNT,
      '--chdir',
      SANDBOX_WORKSPACE_MOUNT,
      '--',
      sandboxAgyCommand,
      ...agyArgs
    );

    return {
      command: bwrapCommand,
      args: bwrapArgs,
      env,
      sandboxed: true,
      sandboxWorkspaceRoot: SANDBOX_WORKSPACE_MOUNT,
    };
  }

  const effectiveHome = params.workspaceDir
    ? ensurePerChatHomeDir(params.profileDir, params.workspaceDir)
    : params.profileDir;
  const env = buildIsolatedAgyEnv({
    profileDir: params.profileDir,
    geminiApiKey: params.geminiApiKey,
    extraEnv: params.workspaceDir
      ? {
          HOME: effectiveHome,
          USERPROFILE: effectiveHome,
        }
      : undefined,
  });

  if (docRuntime) {
    applyDocRuntimeToEnv(env, docRuntime.hostDir, docRuntime);
  }

  return {
    command: resolveCanonicalAgyBin(params.config.agyBin, env.PATH),
    args: agyArgs,
    env,
    sandboxed: false,
    sandboxWorkspaceRoot: workspaceFallback,
  };
}

interface DocRuntimeLayout {
  hostDir: string;
  venvBinRel: string | null;
  nodeModulesRel: string | null;
  nodeBinRel: string | null;
  pythonSiteRels: string[];
}

function resolveDocRuntimeLayout(rawDir?: string | null): DocRuntimeLayout | null {
  if (!rawDir || !rawDir.trim()) return null;
  let hostDir: string;
  try {
    hostDir = fs.realpathSync(path.resolve(rawDir));
    if (!fs.statSync(hostDir).isDirectory()) return null;
  } catch {
    return null;
  }

  const hasDir = (rel: string): string | null => {
    try {
      const full = path.join(hostDir, rel);
      return fs.statSync(full).isDirectory() ? rel : null;
    } catch {
      return null;
    }
  };

  const venvBinRel = hasDir(path.join('venv', 'bin'));
  const nodeModulesRel = hasDir(path.join('node', 'node_modules')) ?? hasDir('node_modules');
  const nodeBinRel =
    hasDir(path.join('node', 'node_modules', '.bin')) ?? hasDir(path.join('node_modules', '.bin'));

  const pythonSiteRels: string[] = [];
  for (const libName of ['lib', 'lib64']) {
    const libDir = path.join(hostDir, 'venv', libName);
    try {
      if (!fs.statSync(libDir).isDirectory()) continue;
      for (const entry of fs.readdirSync(libDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('python')) continue;
        const siteRel = path.join('venv', libName, entry.name, 'site-packages');
        if (hasDir(siteRel)) {
          pythonSiteRels.push(siteRel);
        }
      }
    } catch {
      // ignore missing python lib dir
    }
  }

  if (!venvBinRel && !nodeModulesRel && pythonSiteRels.length === 0) {
    return null;
  }

  return {
    hostDir,
    venvBinRel,
    nodeModulesRel,
    nodeBinRel,
    pythonSiteRels,
  };
}

function applyDocRuntimeToEnv(
  env: NodeJS.ProcessEnv,
  mountRoot: string,
  layout: DocRuntimeLayout
): void {
  const pathPrefix: string[] = [];
  if (layout.venvBinRel) {
    pathPrefix.push(path.posix.join(mountRoot, layout.venvBinRel.split(path.sep).join(path.posix.sep)));
  }
  if (layout.nodeBinRel) {
    pathPrefix.push(path.posix.join(mountRoot, layout.nodeBinRel.split(path.sep).join(path.posix.sep)));
  }
  if (pathPrefix.length > 0) {
    env.PATH = `${pathPrefix.join(path.delimiter)}:${env.PATH || '/usr/local/bin:/usr/bin:/bin'}`;
  }

  if (layout.nodeModulesRel) {
    const nm = path.posix.join(mountRoot, layout.nodeModulesRel.split(path.sep).join(path.posix.sep));
    env.NODE_PATH = env.NODE_PATH ? `${nm}${path.delimiter}${env.NODE_PATH}` : nm;
  }

  if (layout.pythonSiteRels.length > 0) {
    const sites = layout.pythonSiteRels.map((r) =>
      path.posix.join(mountRoot, r.split(path.sep).join(path.posix.sep))
    );
    env.PYTHONPATH = env.PYTHONPATH
      ? `${sites.join(path.delimiter)}${path.delimiter}${env.PYTHONPATH}`
      : sites.join(path.delimiter);
  }

  env.PYTHONIOENCODING = 'utf-8';
  env.SAL_USE_VCLPLUGIN = 'svp';
}
