import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { AcpClientManager } from './acp/client-manager.js';
import { ensureAgyProfileSettings } from './acp/profile-settings.js';
import { QuotaService } from './acp/quota-service.js';
import { ExecutionScheduler } from './acp/scheduler.js';
import { AgyAuthManager } from './auth/agy-auth.js';
import { authenticateRequest } from './auth/session.js';
import { loadConfig, type AppConfig } from './config.js';
import { AppDatabase } from './db/database.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerChatRoutes } from './routes/chat-routes.js';
import { registerFileRoutes } from './routes/file-routes.js';
import { registerNotificationRoutes } from './routes/notification-routes.js';
import { registerProjectRoutes } from './routes/project-routes.js';
import { registerQuotaRoutes } from './routes/quota-routes.js';
import { registerSkillRoutes } from './routes/skill-routes.js';
import { registerMcpRoutes } from './routes/mcp-routes.js';
import { McpService } from './mcp/mcp-service.js';
import { SkillService } from './skills/skill-service.js';
import { PushNotificationService } from './notifications/web-push.js';
import { SyncHub } from './sync/hub.js';
import { loadAppBuildInfo, type AppBuildInfo } from './version.js';

export interface AppContext {
  app: FastifyInstance;
  config: AppConfig;
  buildInfo: AppBuildInfo;
  db: AppDatabase;
  hub: SyncHub;
  acp: AcpClientManager;
  agyAuth: AgyAuthManager;
  scheduler: ExecutionScheduler;
  quotaService: QuotaService;
  pushService: PushNotificationService;
  skillService: SkillService;
  mcpService: McpService;
  shutdown: () => Promise<void>;
}

export async function createApp(configOverrides: Partial<AppConfig> = {}): Promise<AppContext> {
  const config = loadConfig(configOverrides);
  for (const dir of [
    config.dataRoot,
    config.profilesRoot,
    config.workspacesRoot,
    config.projectsRoot,
    config.uploadsRoot,
    config.artifactsCacheRoot,
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const buildInfo = loadAppBuildInfo(config.webDistDir, configOverrides.appVersion);
  config.appVersion = buildInfo.version;
  const buildId = buildInfo.buildId;
  const db = new AppDatabase(config.dbPath);
  db.recoverInterruptedRuns();

  const hub = new SyncHub(db, buildId, buildInfo.version);
  const pushService = new PushNotificationService(config, db, hub);
  const quotaService = new QuotaService(config, db, hub);
  const skillService = new SkillService(config, db, hub);
  const mcpService = new McpService(config, db, hub);
  const acp = new AcpClientManager(config, db, hub, skillService, pushService, mcpService);
  const agyAuth = new AgyAuthManager(config, db, hub, acp);
  const scheduler = new ExecutionScheduler(config, db, hub, acp, pushService, quotaService);

  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: 10 * 1024 * 1024,
    logger: config.nodeEnv === 'test' ? false : { level: 'info' },
  });

  for (const profileDir of db.listAgyProfileDirs()) {
    try {
      ensureAgyProfileSettings(profileDir);
      mcpService.syncAllSharedMcpPermissionsToProfile(profileDir);
    } catch (err) {
      app.log.error({ err, profileDir }, 'Failed to initialize Antigravity profile settings');
    }
  }

  await app.register(cookie);
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 20,
    },
  });
  await app.register(websocket);

  app.get('/api/health', async () => {
    return {
      ok: true,
      agyMode: config.agyMode,
      version: buildInfo.version,
      tag: buildInfo.tag,
      shortSha: buildInfo.shortSha,
      builtAt: buildInfo.builtAt,
      buildId,
      uptimeSec: Math.floor(process.uptime()),
    };
  });

  await registerAuthRoutes(app, { config, db, hub, agyAuth, mcpService, buildId, buildInfo });
  await registerProjectRoutes(app, { config, db, hub, agyAuth });
  await registerChatRoutes(app, { config, db, hub, agyAuth, acp, scheduler, skillService });
  await registerFileRoutes(app, { config, db, hub, agyAuth });
  await registerQuotaRoutes(app, { config, db, hub, agyAuth, quotaService });
  await registerNotificationRoutes(app, { config, db, hub, agyAuth, pushService });
  await registerSkillRoutes(app, { config, db, hub, agyAuth, skillService, acp });
  await registerMcpRoutes(app, { config, db, hub, agyAuth, mcpService, acp });

  app.get('/api/ws', { websocket: true }, (socket, req) => {
    const session = authenticateRequest(req, db);
    if (!session) {
      socket.close(4401, 'unauthenticated');
      return;
    }

    const query = req.query as { sinceSeq?: string; clientId?: string };
    const sinceSeq = query.sinceSeq ? Number.parseInt(query.sinceSeq, 10) : 0;
    const clientId = (query.clientId || crypto.randomUUID()).slice(0, 128);

    const unregister = hub.registerConnection({
      userId: session.user.id,
      sessionIdHash: session.sessionIdHash,
      clientId,
      ws: socket,
      sinceSeq: Number.isFinite(sinceSeq) && sinceSeq > 0 ? sinceSeq : 0,
    });

    const pingInterval = setInterval(() => {
      if (socket.readyState === 1) {
        socket.ping();
      }
    }, 25_000);
    pingInterval.unref();

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as {
          kind?: string;
          sinceSeq?: number;
          visible?: unknown;
          pushEndpoint?: unknown;
        };
        if (msg.kind === 'ping') {
          hub.touchVisibleHeartbeat(
            session.user.id,
            socket,
            typeof msg.visible === 'boolean' ? msg.visible : undefined
          );
          socket.send(JSON.stringify({ kind: 'pong', ts: Date.now() }));
        } else if (msg.kind === 'presence') {
          const visible = typeof msg.visible === 'boolean' ? msg.visible : false;
          const pushEndpoint =
            typeof msg.pushEndpoint === 'string' &&
            msg.pushEndpoint.trim().length > 0 &&
            msg.pushEndpoint.length <= 2048
              ? msg.pushEndpoint.trim()
              : msg.pushEndpoint === null
                ? null
                : undefined;
          hub.updatePresence({
            userId: session.user.id,
            ws: socket,
            visible,
            pushEndpoint,
          });
        }
      } catch {
        // ignore invalid messages
      }
    });

    socket.on('close', () => {
      clearInterval(pingInterval);
      unregister();
    });

    socket.on('error', () => {
      clearInterval(pingInterval);
      unregister();
    });
  });

  // Serve built frontend bundle when present
  if (fs.existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: '/',
      wildcard: false,
      setHeaders: (reply, filePath) => {
        if (
          filePath.endsWith('index.html') ||
          filePath.endsWith('sw.js') ||
          filePath.endsWith('.webmanifest')
        ) {
          reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'APIルートが見つかりません。' });
      }
      const indexFile = path.join(config.webDistDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        return reply
          .header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
          .type('text/html; charset=utf-8')
          .send(fs.readFileSync(indexFile, 'utf8'));
      }
      return reply.code(404).send({ error: 'NOT_FOUND' });
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    });
  }

  const shutdown = async () => {
    await quotaService.shutdown();
    await agyAuth.shutdown();
    await acp.shutdown();
    await mcpService.shutdown();
    await app.close();
    db.close();
  };

  return {
    app,
    config,
    buildInfo,
    db,
    hub,
    acp,
    agyAuth,
    scheduler,
    quotaService,
    pushService,
    skillService,
    mcpService,
    shutdown,
  };
}
