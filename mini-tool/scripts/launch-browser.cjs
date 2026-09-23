'use strict';
const {chromium} = require('playwright');

// Prefer the installed Chrome used for device-development regression runs.
// A clean checkout can instead use `npx playwright install chromium`.
async function launchBrowser() {
  try {
    return await chromium.launch({channel: 'chrome', headless: true});
  } catch (chromeError) {
    try {
      return await chromium.launch({headless: true});
    } catch (chromiumError) {
      throw new AggregateError([chromeError, chromiumError],
        'No usable Chrome/Chromium. Run: npx playwright install chromium');
    }
  }
}

module.exports = {launchBrowser};
