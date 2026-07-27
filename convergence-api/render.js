// render.js — sanitized markdown rendering for Agent Chat message bodies.
//
// Pipeline: strip `[[attach: <url>]]` tokens (handled separately, before
// markdown parsing) -> render remaining markdown to HTML via `marked` ->
// sanitize the HTML via `sanitize-html` (strict allowlist, no raw HTML
// passthrough) -> append rendered attachment <img> tags.
//
// Ported from GaretAnderson/homeassistant PR #66 (addons/convergence-api,
// merged there but not live — this repo is the canonical, deployed source).
'use strict';

const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

// Matches `[[attach: <url>]]` tokens anywhere in the message body. Attachment
// URLs are pulled out and rendered as <img> tags *after* sanitization, kept
// separate from markdown-authored content.
const ATTACH_RE = /\[\[attach:\s*([^\]]+?)\s*\]\]/gi;

marked.setOptions({
  gfm: true,
  breaks: true
});

// Force safe target/rel on every link the renderer produces, regardless of
// whether it came from `[text](url)` syntax or a bare-URL autolink.
const renderer = new marked.Renderer();
renderer.link = (href, title, text) => {
  const safeHref = escapeAttr(href || '');
  const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
  return `<a href="${safeHref}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
};

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Extracts `[[attach: url]]` tokens from a raw message body. Returns the
// stripped text (attachment tokens removed) and the list of attachment URLs
// in the order they appeared.
function extractAttachments(body) {
  const text = String(body || '');
  const attachments = [];
  const stripped = text.replace(ATTACH_RE, (_match, url) => {
    attachments.push(url.trim());
    return '';
  });
  return { text: stripped.trim(), attachments };
}

// Validates an attachment URL, allowing only http(s) absolute URLs or
// root-relative `/files/...` style paths served by this app. Anything else
// (javascript:, data:, vbscript:, protocol-relative //host, bare relative
// paths, malformed input, etc.) is rejected so it can never reach an <img
// src> attribute — sanitize-html never sees `[[attach:]]` URLs since they're
// rendered after the sanitize step, so this check is the only thing standing
// between a malicious URL and the DOM.
function isSafeAttachmentUrl(url) {
  const str = String(url || '').trim();
  if (!str) return false;
  // Reject anything containing control characters (some browsers strip
  // these before scheme-sniffing, allowing "java\tscript:" style bypasses).
  if (/[\u0000-\u001f\u007f]/.test(str)) return false;

  // Root-relative path, e.g. "/files/photo.png". Must not be
  // protocol-relative ("//evil.com/...") which browsers treat as absolute.
  if (str.startsWith('/') && !str.startsWith('//')) return true;

  try {
    const parsed = new URL(str);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// Renders a single attachment URL as a sanitized <img> tag. Returns an empty
// string if the URL doesn't pass the http(s)/root-relative allowlist.
function imgTag(url) {
  if (!isSafeAttachmentUrl(url)) return '';
  const safe = escapeAttr(String(url).trim());
  return `<img src="${safe}" alt="attachment" class="chat-attachment" loading="lazy">`;
}

const SANITIZE_OPTIONS = {
  allowedTags: [
    'p', 'br', 'hr',
    'strong', 'b', 'em', 'i', 'del', 's',
    'code', 'pre',
    'ul', 'ol', 'li',
    'blockquote',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'a', 'img', 'span'
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'class', 'loading'],
    code: ['class'],
    span: ['class'],
    th: ['align', 'colspan', 'rowspan'],
    td: ['align', 'colspan', 'rowspan']
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {
    img: ['http', 'https']
  },
  disallowedTagsMode: 'discard',
  // Belt-and-suspenders: even if a link somehow slips through without our
  // renderer's target/rel, force them here too.
  transformTags: {
    a: (tagName, attribs) => ({
      tagName: 'a',
      attribs: {
        ...attribs,
        target: '_blank',
        rel: 'noopener noreferrer'
      }
    })
  }
};

// Renders a raw message body into sanitized HTML, ready for innerHTML.
// - Strips `[[attach: url]]` tokens before markdown parsing.
// - Renders remaining text as GFM markdown (tables, links, lists, code,
//   bold/italic, headings, blockquotes).
// - Sanitizes the resulting HTML with a strict allowlist (no script/style/
//   event-handler passthrough, no raw HTML from message authors).
// - Appends sanitized <img> tags for any stripped attachments.
function renderMessageHtml(body) {
  const { text, attachments } = extractAttachments(body);

  let html = '';
  if (text) {
    const rawHtml = marked.parse(text, { renderer });
    html = sanitizeHtml(rawHtml, SANITIZE_OPTIONS);
  }

  const imgHtml = attachments.map(imgTag).join('');
  return html + imgHtml;
}

module.exports = {
  renderMessageHtml,
  extractAttachments,
  imgTag,
  escapeHtml,
  isSafeAttachmentUrl
};
