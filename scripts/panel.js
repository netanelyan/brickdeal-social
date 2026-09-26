import { loadEnv } from '../src/env.js';
loadEnv();

import * as store from '../src/store.js';
import { count as adminCount } from '../src/web/auth.js';
import { startWebServer, stopWebServer } from '../src/web/server.js';
import { liveTargets } from '../src/publish/targets.js';
import { closeBrowser } from '../src/render/index.js';

// The panel on its own, without the bot.
//
// WHY THIS EXISTS
//
// bot.js refuses to start with no publish destination configured, and it is
// right to: an approval queue with nowhere to send things silently eats what you
// approve. But that is a fact about PUBLISHING, and the panel is not only a
// publishing tool. Reviewing what is queued, editing the captions and hashtags,
// changing the schedule, adding an account — none of that needs Instagram to be
// connected, and none of it should be unreachable because it is not.
//
// So: a machine part-way through being set up can still look at its own state.
//
// WHAT IS DIFFERENT WITHOUT THE BOT, AND IT IS NOT SUBTLE
//
//   - Nothing publishes. There is no drip timer here, so approving something
//     puts it in the queue and it stays there until a real bot process runs.
//   - Nothing is proposed on a schedule. The timer lives in bot.js.
//   - Nothing reaches Telegram. src/ops/surface.js falls back to its silent
//     implementation, so an approval settles no card and sends no message —
//     which is correct rather than broken, and is why the actions take the
//     surface as something handed in rather than importing it.
//
// Those are stated at startup, not left to be discovered.
//
// AND IT MUST NOT RUN ALONGSIDE THE BOT. src/store.js holds the whole of
// data/store.json in memory and saves it whole, so two processes writing it
// would each silently roll back the other. This is the same check, and the same
// reasoning, as scripts/admin.js.

const forced = process.argv.includes('--force');

/**
 * Is a bot process already holding this store?
 *
 * Guessed from a recent write rather than a pid file — see the note in
 * scripts/admin.js. Entries this tool and the CLI make are excluded, or a panel
 * restarted twice in a minute would accuse itself.
 */
function probablyRunning() {
  const stamped = Math.max(store.lastStagedAt() || 0, store.lastPublishedAt() || 0);
  const audit = store.auditTrail({ limit: 20 }).find((a) => !['cli', 'panel'].includes(a.actor?.kind))?.ts || 0;
  return Date.now() - Math.max(stamped, audit) < 120_000;
}

if (!forced && probablyRunning()) {
  console.error(
    [
      '',
      '⚠️  הבוט כנראה רץ עכשיו — ואז אין צורך בסקריפט הזה: האתר כבר פעיל בתוכו.',
      '',
      'שני תהליכים שכותבים את data/store.json ימחקו זה את השינויים של זה, כי',
      'src/store.js מחזיק את כל הקובץ בזיכרון ושומר אותו בשלמותו.',
      '',
      'אם הבוט באמת עצור: הוסף --force',
      '',
    ].join('\n')
  );
  process.exit(1);
}

const targets = liveTargets();

startWebServer();

console.log('');
console.log('   ---------------------------------------------------------');
console.log('   האתר רץ לבד, בלי הבוט.');
console.log('');
console.log(`   חשבונות: ${adminCount() || 'אין — npm run admin -- add <שם>'}`);
console.log(`   יעדי פרסום מוגדרים: ${targets.join(' + ') || 'אין'}`);
console.log('');
console.log('   מה שלא עובד כאן, בכוונה:');
console.log('     · שום דבר לא מתפרסם — אין טיימר, מה שמאושר נשאר בתור');
console.log('     · שום דבר לא מוצע אוטומטית — הטיימר נמצא ב-bot.js');
console.log('     · שום דבר לא מגיע לטלגרם — אין בוט מחובר');
console.log('');
console.log('   מה שכן עובד: לראות הכל, לערוך את הקופי, לוח הזמנים, וחשבונות.');
console.log('   Ctrl+C לעצור.');
console.log('   ---------------------------------------------------------');
console.log('');

const shutdown = async () => {
  await stopWebServer();
  // The panel can trigger a render (a new cover, a new photograph), and that
  // launches Chromium. Leaving it resident would keep the process alive after
  // the port was released.
  await closeBrowser();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
