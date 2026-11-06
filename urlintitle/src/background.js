import * as Options from './options_lib.js';
import {formatPageTitle, formatUsesGroup} from './title_lib.js';

// Mirrors the "debug" option. Refreshed by loadOptions(), so the option takes
// effect on the next message or tab event without reloading the extension.
// Logs go to the service worker console.
let debug_enabled = false;
function debug(...args) {
  if (debug_enabled) console.log('urlintitle[bg]:', ...args);
}

async function loadOptions() {
  const options = await Options.getOptions();
  debug_enabled = options.debug;
  return options;
}

/**
 * Returns whether the given URL passes the filter (whitelist or blacklist).
 */
function shouldProcessUrl(options, url) {
  const at_least_one_match =
      options.url_filter_regexps.some(
          regexp => url.search(new RegExp(regexp)) >= 0);
  return at_least_one_match == options.url_filter_is_whitelist;
}

/**
 * Returns the name of the tab group that the sender's tab belongs to, or '' if
 * the format does not use {group}, the sender has no tab, the tab is ungrouped,
 * the group is unnamed, or the lookup fails. Requires the "tabGroups"
 * permission.
 */
async function getTabGroupName(format, sender) {
  // Avoid the extra async round-trips when the format does not use the group.
  if (!formatUsesGroup(format)) {
    return '';
  }
  const tabId = sender && sender.tab && sender.tab.id;
  if (tabId == null) {
    return '';
  }
  try {
    // Read a fresh groupId rather than trusting the possibly-stale snapshot in
    // sender.tab.
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId == null ||
        tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
      return '';
    }
    const group = await chrome.tabGroups.get(tab.groupId);
    debug('resolved group for tab', tabId, '->', JSON.stringify(group.title));
    return group.title || '';
  } catch (error) {
    // A tab or group can disappear between the page sending its message and this
    // lookup running (e.g. the tab was closed). That race is expected, so log it
    // quietly rather than as an error.
    debug('failed to resolve tab group name for tab', tabId, error);
    return '';
  }
}

/**
 * env: same format as EXAMPLE_ENV
 * previous_formatted_title_suffix: should be the formatted_title_suffix
 *   value returned by the previous call to formatPageTitleUpdate().
 *   Theoretically undefined but usually ok behavior if the format changes
 *   between two calls.
 */
function formatPageTitleUpdate(format, env, previous_formatted_title_suffix) {
  let formatted_title_suffix;

  // Heuristic to support pages that update their title and preserve the text
  // that the extension appends, such as:
  // document.title = 'prefix' + document.title;
  // Supports only formats like: '{title}...' that contain only one {title} tag.
  const format_split = format.match(/^\{title\}([\s\S]*$)/);
  if (format_split && !format_split[1].match(/\{title\}/g)) {
    // Supported {title}-prefixed format: generate the title suffix.
    formatted_title_suffix =
        formatPageTitle(format, Object.assign({}, env, {title: ''}));

    // Strip the previous suffix from the title if present, to avoid
    // formatPageTitle() below appending another suffix to the previous one.
    let title = env.title;
    if (previous_formatted_title_suffix &&
        title.endsWith(previous_formatted_title_suffix)) {
      title = title.substring(
          0, title.length - previous_formatted_title_suffix.length);
    }
    env = Object.assign({}, env, {title: title});
  } else {
    // Not a {title}-prefixed format.
    formatted_title_suffix = null;
  }

  return {
    formatted_title: formatPageTitle(format, env),
    formatted_title_suffix: formatted_title_suffix,
    // The title with any previously-appended suffix stripped. The content
    // script stores this so a later refresh re-formats from the clean title
    // instead of re-accumulating a stale suffix.
    core_title: env.title,
  };
}

class MessageHandlers {
  static async get_constants(message) {
    return {LOCATION_FIELDS: Options.LOCATION_FIELDS};
  }

  static async format_title_update(message, sender) {
    const options = await loadOptions();
    if (!shouldProcessUrl(options, message.filtering_url)) {
      debug('skipped (filtered URL)', message.filtering_url);
      return null;
    }
    const group = await getTabGroupName(options.format, sender);
    const result = formatPageTitleUpdate(
        options.format,
        {
          location: message.location,
          title: message.title,
          group: group,
          session: message.session || '',
        },
        message.previous_formatted_title_suffix);
    debug('format', JSON.stringify(message.title), '+ group',
        JSON.stringify(group), '->', JSON.stringify(result.formatted_title));
    return result;
  }
}

// Last-known title per group id, used to skip the refresh fan-out when a group
// update (e.g. color or collapse change) leaves the title unchanged. The map
// resets when the service worker restarts; the first event for a group then
// always refreshes, so a stale map can only cause one extra refresh, never a
// missed one.
const last_group_titles = new Map();

chrome.tabGroups.onRemoved.addListener(
    (group) => last_group_titles.delete(group.id));

// When a tab group is renamed, ask the content scripts of its tabs to
// re-format their titles, so a new group name is reflected without waiting for
// the next navigation or page-driven title change.
chrome.tabGroups.onUpdated.addListener(async (group) => {
  try {
    const title = group.title || '';
    if (last_group_titles.get(group.id) === title) {
      return;  // Color/collapse-only update: the group name is unchanged.
    }
    last_group_titles.set(group.id, title);
    const options = await loadOptions();
    if (!formatUsesGroup(options.format)) {
      return;  // The group name is not used in titles; nothing to refresh.
    }
    const tabs = await chrome.tabs.query({groupId: group.id});
    debug('tabGroups.onUpdated', group.id, JSON.stringify(group.title),
        '-> refreshing', tabs.length, 'tab(s)');
    await Promise.all(tabs.map(tab =>
        // Ignore tabs with no content script (e.g. chrome:// pages).
        chrome.tabs.sendMessage(tab.id, {name: 'refresh_title'})
            .catch(() => {})));
  } catch (error) {
    console.error(
        'urlintitle: failed to refresh titles after tab group update', error);
  }
});

// When a tab is added to or removed from a group, re-format its title.
// tabGroups.onUpdated does not fire for membership changes; tabs.onUpdated
// reports them via changeInfo.groupId ("The tab's new group", Chrome 88+).
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.groupId === undefined) {
    return;
  }
  try {
    const options = await loadOptions();
    if (!formatUsesGroup(options.format)) {
      return;  // The group name is not used in titles; nothing to refresh.
    }
    debug('tabs.onUpdated', tabId, 'groupId ->', changeInfo.groupId);
    // Ignore tabs with no content script (e.g. chrome:// pages).
    await chrome.tabs.sendMessage(tabId, {name: 'refresh_title'})
        .catch(() => {});
  } catch (error) {
    console.error(
        'urlintitle: failed to refresh title after tab group change', error);
  }
});

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    const handler = Object.hasOwn(MessageHandlers, message.name)
        ? MessageHandlers[message.name]
        : undefined;
    if (typeof handler !== 'function') {
      sendResponse(null);
      return false;
    }
    handler(message, sender)
        .then(sendResponse)
        .catch(error => {
          console.error(
              `urlintitle: message handler '${message.name}' failed`, error);
          sendResponse(null);
        });
    return true;  // async response
  });
