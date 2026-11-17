import './parser.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { origins, latestTitles, pendingTitles, mergeBackup, viewDate, remainingLabel, canSaveToAccount, restoreAppBackup, titlePath, normalizeTitleUrls } from './history.mjs';

const entry = (overrides = {}) => ({
  key: 'progress:14068:110:15:39', id: 14068, translator: 110, season: 15, episode: 39,
  title: 'Солдаты', time: 120, duration: 2880.117, updatedAt: 100000,
  url: 'https://hdrezka-home.tv/series/drama/14068-soldaty-2004-latest.html#t:110-s:15-e:39',
  source: 'guest', sync: { state: 'pending' }, remainingEpisodes: 44, ...overrides
});
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');

function app(origin = 'https://hdrezka-home.tv') {
  const local = {}, remote = {}, requests = [];
  let listener, changed, logged = false, success = true, cloudWrites = 0;
  const area = (data, cloud = false) => ({
    async get(keys) { return keys === null ? structuredClone(data) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])); },
    async set(values) { Object.assign(data, structuredClone(values)); if (cloud) cloudWrites++; },
    async remove(keys) { for (const key of keys) delete data[key]; }
  });
  const chrome = {
    runtime: { id: 'extension', getURL: path => `chrome-extension://extension/${path}`, onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: area(local), sync: area(remote, true), onChanged: { addListener(fn) { changed = fn; } } },
    tabs: {
      async get() { return { id: 1, url: `${origin}/continue/`, incognito: false }; },
      async sendMessage(id, message) {
        if (message.type === 'rezka:profile-status') return { loggedIn: logged, origin, bridgeId: 'page' };
        requests.push(structuredClone(message));
        return { ok: success && logged, error: 'Сервер отклонил запись' };
      }
    }
  };
  runInNewContext(read('background.js').replace(/^import[^\n]+\n/, ''), {
    chrome, URL, Date, origins, latestTitles, pendingTitles, mergeBackup, canSaveToAccount, restoreAppBackup, structuredClone, titlePath, normalizeTitleUrls
  });
  const popup = { id: 'extension', url: chrome.runtime.getURL('popup.html') };
  const page = { id: 'extension', frameId: 0, url: 'https://hdrezka-home.tv/series/drama/14068-soldaty.html', tab: { id: 1 } };
  const send = (message, sender = popup) => new Promise(resolve => listener(message, sender, resolve));
  return {
    local, remote, requests, send, page, cloudWrites: () => cloudWrites,
    logged(value) { logged = value; }, accept(value) { success = value; },
    progress(value = entry(), loggedIn = false) { return send({ type: 'rezka:save-progress', entry: value, loggedIn, force: true }, page); },
    receive(changes) { changed(changes, 'sync'); }
  };
}

test('guest viewing in an ordinary tab stores locally; login alone sends nothing', async () => {
  const state = app();
  assert.equal((await state.progress()).sync.state, 'pending');
  assert.equal(state.local[entry().key].time, 120);
  state.logged(true);
  assert.equal((await state.send({ type: 'rezka:pending' }, state.page)).count, 1);
  assert.equal(state.requests.length, 0);
  assert.equal(state.cloudWrites(), 0);
});

test('explicit upload sends only the latest watched episode of each title', async () => {
  const state = app();
  await state.progress(entry({ updatedAt: 200, episode: 39 }));
  await state.progress(entry({ updatedAt: 100, episode: 40 }));
  state.logged(true);
  const result = await state.send({ type: 'rezka:sync-pending', tabId: 1 });
  assert.equal(result.saved, 1);
  assert.equal(state.requests[0].entry.episode, 39, 'highest episode number does not imply newest viewing');
  assert.equal((await state.send({ type: 'rezka:pending' }, state.page)).count, 0);
});

test('failed upload keeps local progress and is retried by user command', async () => {
  const state = app();
  await state.progress(); state.logged(true); state.accept(false);
  assert.equal((await state.send({ type: 'rezka:sync-pending', tabId: 1 })).failed, 1);
  assert.equal(state.local[entry().key].time, 120);
  assert.equal(state.local[entry().key].sync.state, 'error');
  state.accept(true);
  assert.equal((await state.send({ type: 'rezka:sync-pending', tabId: 1 })).saved, 1);
});

test('logged out account and unknown duration cannot write server progress', async () => {
  const state = app();
  assert.equal((await state.progress(entry({ duration: 0 }))).ok, false);
  await state.progress();
  assert.equal((await state.send({ type: 'rezka:sync-pending', tabId: 1 })).ok, false);
  assert.equal(state.requests.length, 0);
});

