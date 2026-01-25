# Vumeto Desktop

The official desktop application for Vumeto - an anime streaming platform that aggregates content from various sources.

## About

Vumeto is an anime scraping site that collects and displays anime content from multiple sources. This desktop app wraps the Vumeto web experience using Electron's `loadURL` to provide enhanced features not possible in a web browser.

## Features

- **Fast Proxy** - Built-in proxy support for faster and more reliable content access
- **Video Download** - Download anime episodes directly to your device (not available on web)
- **System Tray** - Runs in the background with quick access from system tray
- **Single Instance** - Prevents multiple instances from running simultaneously
- **Custom Protocol** - Supports `vumeto-desktop://` protocol for deep linking

## Installation

### Prerequisites

- Node.js (v18 or higher recommended)
- npm or yarn

### Setup

1. Clone the repository
2. Install dependencies:

```bash
bun install
```

3. Run the application:

```bash
bun start
```

## Development

The app uses Electron and loads the Vumeto website at `https://vumeto.samy0f.com`.

### Project Structure

```
vumeto/
├── main.js          # Main Electron process
├── preload.js       # Preload script for IPC
├── package.json     # Project configuration
└── assets/          # App icons and resources
```

## License

GPL-3.0
