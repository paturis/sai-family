import path from 'node:path';

/** All settings come from environment variables (see deploy/.env.example). */
export function loadConfig(env = process.env, overrides = {}) {
  const publicUrl = (env.PUBLIC_URL || 'http://localhost:8080').replace(/\/+$/, '');
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST || '0.0.0.0',
    publicUrl,
    secureCookies: publicUrl.startsWith('https://'),
    dataDir: env.DATA_DIR || path.resolve('data'),
    webRoot: env.WEB_ROOT || path.resolve('..'),
    sessionSecret: env.SESSION_SECRET || '',
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    geminiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    geminiBase: env.GEMINI_BASE || 'https://generativelanguage.googleapis.com',
    adminIds: (env.ADMIN_IDS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    maxSockets: Number(env.MAX_SOCKETS || 5000),
    maxBodyBytes: Number(env.MAX_BODY_BYTES || 5 * 1024 * 1024),
    closeGraceMs: 500,
    answerGraceMs: 1500,
    ...overrides,
  };
}
