# Automatic updates

Honya Desktop updates itself from **GitHub Releases** of this repository
(`TheDeadShadow47/Honya-Desktop-`, taken from `package.json` → `repository` and `electron-builder.yml` → `publish`).

## How it works

| Build | Mechanism | What the user can do |
|---|---|---|
| **Installed** (NSIS installer) | [`electron-updater`](https://www.electron.build/auto-update) reads `latest.yml` from the latest GitHub release, downloads the installer and verifies its **sha512** | See version + release notes → **Download update** → **Install and restart** (or **Later**) |
| **Portable** (`Honya-Desktop-Portable-x.y.z.exe`) | GitHub Releases API (`/releases/latest`), *detect only* | See version + release notes → **Download from GitHub** (opens the portable file in the browser). The running executable is never replaced by the app |
| Development / test runs | disabled | Settings says why |

Behaviour:

- Checks once ~45 s after startup, then every 6 h, only while **Settings → App Update → Check for updates automatically** is on. A failed background check is silent; the manual button reports errors.
- Never downloads or installs without a click. `autoDownload`, `autoInstallOnAppQuit`, prereleases and downgrades are all off.
- A newer version shows a small notice (never over the reader), once per version per session. **Later** is remembered (`postponedUpdateVersion` in the existing preferences); a still-newer release notifies again. A downloaded-but-not-installed update stays available in Settings.
- One check/download at a time; no retry loops (a failed download offers **Retry**).
- Release notes are reduced to plain text and shown as text, never as HTML. Links opened by the updater are limited to this repository's `github.com/.../releases` pages.
- Errors are explained (offline, GitHub rate limit, no release, missing release files, failed integrity check, …) with a link to the Releases page where useful. The rest of the app keeps working.

## User data

The updater never deletes, moves or migrates user data, and adds no database changes. Data lives in `%APPDATA%\Honya Desktop\data\` (outside the install folder); the NSIS installer is per-user and has `deleteAppDataOnUninstall: false`. The only new stored values are two preferences: `autoCheckAppUpdates` (default `true`) and `postponedUpdateVersion`.

> If a future release changes the database schema, handle that separately (schema versioning + pre-migration backup). An update replaces program files only.

## Publishing a release (maintainer checklist)

1. Bump `version` in `package.json` (e.g. `0.2.0`). Release tag **must be `v` + that version** (`v0.2.0`).
2. On Windows: `npm run dist` (runs `electron-builder --win --publish never`; nothing is uploaded by the build).
3. In `release/` you get, among others:
   - `Honya-Desktop-Setup-<version>.exe`
   - `Honya-Desktop-Setup-<version>.exe.blockmap`
   - `latest.yml`
   - `Honya-Desktop-Portable-<version>.exe`
4. Create a **published, non-prerelease** GitHub release for tag `v<version>` and attach **all four files** (do not rename them: `latest.yml` refers to the installer by name). Write the release notes in the release description; they are what users see in the update dialog.
5. Do **not** publish as *Draft* or *Pre-release*: neither is ever offered to users.

Without `latest.yml` + installer in the release, installed copies report "missing update files" and link to the Releases page; without the portable `.exe`, portable copies report that the download file is missing.

## Important limitations

- **Bootstrap:** copies of v0.1.0 have no updater. The first updater-enabled version must be installed manually once; every later version can be offered automatically.
- **Unsigned builds:** downloads are verified against the sha512 in `latest.yml`, which protects against corruption but is published in the same release, so it is not a substitute for code signing. SmartScreen will still warn on first install. If you sign later, set the publisher name in `electron-builder.yml` so electron-updater also verifies the signature.
- Windows only (the only configured target). Other platforms get the detect-and-link behaviour.
- Never change `appId` (`app.honya.desktop`) or the NSIS GUID inputs: in-place upgrades depend on them.
- The installer path uses `github.com` release downloads (no API quota). The portable path uses the GitHub API: 60 unauthenticated requests/hour per IP, far above one check per 6 h; rate limits are reported gracefully.

## Testing

```bash
npm run test:app-update      # unit/config tests: state machine, GitHub + electron-updater backends, helpers, release config (no network)
npm run test:app-update-ui   # real Electron + local fake GitHub API: notice, notes, Later (persisted), up-to-date, rate limit,
                             # offline, missing asset, dev mode, and the installer flow (progress, failed download, retry, install)
```

The two smoke-mode-only environment hooks (`HONYA_UPDATE_TEST_API`, `HONYA_UPDATE_TEST_AUTO`) exist solely for these tests; they do nothing outside `HONYA_SMOKE=1` runs.

**Real-world test on Windows** (not covered by the automated tests): install a build with version `0.2.0`, publish a release `v0.2.1` following the checklist above, start the installed app, open **Settings → App Update** and run the full download → install → restart flow; confirm library, settings and downloads are intact. Repeat with the portable `.exe` to confirm the notice, notes and download link.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "The release is missing its update files" | `latest.yml` / installer not attached to the release, or release is a draft/prerelease |
| "No update" although a newer release exists | tag is not `v<version>` of the uploaded build, or the release is a prerelease |
| Integrity check failed | installer re-uploaded/renamed after `latest.yml` was generated; rebuild and re-upload all files together |
| "GitHub is limiting requests" (portable) | many users behind one IP; it resolves itself, or use the Releases page |
