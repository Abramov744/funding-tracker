// Where small on-disk state files (guest-login log, APR-trend snapshots,
// Variational's self-built funding history) get written. Set DATA_DIR to a
// mounted persistent disk's path so these survive a redeploy instead of
// vanishing with the old container's filesystem — e.g. Render's persistent
// disks (render.yaml sets DATA_DIR to the disk's own mountPath) or any other
// host that lets you mount one. RAILWAY_VOLUME_MOUNT_PATH is checked next
// for continuity with this app's original Railway deployment, which injects
// that variable itself rather than needing DATA_DIR set explicitly. Falls
// back to a local ./data folder (gitignored) for local dev or a host with no
// disk attached, same as before this existed.
const path = require('path');

function dataDir() {
  return process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
}

module.exports = { dataDir };
