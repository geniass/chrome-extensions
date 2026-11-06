import {toUnicode} from './punycode.js';

export const TAGS = {
  'title': {
    compute: (env) => env.title,
    description: "The page title.",
  },
  'protocol': {
    compute: (env) => env.location.protocol.replace(':', ''),
    description: "The URL protocol, without '<code>://</code>' suffix.",
  },
  'hostname': {
    compute: (env) => {
      try {
        return toUnicode(env.location.hostname);
      } catch(e) {
        return env.location.hostname;
      }
    },
    description: "The URL hostname, converted from Punycode to Unicode.",
  },
  'hostnameascii': {
    compute: (env) => env.location.hostname,
    description: "The raw URL hostname, not converted from Punycode to Unicode.",
  },
  'port': {
    compute: (env) => env.location.port && (':' + env.location.port),
    description: "The URL port, prefixed with '<code>:</code>' if not empty.",
  },
  'path': {
    compute: (env) => env.location.pathname.replace(/^\/?/, ''),
    description: "The URL path, without '<code>/</code>' prefix.",
  },
  'args': {
    compute: (env) => env.location.search,
    description: "The URL arguments, prefixed with '<code>?</code>' if not empty.",
  },
  'hash': {
    compute: (env) => env.location.hash,
    description: "The URL hash, prefixed with '<code>#</code>' if not empty.",
  },
  'group': {
    compute: (env) => env.group || '',
    description: "The name of the tab's tab group. When the tab is not in a "
        + "group (or the group is unnamed) the tag and one adjacent separator "
        + "are removed, so '<code>{title} - {group}</code>' has no trailing "
        + "'<code> - </code>'.",
  },
  'session': {
    compute: (env) => env.session || '',
    description: "The session name shown in the header of a Claude Code web "
        + "session (<code>claude.ai/code</code>). Empty on other pages, where "
        + "the tag and one adjacent separator are removed like "
        + "'<code>{group}</code>'.",
  },
};

const FORMAT_REGEXP =
    new RegExp('{(' + Object.keys(TAGS).join('|') + ')}', 'g');

// A "separator": a run of characters that are neither letters/digits nor tag
// braces, e.g. ' - ', ' | ', ': ', '[', ']'.
const SEPARATOR = '[^\\p{L}\\p{N}{}]+';

const GROUP_TAG = '{group}';

/**
 * Returns whether the format string uses the {group} tag, i.e. whether
 * formatting it requires resolving the tab's group name.
 */
export function formatUsesGroup(format) {
  return format.includes(GROUP_TAG);
}

// Tags that are removed, together with their surrounding separators, when
// their value is empty.
const OPTIONAL_TAGS = ['group', 'session'];

// Per optional tag, matches the tag together with any separators immediately
// surrounding it.
const EMPTY_TAG_REGEXPS = OPTIONAL_TAGS.map(tag => ({
  tag,
  regexp: new RegExp(
      '(' + SEPARATOR + ')?\\{' + tag + '\\}(' + SEPARATOR + ')?', 'gu'),
}));

// Bracket-like pairs that may wrap {group}, e.g. '({group})' or '[{group}]'.
// Used to drop both halves of the pair together instead of leaving an
// orphaned closer behind.
const BRACKET_PAIRS =
    {'(': ')', '[': ']', '<': '>', '«': '»', '"': '"', "'": "'"};

// String.replace() callback for EMPTY_TAG_REGEXPS: returns what remains of a
// match for an optional tag whose value is empty.
function removeEmptyTag(match, before = '', after = '', offset, string) {
  // Strip bracket pairs that wrap the tag, so ' ({group}) - ' is treated as
  // separators ' ' and ' - ' rather than leaving an orphaned ')'.
  while (before && after && BRACKET_PAIRS[before.at(-1)] === after[0]) {
    before = before.slice(0, -1);
    after = after.slice(1);
  }
  const content_before = offset > 0;
  const content_after = offset + match.length < string.length;
  return (after && content_before && content_after) ? after : '';
}

export function normalizeTitle(title) {
  return (title || '').trim().replace(/\s+/g, ' ');
}

/**
 * env: same format as EXAMPLE_ENV
 */
export function formatPageTitle(format, env) {
  // When an optional tag (e.g. {group}) has no value, remove it and its
  // surrounding separators rather than formatting it to an empty string that
  // would leave a dangling or doubled separator. If the tag is flanked by real
  // content on both sides (e.g. '{title} @ {group} - {host}') the trailing
  // separator is kept ('{title} - {host}'), so a tag-specific delimiter before
  // the tag disappears with it; brackets wrapping the tag (e.g. '{title}
  // ({group}) - {host}') are dropped as a pair; at an edge (e.g. '{title} -
  // {group}' or '[{group}]') the tag and its separators are dropped entirely.
  for (const {tag, regexp} of EMPTY_TAG_REGEXPS) {
    if (!env[tag]) {
      format = format.replace(regexp, removeEmptyTag);
    }
  }
  return normalizeTitle(format.replace(FORMAT_REGEXP,
      (format, tag) => TAGS[tag].compute(env)));
}
