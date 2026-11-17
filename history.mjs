export function cleanTitle(title) {
  return title.replace(/\s+(?:смотреть\s+онлайн|смотреть\s+все|в\s+озвучке|\d+\s+сезон).*$/iu, '')
    .replace(/\s*[-–|]\s*(?:HDRezka|Rezka).*$/iu, '').trim();
}

export const providers = { hdrezka: { name: 'HDRezka', features: ['Карточки', 'Постеры', 'Озвучки', 'Прогресс', 'Импорт «Досмотреть»', 'Сохранение в аккаунт'], origins: ['https://hdrezka-home.tv', 'https://rezka.ag', 'https://www.rezka.ag', 'https://hdrezka.mn', 'https://rezka.si'] } };
export const origins = new Set(providers.hdrezka.origins);
export function providerFor(url) {
  if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) return 'hdrezka';
  return Object.entries(providers).find(([, provider]) => provider.origins.includes(new URL(url).origin))?.[0] || null;
}
export function canSaveToAccount(entry) {
  return !entry.accountOnly && entry.season > 0 && entry.time > 0 && entry.duration > 0 && providerFor(entry.url) === 'hdrezka';
}

export function latestTitles(entries) {
  const latest = new Map();
  for (const entry of entries) {
    const id = entry.id || Number(entry.key.split(':')[1]);
    if (!latest.has(id) || latest.get(id).updatedAt < entry.updatedAt) latest.set(id, entry);
  }
  return [...latest.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function pendingTitles(entries, origin) {
  if (!origins.has(origin)) return [];
  return latestTitles(entries.filter(entry => providerFor(entry.url) === 'hdrezka'))
    .filter(entry => ['guest', 'import', 'cloud'].includes(entry.source) && entry.sync?.state !== 'saved')
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

export function mergeBackup(backup, stored, source = 'import') {
  if (backup.format !== 'rezka-progress' || backup.version !== 1 || !Array.isArray(backup.entries)) throw Error('Неподдерживаемый формат копии.');
  const updates = {};
  for (const entry of backup.entries) {
    const match = typeof entry.key === 'string' && entry.key.match(/^progress:(\d+):(\d+):(\d+):(\d+)$/);
    const url = new URL(entry.url, providers.hdrezka.origins[0]);
    if (!match || !origins.has(url.origin) || !Number.isFinite(entry.time) || entry.time < 0
      || !Number.isFinite(entry.duration) || entry.duration <= 0 || !Number.isFinite(entry.updatedAt)
      || typeof entry.title !== 'string') throw Error('Некорректная запись. Импорт отменён.');
    const previous = updates[entry.key] || stored[entry.key];
    if (previous && previous.updatedAt >= entry.updatedAt) continue;
    updates[entry.key] = {
      key: entry.key, id: Number(match[1]), translator: Number(match[2]), season: Number(match[3]), episode: Number(match[4]),
      title: entry.title, url: url.href, time: entry.time, duration: entry.duration,
      updatedAt: entry.updatedAt, completed: entry.completed === true,
      availableEpisodes: Array.isArray(entry.availableEpisodes) ? entry.availableEpisodes.filter(value => typeof value === 'string' && /^\d+:\d+$/.test(value)) : [],
      translatorName: typeof entry.translatorName === 'string' ? entry.translatorName : null,
      posterUrl: typeof entry.posterUrl === 'string' ? entry.posterUrl : null,
      year: typeof entry.year === 'string' ? entry.year : null,
      projectCompleted: typeof entry.projectCompleted === 'boolean' ? entry.projectCompleted : null,
      seasonEpisodeCount: Number.isInteger(entry.seasonEpisodeCount) ? entry.seasonEpisodeCount : null,
      remainingEpisodes: Number.isInteger(entry.remainingEpisodes) ? entry.remainingEpisodes : null,
      source, sync: { state: 'pending', message: 'Восстановлено локально; отправка в аккаунт — по кнопке' }
    };
  }
  return updates;
}

export function viewDate(timestamp, now = new Date()) {
  const date = new Date(timestamp);
  if (date.toDateString() === now.toDateString()) return 'Сегодня';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Вчера';
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

export function remainingLabel(entry) {
  if (!entry.season || !Number.isInteger(entry.remainingEpisodes)) return '';
  if (entry.remainingEpisodes <= 0) return '';
  const word = { one: 'серию', few: 'серии', many: 'серий', other: 'серии' }[new Intl.PluralRules('ru').select(entry.remainingEpisodes)];
  return `Смотреть ещё ${entry.remainingEpisodes} ${word} в ${entry.season} сезоне`;
}

// Account metadata enriches a title; playback identity always comes from local progress.
export function catalogTitles(stored, current = null) {
  const catalog = new Map((stored.accountHistory?.entries || []).map(entry => [entry.id, { ...entry, accountOnly: true, imported: true }]));
  for (const [key, page] of Object.entries(stored)) {
    if (!key.startsWith('page:')) continue;
    const account = catalog.get(page.id);
    if (account) {
      const voices = page.translators?.filter(voice => voice.name === account.translatorName) || [];
      const translator = account.translatorName ? voices.length === 1 ? voices[0].id : page.translatorName === account.translatorName ? page.translator : null : null;
      let url = account.url;
      if (translator && account.season && Number.isInteger(account.episode)) {
        const target = new URL(url, providers.hdrezka.origins[0]);
        target.hash = `t:${translator}-s:${account.season}-e:${account.episode}`;
        url = target.href;
      }
      catalog.set(page.id, { ...page, ...account, url, translator: translator || account.translator, localPage: true });
    } else catalog.set(page.id, { ...page, accountOnly: true, localPage: true });
  }
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith('library:') && value.entry && !catalog.has(value.entry.id)) catalog.set(value.entry.id, { ...value.entry, accountOnly: true, localPage: true });
  }
  const local = latestTitles(Object.entries(stored).filter(([key]) => key.startsWith('progress:')).map(([, entry]) => entry));
  for (const entry of local) {
    const account = catalog.get(entry.id);
    const sameVoice = !entry.translatorName || !account?.translatorName || entry.translatorName === account.translatorName;
    const sameEpisode = sameVoice && account?.season === entry.season && account?.episode === entry.episode;
    const episodes = entry.availableEpisodes;
    const remaining = episodes?.length ? episodes.filter(key => {
      const [season, episode] = key.split(':').map(Number);
      return season === entry.season && episode > entry.episode;
    }).length : entry.remainingEpisodes ?? (sameEpisode ? account.remainingEpisodes : null);
    catalog.set(entry.id, {
      ...account, ...entry, accountOnly: false, localPage: true,
      title: account?.title || entry.title,
      posterUrl: account?.posterUrl || entry.posterUrl,
      year: entry.year || account?.year,
      projectCompleted: entry.projectCompleted ?? account?.projectCompleted,
      translatorName: entry.translatorName || account?.translatorName,
      remainingEpisodes: remaining,
      next: sameEpisode ? account.next : null,
      nextUrl: sameEpisode ? account.nextUrl : null,
      ...stored[`details:${entry.id}:${entry.translator}`]
    });
  }
  if (current && !catalog.has(current.id)) catalog.set(current.id, { ...current, accountOnly: true, localPage: true });
  return [...catalog.values()].map(entry => ({ ...entry, posterUrl: stored[`poster:${entry.id}`] || entry.posterUrl || (current?.id === entry.id ? current.posterUrl : null), provider: providerFor(entry.url), libraryState: stored[`library:${entry.id}`]?.state || 'active', favorite: stored[`library:${entry.id}`]?.favorite === true, current: entry.id === current?.id }))
    .sort((a, b) => Number(b.current) - Number(a.current) || (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function titleSearchScore(title, query) {
  const normalize = value => value.toLocaleLowerCase().replaceAll('ё', 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const text = normalize(title);
  const search = normalize(query);
  if (!search) return 0;
  if (text.includes(search)) return text === search ? 0 : 1;
  const words = text.split(' ');
  let score = 2;
  for (const token of search.split(' ')) {
    if (words.some(word => word.startsWith(token))) continue;
    const tolerance = token.length < 4 ? 0 : token.length < 6 ? 1 : 2;
    let best = Infinity;
    for (const word of words) {
      let previous = Array.from({ length: word.length + 1 }, (_, i) => i);
      for (let i = 1; i <= token.length; i++) {
        const row = [i];
        for (let j = 1; j <= word.length; j++) row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(token[i - 1] !== word[j - 1]));
        previous = row;
      }
      best = Math.min(best, previous[word.length]);
    }
    if (best <= tolerance) { score += best; continue; }
    let index = 0;
    for (const char of text.replaceAll(' ', '')) if (char === token[index]) index++;
    if (token.length >= 3 && index === token.length) score += 5;
    else return Infinity;
  }
  return score;
}


export function catalogViewEntries(catalog, view, query = '') {
  let entries = catalog.filter(entry => view === 'favorites' ? entry.favorite && entry.libraryState === 'active'
    : entry.libraryState === (view === 'all' || view === 'recent' ? 'active' : view));
  if (view === 'recent') {
    entries = entries.map(entry => {
      const date = entry.dateLabel?.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      const accountDate = date ? new Date(Number(date[3]), Number(date[2]) - 1, Number(date[1])).getTime() : 0;
      return { ...entry, watchedAt: Math.max(entry.updatedAt || 0, accountDate) };
    }).filter(entry => entry.watchedAt > 0)
      .sort((a, b) => b.watchedAt - a.watchedAt).slice(0, 10);
  }
  return entries.map(entry => ({ ...entry, searchScore: titleSearchScore(entry.title, query) }))
    .filter(entry => Number.isFinite(entry.searchScore))
    .sort((a, b) => Number(b.current) - Number(a.current) || a.searchScore - b.searchScore);
}

export function restoreAppBackup(backup) {
  if (backup?.format !== 'rezka-progress' || backup.version !== 2 || !backup.state || typeof backup.state !== 'object' || Array.isArray(backup.state)) throw Error('Неподдерживаемый формат полной копии.');
  const state = structuredClone(backup.state);
  if (!['auto', 'light', 'dark'].includes(state.theme)) throw Error('Некорректная тема в копии.');
  const progress = [];
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith('progress:')) {
      if (!value || value.key !== key) throw Error('Некорректный прогресс в копии.');
      progress.push(value);
    } else if (/^(page|details|library):/.test(key) && (!value || typeof value !== 'object' || Array.isArray(value))) throw Error('Некорректная карточка в копии.');
  }
  mergeBackup({ format: 'rezka-progress', version: 1, entries: progress }, {});
  if (state.accountHistory) {
    if (!Array.isArray(state.accountHistory.entries)) throw Error('Некорректная история аккаунта в копии.');
    // A saved file cannot resume the old browser page's import job.
    state.accountHistory.importId = null;
    if (state.accountHistory.links?.state === 'running') state.accountHistory.links.state = 'stopped';
  }
  return state;
}


export function titlePath(url) {
  if (providerFor(url) !== 'hdrezka') return url;
  const parsed = new URL(url, providers.hdrezka.origins[0]);
  return parsed.pathname + parsed.search + parsed.hash;
}

export function titleUrl(url, stored, currentUrl) {
  const provider = providerFor(url);
  if (!provider) return url;
  const config = stored[`provider:${provider}`] || {};
  const current = currentUrl && providerFor(currentUrl) === provider ? new URL(currentUrl).origin : null;
  const origin = providers[provider].origins.includes(config.mirror) ? config.mirror
    : current || (providers[provider].origins.includes(config.lastOrigin) ? config.lastOrigin : providers[provider].origins[0]);
  return new URL(titlePath(url), origin).href;
}

export function normalizeTitleUrls(state) {
  const result = structuredClone(state);
  const normalize = entry => {
    if (entry?.url) entry.url = titlePath(entry.url);
    if (entry?.nextUrl) entry.nextUrl = titlePath(entry.nextUrl);
  };
  for (const [key, value] of Object.entries(result)) {
    if (key.startsWith('progress:') || key.startsWith('page:')) normalize(value);
    if (key.startsWith('library:')) normalize(value.entry);
  }
  for (const entry of result.accountHistory?.entries || []) normalize(entry);
  return result;
}
