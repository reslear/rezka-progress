import { encodeBackup, decodeBackup } from './backup.mjs';
import { latestTitles, viewDate, cleanTitle, catalogTitles, remainingLabel, catalogViewEntries, canSaveToAccount, providers, providerFor, titleUrl } from './history.mjs';
const message = document.querySelector('#message');
new MutationObserver(() => { document.querySelector('#settings-message').textContent = message.textContent; }).observe(message, { childList: true, characterData: true, subtree: true });
let activeTab;
let editing;
let libraryView = 'recent';
let renderRevision = 0;
const editor = document.querySelector('#editor');
const form = document.querySelector('#edit-form');

const menuIcons = {
  edit: 'm16 3 5 5-12 12-6 1 1-6Z M14 5l5 5',
  save: 'M5 3h12l4 4v14H3V3Z M7 3v6h10V3 M7 21v-8h10v8',
  favorite: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z',
  archived: 'M4 7h16v14H4Z M3 3h18v4H3Z M9 11h6',
  hidden: 'm3 3 18 18 M10.6 10.6a2 2 0 0 0 2.8 2.8 M9 5.5A12 12 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.5 M6 6.5A19 19 0 0 0 2 12s4 7 10 7c1.5 0 3-.4 4.3-1',
  active: 'M9 4 4 9l5 5 M4 9h10a6 6 0 0 1 0 12',
  trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7'
};
function menuIcon(name) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', menuIcons[name]);
  icon.append(path);
  return icon;
}

async function action(request) {
  try {
    message.textContent = 'Выполняется…';
    const result = await chrome.runtime.sendMessage(request);
    message.textContent = !result.ok ? result.error
      : result.restored ? 'Полная копия восстановлена.'
      : result.saved !== undefined ? `Сохранено: ${result.saved}. Ошибок: ${result.failed}.${result.errors?.length ? ' ' + result.errors.join(' · ') : ''}`
      : result.imported !== undefined ? `Импортировано записей: ${result.imported}.` : 'Готово';
    await render();
  } catch (error) { message.textContent = error.message; }
}

