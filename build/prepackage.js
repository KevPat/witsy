
export default function(platform, arch) {

  console.log(`Running prePackage script for ${platform}-${arch}…`)
  // Target-specific dependency cleanup happens inside Forge's packaged copy in
  // packageAfterPrune. Never mutate package.json, package-lock.json, or the
  // developer's node_modules while packaging.
}
