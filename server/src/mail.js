import nodemailer from 'nodemailer';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Sends the sign-in emails over SMTP (Microsoft 365 by default: smtp.office365.com:587 + STARTTLS).
 * Credentials come from the environment only. Nothing here ever logs the password or the link.
 */
export function createMailer({ config, transportFactory = nodemailer.createTransport.bind(nodemailer) }) {
  const enabled = Boolean(config.smtpUser && config.smtpPass && config.smtpFrom);
  let transport = null;
  const get = () => transport || (transport = transportFactory({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    requireTLS: !config.smtpSecure && config.smtpRequireTls,
    auth: { user: config.smtpUser, pass: config.smtpPass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    tls: { minVersion: 'TLSv1.2' },
  }));
  const from = () => ({ name: config.smtpFromName, address: config.smtpFrom });

  const explain = (e) => {
    const m = String((e && (e.response || e.message)) || e);
    if (/5\.7\.139|basic authentication is disabled|SmtpClientAuthentication is disabled|535 5\.7\.3|Authentication unsuccessful/i.test(m)) {
      return `Microsoft refused the login (${m.slice(0, 160)}). SMTP AUTH may be disabled for this mailbox or tenant: enable "Authenticated SMTP" for the mailbox in Exchange admin, or use an app password / relay connector.`;
    }
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ESOCKET|EAI_AGAIN/i.test(m)) return `Cannot reach ${config.smtpHost}:${config.smtpPort} (${m.slice(0, 100)}). Is outbound port ${config.smtpPort} open on the VPS?`;
    return m.slice(0, 220);
  };

  async function sendLoginLink({ to, url, minutes, invite = false }) {
    if (!enabled) throw new Error('Email is not configured (SMTP_USER / SMTP_PASS)');
    const when = minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`;
    const subject = invite ? 'You have been added to the One Sai Family game show' : 'Your sign-in link for the One Sai Family game show';
    const intro = invite ? 'You have been added to the game show team. Use the link below to sign in.' : 'Use the link below to sign in.';
    const text = `${intro}\n\n${url}\n\nThis link works once and expires in ${when}. If you did not ask for it, you can ignore this email.\n`;
    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:480px;margin:auto">
<h2 style="color:#034787;margin:0 0 12px">One Sai Family — game show</h2>
<p>${esc(intro)}</p>
<p style="margin:22px 0"><a href="${esc(url)}" style="background:#e87000;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;display:inline-block">Sign in</a></p>
<p style="color:#555;font-size:13px">This link works once and expires in ${esc(when)}. If you did not ask for it, you can ignore this email.</p>
<p style="color:#888;font-size:12px">Button not working? Paste this into your browser:<br>${esc(url)}</p></div>`;
    try {
      await get().sendMail({ from: from(), to, subject, text, html });
    } catch (e) {
      throw new Error(explain(e));
    }
  }

  let hcache = null;
  /** Checks the SMTP login without sending anything (cached for 60 s). */
  async function health(force = false) {
    if (!force && hcache && Date.now() - hcache.at < 60_000) return hcache;
    const base = { configured: enabled, host: config.smtpHost, from: config.smtpFrom, at: Date.now() };
    if (!enabled) return (hcache = { ...base, ok: false, error: 'SMTP_USER / SMTP_PASS are not set' });
    try {
      await get().verify();
      hcache = { ...base, ok: true };
    } catch (e) {
      hcache = { ...base, ok: false, error: explain(e) };
    }
    return hcache;
  }

  async function sendTest(to) {
    if (!enabled) throw new Error('Email is not configured (SMTP_USER / SMTP_PASS)');
    try {
      await get().sendMail({ from: from(), to, subject: 'Game show email test', text: 'If you can read this, sign-in emails will work.' });
    } catch (e) {
      throw new Error(explain(e));
    }
  }

  return { enabled, sendLoginLink, sendTest, health };
}