test('import is atomic, keeps newer entries and preserves history metadata', () => {
  const backup = { format: 'rezka-progress', version: 1, entries: [entry({ year: '2004–2013', projectCompleted: true })] };
  const updates = mergeBackup(backup, {});
  assert.equal(updates[entry().key].remainingEpisodes, 44);
  assert.equal(updates[entry().key].projectCompleted, true);
  assert.equal(updates[entry().key].source, 'import');
  assert.deepEqual(mergeBackup(backup, { [entry().key]: entry({ updatedAt: 200000 }) }), {});
  assert.throws(() => mergeBackup({ ...backup, entries: [...backup.entries, entry({ duration: 0 })] }, {}));
});

test('continue list uses calendar dates and correct remaining episode wording', () => {
  const now = new Date(2026, 10, 17, 12);
  assert.equal(viewDate(new Date(2026, 10, 17, 1).getTime(), now), 'Сегодня');
  assert.equal(viewDate(new Date(2026, 10, 16, 22).getTime(), now), 'Вчера');
  assert.equal(remainingLabel(entry()), 'Смотреть ещё 44 серии в 15 сезоне');
  assert.equal(remainingLabel(entry({ remainingEpisodes: null })), '');
  assert.equal(latestTitles([entry({ updatedAt: 200 }), entry({ updatedAt: 100 })]).length, 1);
});

test('content ignores ads and tracks hash-switched active episode, date and episode count', async () => {
  const messages = [], posters = [];
  let observer;
  const active = { dataset: { season_id: '15', episode_id: '39' } };
  const video = { currentTime: 120, duration: 2880, readyState: 4, paused: false, seeking: false, ended: false, handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } };
  const advert = { handlers: {} };
  const location = new URL('https://hdrezka-home.tv/series/drama/14068-soldaty-2004-latest/110-default/15-season/39-episode.html');
  const document = {
    body: {}, title: 'Солдаты', scripts: [{ textContent: 'initCDNSeriesEvents(14068, 110, 15, 39)' }],
    createElement() { return { style: {}, append() {} }; }, addEventListener() {},
    querySelector(selector) {
      if (selector.includes('simple-episodes-tabs')) return active;
      if (selector.includes('video')) return video;
      if (selector === '#cdnplayer-container') return { after(panel) { panel.isConnected = true; } };
      if (selector === '[data-imagelightbox="cover"] img') return { src: 'https://st.hdrezka.ac/poster.jpg' };
      if (selector === 'h1') return { textContent: 'Солдаты 15 сезон 39 серия в озвучке' };
      if (selector === '.b-post__info') return { textContent: '23 августа 2004 года' };
      if (selector === '.b-post__status') return { textContent: 'Завершен (все серии)' };
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes('infotable')) return [{ textContent: 'Дата выхода: 23 августа 2004 года' }];
      if (selector.includes('simple-episodes')) return Array.from({ length: 83 }, (_, i) => ({ dataset: { season_id: '15', episode_id: String(i + 1) } }));
      return selector.includes('controlslist') ? [video] : [video, advert];
    }
  };
  runInNewContext(read('content.js'), { RezkaParser,
    document, location, URL, Date,
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} }, window: { addEventListener() {} },
    chrome: {
      runtime: { id: 'extension', onMessage: { addListener() {} }, async sendMessage(message) { (message.type === 'rezka:save-page' ? posters : messages).push(structuredClone(message)); return { ok: true }; } },
      storage: { local: { async get() { return {}; } }, onChanged: { addListener() {} } }
    }
  });
  assert.equal(posters.length, 1, 'poster is sent before playing');
  assert.equal(messages.length, 0);
  video.handlers.playing(); video.handlers.timeupdate(); await new Promise(setImmediate);
  assert.equal(Object.keys(advert.handlers).length, 0);
  assert.equal(messages[0].entry.remainingEpisodes, 44);
  assert.equal(messages[0].entry.title, 'Солдаты');
  assert.equal(messages[0].entry.posterUrl, 'https://st.hdrezka.ac/poster.jpg');
  assert.equal(messages[0].entry.projectCompleted, true);
  active.dataset.episode_id = '40'; location.hash = '#t:110-s:15-e:40'; observer();
  video.handlers.timeupdate(); await new Promise(setImmediate);
  assert.equal(messages.length, 1);
  video.handlers.playing(); video.handlers.timeupdate(); await new Promise(setImmediate);
  assert.equal(messages[1].entry.episode, 40);
  assert.equal(messages[1].entry.remainingEpisodes, 43);
});


test('editing moves the episode key and deletion removes all local episodes of a title', async () => {
  const state = app();
  await state.progress();
  await state.progress(entry({ episode: 40 }));
  const result = await state.send({ type: 'rezka:edit', key: entry().key, title: 'Новое название',
    translatorName: 'LostFilm', projectCompleted: false, season: 16, episode: 1, time: 60 });
  assert.equal(result.ok, true);
  assert.equal(state.local[entry().key], undefined);
  const edited = state.local['progress:14068:110:16:1'];
  assert.equal(edited.time, 60);
  assert.equal(edited.updatedAt, entry().updatedAt);
  assert.ok(edited.url.endsWith('#t:110-s:16-e:1'));
  assert.equal(state.local['details:14068:110'].title, 'Новое название');
  assert.equal((await state.send({ type: 'rezka:delete', id: 14068 })).ok, true);
  assert.deepEqual(Object.keys(state.local), []);
});


