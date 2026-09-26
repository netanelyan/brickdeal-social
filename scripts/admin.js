import { loadEnv } from '../src/env.js';
loadEnv();

import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import * as auth from '../src/web/auth.js';
import * as store from '../src/store.js';

// Accounts for the website, from the terminal.
//
// WHY THIS HAS TO EXIST
//
// The panel can create accounts, and only an owner may. So the FIRST one cannot
// come from the panel — there is nobody to authorise it — and a sign-up page that
// existed only until the first account is a sign-up page that is open on any box
// where somebody deleted the accounts to start again. This is the bootstrap, and
// it requires shell access to the server, which is the correct credential for
// "create the first administrator".
//
// It is also the way back in. A forgotten password on an install with one owner
// has no other exit: there is no mail on this box to send a reset to, and adding
// one would be a second credential to protect for a page used by three people.
//
// IT WRITES THE SAME data/store.json THE BOT HOLDS OPEN, WHICH IS SAFE FOR
// EXACTLY ONE REASON: this process is short-lived and the bot does not have to be
// running. If it IS running, the bot will not see the new account until it next
// reloads the file — and it re-reads nothing, so an account added while the bot is
// live is visible to the PANEL (same process reads through the same module... no:
// a different process). Read that again, because it matters:
//
//   Adding an account while the bot is running writes a file the bot already
//   holds in memory. The bot's next save would roll it back.
//
// So the tool refuses to do it silently. `--force` is there for the case where you
// know the bot is stopped and the lock file is stale.

const LOCK_NOTE = [
  'הבוט כנראה רץ עכשיו.',
  '',
  'src/store.js מחזיק את כל data/store.json בזיכרון ושומר אותו בשלמותו, ולכן שינוי',
  'שנכתב מתהליך אחר יימחק בשמירה הבאה של הבוט. לכן:',
  '',
  '  1. עצור את הבוט:      pm2 stop brickdeal-social   (או systemctl stop ...)',
  '  2. הרץ את הפקודה הזו שוב',
  '  3. הפעל מחדש:          pm2 start brickdeal-social',
  '',
  'אחרי שיש חשבון אחד, כל השאר נעשה מהאתר עצמו ובלי לעצור כלום.',
  'אם אתה בטוח שהבוט עצור: הוסף --force',
].join('\n');

/**
 * Is a bot process holding this store?
 *
 * Guessed rather than known, deliberately. There is no pid file in this project
 * and inventing one would be a new thing to leave stale; what there IS is a
 * timestamp the bot stamps whenever anything happens. A store touched in the last
 * two minutes is very likely a live bot, and being wrong costs one --force.
 */
function probablyRunning() {
  const recent = Math.max(store.lastStagedAt() || 0, store.lastPublishedAt() || 0);
  // This tool's OWN entries are excluded, and that is not a detail: it records
  // what it does (see note() below), so counting them would mean the second of
  // two consecutive commands always believed the bot was running.
  const audit = store.auditTrail({ limit: 20 }).find((a) => a.actor?.kind !== 'cli')?.ts || 0;
  return Date.now() - Math.max(recent, audit) < 120_000;
}

/**
 * Record what was done from the terminal.
 *
 * An account created over SSH is exactly as worth logging as one created from the
 * panel — arguably more, since there is no session behind it to ask about later.
 * `kind: 'cli'` is what the panel's audit page prints as "terminal".
 */
const note = (action, detail = {}) =>
  store.note({ action, actor: { kind: 'cli', id: null, name: process.env.USER || process.env.USERNAME || 'terminal' }, ...detail });

// --- reading answers, from a person or from a pipe -------------------------
//
// THE NON-TTY CASE IS NOT A CURIOSITY, and it failed twice before it worked.
//
// First: `terminal: true` on a stdin that is a pipe does not read the pipe.
// readline waits for keystrokes that cannot arrive, the stream ends, the
// callback never fires, and the process exits ZERO having done nothing —
// `printf 'pw\npw\n' | npm run admin -- add lab` printed both prompts, created
// no account, and reported success by saying nothing at all.
//
// Then: opening a fresh readline per question does not work either. The first
// one drains and closes the pipe, so the second question gets EOF and an empty
// answer — which presented as "the passwords do not match" on two identical
// lines.
//
// So a pipe is read ONCE, in full, and the lines are handed out in order. A
// silent no-op on the tool that bootstraps the only administrator is the worst
// failure available to it, and both of the above were that.

let piped = null;
const readAllPiped = () =>
  (piped ??= new Promise((resolve) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (buffer += chunk));
    process.stdin.on('end', () => resolve(buffer.split(/\r?\n/)));
    process.stdin.on('error', () => resolve([]));
  }));

let queued = null;
async function nextPipedLine() {
  queued ??= [...(await readAllPiped())];
  // Empty when the pipe ran out, so the validator gets its say — "the password
  // must be at least 12 characters" — rather than the process hanging or, worse,
  // carrying on as though it had an answer.
  return queued.length ? queued.shift() : '';
}

