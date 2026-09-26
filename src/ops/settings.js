import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from 'node:fs';
import * as store from '../store.js';
import { brickConfig, configPath, __reset as resetBrickConfig } from '../brick/config.js';
import { emit } from './bus.js';

// Changing how the marketing reads, without a deploy.
//
// TWO KINDS OF DIAL, AND THEY ARE NOT THE SAME KIND OF THING
//
// The schedule lives in the store (see SETTABLE in src/store.js): numbers with
// obvious bounds, changed occasionally, and read on every use so a change takes
// effect on the next tick rather than the next restart.
//
// The COPY lives in brick-config.json, and it is not a number. It is the caption
// template, the hashtag pools, the cover lines, the labels on every price and the
// closing frame — the whole voice of the account, in a file that src/brick/config.js
// deliberately THROWS on rather than falling back when it cannot be read. That
// posture is right and it is also a trap for an editor: save one broken bracket
// from a browser and the next build dies, from a file nobody can fix from the
// same browser because the page that would fix it also reads the config.
//
// So every write here is: back up, write, forget the cache, re-parse, and put the
// backup back if the re-parse throws. The file on disk is therefore always one
// that src/brick/config.js accepts, and the admin gets the validator's own
// sentence back instead of a broken bot.

// Asked for on every use rather than captured, so BRICK_CONFIG_PATH works — the
// test suite points at its own copy, exactly as it does with STORE_PATH.
const file = () => configPath();
const backup = () => `${file()}.bak`;

/** The file as written, not as parsed — what an editor should be handed. */
export function readRaw() {
  try {
    return readFileSync(file(), 'utf8');
  } catch (e) {
    throw new Error(`brick-config.json could not be read: ${e.message}`);
  }
}

/**
 * Replace brick-config.json, but only if the result still parses.
 *
 * Returns the newly parsed config on success and throws with the validator's own
 * message on failure — by which point the previous file is already back on disk.
 */
export function writeRaw(text, { actor = null } = {}) {
  const incoming = String(text ?? '');

  // Parsed here first, so the commonest mistake — a trailing comma — is caught
  // before anything on disk is touched at all.
  let parsed;
  try {
    parsed = JSON.parse(incoming);
  } catch (e) {
    throw new Error(`זה לא JSON תקין: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('הקובץ צריך להיות אובייקט JSON');
  }

  const target = file();
  const previous = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (previous !== null) copyFileSync(target, backup());

  // Atomic, like every other write in this project: a half-written config is a
  // file the next build would read.
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, incoming.endsWith('\n') ? incoming : `${incoming}\n`);
  renameSync(tmp, target);

  // The cache is the whole reason this is delicate. brickConfig() reads once and
  // holds the result for the life of the process, so without this the new file
  // would sit on disk having no effect until a restart — and the validation below
  // would be re-validating the OLD bytes and passing.
  resetBrickConfig();
  try {
    const config = brickConfig();
    emit('settings:copy', { actor: actor?.name || actor?.username || null });
    store.note({
      action: 'settings:copy',
      actor: actor ? { kind: actor.kind, id: actor.id ?? null, name: actor.name || actor.username || null } : null,
      bytes: incoming.length,
    });
    return config;
  } catch (e) {
    // Put it back, and put the cache back with it. Leaving the broken file in
    // place would break the next build; leaving the cache cleared would make the
    // next read throw even though the good file had been restored.
    if (previous !== null) {
      writeFileSync(tmp, previous);
      renameSync(tmp, target);
    }
    resetBrickConfig();
    try {
      brickConfig();
    } catch {
      // The file that was there was already broken. Nothing to restore to, and
      // saying so is more use than pretending the write was the problem.
    }
    throw new Error(`הקובץ לא עבר אימות ולכן שוחזר: ${e.message}`);
  }
}

/** The previous version, for an admin who wants yesterday's wording back. */
export const readBackup = () => (existsSync(backup()) ? readFileSync(backup(), 'utf8') : null);

// --- the schedule ------------------------------------------------------------

export const dials = () => store.settingsReport();

/**
 * Change one dial.
 *
 * The change is announced rather than applied: bot.js reads every dial through
 * store.setting() on each tick, so there is no timer to reschedule and nothing to
 * restart. The event exists so the other surface's page stops showing the old
 * number, not because anything has to act on it.
 */
export function setDial(key, value, { actor = null } = {}) {
  const stored = store.setSetting(key, value);
  store.note({
    action: 'settings:dial',
    actor: actor ? { kind: actor.kind, id: actor.id ?? null, name: actor.name || actor.username || null } : null,
    key,
    value: stored,
  });
  emit('settings:dial', { key, value: stored, actor: actor?.name || actor?.username || null });
  return { key, value: stored };
}
