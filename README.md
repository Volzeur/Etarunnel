# Etarunnel

Etarunnel is an Electron-based desktop client for YouTube and YouTube Music. It provides a dedicated window for both services with built-in ad-blocking, custom font injection, and external link routing.

## Features

YouTube with extended feature such as:
- **Ad Blocking:** Intercepts network requests and API responses to block video and banner ads.
- **Dual Services:** Supports switching between YouTube and YouTube Music instances.

## Keyboard Shortcuts

| Action | Shortcut |
| :--- | :--- |
| Go Back | `Alt` + `←` |
| Go Forward | `Alt` + `→` |
| Reload | `Ctrl/Cmd` + `R` |
| Switch to YouTube | `Ctrl/Cmd` + `1` |
| Switch to YT Music | `Ctrl/Cmd` + `2` |
| Zoom In | `Ctrl/Cmd` + `+` |
| Zoom Out | `Ctrl/Cmd` + `-` |
| Reset Zoom | `Ctrl/Cmd` + `0` |

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS recommended)
- npm

### Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/Volzeur/Etarunnel.git
   cd Etarunnel
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Run the application in development mode:

   ```bash
   npm start
   ```

## Building

The application uses `electron-builder` for packaging.

- Build for the current operating system:

  ```bash
  npm run dist
  ```

- Platform-specific builds:

  ```bash
  npm run dist:win    # Windows
  npm run dist:mac    # macOS
  npm run dist:linux  # Linux
  ```

## Tech Stack

- **Framework:** Electron (v37)
- **Languages:** JavaScript, HTML, CSS
- **Build Tool:** electron-builder

## Author

**Nicodemus Gurning (Volzeur)**

- GitHub: [@Volzeur](https://github.com/Volzeur)

---

*Disclaimer: Etarunnel is an unofficial, open-source project and is not affiliated with, endorsed by, or sponsored by YouTube or Google Inc.*