/** Read a line without echoing it. On a pipe there is no echo to suppress. */
function secret(question) {
  if (!process.stdin.isTTY) {
    process.stdout.write(question);
    return nextPipedLine().then((answer) => {
      process.stdout.write('\n');
      return answer;
    });
  }

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // readline echoes what it is given; overriding the writer is what suppresses
    // it. The prompt itself still has to be written, hence the length check.
    let asked = false;
    rl._writeToOutput = (s) => {
      if (!asked) {
        process.stdout.write(s);
        if (s.includes(question)) asked = true;
      }
    };
    rl.question(question, (answer) => {
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

const ask = async (question) => {
  if (!process.stdin.isTTY) {
    process.stdout.write(question);
    return (await nextPipedLine()).trim();
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
};

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const words = argv.filter((a) => !a.startsWith('--'));
const [command, ...rest] = words;

const flagValue = (name) => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};

const ROLE_HE = { owner: 'בעלים', admin: 'מנהל', viewer: 'צפייה' };

function usage() {
  console.log(
    [
      'ניהול חשבונות לאתר:',
      '',
      '  npm run admin -- list',
      '  npm run admin -- add <username> [--name="שם"] [--role=admin|viewer|owner] [--generate]',
      '  npm run admin -- password <username> [--generate]',
      '  npm run admin -- role <username> <owner|admin|viewer>',
      '  npm run admin -- remove <username>',
      '  npm run admin -- signout-all',
      '',
      'החשבון הראשון הוא תמיד בעלים, כי אחרת אין מי שיוסיף את השני.',
      '--generate מגריל סיסמה חזקה ומדפיס אותה פעם אחת.',
      '--force מדלג על הבדיקה אם הבוט רץ (רק אם אתה בטוח שהוא עצור).',
    ].join('\n')
  );
}

/** Long, random, and typable — it has to be copied into a browser once. */
const generated = () => randomBytes(18).toString('base64url');

async function passwordFor(username) {
  if (flags.has('--generate')) {
    const password = generated();
    console.log(`\nסיסמה ל-${username}:\n\n    ${password}\n\nהיא לא תוצג שוב.\n`);
    return password;
  }
  const first = await secret(`סיסמה ל-${username} (12 תווים לפחות): `);
  const bad = auth.checkPassword(first);
  if (bad) throw new Error(bad);
  const again = await secret('שוב, לאימות: ');
  if (first !== again) throw new Error('הסיסמאות לא זהות');
  return first;
}

/** Everything that writes has to pass the running-bot check. */
function guard() {
  if (flags.has('--force')) return;
  if (probablyRunning()) {
    console.error(`\n⚠️  ${LOCK_NOTE}\n`);
    process.exit(1);
  }
}

async function main() {
  switch (command) {
    case 'list': {
      const rows = auth.list();
      if (!rows.length) return console.log('אין חשבונות. npm run admin -- add <username>');
      console.log(`${rows.length} חשבונות:\n`);
      for (const a of rows) {
        console.log(
          `  ${a.username.padEnd(18)} ${(ROLE_HE[a.role] || a.role).padEnd(8)} ${a.name || ''}` +
            (a.lastLoginAt ? `   כניסה אחרונה: ${new Date(a.lastLoginAt).toLocaleString('he-IL')}` : '   מעולם לא נכנס')
        );
      }
      return;
    }

    case 'add': {
      const username = rest[0] || (await ask('שם משתמש: '));
      const bad = auth.checkUsername(username);
      if (bad) throw new Error(bad);
      guard();
      const first = auth.count() === 0;
      const role = first ? 'owner' : flagValue('--role') || 'admin';
      const password = await passwordFor(username);
      const created = auth.createAdmin({
        username,
        password,
        name: flagValue('--name') || null,
        role,
      });
      note('account:created', { username: created.username, role: created.role });
      console.log(`✅ נוצר: ${created.username} · ${ROLE_HE[created.role] || created.role}`);
      if (first) console.log('   זה החשבון הראשון, ולכן הוא בעלים. את השאר אפשר להוסיף מהאתר.');
      return;
    }

    case 'password': {
      const username = rest[0] || (await ask('שם משתמש: '));
      if (!store.adminByUsername(username)) throw new Error('אין משתמש כזה');
      guard();
      auth.setPassword(username, await passwordFor(username));
      note('account:password', { username });
      console.log(`✅ הסיסמה של ${username} הוחלפה. כל החיבורים הפתוחים שלו נותקו.`);
      return;
    }

    case 'role': {
      const [username, role] = rest;
      if (!username || !role) return usage();
      guard();
      const updated = auth.setRole(username, role);
      note('account:role', { username: updated.username, role: updated.role });
      console.log(`✅ ${updated.username} → ${ROLE_HE[updated.role] || updated.role}`);
      return;
    }

    case 'remove': {
      const username = rest[0];
      if (!username) return usage();
      guard();
      auth.removeAdmin(username);
      note('account:removed', { username });
      console.log(`✅ ${username} הוסר`);
      return;
    }

    case 'signout-all': {
      guard();
      auth.signOutEveryone();
      note('account:signout-all');
      console.log('✅ כל החיבורים נותקו — כולם יצטרכו להתחבר מחדש');
      return;
    }

    default:
      return usage();
  }
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
