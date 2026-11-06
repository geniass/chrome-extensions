(async () => {

// Ignore the page if <head> does not exist or <head urlintitle="disabled">.
if (!document.head || document.head.getAttribute('urlintitle') == 'disabled') {
  return;
}

// Set to true (then reload the page) to log title activity to the page's own
// DevTools console. Off by default.
const DEBUG = false;
function debug(...args) {
  if (DEBUG) console.log('urlintitle[page]:', ...args);
}

// The last known title set by the page, before formatting.
// Reset to null after each update.
let last_original_title = null;

// The last formatted title before any browser post-processing.
let last_formatted_title = null;

// The last formatted_title_suffix returned by format_title_update.
let last_formatted_title_suffix = null;

// The last formatted title after browser post-processing (e.g. trimming).
let last_postprocessed_title = null;

// Monotonic id of the most recently started update. Used to ignore responses
// from superseded updates, so out-of-order replies from concurrent, in-flight
// requests cannot apply a stale formatted title.
let latest_update_id = 0;

// The raw, pre-format title last sent to the background script (the input that
// produced the current displayed title). Used by refresh_title to re-format
// from the original title rather than from the already-formatted document.title.
let last_source_title = null;

// The session name last sent to the background script, used to detect a change
// that needs a re-format.
let last_session = '';

// Returns the session name from the Claude Code web header, or '' on any other
// page. The page also has an unrelated sr-only <h2>Navigation</h2>, so select
// the rename button by its data attribute rather than by tag alone.
function getSessionName() {
  if (location.hostname !== 'claude.ai') {
    return '';
  }
  const button = document.querySelector('h2 > button[data-pane-title]');
  return button ? button.textContent.trim() : '';
}

// Memoized LOCATION_FIELDS from the background script. These are static, so
// they are fetched at most once instead of on every title change.
let constants_cache = null;
async function getConstants() {
  if (!constants_cache) {
    constants_cache = await chrome.runtime.sendMessage({name: 'get_constants'});
  }
  return constants_cache;
}


async function maybeUpdateTitle() {
  const current_title = document.title;

  // Drop redundant update requests:
  // - an update is already pending for the current title
  // - the current title is the result of the last update
  if (last_original_title === current_title ||
      last_postprocessed_title === current_title) {
    return;
  }

  last_original_title = current_title;
  last_formatted_title = null;

  await updateTitle(current_title);
}

async function updateTitle(original_title) {
  const update_id = ++latest_update_id;
  let result;
  try {
    const constants = await getConstants();

    // Explicitly copy the required location fields that Chrome strips out.
    const location_copy = {};
    Object.keys(constants.LOCATION_FIELDS).forEach(
      field => location_copy[field] = document.location[field]);

    last_session = getSessionName();

    // Ask the background script to format the title.
    const update_msg = {
      name: 'format_title_update',
      location: location_copy,
      filtering_url: document.location.href,
      title: original_title,
      session: last_session,
      previous_formatted_title_suffix: last_formatted_title_suffix,
    };
    result = await chrome.runtime.sendMessage(update_msg);
  } catch (error) {
    // A message failed (e.g. the extension was reloaded and this content
    // script is orphaned). Clear the pending marker if we are still the latest
    // update, so this title is not deduped forever and a retry can proceed.
    if (update_id === latest_update_id) {
      last_original_title = null;
    }
    return;
  }

  // Ignore stale responses: a newer update started while this one was pending.
  if (update_id !== latest_update_id) {
    return;
  }

  // This is the latest update: clear the pending-original marker so that if the
  // page later resets the title to this same value, it gets reprocessed.
  last_original_title = null;

  if (!result) {
    // Filtered URL: keep the raw title so a later refresh re-sends the same
    // input (which will again be filtered).
    last_source_title = original_title;
    return;
  }
  const {formatted_title, formatted_title_suffix, core_title} = result;

  // Record the source title so a later refresh re-formats from it. Prefer the
  // background's suffix-stripped core_title, so repeated refreshes don't
  // re-accumulate a stale group-name suffix.
  last_source_title = core_title != null ? core_title : original_title;

  // Set the title only if it has changed, to avoid recursive notifications.
  if (last_formatted_title !== formatted_title) {
    last_formatted_title = formatted_title;
    document.title = formatted_title;
    last_postprocessed_title = document.title;
    last_formatted_title_suffix = formatted_title_suffix;
    debug('set title', JSON.stringify(formatted_title));
  }
}

// Calls maybeUpdateTitle() on future, programmatic title changes.
// Listens for all <head> updates, not just <title> because the page can delete
// it with document.querySelector('head > title').remove().
// Known limitation: do not handle document.head.remove() by listening for
// all of document, because deleting <head> is unlikely and breaks the
// connection between document.title and the tab title.
function registerTitleMutationObserver() {
  const observer = new window.MutationObserver(
      (mutations, observer) => maybeUpdateTitle());
  observer.observe(document.head, {subtree: true, childList: true});
}

// Re-formats the title when the background script reports that the tab's group
// changed (e.g. renamed). We re-format from the stored raw source title, not
// from the already-formatted document.title, so the group name is rebuilt
// cleanly for every format (reprocessing the formatted title would otherwise
// re-append prefixes for non-'{title}'-prefixed formats). No-op until an
// update has at least started, and idempotent when the group name is unchanged.
function registerRefreshListener() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.name === 'refresh_title') {
      refreshTitle();
    }
  });
}

function refreshTitle() {
  // Prefer the title of an in-flight page-driven update over the stored
  // source title: this refresh supersedes that update via latest_update_id,
  // so re-sending its (newer) input avoids resurrecting the previous title.
  const source =
      last_original_title !== null ? last_original_title : last_source_title;
  if (source !== null) {
    debug('refresh_title from source', JSON.stringify(source));
    updateTitle(source);
  }
}

// Re-formats the title when the session name in the page body changes. The
// page can change it (initial render, navigation to another session, rename)
// without touching <title>, so the <head> observer does not see it. The check
// is debounced because the page mutates its body continuously while a
// response streams.
const SESSION_CHECK_DELAY_MS = 100;

function registerSessionObserver() {
  if (location.hostname !== 'claude.ai') {
    return;
  }
  let check_pending = false;
  new window.MutationObserver(() => {
    if (check_pending) {
      return;
    }
    check_pending = true;
    setTimeout(() => {
      check_pending = false;
      const session = getSessionName();
      if (session !== last_session) {
        debug('session changed', JSON.stringify(session));
        refreshTitle();
      }
    }, SESSION_CHECK_DELAY_MS);
  }).observe(document.body,
      {subtree: true, childList: true, characterData: true});
}

// Register the refresh listener before the first (awaited) update, so a group
// rename that happens while the initial format round-trip is in flight is not
// silently dropped for lack of a listener.
registerRefreshListener();
await maybeUpdateTitle();
registerTitleMutationObserver();
registerSessionObserver();

})();