test('title cleanup keeps the title and removes viewing page suffixes', async () => {
  const { cleanTitle } = await import('./history.mjs');
  assert.equal(cleanTitle('Король Талсы смотреть онлайн в озвучке LostFilm'), 'Король Талсы');
  assert.equal(cleanTitle('Солдаты 15 сезон 39 серия в озвучке'), 'Солдаты');
});


test('local progress from one supported mirror can be explicitly saved through another mirror', async () => {
  const state = app('https://rezka.ag');
  await state.progress();
  state.logged(true);
  const result = await state.send({ type: 'rezka:sync-pending', tabId: 1 });
  assert.equal(result.saved, 1);
  assert.equal(state.requests[0].entry.translator, 110);
  assert.equal(state.local[entry().key].sync.state, 'saved');
  assert.deepEqual(pendingTitles([entry()], 'https://example.com'), []);
});


test('episode parser deduplicates, sorts numerically and excludes incomplete attributes', () => {
  const page = { querySelectorAll: () => [
    { dataset: { season_id: '15', episode_id: '40' } },
    { dataset: { season_id: '2', episode_id: '3' } },
    { dataset: { season_id: '15', episode_id: '40' } },
    { dataset: { season_id: '15' } }
  ] };
  assert.deepEqual(RezkaParser.episodes(page), ['2:3', '15:40']);
});

function continuePage({ path = '/series/drama/35084-ted-lasso.html', description = '4 сезон 9 серия (HDrezka Studio (18+))', metadata = '(2020 - ...)', next = 'смотреть ещё 1 серию в 4 сезоне' } = {}) {
  const elements = {
    '.td.title a': { getAttribute: name => name === 'href' ? path : name === 'data-cover_url' ? 'https://st.hdrezka.ac/poster.jpg' : null, textContent: 'Тед Лассо' },
    '.td.title small': { textContent: metadata },
    '.td.date': { textContent: 'вчера' },
    '.td.info': { cloneNode: () => ({ textContent: description, querySelector: () => ({ remove() {} }) }) },
    '.info-holder': { textContent: next }
  };
  return { querySelector: () => ({ querySelectorAll: () => [{ querySelector: selector => elements[selector] }] }) };
}

test('continue parser preserves nested voice names, calendar dates and remaining counts', () => {
  const [value] = RezkaParser.continueHistory(continuePage(), 'https://rezka.ag', new Date(2026, 0, 1));
  assert.equal(value.posterUrl, 'https://st.hdrezka.ac/poster.jpg');
  assert.equal(value.translatorName, 'HDrezka Studio (18+)');
  assert.equal(value.remainingEpisodes, 1);
  assert.equal(value.dateLabel, '31-12-2025');
  assert.equal(value.projectCompleted, false);
  assert.equal(value.url, '/series/drama/35084-ted-lasso.html#continue');
  assert.equal('time' in value, false);
  assert.equal('translator' in value, false);
});

test('continue parser distinguishes Specials, films, other voices and removed titles', () => {
  const parse = options => RezkaParser.continueHistory(continuePage(options), 'https://rezka.ag');
  const [special] = parse({ description: '6 сезон Special (TVShows)', next: 'доступна 7 серия от HDrezka Studio' });
  assert.equal(special.episode, null);
  assert.equal(special.episodeLabel, 'Special');
  assert.equal(special.translatorName, 'TVShows');
  assert.equal(special.remainingEpisodes, null);
  const [film] = parse({ path: '/films/drama/123-title.html', description: 'Дубляж', metadata: '(2017)', next: '' });
  assert.equal(film.season, 0);
  assert.equal(film.projectCompleted, null);
  assert.equal(film.translatorName, 'Дубляж');
  assert.deepEqual(parse({ path: '/0-.html' }), []);
  assert.throws(() => RezkaParser.continueHistory({ querySelector: () => null }, 'https://rezka.ag'), /не найден/);
});

test('catalog enriches local progress from account metadata without duplicating titles or inventing time', async () => {
  const { catalogTitles } = await import('./history.mjs');
  const local = entry({ title: 'Солдаты смотреть онлайн', translatorName: null, remainingEpisodes: null });
  const stored = { [local.key]: local, accountHistory: { entries: [
    { id: 14068, title: 'Солдаты', translatorName: 'Оригинал', season: 15, episode: 39, remainingEpisodes: 44, year: '2004–2013' },
    { id: 999, title: 'Другой фильм', url: 'https://rezka.ag/films/drama/999-film.html#continue' }
  ] }, 'library:14068': { state: 'archived', favorite: true } };
  const titles = catalogTitles(stored, { id: 999, title: 'Другой фильм' });
  assert.equal(titles.length, 2);
  assert.equal(titles[0].id, 999);
  assert.equal(titles[0].time, undefined);
  assert.equal(titles[1].time, local.time);
  assert.equal(titles[1].translator, 110);
  assert.equal(titles[1].translatorName, 'Оригинал');
  assert.equal(titles[1].title, 'Солдаты');
  assert.equal(titles[1].remainingEpisodes, 44);
  assert.equal(titles[1].libraryState, 'archived');
  assert.equal(titles[1].favorite, true);
});

