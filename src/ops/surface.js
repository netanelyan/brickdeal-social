// The Telegram side of an action, handed in rather than imported.
//
// WHY IT IS INVERTED
//
// Actions have to touch Telegram. Approving a deck in the browser must strike
// through the card sitting in the chat, or that card keeps its live buttons over
// a post that has already gone out — and a second tap on it is the one thing the
// whole approval flow is built to prevent. Re-drawing a cover has to send the
// replacement card. A failed job has to say so somewhere a person will see.
//
// But src/ops must not import bot.js. bot.js imports the actions, so the reverse
// is a cycle, and under ESM a cycle between two modules that both run work at
// load time is how you get an undefined function at the one moment you need it.
//
// So bot.js registers itself here at boot, and the actions call whatever is
// registered. Nothing registers in a test or a script, which is exactly right:
// the fallback below is silent and harmless, so `npm test` can drive an approval
// end to end without a bot token and without pretending to have a chat.

const nothing = {
  /** Send a fresh approval card. Returns where it landed, or null. */
  sendApproval: async () => null,
  /** Re-draw a card that is still awaiting a decision, buttons and all. */
  rewriteApproval: async () => false,
  /** Rewrite a decided card in place and take its buttons away. */
  settle: async () => false,
  /** The same, for a proposal — which is text, never a photo. */
  settleProposal: async () => false,
  /** Take the buttons away and leave the text alone. */
  clearButtons: async () => false,
  /** Replace the text of a message we sent earlier (progress lines). */
  editText: async () => false,
  /** Delete a message we sent earlier. */
  remove: async () => false,
  /** Say something in the approval chat. */
  say: async () => false,
  /** Send a proposal card. Returns where it landed, or null. */
  sendProposal: async () => null,
  /**
   * Publish to the Telegram channel.
   *
   * Throws when there is no Telegram, which is the honest answer: a destination
   * that cannot be reached failed, and src/ops/publish.js already knows how to
   * report a destination that failed.
   */
  publishToChannel: async () => {
    throw new Error('no Telegram surface is attached to this process');
  },
  /** Is a real Telegram surface attached at all? */
  live: false,
};

let current = nothing;

/**
 * Attach the Telegram surface. Called once, from bot.js, at boot.
 *
 * Partial implementations are filled in from the no-ops, so a surface can grow a
 * capability without every other caller having to check for it.
 */
export function attach(surface) {
  current = { ...nothing, live: true, ...surface };
  return current;
}

export const telegram = () => current;

/** For tests: put the silent one back. */
export const detach = () => {
  current = nothing;
};
