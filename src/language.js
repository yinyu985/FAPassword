// Bundled for content scripts and the popup. The same catalogs also feed Chromium's manifest localization.
import en from '../_locales/en/messages.json' with { type: 'json' };
import zh from '../_locales/zh_CN/messages.json' with { type: 'json' };

export function createLanguage(api, changed = () => {}) {
  const normalize = value => value === 'en' || value === 'zh_CN' ? value : 'auto';
  let choice = 'auto', revision = 0;
  function apply(value) {
    const next = normalize(value);
    if (next === choice) return;
    choice = next;
    changed();
  }
  api.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.uiLanguage) { revision++; apply(changes.uiLanguage.newValue); }
  });
  const ready = (async () => {
    try { const data = await api.storage?.local?.get('uiLanguage'); if (!revision) apply(data?.uiLanguage); }
    catch { /* Use browser localization until a preference can be saved or read. */ }
  })();
  return {
    ready,
    get choice() { return choice; },
    get lang() { return choice === 'auto' ? (api.i18n?.getUILanguage?.() || 'en').replaceAll('_', '-') : choice.replace('_', '-'); },
    t(key, substitutions) {
      if (choice === 'auto') return api.i18n?.getMessage(key, substitutions) || key;
      const message = (choice === 'en' ? en : zh)[key];
      if (!message?.message) return key;
      const values = Array.isArray(substitutions) ? substitutions : [substitutions];
      return message.message.replace(/\$(\w+)\$/g, (_, name) => {
        const slot = message.placeholders?.[name.toLowerCase()]?.content;
        return values[Number(slot?.slice(1)) - 1] ?? '';
      });
    },
    async set(value) {
      const next = normalize(value), before = revision;
      await api.storage.local.set({ uiLanguage: next });
      if (before === revision) { revision++; apply(next); }
    },
  };
}
globalThis.FAPASSWORD_LANGUAGE = createLanguage;
