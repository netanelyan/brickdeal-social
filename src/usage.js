// Token accounting for the drafting step — the only part of this pipeline that
// costs money per run.
//
// This exists because "is it efficient?" is not answerable by reading code. The
// three numbers that decide the bill are how many calls a run makes, how many
// of those calls were spent on candidates that got rejected afterwards, and
// what share of input tokens hit the prompt cache. All three are invisible
// without recording them, and all three moved once they were visible.
//
// Costs are computed from the model's published rates rather than guessed, and
// cache reads are billed at a tenth of the input rate — which is the entire
// reason the system prompt is a frozen string.

const RATES = {
  // $ per 1M tokens. input / output / cache write (1.25x) / cache read (0.1x).
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};
const DEFAULT_RATE = RATES['claude-opus-5'];

export function costOf(usage, model = 'claude-opus-5') {
  const r = RATES[model] || DEFAULT_RATE;
  const fresh = usage.input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  const out = usage.output_tokens || 0;
  return (fresh * r.in + write * r.in * 1.25 + read * r.in * 0.1 + out * r.out) / 1e6;
}

// A rolling record, kept in memory. It is deliberately not persisted: this is
// an operational readout for the running process, not an accounting ledger, and
// a store write per drafting call is a worse trade than losing it on restart.
const state = {
  since: new Date().toISOString(),
  calls: 0,
  wasted: 0, // calls whose candidate was rejected after the call was paid for
  input: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  cost: 0,
  wastedCost: 0,
};

let lastCost = 0;

export function record(usage, model) {
  if (!usage) return;
  state.calls++;
  state.input += usage.input_tokens || 0;
  state.cacheWrite += usage.cache_creation_input_tokens || 0;
  state.cacheRead += usage.cache_read_input_tokens || 0;
  state.output += usage.output_tokens || 0;
  lastCost = costOf(usage, model);
  state.cost += lastCost;
}

/**
 * Called when a candidate dies AFTER its drafting call was made. The call is
 * already paid for; recording it separately is what makes the difference
 * between "we made 12 calls" and "we made 12 calls and threw 9 away" legible.
 */
export function recordWasted() {
  if (!state.calls) return;
  state.wasted++;
  state.wastedCost += lastCost;
}

export function snapshot() {
  const totalIn = state.input + state.cacheWrite + state.cacheRead;
  return {
    ...state,
    cacheHitRate: totalIn ? state.cacheRead / totalIn : 0,
    wasteRate: state.calls ? state.wasted / state.calls : 0,
    perCall: state.calls ? state.cost / state.calls : 0,
  };
}

export function reset() {
  Object.assign(state, {
    since: new Date().toISOString(),
    calls: 0,
    wasted: 0,
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    cost: 0,
    wastedCost: 0,
  });
  lastCost = 0;
}

const usd = (n) => (n < 0.01 ? `${(n * 100).toFixed(2)}¢` : `$${n.toFixed(2)}`);
const pct = (n) => `${Math.round(n * 100)}%`;

/** Hebrew readout for /usage in the bot. */
export function usageReport() {
  const s = snapshot();
  if (!s.calls) return '📊 עוד לא בוצעו קריאות כתיבה מאז ההפעלה.';
  return [
    '📊 *צריכת טוקנים*',
    '',
    `קריאות כתיבה: ${s.calls}`,
    `מתוכן נזרקו אחרי התשלום: ${s.wasted} (${pct(s.wasteRate)})`,
    '',
    `קלט טרי: ${s.input.toLocaleString()}`,
    `נכתב למטמון: ${s.cacheWrite.toLocaleString()}`,
    `נקרא מהמטמון: ${s.cacheRead.toLocaleString()} (${pct(s.cacheHitRate)})`,
    `פלט: ${s.output.toLocaleString()}`,
    '',
    `עלות: ${usd(s.cost)} · לקריאה: ${usd(s.perCall)}`,
    `בזבוז: ${usd(s.wastedCost)}`,
  ].join('\n');
}
