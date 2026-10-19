# Aniverse Desktop App

Electron desktop app for [aniverse.fr](https://aniverse.fr) with:

- Custom headers (`x-app: desktop`) + branded User-Agent on all requests
- Background Express server for app detection & CORS-bypassing proxy
- Auto-updates via GitHub Releases
- Deep link support (`aniverse://`)

---

## Project Structure

```
aniverse-desktop/
├── src/
│   ├── main.js          # Electron main process
│   ├── preload.js       # Context bridge (renderer ↔ main)
│   ├── server.js        # Express background server
│   ├── updater.js       # Auto-updater
│   └── config.js        # ← Edit this to change URLs, ports, etc.
├── assets/icons/
│   ├── filled/          # App icon: icon.png (1024×1024), icon.ico, icon.icns
│   └── transparant/     # Transparent logo PNGs (16–512); 512.png is the loading screen logo
├── logo.png             # Source: filled app icon (1024×1024)
├── logo-tp.png          # Source: transparent logo (1024×1024)
├── build/
│   └── entitlements.mac.plist
├── website-integration.js  # Drop into your website
└── package.json
```

---

## Setup

```bash
npm install
```

### Icons

All icons are generated from the two 1024×1024 source logos in the project root:

- `logo.png` → `assets/icons/filled/icon.png`, `icon.ico` (16–256), `icon.icns` (16–1024, incl. @2x)
- `logo-tp.png` → `assets/icons/transparant/{16,32,48,128,512}.png`

---

## Configuration

Edit `src/config.js`:

```js
APP_URL: 'https://aniverse.fr',   // URL the window loads
EXPRESS_PORT: 57331,               // Background server port
DEEP_LINK_PROTOCOL: 'aniverse',    // aniverse:// deep links
AUTO_UPDATE: true,                // Enable/disable auto-updates
```

---

## Development

```bash
npm start        # Run the app
npm run dev      # Same but with --dev flag (opens DevTools)
```

---

## Building

```bash
npm run build        # Current platform
npm run build:win    # Windows (NSIS installer)
npm run build:mac    # macOS (DMG)
npm run build:linux  # Linux (AppImage + deb)
```

Outputs go to `dist/`.

---

## Auto-Updates Setup (GitHub Releases)

1. In `package.json`, set your GitHub repo:

   ```json
   "publish": [{
     "provider": "github",
     "owner": "YOUR_USERNAME",
     "repo": "aniverse-desktop"
   }]
   ```

2. Create a GitHub personal access token with `repo` scope.

3. Set `GH_TOKEN` environment variable when publishing:

   ```bash
   GH_TOKEN=your_token npm run publish
   ```

4. This creates a GitHub Release + uploads the installers automatically.
   electron-updater checks this release endpoint for updates.

---

## Deep Links

The app registers the `aniverse://` protocol.

| URL                               | Effect                                  |
| --------------------------------- | --------------------------------------- |
| `aniverse://open`                 | Opens/focuses the app                   |
| `aniverse://open?path=/dashboard` | Opens app and navigates to `/dashboard` |

From your website:

```js
window.location.href = "aniverse://open?path=/dashboard";
```

Or use the helper:

```js
import { openDesktopApp } from "./website-integration";
await openDesktopApp("/dashboard");
```

---

## Website Integration

Copy `website-integration.js` into your site and use:

```js
import {
  detectDesktopApp,
  openDesktopApp,
  isRunningInDesktopApp,
} from "./website-integration";

// Check if app is installed (via ping)
const appInfo = await detectDesktopApp();
if (appInfo) {
  console.log("Desktop app installed, version:", appInfo.version);
}

// Check if currently running inside Electron
if (isRunningInDesktopApp) {
  const version = await window.aniverseDesktop.getVersion();
}

// Open the app from a browser
await openDesktopApp("/dashboard");
```

### Server-side detection (Node/Express)

```js
app.use((req, res, next) => {
  res.locals.isDesktopApp =
    req.headers["x-app"] === "desktop" &&
    req.headers["user-agent"]?.startsWith("AniverseDesktop/");
  next();
});
```

---

## App Lifecycle

- The app behaves like a normal desktop app: it does not launch at login and has no system tray icon.
- Closing the window quits the app (except on macOS, where it stays in the dock per platform convention).
- The Express server runs only while the app is open.

---

## Proxy Usage

The Express server at `http://127.0.0.1:57331` exposes:

| Endpoint            | Purpose                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `GET /ping`         | App detection — returns `{ installed: true, version, platform }` |
| `GET /open?path=/x` | Open/focus the desktop window, optionally navigate               |
| `ANY /proxy/*`      | Transparent proxy to `https://aniverse.fr`, CORS-bypassed        |

All proxied requests forward `Origin`, `Referer`, `Cookie`, `Authorization`, and other headers.
