<div align="center">

<img src="assets/icon.png" alt="Honya Desktop Logo" width="140">

# Honya Desktop

### An Offline-First Web Novel Reader for Windows

A standalone, offline-first desktop novel reader built with **Electron, React, and Vite**, featuring an LNReader-compatible plugin system, a persistent download queue, and full offline reading support. Fetch, browse, and read content from any supported source — all from a native Windows app.

![Electron](https://img.shields.io/badge/Electron-2B2E3A?style=for-the-badge&logo=electron&logoColor=9FEAF9)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-07405E?style=for-the-badge&logo=sqlite&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-ED8DB0?style=for-the-badge)

[![Download](https://img.shields.io/badge/Download-Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/TheDeadShadow47/Honya-Desktop/releases)

</div>

---

## 📖 Overview

Honya Desktop brings novel reading to your Windows PC as a clean, self-contained application. Content comes from LNReader-compatible plugins, so you decide which sources to use, and anything you download stays available offline.

Under the hood, Honya Desktop pairs an Electron shell with a React + Vite interface, a SQLite database for library and progress storage, and an LNReader-compatible plugin engine for fetching and reading content.

---

## ✨ Features

- 📥 **Offline-first reading** — download chapters and read them without a connection
- 📚 **Library management** — track reading progress, recently read novels, and unread chapters
- 📜 **Continuous scrolling reader** — smooth vertical reading with per-chapter progress tracking
- ✅ **Chapter management** — bulk selection, range selection, mark read/unread, and download controls
- 🔄 **Library updates** — check installed novels for new chapters
- ⬇️ **Download queue** — persistent download management with pause / resume and retry support
- 🎨 **Themes** — multiple themes to suit your setup
- 🌍 **Localization** — English, العربية, Français, Deutsch, and Italiano
- ↔️ **RTL language support** — proper layout for right-to-left languages
- 🎮 **Discord Rich Presence** — optional integration to show your reading activity on Discord
- 💾 **Backup & restore** — export and import your library, reading progress, and settings
- ⚙️ **LNReader-compatible plugins** — an extensible source system built on compatible LNReader plugins

---

## 🛠 Tech Stack

| Layer | Choice |
|---|---|
| Shell | Electron |
| UI | React + Vite |
| Database | SQLite (`honya.db`) |
| Plugin engine | LNReader-compatible plugins |
| Platform | Windows |

---

## 💻 System Requirements

- [Node.js](https://nodejs.org/) 20.19+ (22.x recommended)
- npm

---

## 🚀 Getting Started

Install dependencies

```bash
npm install
```

Run in development mode

```bash
npm run dev
```

---

## 🏗 Building & Running

Build for production

```bash
npm run build
```

Build and launch the production build

```bash
npm start
```

---

## 📦 Packaging for Windows

Build on Windows to create distributables:

```bash
npm run dist              # Installer (.exe) and portable version
npm run dist:installer    # NSIS installer only
npm run dist:portable     # Portable executable only
npm run pack              # Unpacked version for testing
```

Built packages are written to the `release/` directory.

> **Note:** The installers are unsigned, so Windows SmartScreen may show a warning on first run. Select **More info → Run anyway** to continue.

---

## 🧪 Development

| Area | Command |
|---|---|
| Core (database, plugins, backup/restore, persistence) | `npm run test:smoke` |
| Plugin compatibility | `npm run test:compat` · `npm run test:plugins` |
| Reader | `npm run test:reader-logic` · `npm run test:reader` |
| UI | `npm run test:ui` |
| Internationalization audit | `npm run test:i18n` |
| Discord integration | `npm run test:discord` |
| Everything | `npm test` |

---

## 💾 Storage & Data

User data is stored separately from the installation location and is **never deleted** when updating or uninstalling the application.

- **Location** — `%APPDATA%\Honya Desktop\data\`
- **SQLite database** — `honya.db`
- **Plugins** — installed plugins are kept alongside your data
- **Downloads** — downloaded chapters are stored for offline reading
- **Settings** — user preferences persist between sessions

Legacy data from older builds (`%APPDATA%\honya-desktop\data\`) is automatically migrated on first launch if present.

---

## 🧩 Plugins

Honya Desktop uses the LNReader-compatible plugin system for source functionality. Compatible plugins let the app browse, search, and fetch content from supported novel sources.

For more information about the plugin ecosystem, see the [LNReader project](https://github.com/LNReader/lnreader).

---

## 🎮 Discord Rich Presence

Discord Rich Presence is an **optional** feature that displays your reading activity on Discord when enabled in **Settings**.

- Can show your current novel, chapter, and reading time while in the reader
- **Disabled by default**
- Remains inert if no Discord application is configured
- No personal data beyond the minimal display information is shared

---

## 📄 License

This project is available under the **MIT License**. See [LICENSE.txt](LICENSE.txt) for details.

---

## 🙏 Credits

### Honya

Some components are vendored from Honya (© 2026 TheDeadShadow47). See [core/README.md](core/README.md) for attribution details.

### LNReader

Honya Desktop supports the **LNReader-compatible plugin ecosystem**. We gratefully acknowledge the [LNReader](https://github.com/LNReader/lnreader) project and its contributors for the plugin architecture that makes community-maintained sources possible.

---

<div align="center">

### 📖 "Every story deserves a good reader."

Built with ❤️ for offline-first reading.

</div>