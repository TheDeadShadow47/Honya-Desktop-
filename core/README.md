# core/ - code vendored from Honya mobile

These files are **unmodified copies** from https://github.com/TheDeadShadow47/Honya (commit `4043045`, v1.4.2, MIT).
They are copied (not referenced) so this project runs on its own. Keeping them byte-identical makes it easy to diff
against mobile and pull in upstream fixes.

| here | mobile path | notes |
|---|---|---|
| `db/database.js` | `db/database.js` | schema + queries; `expo-sqlite` is resolved to `../../shims/expo-sqlite.js` at build time |
| `plugins/pluginEngine.js` | `lib/pluginEngine.js` | LNReader plugin loader + shims (`require` table) |
| `plugins/repository.js` | `lib/repository.js` | plugin repository fetch/normalize |
| `text/clean.js` | `lib/clean.js` | chapter HTML -> text |
| `i18n/i18n.js`, `i18n/locales/*` | `lib/i18n.js`, `lib/locales/*` | strings; `react-native` is aliased to `src/shims/react-native.js` |
| `theme/theme.js` | `theme/theme.js` | theme tokens |

Desktop-only fixes live OUTSIDE this folder (e.g. the `dayjs` localizedFormat shim in `plugin-host/PluginHost.js`),
so these copies stay pristine.
