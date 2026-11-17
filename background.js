import { origins, pendingTitles, mergeBackup, canSaveToAccount, restoreAppBackup, titlePath, normalizeTitleUrls } from './history.mjs';

let progressQueue = Promise.resolve();

async function profileFor(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.incognito || !tab.url || !origins.has(new URL(tab.url).origin)) throw Error('Выбери обычную вкладку сайта с аккаунтом.');
  let status;
  try { status = await chrome.tabs.sendMessage(tabId, { type: 'rezka:profile-status' }); }
  catch { throw Error('Обнови вкладку сайта после обновления расширения.'); }
  if (!status?.loggedIn) throw Error('Сначала войди в нужный аккаунт сайта.');
  return { tabId, origin: status.origin, bridgeId: status.bridgeId };
}

async function handle(message, sender) {
  const page = sender.tab && sender.frameId === 0 && origins.has(new URL(sender.url).origin);
  const popup = sender.url === chrome.runtime.getURL('popup.html');
  if (!page && !popup) throw Error('Команда доступна только в расширении или на поддерживаемом сайте.');
  const tabId = sender.tab?.id ?? message.tabId;
  if (message.type === 'rezka:mirror-seen') {
    if (!page) throw Error('Зеркало определяется со страницы сайта.');
    const key = 'provider:hdrezka';
    const previous = (await chrome.storage.local.get(key))[key] || {};
    const lastOrigin = new URL(sender.url).origin;
    if (previous.lastOrigin !== lastOrigin) await chrome.storage.local.set({ [key]: { ...previous, lastOrigin } });
    return { ok: true };
  }
  if (message.type === 'rezka:normalize-urls') {
    if (!popup) throw Error('Обновление каталога доступно в расширении.');
    const stored = await chrome.storage.local.get(null);
    const normalized = normalizeTitleUrls(stored);
    const updates = Object.fromEntries(Object.entries(normalized).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(stored[key])));
    if (Object.keys(updates).length) await chrome.storage.local.set(updates);
    return { ok: true };
  }
  if (message.type === 'rezka:save-page') {
    const route = page && new URL(sender.url).pathname.match(/^\/(?:series|films)\/[^/]+\/(\d+)-/);
    if (!route || Number(route[1]) !== message.entry?.id) throw Error('Карточка доступна только со страницы произведения.');
    const { id, title, year, posterUrl, translator, translatorName, translators, url } = message.entry;
    const entry = { id, title, year, posterUrl, translator, translatorName, translators, url: titlePath(url) };
    await chrome.storage.local.set({ [`page:${id}`]: entry, ...(posterUrl ? { [`poster:${id}`]: posterUrl } : {}) });
    return { ok: true };
  }
  if (message.type === 'rezka:save-poster') {
    const route = page && new URL(sender.url).pathname.match(/^\/(?:series|films)\/[^/]+\/(\d+)-/);
    if (!route || typeof message.posterUrl !== 'string' || new URL(message.posterUrl).protocol !== 'https:') throw Error('Постер доступен только со страницы произведения.');
    const key = `poster:${Number(route[1])}`;
    const previous = (await chrome.storage.local.get(key))[key];
    if (previous !== message.posterUrl) await chrome.storage.local.set({ [key]: message.posterUrl });
    return { ok: true };
  }
  if (message.type === 'rezka:save-progress') {
    if (!page) throw Error('Запись доступна со страницы видео.');
    const { entry } = message;
    if (!Number.isFinite(entry.duration) || entry.duration <= 0 || !Number.isFinite(entry.time) || entry.time < 0) throw Error('Время видео ещё не загружено.');
    const key = `progress:${entry.id}:${entry.translator}:${entry.season}:${entry.episode}`;
    const posterKey = `poster:${entry.id}`;
    const poster = (await chrome.storage.local.get(posterKey))[posterKey] || entry.posterUrl || null;
    const record = {
      ...entry, url: titlePath(entry.url), posterUrl: poster, key, source: message.loggedIn ? 'local' : 'guest',
      sync: { state: message.loggedIn ? 'local' : 'pending', message: message.loggedIn ? 'Сохранено локально' : 'Сохранено локально. После входа можно отправить в аккаунт.' }
    };
    await chrome.storage.local.set({ [key]: record, ...(poster ? { [posterKey]: poster } : {}) });
    return { ok: true, sync: record.sync };
  }
  if (message.type === 'rezka:delete-account-history') {
    if (!popup) throw Error('Удаление импорта доступно в настройках расширения.');
    await chrome.storage.local.remove(['accountHistory']);
    return { ok: true };
  }
  const stored = await chrome.storage.local.get(null);
  const entries = Object.entries(stored).filter(([key]) => key.startsWith('progress:')).map(([, value]) => value);
  if (message.type === 'rezka:trash') {
    if (!popup) throw Error('Корзина доступна в расширении.');
    const key = `library:${message.entry.id}`;
    const previous = stored[key] || {};
    await chrome.storage.local.set(normalizeTitleUrls({ [key]: { ...previous, entry: message.entry, state: 'trash', previousState: previous.state === 'trash' ? previous.previousState : previous.state || 'active' } }));
    return { ok: true };
  }
  if (message.type === 'rezka:restore-trash') {
    if (!popup) throw Error('Корзина доступна в расширении.');
    const updates = {};
    for (const id of message.ids) {
      const key = `library:${id}`;
      const previous = stored[key];
      if (previous?.state === 'trash') updates[key] = { ...previous, state: previous.previousState || 'active' };
    }
    await chrome.storage.local.set(updates);
    return { ok: true };
  }
  if (message.type === 'rezka:delete') {
    if (!popup) throw Error('Редактирование доступно в окне расширения.');
    const keys = Object.entries(stored).filter(([key, value]) =>
      key.startsWith('progress:') && value.id === message.id || key.startsWith(`details:${message.id}:`) || key.startsWith(`releases:${message.id}:`) || key === `poster:${message.id}`
    ).map(([key]) => key);
    await chrome.storage.local.remove(keys);
    return { ok: true };
  }
  if (message.type === 'rezka:edit') {
    if (!popup) throw Error('Редактирование доступно в окне расширения.');
    const entry = stored[message.key];
    if (!entry) throw Error('Запись уже удалена.');
    const { title, translatorName, projectCompleted, season, episode, time } = message;
    if (!title || !Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 0
      || !Number.isFinite(time) || time < 0 || time > entry.duration) throw Error('Проверь название, серию и время просмотра.');
    const key = `progress:${entry.id}:${entry.translator}:${season}:${episode}`;
    const url = new URL(entry.url, 'https://hdrezka-home.tv');
    if (season) url.hash = `t:${entry.translator}-s:${season}-e:${episode}`;
    const remainingEpisodes = entry.availableEpisodes?.length ? entry.availableEpisodes.filter(value => {
      const [s, e] = value.split(':').map(Number);
      return s === season && e > episode;
    }).length : season === entry.season ? entry.remainingEpisodes : null;
    await chrome.storage.local.set({
      [`details:${entry.id}:${entry.translator}`]: { title, translatorName, projectCompleted },
      [key]: { ...entry, key, title, translatorName, projectCompleted, season, episode, time,
        remainingEpisodes, url: titlePath(url.href), completed: time >= entry.duration,
        source: 'import', sync: { state: 'pending', message: 'Изменено локально' } }
    });
    if (key !== entry.key) await chrome.storage.local.remove([entry.key]);
    return { ok: true };
  }
  if (message.type === 'rezka:pending') return { ok: true, count: pendingTitles(entries, new URL(sender.url).origin).length };
  if (message.type === 'rezka:sync-pending' || message.type === 'rezka:sync-entry') {
    const selected = message.type === 'rezka:sync-entry' ? stored[message.key] : null;
    if (message.type === 'rezka:sync-entry' && (!popup || !selected || !canSaveToAccount(selected))) throw Error('Сохранение доступно только для просмотренного сериала HDRezka.');
    const profile = await profileFor(tabId);
    const pending = selected ? [selected] : pendingTitles(entries, profile.origin);
    let saved = 0;
    const errors = [];
    for (const entry of pending) {
      const record = { ...entry, sync: { state: 'pending', message: 'Отправляется в аккаунт' } };
      let blocked = false;
      try {
        const response = await chrome.tabs.sendMessage(profile.tabId, { type: 'rezka:profile-save', bridgeId: profile.bridgeId, entry });
        blocked = response?.status === 403 || response?.status === 429;
        if (!response?.ok) throw Error(response?.error || 'Сайт не подтвердил сохранение.');
        record.sync = { state: 'saved', message: 'Сохранено в аккаунте', savedAt: Date.now() };
        saved++;
      } catch (error) {
        record.sync = { state: 'error', message: error.message };
        errors.push(`${entry.title}: ${error.message}`);
      }
      await chrome.storage.local.set({ [record.key]: record });
      if (blocked) break;
    }
    return { ok: true, saved, failed: pending.length - saved, errors };
  }
  if (message.type === 'rezka:import') {
    if (!popup) throw Error('Импорт доступен только в настройках расширения.');
    if (message.backup?.version === 2) {
      const restored = normalizeTitleUrls(restoreAppBackup(message.backup));
      await chrome.storage.local.set(restored);
      const removed = Object.keys(stored).filter(key => !Object.hasOwn(restored, key));
      if (removed.length) await chrome.storage.local.remove(removed);
      return { ok: true, restored: true };
    }
    const updates = normalizeTitleUrls(mergeBackup(message.backup, stored));
    await chrome.storage.local.set(updates);
    return { ok: true, imported: Object.keys(updates).length };
  }
  throw Error('Неизвестная команда расширения.');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !message.type?.startsWith('rezka:')) return;
  const task = progressQueue.then(() => handle(message, sender));
  progressQueue = task.catch(() => {});
  task.then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});