test('catalog does not use remaining episodes from a different voice or viewing position', async () => {
  const { catalogTitles } = await import('./history.mjs');
  const local = entry({ translatorName: 'LostFilm', remainingEpisodes: null });
  const stored = { [local.key]: local, accountHistory: { entries: [{ id: 14068, translatorName: 'TVShows', season: 15, episode: 39, remainingEpisodes: 44, next: 'Ещё 44' }] } };
  assert.equal(catalogTitles(stored)[0].remainingEpisodes, null);
  assert.equal(catalogTitles(stored)[0].next, null);
  local.availableEpisodes = ['15:39', '15:40', '15:42', '16:1'];
  assert.equal(catalogTitles(stored)[0].remainingEpisodes, 2);
  assert.equal(remainingLabel(catalogTitles(stored)[0]), 'Смотреть ещё 2 серии в 15 сезоне');
});

test('fuzzy title search accepts typos, abbreviations and word prefixes, ranking exact matches first', async () => {
  const { titleSearchScore } = await import('./history.mjs');
  assert.ok(titleSearchScore('Солдаты', 'солдаты') < titleSearchScore('Солдаты', 'солдти'));
  assert.ok(Number.isFinite(titleSearchScore('Солдаты', 'солдти')));
  assert.ok(Number.isFinite(titleSearchScore('Король Талсы', 'крл тлс')));
  assert.ok(Number.isFinite(titleSearchScore('Король Талсы', 'тал кор')));
  assert.equal(titleSearchScore('Ёлки', 'елки'), 0);
  assert.equal(titleSearchScore('Солдаты', 'автомобиль'), Infinity);
  assert.equal(titleSearchScore('Солдаты', ''), 0);
});

test('favorite title saved from the current page remains in the catalog after leaving it', async () => {
  const { catalogTitles } = await import('./history.mjs');
  const stored = { 'library:42': { favorite: true, entry: { id: 42, title: 'Фильм', url: 'https://rezka.ag/films/drama/42-film.html' } } };
  const [title] = catalogTitles(stored);
  assert.equal(title.id, 42);
  assert.equal(title.favorite, true);
  assert.equal(title.libraryState, 'active');
  assert.equal(title.current, false);
  assert.equal(title.time, undefined);
});


test('per-title account save sends only the selected watched series across HDRezka mirrors', async () => {
  const state = app('https://rezka.ag');
  await state.progress();
  await state.progress(entry({ id: 42 }));
  state.logged(true);
  const result = await state.send({ type: 'rezka:sync-entry', key: entry().key, tabId: 1 });
  assert.equal(result.saved, 1);
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].entry.id, 14068);
});

test('account saving is unavailable for unplayed entries, movies and other providers', async () => {
  const { providerFor } = await import('./history.mjs');
  assert.equal(providerFor('https://www.rezka.ag/continue/'), 'hdrezka');
  assert.equal(providerFor('https://example.com/series/42'), null);
  assert.equal(canSaveToAccount(entry({ time: 0 })), false);
  assert.equal(canSaveToAccount(entry({ season: 0 })), false);
  assert.equal(canSaveToAccount(entry({ accountOnly: true })), false);
  assert.equal(canSaveToAccount(entry({ url: 'https://example.com/series/42' })), false);
  const state = app();
  await state.progress(entry({ time: 0 }));
  state.logged(true);
  assert.equal((await state.send({ type: 'rezka:sync-entry', key: entry().key, tabId: 1 })).ok, false);
  assert.equal(state.requests.length, 0);
});

