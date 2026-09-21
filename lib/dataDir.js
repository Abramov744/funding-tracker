// Where small on-disk state files (guest-login log, APR-trend snapshots) get
// written. Railway injects RAILWAY_VOLUME_MOUNT_PATH when a persistent volume
// is attached to the service — using it means these files survive a redeploy
// instead of vanishing with the old container's filesystem. Falls back to a
// local ./data folder (gitignored) for local dev or an environment with no
// volume attached, same as before this existed.
const path = require('path');

function dataDir() {
  return process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
}

module.exports = { dataDir };
