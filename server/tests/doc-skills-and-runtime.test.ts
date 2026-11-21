import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAgyCommandSpec, SANDBOX_DOC_RUNTIME_MOUNT } from '../src/acp/env-isolation.js';
import { loadConfig } from '../src/config.js';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

interface FetchSkillsApi {
  fetchAnthropicSkills: (opts: {
    outDir?: string;
    tarballPath?: string;
    fromDir?: string;
    skills?: string[];
  }) => Promise<{
    outDir: string;
    manifest: {
      source: string;
      manifestDigest: string;
      skills: Record<string, { sha256: string; fileCount: number }>;
    };
  }>;
  hasValidBuiltinSkillsCache: (outDir: string, skills?: string[]) => boolean;
}

function hasContiguousSlice(arr: string[], sub: string[]): boolean {
  for (let i = 0; i <= arr.length - sub.length; i++) {
    if (sub.every((v, idx) => arr[i + idx] === v)) return true;
  }
  return false;
}

async function loadFetchSkillsScript(): Promise<FetchSkillsApi> {
  const scriptPath = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'fetch-anthropic-skills.mjs');
  return (await import(pathToFileURL(scriptPath).href)) as FetchSkillsApi;
}

describe('Dynamic Anthropic Document Skills & Isolated Sandbox Runtime', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('fetches and verifies document skills from archive, rejects unsafe tar entries, and handles best-effort cache fallback', async () => {
    const api = await loadFetchSkillsScript();
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fetch-skills-test-'));
    cleanups.push(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

    // Build a realistic mock anthropics/skills tarball
    const repoStage = path.join(tmpRoot, 'skills-main');
    for (const slug of ['docx', 'pptx', 'xlsx', 'pdf']) {
      const skillDir = path.join(repoStage, 'skills', slug, 'scripts');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(repoStage, 'skills', slug, 'SKILL.md'),
        `---\nname: ${slug}\ndescription: "Handle ${slug} documents"\n---\n\nUse ${slug} scripts.\n`
      );
      fs.writeFileSync(path.join(skillDir, 'helper.py'), `print("${slug}")\n`, { mode: 0o644 });
    }
    const validTar = path.join(tmpRoot, 'valid-skills.tar.gz');
    execFileSync('tar', ['-czf', validTar, '-C', tmpRoot, 'skills-main']);

    const outDir = path.join(tmpRoot, 'builtin-skills');
    const fetched = await api.fetchAnthropicSkills({ outDir, tarballPath: validTar });
    expect(Object.keys(fetched.manifest.skills).sort()).toEqual(['docx', 'pdf', 'pptx', 'xlsx']);
    expect(api.hasValidBuiltinSkillsCache(outDir)).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'pptx', 'SKILL.md'))).toBe(true);
    expect(fs.statSync(path.join(outDir, 'pptx', 'scripts', 'helper.py')).mode & 0o111).not.toBe(0);

    // Symlink inside selected skill in archive must be rejected
    const badStage = path.join(tmpRoot, 'bad-repo');
    fs.mkdirSync(path.join(badStage, 'skills', 'docx'), { recursive: true });
    fs.writeFileSync(path.join(badStage, 'skills', 'docx', 'SKILL.md'), '---\nname: docx\ndescription: x\n---\n');
    fs.symlinkSync('/etc/passwd', path.join(badStage, 'skills', 'docx', 'leak.txt'));
    const badTar = path.join(tmpRoot, 'bad-skills.tar.gz');
    execFileSync('tar', ['-czf', badTar, '-C', tmpRoot, 'bad-repo']);

    await expect(
      api.fetchAnthropicSkills({ outDir: path.join(tmpRoot, 'out-bad'), tarballPath: badTar })
    ).rejects.toThrow(/Unsupported non-regular entry/);

    // CLI --best-effort preserves valid cache when network/URL fails
    const scriptPath = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'fetch-anthropic-skills.mjs');
    execFileSync(
      process.execPath,
      [scriptPath, '--out', outDir, '--tarball-url', 'http://127.0.0.1:1/unreachable.tar.gz', '--best-effort'],
      { encoding: 'utf8' }
    );
    expect(api.hasValidBuiltinSkillsCache(outDir)).toBe(true);
  });

  it('provisions bundled Anthropic document skills to all profiles and preserves user disable, edit, delete, and custom overrides', async () => {
    const api = await loadFetchSkillsScript();
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-builtin-sync-test-'));
    cleanups.push(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

    const srcV1 = path.join(tmpRoot, 'upstream-v1');
    for (const [slug, ver] of [
      ['docx', 'v1'],
      ['pptx', 'v1'],
      ['xlsx', 'v1'],
      ['pdf', 'v1'],
    ]) {
      const sDir = path.join(srcV1, 'skills', slug, 'scripts');
      fs.mkdirSync(sDir, { recursive: true });
      fs.writeFileSync(
        path.join(srcV1, 'skills', slug, 'SKILL.md'),
        `---\nname: ${slug}\ndescription: "Anthropic ${slug} (${ver})"\n---\n\n${slug.toUpperCase()}_${ver}\n`
      );
      fs.writeFileSync(path.join(sDir, 'run.py'), `print("${slug}_${ver}")\n`);
    }

    const builtinSkillsDir = path.join(tmpRoot, 'builtin-skills');
    await api.fetchAnthropicSkills({ outDir: builtinSkillsDir, fromDir: srcV1 });

    // Start server with bundled skills -> register alice & bob
    const srv = await createTestServer({ builtinSkillsDir });
    cleanups.push(srv.cleanup);

    const { client: alice, userId: aliceId } = await registerAndBindAgy(
      srv.baseUrl,
      'alice',
      'user:alice@gmail.com'
    );
    const { client: bob, userId: bobId } = await registerAndBindAgy(
      srv.baseUrl,
      'bob',
      'user:bob@gmail.com'
    );

    const aliceSkills = await alice.request<{
      global: Array<{ slug: string; enabled: boolean; resourceCount: number }>;
      commands: Array<{ name: string }>;
    }>('GET', '/api/skills');
    expect(aliceSkills.status).toBe(200);
    expect(aliceSkills.data.global.map((s) => s.slug).sort()).toEqual(['docx', 'pdf', 'pptx', 'xlsx']);
    expect(aliceSkills.data.global.find((s) => s.slug === 'pptx')?.resourceCount).toBe(1);
    expect(aliceSkills.data.commands.map((c) => c.name)).toEqual(
      expect.arrayContaining(['docx', 'pdf', 'pptx', 'xlsx'])
    );

    const bobSkills = await bob.request<{ global: Array<{ slug: string }> }>('GET', '/api/skills');
    expect(bobSkills.data.global.map((s) => s.slug).sort()).toEqual(['docx', 'pdf', 'pptx', 'xlsx']);

    // Alice disables pptx, customizes docx, and deletes pdf
    expect((await alice.request('PUT', '/api/skills/global/pptx', { enabled: false })).status).toBe(200);
    expect(
      (
        await alice.request('PUT', '/api/skills/global/docx', {
          name: 'docx',
          description: 'Custom docx',
          instructions: 'ALICE_CUSTOM_DOCX',
        })
      ).status
    ).toBe(200);
    expect((await alice.request('DELETE', '/api/skills/global/pdf')).status).toBe(200);

    // Bundle updates to v2
    const srcV2 = path.join(tmpRoot, 'upstream-v2');
    for (const slug of ['docx', 'pptx', 'xlsx', 'pdf']) {
      const sDir = path.join(srcV2, 'skills', slug, 'scripts');
      fs.mkdirSync(sDir, { recursive: true });
      fs.writeFileSync(
        path.join(srcV2, 'skills', slug, 'SKILL.md'),
        `---\nname: ${slug}\ndescription: "Anthropic ${slug} (v2)"\n---\n\n${slug.toUpperCase()}_v2\n`
      );
      fs.writeFileSync(path.join(sDir, 'run.py'), `print("${slug}_v2")\n`);
    }
    await api.fetchAnthropicSkills({ outDir: builtinSkillsDir, fromDir: srcV2 });

    // Re-sync all profiles (simulating app restart with updated bundle)
    srv.ctx.skillService.syncBuiltinSkillsToAllProfiles();

    const aliceAfter = await alice.request<{
      global: Array<{ slug: string; enabled: boolean; description: string }>;
    }>('GET', '/api/skills');
    // pdf stays deleted
    expect(aliceAfter.data.global.some((s) => s.slug === 'pdf')).toBe(false);
    // pptx stays disabled, and its disabled copy is updated to v2
    const alicePptx = aliceAfter.data.global.find((s) => s.slug === 'pptx');
    expect(alicePptx?.enabled).toBe(false);
    expect(alicePptx?.description).toContain('v2');
    // docx keeps Alice's customization
    const aliceDocx = await alice.request<{ skill: { instructions: string } }>('GET', '/api/skills/global/docx');
    expect(aliceDocx.data.skill.instructions).toBe('ALICE_CUSTOM_DOCX');
    // xlsx (unmodified) auto-updates to v2
    const aliceXlsx = await alice.request<{ skill: { instructions: string } }>('GET', '/api/skills/global/xlsx');
    expect(aliceXlsx.data.skill.instructions).toBe('XLSX_v2');

    // Bob's unmodified profile updates all 4 to v2
    const bobDocx = await bob.request<{ skill: { instructions: string } }>('GET', '/api/skills/global/docx');
    expect(bobDocx.data.skill.instructions).toBe('DOCX_v2');
    expect(srv.ctx.db.getAgyProfile(aliceId)?.profileDir).toBeTruthy();
    expect(srv.ctx.db.getAgyProfile(bobId)?.profileDir).toBeTruthy();
  });

  it('mounts isolated docRuntimeDir read-only in bwrap and configures PATH, NODE_PATH, and PYTHONPATH for all profiles', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-doc-runtime-test-'));
    cleanups.push(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

    const profileDir = path.join(tmpRoot, 'profile');
    const workspaceDir = path.join(tmpRoot, 'workspace');
    const docRuntimeDir = path.join(tmpRoot, 'doc-runtime');
    const venvBin = path.join(docRuntimeDir, 'venv', 'bin');
    const sitePackages = path.join(docRuntimeDir, 'venv', 'lib', 'python3.12', 'site-packages');
    const nodeMods = path.join(docRuntimeDir, 'node', 'node_modules');
    const nodeBin = path.join(nodeMods, '.bin');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(venvBin, { recursive: true });
    fs.mkdirSync(sitePackages, { recursive: true });
    fs.mkdirSync(nodeBin, { recursive: true });

    const extAgy = path.join(tmpRoot, 'agy');
    fs.writeFileSync(extAgy, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const cfg = loadConfig({
      agyMode: 'real',
      sandboxMode: 'strict',
      agyBin: extAgy,
      bwrapBin: '/usr/bin/bwrap',
      dataRoot: tmpRoot,
      docRuntimeDir,
    });

    const spec = buildAgyCommandSpec({
      config: cfg,
      subcommandArgs: ['acp'],
      profileDir,
      workspaceDir,
      enableSandboxBwrap: true,
    });

    if (process.platform === 'linux') {
      expect(spec.sandboxed).toBe(true);
      expect(
        hasContiguousSlice(spec.args, ['--ro-bind', fs.realpathSync(docRuntimeDir), SANDBOX_DOC_RUNTIME_MOUNT])
      ).toBe(true);
      if (fs.existsSync('/etc/fonts')) {
        expect(hasContiguousSlice(spec.args, ['--ro-bind', fs.realpathSync('/etc/fonts'), '/etc/fonts'])).toBe(
          true
        );
      }
      expect(spec.env.PATH?.startsWith('/opt/agy:')).toBe(true);
      expect(spec.env.PATH).toContain(`${SANDBOX_DOC_RUNTIME_MOUNT}/venv/bin`);
      expect(spec.env.NODE_PATH).toContain(`${SANDBOX_DOC_RUNTIME_MOUNT}/node/node_modules`);
      expect(spec.env.PYTHONPATH).toContain(`${SANDBOX_DOC_RUNTIME_MOUNT}/venv/lib/python3.12/site-packages`);
      expect(spec.env.PYTHONIOENCODING).toBe('utf-8');
      expect(spec.env.SAL_USE_VCLPLUGIN).toBe('svp');
    }

    // Also applies cleanly when sandboxMode === 'off'
    const offCfg = loadConfig({
      agyMode: 'real',
      sandboxMode: 'off',
      agyBin: extAgy,
      dataRoot: tmpRoot,
      docRuntimeDir,
    });
    const offSpec = buildAgyCommandSpec({
      config: offCfg,
      subcommandArgs: ['acp'],
      profileDir,
      workspaceDir,
      enableSandboxBwrap: false,
    });
    expect(offSpec.sandboxed).toBe(false);
    expect(offSpec.env.NODE_PATH).toContain(fs.realpathSync(nodeMods));
    expect(offSpec.env.PYTHONPATH).toContain(fs.realpathSync(sitePackages));
  });

  it('apply-bundle.sh deploys builtin-skills atomically even in --runtime-only mode', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-bundle-skills-test-'));
    cleanups.push(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

    const appDir = path.join(tmpRoot, 'app');
    const stageSrc = path.join(tmpRoot, 'stage-src');
    const bundlePath = path.join(tmpRoot, 'bundle.tar.gz');

    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(path.join(stageSrc, 'server', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(stageSrc, 'web', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(stageSrc, 'builtin-skills', 'pptx'), { recursive: true });
    fs.writeFileSync(path.join(stageSrc, 'builtin-skills', 'pptx', 'SKILL.md'), '# pptx\n');
    fs.writeFileSync(
      path.join(stageSrc, 'builtin-skills', '.builtin-skills-manifest.json'),
      JSON.stringify({ manifestDigest: 'abc', skills: { pptx: { sha256: 'def' } } })
    );
    fs.writeFileSync(path.join(stageSrc, 'BUILD_INFO.json'), JSON.stringify({ version: '1.2.0' }));
    execFileSync('tar', ['-czf', bundlePath, '-C', stageSrc, '.']);

    execFileSync(
      'bash',
      [path.join(repoRoot, 'deploy', 'apply-bundle.sh'), bundlePath, '--runtime-only', '--no-restart'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          APP_DIR: appDir,
          AUTO_SETUP_DOC_RUNTIME: '0',
        },
      }
    );

    expect(fs.existsSync(path.join(appDir, 'builtin-skills', 'pptx', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, 'builtin-skills', '.builtin-skills-manifest.json'))).toBe(true);
  });
});