test('recent view selects ten watched titles before promoting the current page', async () => {
  const { catalogViewEntries } = await import('./history.mjs');
  const titles = Array.from({ length: 12 }, (_, i) => ({ id: i, title: `Фильм ${i}`, updatedAt: i + 1, libraryState: 'active', current: i === 0 }));
  titles.push({ id: 99, title: 'Без просмотра', libraryState: 'active' });
  const recent = catalogViewEntries(titles, 'recent');
  assert.deepEqual(recent.map(entry => entry.id), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  assert.equal(catalogViewEntries(titles, 'all').length, 13);
  titles[3].current = true;
  assert.equal(catalogViewEntries(titles, 'recent')[0].id, 3);
});

test('recent view includes account dates and excludes archived and hidden titles', async () => {
  const { catalogViewEntries } = await import('./history.mjs');
  const titles = [
    { id: 1, title: 'Первый', dateLabel: '17-11-2026', libraryState: 'active' },
    { id: 2, title: 'Второй', updatedAt: new Date(2026, 10, 16).getTime(), libraryState: 'active' },
    { id: 3, title: 'Архив', dateLabel: '17-11-2026', libraryState: 'archived' },
    { id: 4, title: 'Скрытый', dateLabel: '17-11-2026', libraryState: 'hidden' }
  ];
  assert.deepEqual(catalogViewEntries(titles, 'recent').map(entry => entry.id), [1, 2]);
  assert.equal(catalogViewEntries(titles, 'all').length, 2);
  assert.equal(remainingLabel({ season: 15, remainingEpisodes: 0 }), '');
});


test('poster from viewing is retained across episodes and backup import', async () => {
  const state = app();
  const posterUrl = 'https://st.hdrezka.ac/poster.jpg';
  await state.progress(entry({ posterUrl }));
  await state.progress(entry({ episode: 40, posterUrl: null }));
  assert.equal(state.local['progress:14068:110:15:40'].posterUrl, posterUrl);
  const restored = mergeBackup({ format: 'rezka-progress', version: 1, entries: [entry({ posterUrl })] }, {});
  assert.equal(restored[entry().key].posterUrl, posterUrl);
});


test('opening a title saves and refreshes its poster without creating viewing history', async () => {
  const state = app();
  const oldPoster = 'https://static.hdrezka.ac/old.jpg';
  const posterUrl = 'https://static.hdrezka.ac/new.jpg';
  await state.send({ type: 'rezka:save-poster', posterUrl: oldPoster }, state.page);
  assert.deepEqual(Object.keys(state.local), ['poster:14068']);
  await state.send({ type: 'rezka:save-poster', posterUrl }, state.page);
  assert.equal(state.local['poster:14068'], posterUrl);
  assert.equal(state.requests.length, 0);
  const { catalogTitles } = await import('./history.mjs');
  const catalog = catalogTitles({ ...state.local, accountHistory: { entries: [{ ...entry(), posterUrl: oldPoster }] } });
  assert.equal(catalog[0].posterUrl, posterUrl);
  assert.equal((await state.send({ type: 'rezka:save-poster', posterUrl })).ok, false, 'popup cannot impersonate a title page');
});

test('page metadata creates a local catalog title before playback without entering recent views', async () => {
  const { catalogTitles, catalogViewEntries } = await import('./history.mjs');
  const state = app();
  const pageEntry = { id: 14068, title: 'Солдаты', year: '2004', posterUrl: null, translator: 110, translatorName: 'Оригинал', translators: [], url: state.page.url };
  assert.equal((await state.send({ type: 'rezka:save-page', entry: pageEntry }, state.page)).ok, true);
  assert.deepEqual(Object.keys(state.local), ['page:14068']);
  const titles = catalogTitles(state.local);
  assert.equal(titles[0].title, 'Солдаты');
  assert.equal(titles[0].translatorName, 'Оригинал');
  assert.equal(titles[0].localPage, true);
  assert.equal(catalogViewEntries(titles, 'all').length, 1);
  assert.equal(catalogViewEntries(titles, 'recent').length, 0);
});

test('deleting the account snapshot preserves local pages, progress, posters and favorites', async () => {
  const state = app();
  await state.progress(entry({ posterUrl: 'https://static.hdrezka.ac/poster.jpg' }));
  state.local['page:14068'] = { id: 14068, title: 'Солдаты', url: state.page.url };
  state.local['library:14068'] = { favorite: true };
  const local = structuredClone(state.local);
  state.local.accountHistory = { entries: [{ id: 99, title: 'Только импорт' }] };
  assert.equal((await state.send({ type: 'rezka:delete-account-history' })).ok, true);
  assert.deepEqual(state.local, local);
});

test('imported episode link resolves only with a known matching voice, not a remaining count', async () => {
  const { catalogTitles } = await import('./history.mjs');
  const url = 'https://rezka.ag/series/drama/14068-soldaty.html#continue';
  const account = { id: 14068, title: 'Солдаты', url, season: 1, episode: 2, remainingEpisodes: 21, translatorName: 'Оригинал' };
  const stored = { accountHistory: { entries: [account] }, 'page:14068': { id: 14068, title: 'Солдаты', url, translator: 232, translatorName: 'TVShows', translators: [{ id: 110, name: 'Оригинал' }] } };
  assert.equal(catalogTitles(stored)[0].url, url.replace('#continue', '#t:110-s:1-e:2'));
  assert.equal(catalogTitles(stored)[0].imported, true);
  account.translatorName = 'Неизвестная';
  assert.equal(catalogTitles(stored)[0].url, url);
  account.translatorName = null;
  stored['page:14068'].translatorName = null;
  assert.equal(catalogTitles(stored)[0].url, url);
});

test('import link resolver uses the named translator rather than the page default', () => {
  const voice = (id, name) => ({ dataset: { translator_id: String(id) }, textContent: name });
  const page = { scripts: [{ textContent: 'sof.tv.initCDNSeriesEvents(14068, 232, 1, 1)' }], querySelectorAll: () => [voice(232, 'TVShows'), voice(110, 'Оригинал')] };
  const imported = entry({ translatorName: 'Оригинал', season: 1, episode: 2 });
  const resolved = RezkaParser.resolveContinueLink(page, imported);
  assert.equal(resolved.translator, 110);
  assert.equal(new URL(resolved.url, 'https://rezka.si').hash, '#t:110-s:1-e:2');
  assert.throws(() => RezkaParser.resolveContinueLink(page, { ...imported, translatorName: null }), /нет названия/);
  assert.throws(() => RezkaParser.resolveContinueLink({ ...page, scripts: [] }, imported), /недоступна/);
  assert.throws(() => RezkaParser.resolveContinueLink({ ...page, querySelectorAll: () => [voice(110, 'Оригинал'), voice(111, 'Оригинал')] }, imported), /однозначно/);
});

test('trash preserves progress and favorites and restores only selected entries to their prior section', async () => {
  const { catalogTitles, catalogViewEntries } = await import('./history.mjs');
  const state = app();
  await state.progress();
  state.local['library:14068'] = { state: 'archived', favorite: true };
  assert.equal((await state.send({ type: 'rezka:trash', entry: entry() })).ok, true);
  const second = entry({ id: 99, key: 'progress:99:110:15:39' });
  await state.send({ type: 'rezka:trash', entry: second });
  assert.equal(state.local[entry().key].time, 120);
  assert.equal(state.local['library:14068'].favorite, true);
  assert.equal(catalogViewEntries(catalogTitles(state.local), 'all').length, 0);
  assert.equal(catalogViewEntries(catalogTitles(state.local), 'trash').length, 2);
  await state.send({ type: 'rezka:restore-trash', ids: [14068] });
  assert.equal(state.local['library:14068'].state, 'archived');
  assert.equal(state.local['library:99'].state, 'trash');
});

test('account import reads only the open document and makes no network requests', async () => {
  let listener;
  const local = {};
  const imported = entry({ translatorName: 'Оригинал' });
  const page = { scripts: [{ textContent: 'initCDNSeriesEvents(14068, 110)' }], querySelectorAll: () => [{ textContent: 'Оригинал', dataset: { translator_id: '110' } }] };
  runInNewContext(read('account.js'), {
    chrome: { extension: {}, runtime: { id: 'extension', async sendMessage() { return { ok: true }; }, onMessage: { addListener(fn) { listener = fn; } } }, storage: { local: {
      async get(key) { return { [key]: structuredClone(local[key]) }; },
      async set(values) { Object.assign(local, structuredClone(values)); }
    } } },
    crypto: { randomUUID: () => 'import-run' }, URL, Date, AbortSignal,
    location: { pathname: '/continue/', origin: 'https://hdrezka-home.tv' },
    document: { querySelector: () => ({}) },
    RezkaParser: { ...RezkaParser, continueHistory: () => [imported] },
    DOMParser: class { parseFromString() { return page; } },
    fetch() { assert.fail('Import must not request any title pages'); }
  });
  const result = await new Promise(resolve => listener({ type: 'rezka:read-continue' }, { id: 'extension' }, resolve));
  assert.equal(result.count, 1);
  await new Promise(setImmediate);
  assert.equal(local.accountHistory.links, undefined);
  assert.equal(local.accountHistory.importId, null);
  assert.equal(Object.keys(local).length, 1, 'import does not create local viewing progress');
});

test('full backup restores every stored section and removes state absent from the backup', async () => {
  const state = app();
  state.local['page:999'] = { id: 999, title: 'Лишняя карточка' };
  state.local.theme = 'light';
  const backupState = {
    theme: 'dark', [entry().key]: entry(),
    'page:14068': { id: 14068, title: 'Солдаты', url: entry().url },
    'poster:14068': 'https://static.hdrezka.ac/poster.jpg',
    'library:14068': { state: 'trash', previousState: 'archived', favorite: true, entry: entry() },
    'details:14068:110': { title: 'Моё название', translatorName: 'Оригинал' },
    accountHistory: { entries: [entry()], importId: 'old-run', links: { state: 'running', checked: 1, total: 2 } }
  };
  const result = await state.send({ type: 'rezka:import', backup: { format: 'rezka-progress', version: 2, state: backupState } });
  assert.equal(result.ok, true);
  assert.equal(result.restored, true);
  const expected = normalizeTitleUrls(backupState);
  expected.accountHistory.importId = null;
  expected.accountHistory.links.state = 'stopped';
  assert.deepEqual(state.local, expected);
  assert.equal(backupState.accountHistory.importId, 'old-run', 'validation does not mutate the backup');
  assert.equal(state.requests.length, 0);
});

test('invalid full backup leaves existing state untouched and legacy import remains supported', async () => {
  const state = app();
  await state.progress();
  const before = structuredClone(state.local);
  const invalid = { theme: 'dark', [entry().key]: entry({ duration: 0 }) };
  assert.equal((await state.send({ type: 'rezka:import', backup: { format: 'rezka-progress', version: 2, state: invalid } })).ok, false);
  assert.deepEqual(state.local, before);
  const legacy = { format: 'rezka-progress', version: 1, entries: [entry({ updatedAt: 200000 })] };
  assert.equal((await state.send({ type: 'rezka:import', backup: legacy })).imported, 1);
  assert.equal(state.local[entry().key].updatedAt, 200000);
});

test('compressed full backups preserve state and the importer also accepts legacy JSON', async () => {
  const { encodeBackup, decodeBackup } = await import('./backup.mjs');
  const state = { theme: 'dark', [entry().key]: entry(), 'library:14068': { state: 'trash', favorite: true }, accountHistory: { importId: null, entries: [entry({ title: 'Солдаты — озвучка' })] } };
  const compressed = await encodeBackup(state);
  assert.deepEqual(Array.from(new Uint8Array(await compressed.slice(0, 2).arrayBuffer())), [31, 139]);
  const decoded = await decodeBackup(compressed);
  assert.deepEqual(decoded.state, normalizeTitleUrls(state));
  assert.equal(decoded.version, 2);
  assert.deepEqual(restoreAppBackup(decoded), normalizeTitleUrls(state));
  const legacy = { format: 'rezka-progress', version: 1, entries: [entry()] };
  assert.deepEqual(await decodeBackup(new Blob([JSON.stringify(legacy)])), legacy);
  await assert.rejects(decodeBackup(new Blob(['not JSON'])));
});

test('new HDRezka mirrors share the provider and have matching extension permissions', async () => {
  const { providerFor } = await import('./history.mjs');
  const manifest = JSON.parse(read('manifest.json'));
  for (const origin of ['https://hdrezka.mn', 'https://rezka.si']) {
    assert.equal(providerFor(`${origin}/continue/`), 'hdrezka');
    assert.ok(manifest.host_permissions.includes(`${origin}/*`));
    assert.ok(manifest.content_scripts[0].matches.includes(`${origin}/*`));
    assert.ok(manifest.content_scripts[1].matches.includes(`${origin}/series/*`));
    const state = app(origin);
    await state.progress();
    state.logged(true);
    assert.equal((await state.send({ type: 'rezka:sync-entry', key: entry().key, tabId: 1 })).saved, 1);
  }
});

test('compact backups remove obsolete cache and redundant import fields without changing catalog behavior', async () => {
  const { compactBackupState } = await import('./backup.mjs');
  const { catalogTitles } = await import('./history.mjs');
  const url = entry().url;
  const imported = { ...entry(), episodeLabel: '39', description: '15 сезон 39 серия', linkError: 'HTTP 403', nextUrl: url, projectCompleted: null, translatorName: null };
  const special = { ...entry({ id: 99 }), episode: null, episodeLabel: 'Special', nextUrl: 'https://rezka.ag/series/drama/99-special.html#continue' };
  const state = { theme: 'dark', accountHistory: { entries: [imported, special], importId: 'old', links: { state: 'error' } }, 'releases:14068:110': { episodes: ['15:39'] }, 'library:14068': { state: 'trash', favorite: true }, [entry().key]: entry() };
  const compact = compactBackupState(state);
  assert.equal(compact['releases:14068:110'], undefined);
  assert.equal(compact.accountHistory.entries.length, 2);
  assert.equal(compact.accountHistory.entries[0].description, undefined);
  assert.equal(compact.accountHistory.entries[0].episodeLabel, undefined);
  assert.equal(compact.accountHistory.entries[0].nextUrl, undefined);
  assert.equal(compact.accountHistory.entries[1].episodeLabel, 'Special');
  assert.equal(compact.accountHistory.entries[1].nextUrl, titlePath(special.nextUrl));
  assert.deepEqual(compact[entry().key], normalizeTitleUrls(state)[entry().key]);
  assert.deepEqual(compact['library:14068'], state['library:14068']);
  assert.equal(catalogTitles(compact).find(value => value.id === 14068).time, 120);
  assert.equal(state.accountHistory.entries[0].description, '15 сезон 39 серия', 'live state is not mutated');
});

test('indexed backup writes one field list and restores sparse entries and Special episodes', async () => {
  const { packBackup, unpackBackup, compactBackupState, decodeBackup } = await import('./backup.mjs');
  const state = { theme: 'dark', accountHistory: { entries: [
    { id: 1, title: 'Первый', year: '2012', season: 1, episode: 0, projectCompleted: false },
    { id: 2, title: 'Второй', episodeLabel: 'Special', translatorName: 'TVShows', posterUrl: null }
  ] }, 'library:1': { state: 'trash', favorite: true } };
  const backup = packBackup(state);
  assert.equal(backup.version, 3);
  assert.equal(backup.state.accountHistory.entries.rows.length, 2);
  assert.ok(Array.isArray(backup.state.accountHistory.entries.rows[0]));
  assert.deepEqual(unpackBackup(backup).state, compactBackupState(state));
  assert.deepEqual((await decodeBackup(new Blob([JSON.stringify(backup)]))).state, compactBackupState(state));
  assert.equal(state.accountHistory.entries[1].posterUrl, null, 'source stays untouched');
  const malformed = structuredClone(backup);
  malformed.state.accountHistory.entries.rows[0].pop();
  assert.throws(() => unpackBackup(malformed), /строка/);
  const duplicate = structuredClone(backup);
  duplicate.state.accountHistory.entries.fields[1] = duplicate.state.accountHistory.entries.fields[0];
  assert.throws(() => unpackBackup(duplicate), /таблица/);
  assert.deepEqual(unpackBackup(packBackup({ theme: 'auto' })).state, { theme: 'auto' });
  assert.deepEqual(unpackBackup(packBackup({ theme: 'auto', accountHistory: { entries: [] } })).state.accountHistory.entries, []);
});

test('pretty backups remove transient card fields but retain trash restoration and preferences', async () => {
  const { compactBackupState, encodeBackup } = await import('./backup.mjs');
  const state = { theme: 'dark', 'library:1': { state: 'trash', previousState: 'archived', favorite: true, entry: {
    id: 1, title: 'Фильм', current: true, searchScore: 5, watchedAt: 10, provider: 'hdrezka', libraryState: 'active', favorite: false, localPage: true
  } }, 'library:2': { state: 'active', previousState: 'hidden' } };
  const compact = compactBackupState(state);
  assert.deepEqual(compact['library:1'], { state: 'trash', previousState: 'archived', favorite: true, entry: { id: 1, title: 'Фильм', localPage: true } });
  assert.equal(compact['library:2'].previousState, undefined);
  const compressed = await encodeBackup(state);
  const json = await new Response(compressed.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  assert.match(json, /\n  "format": "rezka-progress",\n/);
  assert.ok(json.endsWith('\n'));
  assert.equal(state['library:1'].entry.current, true);
});

test('preferred mirror rewrites old and relative links while preserving episode and query', async () => {
  const { titleUrl } = await import('./history.mjs');
  const path = '/series/drama/14068-soldaty.html?test=1#t:110-s:15-e:39';
  const stored = { 'provider:hdrezka': { mirror: 'https://rezka.si', lastOrigin: 'https://hdrezka.mn' } };
  assert.equal(titleUrl('https://hdrezka-home.tv' + path, stored, 'https://rezka.ag/continue/'), 'https://rezka.si' + path);
  assert.equal(titleUrl(path, stored), 'https://rezka.si' + path);
  stored['provider:hdrezka'].mirror = 'auto';
  assert.equal(titleUrl(path, stored, 'https://rezka.ag/continue/'), 'https://rezka.ag' + path);
  assert.equal(titleUrl(path, stored, 'https://example.com'), 'https://hdrezka.mn' + path);
  assert.equal(titleUrl('https://example.com/film', stored), 'https://example.com/film');
});

test('mirror detection preserves explicit preference and URL migration covers stored catalog sections', async () => {
  const state = app();
  state.local['provider:hdrezka'] = { mirror: 'https://rezka.si' };
  await state.send({ type: 'rezka:mirror-seen' }, state.page);
  assert.equal(state.local['provider:hdrezka'].mirror, 'https://rezka.si');
  assert.equal(state.local['provider:hdrezka'].lastOrigin, 'https://hdrezka-home.tv');
  const original = entry();
  state.local[original.key] = original;
  state.local['page:14068'] = { id: 14068, url: original.url };
  state.local.accountHistory = { entries: [{ ...original, nextUrl: original.url }] };
  state.local['library:14068'] = { state: 'trash', entry: original };
  state.local['poster:14068'] = 'https://static.hdrezka.ac/poster.jpg';
  assert.equal((await state.send({ type: 'rezka:normalize-urls' })).ok, true);
  const path = titlePath(original.url);
  assert.equal(state.local[original.key].url, path);
  assert.equal(state.local['page:14068'].url, path);
  assert.equal(state.local.accountHistory.entries[0].nextUrl, path);
  assert.equal(state.local['library:14068'].entry.url, path);
  assert.equal(state.local['poster:14068'], 'https://static.hdrezka.ac/poster.jpg');
  assert.equal(state.requests.length, 0);
});
