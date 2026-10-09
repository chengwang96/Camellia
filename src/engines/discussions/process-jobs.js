'use strict';
const { prepareWindowsJob, recoverWindowsJob } = require('./windows-job');
const { WindowsJobJournal } = require('./windows-job-journal');
const { prepareUnixJob, recoverUnixJob, UnixJobJournal } = require('./unix-job');
const SUPPORTED_PLATFORMS = Object.freeze(['win32', 'darwin']);
function processJobs(platform = process.platform) {
  if (platform === 'win32') return { Journal: WindowsJobJournal, directory: 'windows-jobs', prepare: prepareWindowsJob, recover: recoverWindowsJob };
  if (platform === 'darwin') return { Journal: UnixJobJournal, directory: 'unix-jobs', prepare: prepareUnixJob, recover: recoverUnixJob };
  throw new Error('Agent discussions are currently available on Windows and macOS desktop.');
}
module.exports = { processJobs, SUPPORTED_PLATFORMS };
