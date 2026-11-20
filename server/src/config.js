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
    // Email sign-in (Microsoft 365 / Office 365 by default). Credentials only ever come from the environment.
    smtpHost: env.SMTP_HOST || 'smtp.office365.com',
    smtpPort: Number(env.SMTP_PORT || 587),
    smtpSecure: env.SMTP_SECURE === '1' || env.SMTP_SECURE === 'true',   // true = implicit TLS (port 465); false = STARTTLS (587)
    smtpRequireTls: env.SMTP_REQUIRE_TLS !== '0',
    smtpUser: env.SMTP_USER || '',
    smtpPass: env.SMTP_PASS || '',
    smtpFrom: env.SMTP_FROM || env.SMTP_USER || '',
    smtpFromName: env.SMTP_FROM_NAME || 'One Sai Family game show',
    emailLinkTtlMs: Number(env.EMAIL_LINK_TTL_MIN || 15) * 60_000,        // links people request for themselves
    inviteTtlMs: Number(env.INVITE_TTL_HOURS || 24) * 3_600_000,         // links an admin emails to a new person
    closeGraceMs: 500,
    answerGraceMs: 1500,
    ...overrides,
  };
}