async function render() {
  const revision = ++renderRevision;
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const stored = await chrome.storage.local.get(null);
  let currentPage = null;
  if (activeTab?.url && providerFor(activeTab.url)) {
    const id = Number(new URL(activeTab.url).pathname.match(/^\/[^/]+\/[^/]+\/(\d+)-/)?.[1]);
    if (id) {
      currentPage = { id };
      try { currentPage = await chrome.tabs.sendMessage(activeTab.id, { type: 'rezka:page-context' }) || currentPage; } catch { /* Existing catalog still identifies the current title. */ }
    }
  }
  const catalog = catalogTitles(stored, currentPage?.title ? currentPage : null);
  if (currentPage) {
    for (const entry of catalog) entry.current = entry.id === currentPage.id;
    catalog.sort((a, b) => Number(b.current) - Number(a.current));
  }
  if (revision !== renderRevision) return;
  const filter = libraryView;
  const query = document.querySelector('#search').value.trim().toLocaleLowerCase();
  const entries = catalogViewEntries(catalog, filter, query);
  for (const tab of document.querySelectorAll('[data-library-view]')) tab.setAttribute('aria-pressed', String(tab.dataset.libraryView === filter));
  const history = document.querySelector('#history');
  history.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = query ? 'Ничего не найдено.' : filter === 'recent' || filter === 'all' ? 'Начни смотреть или прочитай «Досмотреть».' : 'Здесь пока нет фильмов.';
    history.append(empty);
  }
  for (const entry of entries) {
    const details = stored[`details:${entry.id}:${entry.translator}`];
    const row = document.createElement('article');
    row.className = 'entry';
    const link = document.createElement('a');
    link.className = 'watch';
    const watchUrl = titleUrl(entry.url, stored, activeTab?.url);
    link.href = watchUrl;
    if (entry.posterUrl) {
      const poster = document.createElement('img');
      poster.className = 'poster';
      poster.width = 32;
      poster.height = 48;
      poster.alt = '';
      poster.loading = 'lazy';
      poster.decoding = 'async';
      poster.referrerPolicy = 'no-referrer';
      poster.src = entry.posterUrl;
      poster.onerror = () => { poster.remove(); link.classList.remove('with-poster'); };
      link.classList.add('with-poster');
      link.append(poster);
    }
    const heading = document.createElement('div');
    heading.className = 'heading';
    const title = document.createElement('strong');
    title.textContent = details?.title || cleanTitle(entry.title);
    if (entry.current) {
      const current = document.createElement('span');
      current.className = 'current-dot';
      current.title = 'Текущая страница';
      current.setAttribute('aria-label', 'Текущая страница');
      heading.append(current);
    }
    heading.append(title);
    const source = document.createElement('span');
    source.className = 'entry-source';
    source.textContent = entry.imported ? entry.localPage ? 'Локально + импорт' : 'Импорт' : 'Локально';
    source.title = entry.imported ? `Данные из «Досмотреть»${entry.linkError ? '. Ссылка: ' + entry.linkError : ''}` : 'Сохранено расширением';
    heading.append(source);
    const completed = details ? details.projectCompleted : entry.projectCompleted;
    if (entry.year) {
      const year = document.createElement('span');
      year.className = 'title-meta';
      year.textContent = entry.year;
      heading.append(year);
    }
    if (entry.season && completed === true) {
      const status = document.createElement('span');
      status.className = 'title-meta';
      status.textContent = 'завершён';
      heading.append(status);
    }
    const voiceName = details?.translatorName ?? entry.translatorName;
    if (voiceName) {
      const voice = document.createElement('span');
      voice.className = 'voice';
      voice.textContent = voiceName;
      heading.append(voice);
    }
    const date = document.createElement('span');
    date.className = 'view-date';
    date.textContent = entry.watchedAt || entry.updatedAt ? viewDate(entry.watchedAt || entry.updatedAt) : entry.dateLabel || '';
    const titleLine = document.createElement('div');
    titleLine.className = 'title-line';
    const provider = document.createElement('span');
    provider.className = 'provider';
    provider.textContent = providers[entry.provider]?.name || '';
    titleLine.append(heading, date, provider);
    link.onclick = async event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      await chrome.tabs.update(activeTab.id, { url: watchUrl });
      window.close();
    };
    link.append(titleLine);
    const progressLine = document.createElement('div');
    progressLine.className = 'progress-line';
    if (entry.season) {
      const episode = document.createElement('span');
      episode.className = 'episode';
      episode.textContent = `${entry.season} сезон · ${entry.episode ?? entry.episodeLabel ?? '—'} серия`;
      progressLine.append(episode);
    }
    if (entry.duration > 0 && Number.isFinite(entry.time)) {
      const progress = document.createElement('progress');
      progress.max = entry.duration;
      progress.value = entry.time;
      progress.setAttribute('aria-label', 'Прогресс просмотра');
      const minutes = document.createElement('span');
      minutes.className = 'minutes';
      minutes.textContent = `${Math.floor(entry.time / 60)} из ${Math.ceil(entry.duration / 60)} мин`;
      progressLine.append(progress, minutes);
    }
    const continuation = remainingLabel(entry) || entry.next;
    if (continuation) {
      const hint = document.createElement('div');
      hint.className = 'continuation';
      hint.title = continuation;
      if (entry.nextUrl && !entry.translator) {
        const target = new URL(titleUrl(entry.nextUrl, stored, activeTab?.url));
        if (providers.hdrezka.origins.includes(target.origin)) {
          hint.onclick = async event => {
            event.preventDefault();
            event.stopPropagation();
            await chrome.tabs.update(activeTab.id, { url: target.href });
            window.close();
          };
        }
      }
      hint.textContent = continuation.replace(/^смотреть ещё/i, 'Смотреть дальше').replace(/ в \d+ сезоне$/i, '');
      progressLine.append(hint);
    }
    if (progressLine.childElementCount) link.append(progressLine);
    const edit = document.createElement('button');
    edit.textContent = 'Редактировать';
    edit.prepend(menuIcon('edit'));
    edit.title = 'Редактировать запись';
    edit.setAttribute('aria-label', `Редактировать: ${title.textContent}`);
    edit.onclick = () => {
      editing = entry;
      form.elements.title.value = title.textContent;
      form.elements.translatorName.value = voiceName || '';
      form.elements.season.value = entry.season || 1;
      form.elements.episode.value = entry.episode || 1;
      form.elements.minutes.value = (Math.floor(entry.time / 6) / 10).toFixed(1);
      form.elements.minutes.max = entry.duration / 60;
      form.elements.projectCompleted.value = completed == null ? '' : String(completed);
      document.querySelector('#episode-fields').hidden = !entry.season;
      editor.showModal();
    };
    const controls = document.createElement('div');
    controls.className = 'card-menu';
    controls.id = `card-menu-${entry.id}`;
    controls.setAttribute('popover', 'auto');
    const menu = document.createElement('button');
    menu.className = 'edit';
    menu.textContent = '⋯';
    menu.setAttribute('aria-label', `Действия: ${title.textContent}`);
    menu.setAttribute('popovertarget', controls.id);
    controls.addEventListener('beforetoggle', event => {
      if (event.newState !== 'open') return;
      const rect = menu.getBoundingClientRect();
      controls.style.right = `${Math.max(8, innerWidth - rect.right)}px`;
      controls.style.top = `${Math.max(8, Math.min(rect.bottom, innerHeight - 220))}px`;
    });
    controls.addEventListener('click', event => { if (event.target.closest('button')) controls.hidePopover(); });
    const mainActions = document.createElement('div');
    mainActions.className = 'menu-group';
    const libraryActions = document.createElement('div');
    libraryActions.className = 'menu-group';
    if (!entry.accountOnly) mainActions.append(edit);
    if (canSaveToAccount(entry)) {
      const save = document.createElement('button');
      save.textContent = 'Сохранить в аккаунт';
      save.prepend(menuIcon('save'));
      save.onclick = () => { void action({ type: 'rezka:sync-entry', key: entry.key, tabId: activeTab.id }); };
      mainActions.append(save);
    }
    const favorite = document.createElement('button');
    favorite.textContent = entry.favorite ? 'Убрать звезду' : 'В избранное';
    favorite.prepend(menuIcon('favorite'));
    favorite.title = entry.favorite ? 'Убрать звезду' : 'В избранное';
    favorite.setAttribute('aria-label', favorite.title);
    favorite.setAttribute('aria-pressed', String(entry.favorite));
    favorite.onclick = async () => {
      await chrome.storage.local.set({ [`library:${entry.id}`]: { ...stored[`library:${entry.id}`], ...(entry.current && currentPage?.title ? { entry: currentPage } : {}), favorite: !entry.favorite } });
      await render();
    };
    libraryActions.append(favorite);
    for (const [state, label] of entry.libraryState === 'active' ? [['archived', 'В архив'], ['hidden', 'Скрыть']] : [['active', 'Вернуть в список']]) {
      const button = document.createElement('button');
      button.textContent = label;
      button.prepend(menuIcon(state));
      button.onclick = async () => {
        await chrome.storage.local.set({ [`library:${entry.id}`]: { ...stored[`library:${entry.id}`], ...(entry.current && currentPage?.title ? { entry: currentPage } : {}), state } });
        await render();
      };
      libraryActions.append(button);
    }
    const trash = document.createElement('button');
    trash.textContent = 'В корзину';
    trash.prepend(menuIcon('trash'));
    trash.className = 'menu-trash';
    trash.onclick = () => { void action({ type: 'rezka:trash', entry }); };
    if (mainActions.childElementCount) controls.append(mainActions);
    controls.append(libraryActions, trash);
    row.append(link, menu, controls);
    history.append(row);
  }
}

