// The app icons, in one place: scripts/make-icons.mjs draws them into assets/, scripts/build.mjs copies them next
// to the page and lists them in the manifest and the service worker's precache.
// `width` is how wide the logo's marks are drawn (% of the icon); `radius` rounds the tile (none: full bleed).
export const ICONS = [
  // Shown as they are (browser tabs, install dialogs): a rounded tile on transparent corners.
  { file: 'icon-192.png', size: 192, purpose: 'any', width: 62, radius: 22 },
  { file: 'icon-512.png', size: 512, purpose: 'any', width: 62, radius: 22 },
  // Android cuts its own shape out of a maskable icon: full bleed, marks inside the central safe circle.
  { file: 'icon-maskable-512.png', size: 512, purpose: 'maskable', width: 52 },
  // iOS rounds the corners itself (not in the manifest; linked from the page).
  { file: 'apple-touch-icon.png', size: 180, purpose: 'apple', width: 58 },
];
