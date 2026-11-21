import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildAgyCommandSpec,
  ensurePerChatHomeDir,
  SANDBOX_DOC_RUNTIME_MOUNT,
  SANDBOX_HOME_MOUNT,
} from '../src/acp/env-isolation.js';
import type { AppConfig } from '../src/config.js';
import { resolveAuthorizedChatFileReference } from '../src/files/link-resolver.js';
import {
  BUILTIN_STATE_FILENAME,
  LEGACY_BUILTIN_SYNC_MARKER,
  listCustomGlobalSkillSlugs,
  migrateLegacySyncedBuiltins,
  readProfileDisabledBuiltins,
  resolveActiveBuiltinSkillsForProfile,
} from '../src/skills/builtin-skills.js';
import type { SkillsListResponse } from '../src/types.js';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

function writeSkillDir(
  parentDir: string,
  slug: string,
  opts: {
    name?: string;
    description?: string;
    instructions?: string;
    files?: Record<string, string>;
    legacyMarker?: boolean;
  } = {},
): string {
  const dir = path.join(parentDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  const name = opts.name ?? slug;
  const description = opts.description ?? `${slug} skill description`;
  const instructions = opts.instructions ?? `# ${slug}\nUse this skill for ${slug}.`;
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions}\n`,
    'utf8',
  );
  if (opts.files) {
    for (const [rel, content] of Object.entries(opts.files)) {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
  }
  if (opts.legacyMarker) {
    fs.writeFileSync(path.join(dir, LEGACY_BUILTIN_SYNC_MARKER), 'builtin-sync-v1', 'utf8');
  }
  return dir;
}

function seedBuiltinCatalog(rootDir: string, versionTag = 'v1'): string {
  const builtinDir = path.join(rootDir, 'builtin-skills');
  fs.mkdirSync(builtinDir, { recursive: true });
  for (const slug of ['docx', 'pptx', 'xlsx', 'pdf']) {
    writeSkillDir(builtinDir, slug, {
      name: `${slug}-${versionTag}`,
      description: `Anthropic ${slug} (${versionTag})`,
      instructions: `# ${slug} (${versionTag})\nOfficial built-in workflow (${versionTag}).`,
      files: slug === 'docx' ? { 'scripts/render.py': `print("docx-${versionTag}")\n` } : undefined,
    });
  }
  fs.writeFileSync(
    path.join(builtinDir, '.builtin-skills-manifest.json'),
    JSON.stringify({
      version: 1,
      skills: {
        docx: { sha256: `sha-docx-${versionTag}` },
        pptx: { sha256: `sha-pptx-${versionTag}` },
        xlsx: { sha256: `sha-xlsx-${versionTag}` },
        pdf: { sha256: `sha-pdf-${versionTag}` },
      },
    }),
    'utf8',
  );
  return builtinDir;
}

type ApiSkillsList = {
  global: Array<{
    slug: string;
    origin?: string;
    hasBuiltinConflict?: boolean;
    storageKind?: string;
    enabled: boolean;
  }>;
  commands: Array<{ name: string; source?: string }>;
};