document.querySelector('#export').onclick = async () => {
  const stored = await chrome.storage.local.get(null);
  const state = { ...stored, theme: stored.theme || localStorage.getItem('theme') || 'auto' };
  const url = URL.createObjectURL(await encodeBackup(state));
  const link = document.createElement('a'); link.href = url;
  link.download = `rezka-progress-${new Date().toISOString().slice(0, 10)}.json.gz`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  message.textContent = 'Полная резервная копия сохранена.';
};
document.querySelector('#import').onclick = () => document.querySelector('#backup').click();
document.querySelector('#backup').onchange = async event => {
  const file = event.target.files[0]; if (!file) return;
  try { await action({ type: 'rezka:import', backup: await decodeBackup(file) }); }
  catch (error) { message.textContent = `Импорт не выполнен: ${error.message}`; }
  event.target.value = '';
};
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some(key => ['progress:', 'details:', 'library:', 'accountHistory', 'poster:', 'page:', 'provider:'].some(prefix => key.startsWith(prefix)))) void render();
});
void chrome.runtime.sendMessage({ type: 'rezka:normalize-urls' }).then(() => render());

document.querySelector('#cancel').onclick = () => editor.close();
form.onsubmit = async event => {
  event.preventDefault();
  const result = await chrome.runtime.sendMessage({
    type: 'rezka:edit', key: editing.key,
    title: form.elements.title.value.trim(),
    translatorName: form.elements.translatorName.value.trim(),
    season: editing.season ? form.elements.season.valueAsNumber : 0,
    episode: editing.season ? form.elements.episode.valueAsNumber : 0,
    time: form.elements.minutes.valueAsNumber * 60,
    projectCompleted: form.elements.projectCompleted.value === '' ? null : form.elements.projectCompleted.value === 'true'
  });
  if (!result.ok) { message.textContent = result.error; editor.close(); return; }
  editor.close();
  await render();
};
document.querySelector('#delete').onclick = async () => {
  await action({ type: 'rezka:trash', entry: editing });
  editor.close();
};

