// Puppeteer config: on the Linux server (Render), download Chrome inside the project so it is kept
// between build and run. On Windows, skip the download: the installed Edge/Chrome is used instead.
const path = require('path');
module.exports = {
  cacheDirectory: path.join(__dirname, '.cache', 'puppeteer'),
  skipDownload: process.platform === 'win32',
};