describe('Anthropic doc skills and runtime isolation', () => {
  test('Built-in vs Custom skills: read-only enforcement, per-user state across updates, and collision protection', async () => {
    const builtinRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-builtin-catalog-'));
    const builtinSkillsDir = seedBuiltinCatalog(builtinRoot, 'v1');
    const srv = await createTestServer({ builtinSkillsDir });

    try {
      const alice = await registerAndBindAgy(srv.baseUrl, 'alice_doc', 'alice-doc');
      const bob = await registerAndBindAgy(srv.baseUrl, 'bob_doc', 'bob-doc');

      // 1. Both users see Built-in skills with origin='builtin', zero files copied to profileDir
      const aliceList1 = await alice.client.request<ApiSkillsList>('GET', '/api/skills');
      expect(aliceList1.status).toBe(200);
      for (const slug of ['docx', 'pptx', 'xlsx', 'pdf']) {
        const found = aliceList1.data.global.find((i) => i.slug === slug);
        expect(found, `Expected built-in skill ${slug}`).toBeTruthy();
        expect(found?.origin).toBe('builtin');
        expect(Boolean(found?.hasBuiltinConflict)).toBe(false);
        expect(found?.storageKind).toBe('builtin');
        expect(found?.enabled).toBe(true);
      }

      const aliceProfile = srv.ctx.db.getAgyProfile(alice.userId)!;
      expect(
        fs.existsSync(path.join(aliceProfile.profileDir, '.gemini', 'config', 'skills', 'docx')),
      ).toBe(false);

      // 2. Built-in detail & resource reads succeed
      const docxDetail = await alice.client.request<{
        skill: {
          origin?: string;
          hasBuiltinConflict?: boolean;
          resources: Array<{ relPath: string }>;
          instructions: string;
        };
      }>('GET', '/api/skills/global/docx');
      expect(docxDetail.status).toBe(200);
      expect(docxDetail.data.skill.origin).toBe('builtin');
      expect(docxDetail.data.skill.resources.some((r) => r.relPath === 'scripts/render.py')).toBe(true);

      const resRead = await alice.client.request<{ relPath: string; content: string }>(
        'GET',
        '/api/skills/global/docx/files?path=scripts%2Frender.py',
      );
      expect(resRead.status).toBe(200);
      expect(resRead.data.content).toContain('docx-v1');

      // 3. Built-in edits, deletes, resource writes/deletes, and duplicate creation are rejected
      const putEdit = await alice.client.request<{ error: string }>('PUT', '/api/skills/global/docx', {
        description: 'Tampered description',
        instructions: 'Tampered instructions',
      });
      expect(putEdit.status).toBe(403);
      expect(putEdit.data.error).toBe('BUILTIN_SKILL_READONLY');

      const deleteBuiltin = await alice.client.request<{ error: string }>('DELETE', '/api/skills/global/docx');
      expect(deleteBuiltin.status).toBe(403);
      expect(deleteBuiltin.data.error).toBe('BUILTIN_SKILL_READONLY');

      const postResourceJson = await alice.client.request<{ error: string }>(
        'POST',
        '/api/skills/global/docx/files',
        { relPath: 'scripts/evil.py', content: 'print("evil")' },
      );
      expect(postResourceJson.status).toBe(403);
      expect(postResourceJson.data.error).toBe('BUILTIN_SKILL_READONLY');

      const form = new FormData();
      form.append('file', new Blob(['x'], { type: 'text/plain' }), 'note.txt');
      const postResourceMultipart = await alice.client.request<{ error: string }>(
        'POST',
        '/api/skills/global/docx/files?folder=resources',
        form,
      );
      expect(postResourceMultipart.status).toBe(403);
      expect(postResourceMultipart.data.error).toBe('BUILTIN_SKILL_READONLY');

      const deleteResource = await alice.client.request<{ error: string }>(
        'DELETE',
        '/api/skills/global/docx/files?path=scripts%2Frender.py',
      );
      expect(deleteResource.status).toBe(403);
      expect(deleteResource.data.error).toBe('BUILTIN_SKILL_READONLY');

      const createCollision = await alice.client.request<{ error: string }>('POST', '/api/skills', {
        scope: 'global',
        slug: 'docx',
        description: 'Trying to shadow built-in via POST',
        instructions: 'Blocked',
      });
      expect(createCollision.status).toBe(409);
      expect(createCollision.data.error).toBe('BUILTIN_SKILL_CONFLICT');

      // Verify Built-in files on disk stayed completely untouched
      expect(fs.readFileSync(path.join(builtinSkillsDir, 'docx', 'scripts', 'render.py'), 'utf8')).toContain(
        'docx-v1',
      );

      // 4. Separate per-user enable/disable state survives Built-in updates
      const disableDocx = await alice.client.request<{
        skill: { origin?: string; enabled: boolean };
      }>('PUT', '/api/skills/global/docx', { enabled: false });
      expect(disableDocx.status).toBe(200);
      expect(disableDocx.data.skill.origin).toBe('builtin');
      expect(disableDocx.data.skill.enabled).toBe(false);

      expect(
        fs.existsSync(path.join(aliceProfile.profileDir, '.gemini', 'config', BUILTIN_STATE_FILENAME)),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(aliceProfile.profileDir, '.gemini', 'config', 'skills-disabled', 'docx')),
      ).toBe(false);

      // Bob still has docx enabled
      const bobDocx = await bob.client.request<{ skill: { enabled: boolean; origin?: string } }>(
        'GET',
        '/api/skills/global/docx',
      );
      expect(bobDocx.status).toBe(200);
      expect(bobDocx.data.skill.origin).toBe('builtin');
      expect(bobDocx.data.skill.enabled).toBe(true);

      // Simulate Built-in bundle update v1 -> v2
      seedBuiltinCatalog(builtinRoot, 'v2');

      // Alice keeps docx disabled across update, sees v2 content on pptx and docx
      const aliceList2 = await alice.client.request<ApiSkillsList>('GET', '/api/skills');
      expect(aliceList2.data.global.find((i) => i.slug === 'docx')?.enabled).toBe(false);
      expect(aliceList2.data.global.find((i) => i.slug === 'pptx')?.enabled).toBe(true);
      expect(aliceList2.data.commands.some((c) => c.name === 'docx')).toBe(false);

      const alicePptxV2 = await alice.client.request<{ skill: { instructions: string } }>(
        'GET',
        '/api/skills/global/pptx',
      );
      expect(alicePptxV2.data.skill.instructions).toContain('v2');

      // Re-enabling docx succeeds cleanly
      const reenableDocx = await alice.client.request<{ skill: { enabled: boolean } }>(
        'PUT',
        '/api/skills/global/docx',
        { enabled: true },
      );
      expect(reenableDocx.status).toBe(200);
      expect(reenableDocx.data.skill.enabled).toBe(true);

      // 5. Custom skill collision across canonical and legacy paths is detected & preserved
      writeSkillDir(path.join(aliceProfile.profileDir, '.gemini', 'config', 'skills'), 'xlsx', {
        name: 'Alice Custom XLSX',
        description: 'Custom xlsx skill',
        instructions: 'Custom xlsx instructions',
      });
      writeSkillDir(path.join(aliceProfile.profileDir, '.gemini', 'antigravity', 'skills'), 'pdf', {
        name: 'Alice Legacy PDF',
        description: 'Legacy antigravity pdf skill',
        instructions: 'Legacy pdf instructions',
      });
      writeSkillDir(path.join(aliceProfile.profileDir, '.gemini', 'skills'), 'pptx', {
        name: 'Alice Legacy PPTX',
        description: 'Legacy skills pptx skill',
        instructions: 'Legacy pptx instructions',
      });

      const aliceListCollision = await alice.client.request<ApiSkillsList>('GET', '/api/skills');

      const aliceXlsx = aliceListCollision.data.global.find((i) => i.slug === 'xlsx');
      expect(aliceXlsx?.origin).toBe('custom');
      expect(aliceXlsx?.hasBuiltinConflict).toBe(true);
      expect(aliceXlsx?.storageKind).toBe('canonical');

      const alicePdf = aliceListCollision.data.global.find((i) => i.slug === 'pdf');
      expect(alicePdf?.origin).toBe('custom');
      expect(alicePdf?.hasBuiltinConflict).toBe(true);
      expect(alicePdf?.storageKind).toBe('legacy');

      const alicePptx = aliceListCollision.data.global.find((i) => i.slug === 'pptx');
      expect(alicePptx?.origin).toBe('custom');
      expect(alicePptx?.hasBuiltinConflict).toBe(true);
      expect(alicePptx?.storageKind).toBe('legacy');

      // Alice can still edit and delete her colliding Custom skill
      const editCustomXlsx = await alice.client.request<{
        skill: { origin?: string; hasBuiltinConflict?: boolean; instructions: string };
      }>('PUT', '/api/skills/global/xlsx', {
        description: 'Updated custom xlsx',
        instructions: 'Updated custom xlsx body',
      });
      expect(editCustomXlsx.status).toBe(200);
      expect(editCustomXlsx.data.skill.origin).toBe('custom');
      expect(editCustomXlsx.data.skill.hasBuiltinConflict).toBe(true);
      expect(editCustomXlsx.data.skill.instructions).toContain('Updated custom xlsx body');

      // Bob is completely unaffected by Alice's colliding skills
      const bobList = await bob.client.request<ApiSkillsList>('GET', '/api/skills');
      const bobXlsx = bobList.data.global.find((i) => i.slug === 'xlsx');
      expect(bobXlsx?.origin).toBe('builtin');
      expect(Boolean(bobXlsx?.hasBuiltinConflict)).toBe(false);

      // Deleting Alice's colliding Custom xlsx immediately reveals Built-in xlsx
      const deleteCustomXlsx = await alice.client.request('DELETE', '/api/skills/global/xlsx');
      expect(deleteCustomXlsx.status).toBe(200);

      const aliceAfterDelete = await alice.client.request<ApiSkillsList>('GET', '/api/skills');
      const restoredBuiltinXlsx = aliceAfterDelete.data.global.find((i) => i.slug === 'xlsx');
      expect(restoredBuiltinXlsx?.origin).toBe('builtin');
      expect(Boolean(restoredBuiltinXlsx?.hasBuiltinConflict)).toBe(false);

      // 6. Regular custom skills remain editable and deletable
      const createCustom = await alice.client.request<{ skill: { slug: string; origin?: string } }>(
        'POST',
        '/api/skills',
        {
          scope: 'global',
          slug: 'my-team-notes',
          description: 'Custom non-conflicting skill',
          instructions: 'Custom notes',
        },
      );
      expect(createCustom.status).toBe(201);
      expect(createCustom.data.skill.origin).toBe('custom');
      expect((await alice.client.request('DELETE', '/api/skills/global/my-team-notes')).status).toBe(200);
    } finally {
      await srv.cleanup();
      fs.rmSync(builtinRoot, { recursive: true, force: true });
    }
  });

  test('Legacy .agy-builtin-skill migration and read-only Built-in link resolution', async () => {
    const builtinRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-builtin-migrate-'));
    const builtinSkillsDir = seedBuiltinCatalog(builtinRoot, 'v1');
    const srv = await createTestServer({ builtinSkillsDir });

    try {
      const alice = await registerAndBindAgy(srv.baseUrl, 'alice_migrate', 'alice-mig');
      const aliceProfile = srv.ctx.db.getAgyProfile(alice.userId)!;

      // Seed old copied built-in artifacts inside profileDir
      writeSkillDir(path.join(aliceProfile.profileDir, '.gemini', 'config', 'skills-disabled'), 'docx', {
        legacyMarker: true,
      });
      writeSkillDir(path.join(aliceProfile.profileDir, '.gemini', 'config', 'skills'), 'pptx', {
        legacyMarker: true,
      });
      // Also place a Custom skill named xlsx WITHOUT the legacy marker (must NOT be removed)
      writeSkillDir(path.join(aliceProfile.profileDir, '.gemini', 'config', 'skills'), 'xlsx', {
        legacyMarker: false,
      });

      migrateLegacySyncedBuiltins(aliceProfile.profileDir);

      expect(
        fs.existsSync(path.join(aliceProfile.profileDir, '.gemini', 'config', 'skills-disabled', 'docx')),
      ).toBe(false);
      expect(
        fs.existsSync(path.join(aliceProfile.profileDir, '.gemini', 'config', 'skills', 'pptx')),
      ).toBe(false);
      expect(
        fs.existsSync(path.join(aliceProfile.profileDir, '.gemini', 'config', 'skills', 'xlsx', 'SKILL.md')),
      ).toBe(true);

      const disabledSet = readProfileDisabledBuiltins(aliceProfile.profileDir);
      const customSlugs = listCustomGlobalSkillSlugs(aliceProfile.profileDir);
      const resolvedState = resolveActiveBuiltinSkillsForProfile(aliceProfile.profileDir, builtinSkillsDir);
      expect(disabledSet.has('docx')).toBe(true);
      expect(customSlugs.has('xlsx')).toBe(true);
      expect(resolvedState.conflicts).toEqual(['xlsx']);
      expect(resolvedState.active.map((entry) => entry.slug).sort()).toEqual(['pdf', 'pptx']);

      // Chat file link resolution resolves active Built-in files read-only (but not disabled/custom-shadowed ones)
      const projRes = await alice.client.request<{ project: { id: string } }>('POST', '/api/projects', {
        name: 'Link Proj',
      });
      const chatRes = await alice.client.request<{ chat: { id: string } }>('POST', '/api/chats', {
        title: 'Link Chat',
        projectId: projRes.data.project.id,
      });

      const activeBuiltinLink = resolveAuthorizedChatFileReference({
        db: srv.ctx.db,
        userId: alice.userId,
        chatId: chatRes.data.chat.id,
        reference: `${SANDBOX_HOME_MOUNT}/.gemini/config/skills/pptx/SKILL.md`,
        builtinSkillsDir,
      });
      expect(activeBuiltinLink).toBeTruthy();

      const disabledBuiltinLink = resolveAuthorizedChatFileReference({
        db: srv.ctx.db,
        userId: alice.userId,
        chatId: chatRes.data.chat.id,
        reference: `${SANDBOX_HOME_MOUNT}/.gemini/config/skills/docx/scripts/render.py`,
        builtinSkillsDir,
      });
      expect(disabledBuiltinLink).toBeNull();
    } finally {
      await srv.cleanup();
      fs.rmSync(builtinRoot, { recursive: true, force: true });
    }
  });

  test('Sandbox bwrap mounts active Built-in skills read-only, Custom skills read-write, and shared doc-runtime read-only', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bwrap-mount-'));
    try {
      const builtinSkillsDir = seedBuiltinCatalog(tmpRoot, 'v1');
      const docRuntimeDir = path.join(tmpRoot, 'doc-runtime');
      fs.mkdirSync(path.join(docRuntimeDir, 'venv', 'bin'), { recursive: true });
      fs.mkdirSync(path.join(docRuntimeDir, 'venv', 'lib', 'python3.11', 'site-packages'), { recursive: true });
      fs.mkdirSync(path.join(docRuntimeDir, 'node', 'node_modules', '.bin'), { recursive: true });
      fs.writeFileSync(path.join(docRuntimeDir, 'venv', 'bin', 'python3'), '#!/bin/sh\n', { mode: 0o755 });
      fs.writeFileSync(path.join(docRuntimeDir, 'manifest.json'), JSON.stringify({ version: 1 }), 'utf8');

      const profileDir = path.join(tmpRoot, 'profile');
      const workspaceDir = path.join(tmpRoot, 'workspace-1');
      fs.mkdirSync(path.join(profileDir, '.gemini', 'config'), { recursive: true });
      fs.mkdirSync(workspaceDir, { recursive: true });

      // Disable pdf; collide xlsx with a Custom skill; add my-custom skill
      fs.writeFileSync(
        path.join(profileDir, '.gemini', 'config', BUILTIN_STATE_FILENAME),
        JSON.stringify({ disabled: ['pdf'] }),
        'utf8',
      );
      writeSkillDir(path.join(profileDir, '.gemini', 'config', 'skills'), 'my-custom');
      writeSkillDir(path.join(profileDir, '.gemini', 'config', 'skills'), 'xlsx', {
        name: 'User Custom XLSX',
      });

      const mockBinDir = path.join(tmpRoot, 'bin');
      fs.mkdirSync(mockBinDir, { recursive: true });
      const fakeBwrap = path.join(mockBinDir, 'bwrap');
      const fakeAgy = path.join(mockBinDir, 'agy');
      fs.writeFileSync(fakeBwrap, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      fs.writeFileSync(fakeAgy, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const chatHome = ensurePerChatHomeDir(profileDir, workspaceDir, builtinSkillsDir);
      expect(fs.readlinkSync(path.join(chatHome, '.gemini', 'config', 'skills', 'docx'))).toBe(
        path.join(builtinSkillsDir, 'docx'),
      );
      expect(fs.readlinkSync(path.join(chatHome, '.gemini', 'config', 'skills', 'my-custom'))).toBe(
        path.join(profileDir, '.gemini', 'config', 'skills', 'my-custom'),
      );
      expect(fs.existsSync(path.join(chatHome, '.gemini', 'config', 'skills', 'pdf'))).toBe(false);

      const cfg: AppConfig = {
        nodeEnv: 'test',
        host: '127.0.0.1',
        port: 0,
        dataRoot: tmpRoot,
        sessionSecret: 'test-secret',
        agyMode: 'cli',
        agyBin: fakeAgy,
        mockAgentPath: '',
        builtinSkillsDir,
        docRuntimeDir,
        maxConcurrentAcp: 2,
        maxAcpPerUser: 1,
        idleWorkerMs: 60_000,
        allowPublicSignup: true,
        secureCookies: 'never',
        sandboxMode: 'bwrap',
        bwrapBin: fakeBwrap,
        libreOfficeBin: null,
        artifactsCacheRoot: path.join(tmpRoot, 'cache'),
      };

      const spec = buildAgyCommandSpec({
        config: cfg,
        subcommandArgs: ['acp'],
        profileDir,
        workspaceDir,
        enableSandboxBwrap: true,
      });

      expect(spec.sandboxed).toBe(true);
      const argsStr = spec.args.join('\n');
      expect(argsStr).toContain(`--tmpfs\n${SANDBOX_HOME_MOUNT}/.gemini/config/skills`);
      expect(argsStr).toContain(
        `--bind\n${fs.realpathSync(path.join(profileDir, '.gemini', 'config', 'skills', 'my-custom'))}\n${SANDBOX_HOME_MOUNT}/.gemini/config/skills/my-custom`,
      );
      expect(argsStr).toContain(
        `--ro-bind\n${fs.realpathSync(path.join(builtinSkillsDir, 'docx'))}\n${SANDBOX_HOME_MOUNT}/.gemini/config/skills/docx`,
      );
      expect(argsStr).not.toContain(`${SANDBOX_HOME_MOUNT}/.gemini/config/skills/pdf`);
      expect(argsStr).not.toContain(`--ro-bind\n${fs.realpathSync(path.join(builtinSkillsDir, 'xlsx'))}`);
      expect(argsStr).toContain(`--ro-bind\n${fs.realpathSync(docRuntimeDir)}\n${SANDBOX_DOC_RUNTIME_MOUNT}`);
      expect(spec.env.NODE_PATH).toContain(`${SANDBOX_DOC_RUNTIME_MOUNT}/node/node_modules`);
      expect(spec.env.PYTHONPATH).toContain(`${SANDBOX_DOC_RUNTIME_MOUNT}/venv/lib/python3.11/site-packages`);
      expect(spec.env.PATH).toContain(`${SANDBOX_DOC_RUNTIME_MOUNT}/venv/bin`);
      expect(spec.env.SAL_USE_VCLPLUGIN).toBe('svp');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('Deploy scripts unify under INSTALL_DOC_RUNTIME=auto|0|1 and protect builtin-skills permissions', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..');

    // Ensure legacy split flags are completely gone from deploy scripts & README
    for (const rel of [
      'deploy/setup-doc-runtime.sh',
      'deploy/ubuntu-setup.sh',
      'deploy/apply-bundle.sh',
      'deploy/auto-update.sh',
      'README.md',
    ]) {
      const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      expect(content).not.toContain('INSTALL_LIBREOFFICE');
      expect(content).not.toContain('AUTO_SETUP_DOC_RUNTIME');
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-doc-runtime-script-'));
    try {
      const setupScript = path.join(repoRoot, 'deploy', 'setup-doc-runtime.sh');
      const emptyEnvFile = path.join(tmpRoot, 'missing-env');

      // INSTALL_DOC_RUNTIME=0 always skips cleanly regardless of RAM
      const skipExplicit = execFileSync('bash', [setupScript], {
        env: { ...process.env, INSTALL_DOC_RUNTIME: '0', ENV_FILE: emptyEnvFile },
        encoding: 'utf8',
      });
      expect(skipExplicit).toMatch(/Skipping setup \(INSTALL_DOC_RUNTIME=0\)/);

      // INSTALL_DOC_RUNTIME=auto skips on low-RAM host (<2.2GB)
      const lowMeminfo = path.join(tmpRoot, 'meminfo-low');
      fs.writeFileSync(lowMeminfo, 'MemTotal:        1500000 kB\n', 'utf8');
      const skipAutoLow = execFileSync('bash', [setupScript], {
        env: {
          ...process.env,
          INSTALL_DOC_RUNTIME: 'auto',
          ENV_FILE: emptyEnvFile,
          MEMINFO_FILE: lowMeminfo,
        },
        encoding: 'utf8',
      });
      expect(skipAutoLow).toMatch(/Skipping automatic setup on low-RAM host/);

      // ENV_FILE (/etc/antigravity-chat/env equivalent) can disable setup consistently
      const disabledEnvFile = path.join(tmpRoot, 'chat-env');
      fs.writeFileSync(disabledEnvFile, 'INSTALL_DOC_RUNTIME=0\n', 'utf8');
      const skipViaEnvFile = execFileSync('bash', [setupScript], {
        env: { ...process.env, INSTALL_DOC_RUNTIME: 'auto', ENV_FILE: disabledEnvFile },
        encoding: 'utf8',
      });
      expect(skipViaEnvFile).toMatch(/Skipping setup \(INSTALL_DOC_RUNTIME=0\)/);

      // apply-bundle.sh preserves read-only go-w on builtin-skills and skips doc-runtime when INSTALL_DOC_RUNTIME=0
      const appDir = path.join(tmpRoot, 'app');
      const bundleSrc = path.join(tmpRoot, 'bundle-src');
      const bundleTar = path.join(tmpRoot, 'antigravity-chat-bundle.tar.gz');
      const binDir = path.join(tmpRoot, 'bin');
      fs.mkdirSync(path.join(bundleSrc, 'server', 'dist'), { recursive: true });
      fs.mkdirSync(path.join(bundleSrc, 'web', 'dist'), { recursive: true });
      fs.mkdirSync(path.join(bundleSrc, 'builtin-skills', 'docx'), { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(bundleSrc, 'package.json'), '{"name":"agy-chatui"}\n');
      fs.writeFileSync(
        path.join(bundleSrc, 'builtin-skills', 'docx', 'SKILL.md'),
        '---\nname: docx\ndescription: x\n---\n',
        { mode: 0o666 },
      );
      fs.writeFileSync(path.join(bundleSrc, 'setup-doc-runtime.sh'), fs.readFileSync(setupScript, 'utf8'), {
        mode: 0o755,
      });
      execFileSync('tar', ['-czf', bundleTar, '-C', bundleSrc, '.']);

      const fakeAgy = path.join(binDir, 'agy');
      fs.writeFileSync(fakeAgy, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const fakeSystemctl = path.join(binDir, 'systemctl');
      fs.writeFileSync(fakeSystemctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const unitFile = path.join(tmpRoot, 'antigravity-chat.service');
      fs.writeFileSync(
        unitFile,
        `[Service]\nExecStart=/usr/bin/node ${appDir}/server/dist/index.js\n`,
        'utf8',
      );

      const applyOut = execFileSync('bash', [path.join(repoRoot, 'deploy', 'apply-bundle.sh'), bundleTar], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          APP_DIR: appDir,
          SYSTEMD_UNIT_FILE: unitFile,
          CANONICAL_AGY_BIN: fakeAgy,
          DOC_RUNTIME_DIR: path.join(tmpRoot, 'doc-runtime'),
          INSTALL_DOC_RUNTIME: '0',
          ENV_FILE: emptyEnvFile,
        },
        encoding: 'utf8',
      });
      expect(applyOut).toMatch(/Bundle deployed cleanly/);
      expect(fs.readFileSync(path.join(repoRoot, 'deploy', 'apply-bundle.sh'), 'utf8')).toContain(
        'setup-doc-runtime.sh',
      );
      const skillMode = fs.statSync(path.join(appDir, 'builtin-skills', 'docx', 'SKILL.md')).mode & 0o777;
      expect(skillMode & 0o022).toBe(0);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
