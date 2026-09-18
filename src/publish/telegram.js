import { createReadStream, existsSync } from 'node:fs';

// Telegram publishing.
//
// Cards are uploaded as files rather than by URL. Instagram has to fetch the
// image itself (see instagram.js), but Telegram will happily take the bytes —
// so the channel keeps working before CARD_PUBLIC_BASE_URL is ever set, and the
// two destinations fail independently instead of one blocking the other.

// Telegram's photo captions cap at 1024 characters. BrickDeal's README records
// what happens when you find that out at send time, so the check is up front and
// the fallback is deliberate: send the photo with a short caption and follow it
// with the full text, rather than silently truncating what you approved.
const CAPTION_MAX = 1000;

export async function publishTelegram(telegram, chatId, cand) {
  const file = cand.card?.file;
  const caption = cand.channelCaption || '';

  if (!file || !existsSync(file)) {
    // No card is a real failure for a visual feed, but a text post still beats
    // dropping an approved item on the floor.
    const msg = await telegram.sendMessage(chatId, caption, {
      link_preview_options: { is_disabled: true },
    });
    return { messageId: msg.message_id, mode: 'text' };
  }

  if (caption.length <= CAPTION_MAX) {
    const msg = await telegram.sendPhoto(
      chatId,
      { source: createReadStream(file) },
      { caption, link_preview_options: { is_disabled: true } }
    );
    return { messageId: msg.message_id, mode: 'photo' };
  }

  const photo = await telegram.sendPhoto(chatId, { source: createReadStream(file) });
  const text = await telegram.sendMessage(chatId, caption, {
    reply_parameters: { message_id: photo.message_id },
    link_preview_options: { is_disabled: true },
  });
  return { messageId: photo.message_id, followUpId: text.message_id, mode: 'photo+text' };
}

/**
 * A deck's slides, as one album.
 *
 * Sent as a media group so they arrive in order as a single swipeable object,
 * which is the only way to review a slideshow — six separate photos in a chat
 * is not the thing that will be published, and approving something you have not
 * seen in its real shape is how a broken third slide goes out.
 *
 * The album carries no buttons. Telegram does not attach a keyboard to a media
 * group, so the approval text and its buttons follow as their own message.
 */
export async function sendDeckForApproval(telegram, chatId, cand, approvalText, keyboard) {
  const files = (cand.deck?.preview || []).map((s) => s.file).filter((f) => f && existsSync(f));

  if (files.length) {
    await telegram
      .sendMediaGroup(
        chatId,
        files.slice(0, 10).map((f) => ({ type: 'photo', media: { source: createReadStream(f) } }))
      )
      .catch((e) => console.error(`approval UX: media group failed — ${e.message}`));
  }

  return telegram.sendMessage(chatId, approvalText, {
    link_preview_options: { is_disabled: true },
    ...keyboard,
  });
}

/**
 * A deck to the Telegram channel.
 *
 * Same album, with the caption on the first slide — Telegram shows a media
 * group's caption under the whole album when only the first item carries one.
 */
export async function publishTelegramDeck(telegram, chatId, cand) {
  const files = (cand.deck?.preview || []).map((s) => s.file).filter((f) => f && existsSync(f));
  if (!files.length) return publishTelegram(telegram, chatId, cand);

  const caption = cand.channelCaption || '';
  const media = files.slice(0, 10).map((f, i) => ({
    type: 'photo',
    media: { source: createReadStream(f) },
    ...(i === 0 && caption.length <= CAPTION_MAX ? { caption } : {}),
  }));

  const msgs = await telegram.sendMediaGroup(chatId, media);
  const first = msgs[0];

  if (caption.length > CAPTION_MAX) {
    await telegram.sendMessage(chatId, caption, {
      reply_parameters: { message_id: first.message_id },
      link_preview_options: { is_disabled: true },
    });
  }
  return { messageId: first.message_id, mode: 'album', slides: media.length };
}

/** The staging card: the rendered image plus the approval text and buttons. */
export async function sendForApproval(telegram, chatId, cand, approvalText, keyboard) {
  if (cand.kind === 'deck') return sendDeckForApproval(telegram, chatId, cand, approvalText, keyboard);

  const file = cand.card?.file;

  if (file && existsSync(file) && approvalText.length <= CAPTION_MAX) {
    return telegram.sendPhoto(
      chatId,
      { source: createReadStream(file) },
      { caption: approvalText, ...keyboard }
    );
  }

  // Photo first, then the approval text as its own message carrying the
  // buttons. The source URL lives in that text, so it goes out either way —
  // there is no path where a card reaches you without its source.
  if (file && existsSync(file)) {
    await telegram.sendPhoto(chatId, { source: createReadStream(file) }).catch(() => {});
  }
  return telegram.sendMessage(chatId, approvalText, {
    link_preview_options: { is_disabled: true },
    ...keyboard,
  });
}