document.querySelector('#read-account').onclick = async () => {
  const button = document.querySelector('#read-account');
  button.disabled = true;
  try {
    if (!activeTab?.url || new URL(activeTab.url).pathname !== '/continue/' || activeTab.incognito) throw Error('Открой «Досмотреть» в обычной вкладке сайта.');
    const result = await chrome.tabs.sendMessage(activeTab.id, { type: 'rezka:read-continue' });
    if (!result?.ok) throw Error(result?.error || 'Обнови вкладку сайта после обновления расширения.');
    await render();
    message.textContent = `Прочитано записей: ${result.count}. Локальный прогресс сохранён отдельно.`;
  } catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
};

for (const tab of document.querySelectorAll('[data-library-view]')) tab.onclick = () => { libraryView = tab.dataset.libraryView; void render(); };
document.querySelector('#search').oninput = () => { void render(); };

const settings = document.querySelector('#settings');
document.querySelector('#open-settings').onclick = () => settings.showModal();
document.querySelector('#close-settings').onclick = () => settings.close();
const searchToggle = document.querySelector('#toggle-search');
const searchBox = document.querySelector('.catalog-tools');
const searchInput = document.querySelector('#search');
function toggleSearch() {
  searchBox.hidden = !searchBox.hidden;
  searchToggle.setAttribute('aria-expanded', String(!searchBox.hidden));
  if (searchBox.hidden) { searchInput.value = ''; void render(); searchToggle.focus(); }
  else searchInput.focus();
}
searchToggle.onclick = toggleSearch;
searchInput.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); toggleSearch(); } };


document.querySelector('#delete-account-history').onclick = () => { void action({ type: 'rezka:delete-account-history' }); };
const providerList = document.querySelector('#providers');
for (const [providerId, provider] of Object.entries(providers)) {
  const card = document.createElement('details');
  card.className = 'provider-card';
  const summary = document.createElement('summary');
  summary.textContent = `${provider.name} · ${provider.origins.length} зеркал`;
  const content = document.createElement('div');
  content.className = 'provider-content';
  const features = document.createElement('ul');
  features.className = 'provider-features';
  features.setAttribute('aria-label', 'Возможности');
  for (const feature of provider.features) {
    const tag = document.createElement('li');
    tag.textContent = feature;
    features.append(tag);
  }
  const mirrors = document.createElement('ul');
  mirrors.className = 'provider-mirrors';
  for (const origin of provider.origins) {
    const mirror = document.createElement('li');
    mirror.textContent = new URL(origin).hostname;
    mirrors.append(mirror);
  }
  const mirrorLabel = document.createElement('label');
  mirrorLabel.className = 'mirror-setting';
  mirrorLabel.textContent = 'Основное зеркало';
  const mirrorSelect = document.createElement('select');
  mirrorSelect.add(new Option('Авто — последнее открытое', 'auto'));
  for (const origin of provider.origins) mirrorSelect.add(new Option(new URL(origin).hostname, origin));
  const configKey = `provider:${providerId}`;
  void chrome.storage.local.get(configKey).then(stored => { mirrorSelect.value = stored[configKey]?.mirror || 'auto'; });
  mirrorSelect.onchange = async () => {
    const stored = await chrome.storage.local.get(configKey);
    await chrome.storage.local.set({ [configKey]: { ...stored[configKey], mirror: mirrorSelect.value } });
    await render();
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[configKey]) mirrorSelect.value = changes[configKey].newValue?.mirror || 'auto';
  });
  mirrorLabel.append(mirrorSelect);
  content.append(mirrorLabel, features, mirrors);
  const providerActions = document.querySelector(`#${providerId}-actions`);
  if (providerActions) {
    providerActions.hidden = false;
    content.append(providerActions);
  }
  card.append(summary, content);
  providerList.append(card);
}


const trashDialog = document.querySelector('#trash');
async function renderTrash() {
  const stored = await chrome.storage.local.get(null);
  const entries = catalogTitles(stored).filter(entry => entry.libraryState === 'trash');
  const list = document.querySelector('#trash-list');
  list.replaceChildren();
  if (!entries.length) list.textContent = 'Корзина пуста.';
  for (const entry of entries) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = entry.id;
    label.append(checkbox, document.createTextNode(entry.title));
    list.append(label);
  }
  document.querySelector('#restore-trash').disabled = !entries.length;
}
document.querySelector('#open-trash').onclick = async () => { await renderTrash(); trashDialog.showModal(); };
document.querySelector('#close-trash').onclick = () => trashDialog.close();
document.querySelector('#restore-trash').onclick = async () => {
  const ids = Array.from(document.querySelectorAll('#trash-list input:checked')).map(input => Number(input.value));
  if (!ids.length) return;
  await action({ type: 'rezka:restore-trash', ids });
  await renderTrash();
};
