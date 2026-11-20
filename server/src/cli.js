#!/usr/bin/env node
// Admin command line:  docker compose exec app node src/cli.js <command>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createStore } from './store.js';
import { createAuth } from './auth.js';
import { createMailer } from './mail.js';

const config = loadConfig();
const db = openDb(config.dataDir);
const store = createStore({ db });
const secretFile = path.join(config.dataDir, 'secret.key');
const secret = config.sessionSecret || (fs.existsSync(secretFile) ? fs.readFileSync(secretFile, 'utf8').trim() : crypto.randomBytes(32).toString('hex'));
const auth = createAuth({ db, config, secret });
const [cmd, ...args] = process.argv.slice(2);
const ROLES = ['admin', 'tech', 'host'];
const norm = (s) => String(s || '').trim().toLowerCase();

const usage = () => {
  console.log(`Commands:
  add-user <name-or-email> <admin|tech|host>   create or update a person, print their login link
  login-link <name-or-email>                   print a fresh one-time login link (valid 7 days)
  list-users                                   show everyone
  remove-user <name-or-email>                  remove a person and sign them out
  mail-test <email>                            send a test email (checks your SMTP settings)
  backup <file>                                write a consistent copy of the database`);
  process.exit(1);
};

switch (cmd) {
  case 'add-user': {
    const id = norm(args[0]), role = norm(args[1]);
    if (!id || !ROLES.includes(role)) usage();
    store.users.upsert(id, role);
    console.log(`${id} is now ${role}.\nLogin link (works once, 7 days):\n${auth.createLoginLink(id).url}`);
    break;
  }
  case 'login-link': {
    const id = norm(args[0]);
    if (!id || !store.users.get(id)) { console.error('No such person. Use add-user first.'); process.exit(1); }
    console.log(auth.createLoginLink(id).url);
    break;
  }
  case 'list-users':
    for (const u of store.users.list()) console.log(`${u.role.padEnd(6)} ${u.id}`);
    break;
  case 'remove-user':
    store.users.remove(norm(args[0]));
    console.log('Removed.');
    break;
  case 'mail-test': {
    const to = norm(args[0]);
    if (!to.includes('@')) usage();
    const mailer = createMailer({ config });
    const h = await mailer.health(true);
    if (!h.ok) { console.error(`SMTP check FAILED (${h.host}): ${h.error}`); process.exitCode = 1; break; }
    try { await mailer.sendTest(to); console.log(`Sent a test email to ${to} from ${h.from}.`); }
    catch (e) { console.error(`Could not send: ${e.message}`); process.exitCode = 1; }
    break;
  }
  case 'backup': {
    if (!args[0]) usage();
    const out = path.resolve(args[0]);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (fs.existsSync(out)) fs.unlinkSync(out);
    db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    console.log(`Backup written to ${out}`);
    break;
  }
  default:
    usage();
}
db.close();
