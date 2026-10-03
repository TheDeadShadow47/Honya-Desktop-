// Desktop plugin service: the only thing the UI (via IPC) uses for LNReader sources.
//   UI -> IPC -> PluginService -> PluginHost -> LNReader plugin
import { fetchRepository, fetchPluginCode } from '../core/plugins/repository.js';

export function createPluginService({ db, host }) {
  const record = async (pluginId) => {
    const r = await db.getPlugin(pluginId);
    if (!r) throw new Error(`Plugin "${pluginId}" is not installed`);
    return r;
  };
  const call = async (pluginId, method, args) => host.call(await record(pluginId), method, args);

  return {
    hostInfo: () => ({ isolation: host.isolation }),
    listInstalled: async () => (await db.getPlugins()).map(({ code, ...meta }) => meta),
    fetchRepository: (url) => fetchRepository(url),
    install: async (entry) => {
      const code = await fetchPluginCode(entry.codeUrl);
      await db.savePlugin({ ...entry, code });
      await host.unload(entry.id);
    },
    installFromCode: async (meta, code) => {
      await db.savePlugin({ ...meta, code });
      await host.unload(meta.id);
    },
    uninstall: async (id) => {
      await host.unload(id);
      await db.deletePlugin(id);
    },
    popular: (id, page = 1) => call(id, 'popular', [page]),
    latest: (id, page = 1) => call(id, 'latest', [page]),
    search: (id, query, page = 1) => call(id, 'search', [query, page]),
    novel: (id, path) => call(id, 'novel', [path]),
    chapter: (id, path) => call(id, 'chapter', [path]),
  };
}
