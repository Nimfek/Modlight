/**
 * Who is asking: a reader, or a link preview?
 *
 * These patterns used to live inside the preview page, which is why the page
 * knew not to spend a view on a crawler and the raw route did not. That gap was
 * not theoretical: the og:image of a picture points at /raw, so a single unfurl
 * by X or WhatsApp fetched the bytes and consumed a view - and a burn-after-view
 * link died in the chat window before its recipient ever clicked it.
 */

/**
 * Chat clients that turn a *bare file URL* into a native media embed - the image
 * or the video itself, with no card, no title and no site name around it.
 *
 * Handing them the HTML preview page instead is what produces a link card:
 * Open Graph is the best a document can do. Pointing them straight at the bytes
 * is what makes Discord inline the picture and give an mp4 a real player.
 * Everything not listed here (X, Facebook, LinkedIn, Bluesky...) only
 * understands markup, so those keep getting the page and its OG tags.
 */
export const DIRECT_MEDIA_BOTS =
  /discordbot|telegrambot|slackbot|slack-imgproxy|skypeuripreview|mattermost|synapse|revoltbot|guildedbot/i;

/**
 * Every unfurler and crawler we recognise. Used to keep automated previews out
 * of the statistics - and, more importantly, to stop a link preview from
 * spending a budget that was meant for a human.
 */
export const PREVIEW_BOTS = new RegExp(
  `${DIRECT_MEDIA_BOTS.source}|whatsapp|twitterbot|facebookexternalhit|facebot|linkedinbot|redditbot|embedly|` +
    `iframely|vkshare|tumblr|flipboard|bitlybot|nuzzel|bufferbot|quora link preview|showyoubot|outbrain|` +
    `googlebot|bingbot|applebot|duckduckbot|yandexbot|petalbot|semrushbot|ahrefsbot|cardyb|w3c_validator`,
  "i",
);

export function isPreviewBot(userAgent: string | null | undefined): boolean {
  return !!userAgent && PREVIEW_BOTS.test(userAgent);
}

export function isDirectMediaBot(userAgent: string | null | undefined): boolean {
  return !!userAgent && DIRECT_MEDIA_BOTS.test(userAgent);
}
