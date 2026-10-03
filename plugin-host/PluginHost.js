// Plugin host boundary. The rest of desktop talks to a PluginHost, never to plugin code directly.
//
// interface PluginHost {
//   isolation: 'none' | 'realm' | 'process'   // how strongly plugin code is isolated
//   load(record):   Promise<void>             // record = row from the `plugins` table
//   unload(id):     Promise<void>
//   call(record, method, args): Promise<any>  // method: popular | latest | search | novel | chapter
// }
//
// InProcessPluginHost reuses Honya's pluginEngine.js unchanged, so existing LNReader bundles behave as on
// mobile. SECURITY: it is NOT a sandbox. pluginEngine shadows a few globals but plugin code can still reach
// the real realm via constructor chains (verified in the Phase 0 audit). It runs in the Electron main
// process, so a hostile plugin could escape. The planned replacement is a QuickJS-WASM host with a bridged
// fetch; implement the same interface and swap it in createHost().
import dayjs from 'dayjs';
import localizedFormat from 'dayjs/plugin/localizedFormat.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import { loadPlugin, unloadPlugin, pluginApi } from '../core/plugins/pluginEngine.js';

// Compat shim: pluginEngine hands plugins a bare `dayjs`, but 100 of the 288 real bundles call format("LL"), which
// needs the localizedFormat plugin (a bare dayjs returns the literal "LL"). Extending the shared instance here fixes it
// for desktop without touching the engine. (Mobile has the same gap: see report.)
dayjs.extend(localizedFormat);
dayjs.extend(customParseFormat);

export class InProcessPluginHost {
  isolation = 'none';

  async load(record) {
    loadPlugin(record);
  }

  async unload(id) {
    unloadPlugin(id);
  }

  async call(record, method, args = []) {
    const fn = pluginApi[method];
    if (!fn) throw new Error(`Unknown plugin method "${method}"`);
    return fn(loadPlugin(record), ...args);
  }
}

export function createHost() {
  return new InProcessPluginHost();
}
