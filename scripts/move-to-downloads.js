// electron-builder afterAllArtifactBuild hook: moves the built AppImage
// into the user's Downloads folder so `npm run dist` leaves a ready-to-run
// artifact somewhere obvious instead of buried in dist/.
const fs = require('fs');
const os = require('os');
const path = require('path');

function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    // rename() fails across filesystems/mount points; fall back to copy+delete.
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

module.exports = async function afterAllArtifactBuild(buildResult) {
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });

  return buildResult.artifactPaths.map((artifactPath) => {
    if (!artifactPath.toLowerCase().endsWith('.appimage')) return artifactPath;
    const dest = path.join(downloadsDir, path.basename(artifactPath));
    moveFile(artifactPath, dest);
    console.log(`  • moved to Downloads  file=${dest}`);
    return dest;
  });
};
