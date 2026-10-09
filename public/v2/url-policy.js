// Shared outbound-navigation policy for adapters, VMs and browser anchors.
// HTTP is allowed alongside HTTPS; this never fetches a URL on the server.
export const MAX_EXTERNAL_URL_LENGTH = 2048;

/** A bounded, absolute, credential-free HTTP(S) URL in canonical form, or null. */
export function safeExternalUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_EXTERNAL_URL_LENGTH) return null;
  // Reject inputs the URL parser silently repairs (spaces, controls, backslashes,
  // missing authority), malformed escapes, and encoded ASCII controls.
  if (/[\s\u0000-\u001f\u007f-\u009f\\]/u.test(value)
    || /%(?![\da-f]{2})|%(?:0[\da-f]|1[\da-f]|7f)/i.test(value)) return null;
  const authority = /^https?:\/\/([^/?#]+)/i.exec(value);
  if (!authority || /@|:$/.test(authority[1])) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.href.length > MAX_EXTERNAL_URL_LENGTH) return null;
    return url.href;
  } catch { return null; }
}
