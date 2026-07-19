// Web is always served fresh — there's no "install a new version" concept, so
// the update prompt is a no-op on the web build.
export default function AppUpdateBridge() {
  return null;
}
