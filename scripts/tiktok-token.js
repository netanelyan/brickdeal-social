import { loadEnv } from '../src/env.js';
loadEnv();

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  authorizeUrl,
  exchangeCode,
  creatorInfo,
  tokenHoursLeft,
  refreshTokenDaysLeft,
  describeError,
  SCOPES,
} from '../src/publish/tiktok.js';

// Connects the TikTok account, once, from the terminal.
//
//   npm run tiktok-token
//
// There is no callback server here on purpose. TikTok redirects to a URL you
// registered, that URL will 404 on your own domain, and the authorization code
// is sitting in its query string — so pasting the address bar back in is enough,
// and it means nothing new has to listen on a port on the VPS.
//
// What comes back is a pair: an access token good for about a day, and a refresh
// token good for about a year. Both are stored; the bot refreshes the first one
// itself and only this script can replace the second.

const line = () => console.log('─'.repeat(66));
const ask = async (q) => {
  const rl = createInterface({ input: stdin, output: stdout });
  const a = (await rl.question(q)).trim();
  rl.close();
  return a;
};

/**
 * The code, from whatever was pasted.
 *
 * Accepts the whole redirected URL or a bare code, because a URL is what people
 * actually have in front of them.
 *
 * Nothing is trimmed off the end. A v2 code arrives percent-encoded and looks
 * like `...JbN8pg%2Av%215236.s1` — decoded, `...JbN8pg*v!5236.s1`. The `*` and
 * everything after it are PART OF THE CODE. An earlier version of this stripped
 * from the `*` on the strength of TikTok's v1 behaviour, where a literal `*1`
 * was appended and discarded; against v2 that silently sent a code truncated
 * two-thirds of the way through, and TikTok answers a malformed code with
 * "Authorization code is expired". Every fresh code failed, and the error
 * blamed the clock.
 */
export function codeFrom(pasted) {
  const s = String(pasted || '').trim();
  if (!s) return null;
  // A bare code may still be percent-encoded if it was copied out of the bar.
  if (!/^https?:\/\//i.test(s)) return decodeURIComponent(s);
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.searchParams.get('error')) {
    throw new Error(
      `TikTok refused the authorization: ${url.searchParams.get('error_description') || url.searchParams.get('error')}`
    );
  }
  // searchParams decodes for us; whatever comes back goes to TikTok verbatim.
  return url.searchParams.get('code') || null;
}

async function main() {
  const { TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REDIRECT_URI } = process.env;
  const missing = [
    !TIKTOK_CLIENT_KEY && 'TIKTOK_CLIENT_KEY',
    !TIKTOK_CLIENT_SECRET && 'TIKTOK_CLIENT_SECRET',
    !TIKTOK_REDIRECT_URI && 'TIKTOK_REDIRECT_URI',
  ].filter(Boolean);
  if (missing.length) throw new Error(`set these in .env first: ${missing.join(', ')}`);

  console.log(`
CONNECT TIKTOK

Scopes requested: ${SCOPES.join(', ')}
Redirect URI:     ${TIKTOK_REDIRECT_URI}

The redirect URI above must match what is registered in the developer portal
character for character, and its domain must be verified there — a photo post
is fetched from a URL, and TikTok will not fetch from an unverified domain.

1. Open this in a browser, logged in as the account you want to post as:

${authorizeUrl()}

2. Approve it. The browser lands on your redirect URI, which will probably show
   an error page — that is fine and expected. What matters is the address bar.
3. Copy the WHOLE address and paste it below.
`);

  const pasted = await ask('Redirected URL (or just the code): ');
  const code = codeFrom(pasted);
  if (!code) throw new Error('no ?code= found in that — paste the full address after approving');

  console.log('\n1/2  exchanging the code for a token pair...');
  const t = await exchangeCode(code);
  const granted = (t.scope || '').split(',').filter(Boolean);
  const missingScopes = SCOPES.filter((s) => !granted.includes(s));
  console.log(`     access token ok · ${tokenHoursLeft()}h · refresh ${refreshTokenDaysLeft()}d`);
  if (granted.length) console.log(`     scopes granted: ${granted.join(', ')}`);
  if (missingScopes.length) {
    // Worth stopping on rather than discovering at publish time: without
    // video.publish the whole path is dead, and the error it produces then
    // names the posting endpoint rather than the consent screen.
    console.log(`     ⚠️  NOT granted: ${missingScopes.join(', ')} — posting will fail`);
  }

  console.log('2/2  asking TikTok who that is and what it may post...');
  const info = await creatorInfo();
  console.log(`     @${info.username || '?'}${info.nickname ? ` (${info.nickname})` : ''}`);
  console.log(`     privacy levels available: ${info.options.join(', ') || 'none returned'}`);

  line();
  console.log(`
Saved to data/store.json. Nothing else to paste into .env.

${
  info.options.length === 1 && info.options[0] === 'SELF_ONLY'
    ? `Only SELF_ONLY came back, which is what an unaudited app gets: posts will
publish privately, visible to you alone. That is the expected state for
recording the demo video — and it is what the reviewer expects to see.`
    : `More than SELF_ONLY is available, so this app can already post publicly.
The approval message asks which level to use, every time.`
}

Then:  npm start   and send /tiktok in the Telegram DM.
`);
  line();
}

// Importable for the test suite without running the interactive flow.
if (process.argv[1] && process.argv[1].endsWith('tiktok-token.js')) {
  main().catch((e) => {
    console.error(`\nFailed: ${describeError(e)}\n`);
    if (/invalid|expired|code/i.test(e.message)) {
      console.error('An authorization code is single-use and short-lived — open the URL again for a fresh one.');
    }
    process.exitCode = 1;
  });
}
