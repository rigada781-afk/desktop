# Vumeto Desktop App

Electron desktop app for [vumeto.com](https://vumeto.com) with:

- Custom headers (`x-app: desktop`) + branded User-Agent on all requests
- Background Express server for app detection & CORS-bypassing proxy
- Auto-updates via GitHub Releases
- System startup (background/tray mode)
- Deep link support (`vumeto://`)

---

## Project Structure

```
vumeto-desktop/
├── src/
│   ├── main.js          # Electron main process
│   ├── preload.js       # Context bridge (renderer ↔ main)
│   ├── server.js        # Express background server
│   ├── updater.js       # Auto-updater
│   └── config.js        # ← Edit this to change URLs, ports, etc.
├── assets/
│   ├── icon.png         # App icon (512×512 recommended)
│   ├── icon.ico         # Windows icon
│   ├── icon.icns        # macOS icon
│   └── tray-icon.png    # System tray icon (16×16 or 22×22)
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

### Add your icons

Place these in `assets/`:

- `icon.png` — 512×512 PNG (used on Linux + fallback)
- `icon.ico` — Windows multi-size ICO
- `icon.icns` — macOS ICNS
- `tray-icon.png` — 16×16 or 22×22 PNG for the system tray

---

## Configuration

Edit `src/config.js`:

```js
APP_URL: 'https://vumeto.com',   // URL the window loads
EXPRESS_PORT: 57331,               // Background server port
DEEP_LINK_PROTOCOL: 'vumeto',    // vumeto:// deep links
AUTO_UPDATE: true,                // Enable/disable auto-updates
```

---

## Development

```bash
npm start        # Run without startup flag (shows window)
npm run dev      # Same but with --dev flag (disables login item)
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
     "repo": "vumeto-desktop"
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

The app registers the `vumeto://` protocol.

| URL                             | Effect                                  |
| ------------------------------- | --------------------------------------- |
| `vumeto://open`                 | Opens/focuses the app                   |
| `vumeto://open?path=/dashboard` | Opens app and navigates to `/dashboard` |

From your website:

```js
window.location.href = "vumeto://open?path=/dashboard";
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
  const version = await window.vumetoDesktop.getVersion();
}

// Open the app from a browser
await openDesktopApp("/dashboard");
```

### Server-side detection (Node/Express)

```js
app.use((req, res, next) => {
  res.locals.isDesktopApp =
    req.headers["x-app"] === "desktop" &&
    req.headers["user-agent"]?.startsWith("VumetoDesktop/");
  next();
});
```

---

## Startup Behavior

- The app registers itself to run at system login via `app.setLoginItemSettings`.
- At startup, it launches with `--startup` flag → **only the Express server starts** (no window).
- The user can open the app from the system tray.
- On Windows, if the user clicks `vumeto://` or the website's "Open App" button, the window appears.

---

## Proxy Usage

The Express server at `http://127.0.0.1:57331` exposes:

| Endpoint            | Purpose                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `GET /ping`         | App detection — returns `{ installed: true, version, platform }` |
| `GET /open?path=/x` | Open/focus the desktop window, optionally navigate               |
| `ANY /proxy/*`      | Transparent proxy to `https://vumeto.com`, CORS-bypassed         |

All proxied requests forward `Origin`, `Referer`, `Cookie`, `Authorization`, and other headers.
