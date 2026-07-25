// Native has its own update paths (the APK release prompt + expo-updates OTA),
// so the web "refresh for the new build" prompt is a no-op here.
export default function WebUpdateBanner() {
  return null;
}
