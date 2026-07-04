'use strict';

(async function() {
  // getCurrent() returns the tab this page runs in, avoiding the risk of
  // redirecting an unrelated tab when this page is not the active/focused one.
  const tab = await chrome.tabs.getCurrent();
  if (tab) {
    try {
      await chrome.tabs.update(tab.id, {'url': 'chrome://apps'});
    } catch (error) {
      console.error('newtab: failed to open chrome://apps', error);
    }
  }
})();
