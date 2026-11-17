(() => {
  const route = location.pathname.match(/^\/(series|films)\/[^/]+\/(\d+)-/);
  if (!route) return;
  const attached = new WeakSet();
  const episodeVideo = '#cdnplayer video[controlslist~="nodownload"]';
  const initial = Array.from(document.scripts)
    .map(script => script.textContent.match(/initCDN(?:Series|Movies)Events\(\s*(\d+)\s*,\s*(\d+)/))
    .find(Boolean);
  let playback = null;
  let savedPage = null;
  let lastWrite = 0;
  let revision = 0;
  const panel = document.createElement('div');
  panel.style.cssText = 'padding:12px;color:#ddd;background:#242424;font:14px system-ui;display:flex;gap:12px;align-items:center;flex-wrap:wrap';
  const status = document.createElement('span');
  const syncStatus = document.createElement('span');
  const resume = document.createElement('button');
  resume.hidden = true;
  panel.append(status, resume, syncStatus);

  function loggedIn() {
    return !!document.querySelector('a[href="/continue/"]');
  }

  function posterUrl() {
    return document.querySelector('[data-imagelightbox="cover"] img')?.src
      || document.querySelector('meta[property="og:image"]')?.content || null;
  }

  function pageMetadata() {
    const voice = document.querySelector('.b-translator__item.active');
    const info = Array.from(document.querySelectorAll('.b-post__info tr, .b-post__infotable tr'))
      .find(row => /Дата выхода|Год выхода/i.test(row.textContent))?.textContent || '';
    return {
      id: Number(route[2]),
      title: (document.querySelector('.b-post__title h1')?.textContent.trim() || document.querySelector('h1')?.textContent.trim() || document.title).replace(/\s+(?:смотреть\s+онлайн|смотреть\s+все|в\s+озвучке|\d+\s+сезон).*$/iu, ''),
      year: info.match(/\b(?:19|20)\d{2}(?:\s*[-–]\s*(?:19|20)\d{2})?\b/)?.[0] || null,
      posterUrl: posterUrl(),
      translatorName: voice?.textContent.trim() || null,
      translator: Number(voice?.dataset.translator_id || initial?.[2]) || null,
      translators: Array.from(document.querySelectorAll('.b-translator__item'))
        .filter(item => item.dataset?.translator_id)
        .map(item => ({ id: Number(item.dataset.translator_id), name: item.textContent.trim() })),
      url: location.pathname + location.search + location.hash
    };
  }

  async function savePage() {
    const entry = pageMetadata();
    const signature = [entry.title, entry.year, entry.posterUrl, entry.translator, entry.translatorName, entry.url, ...entry.translators.map(voice => `${voice.id}:${voice.name}`)].join('|');
    if (signature === savedPage) return;
    savedPage = signature;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'rezka:save-page', entry });
      if (!result.ok) syncStatus.textContent = result.error;
    } catch {
      syncStatus.textContent = 'Обнови страницу после обновления расширения.';
    }
  }

  function context() {
    const episode = document.querySelector('#simple-episodes-tabs .b-simple_episode__item.active');
    const translator = Number(document.querySelector('.b-translator__item.active')?.dataset.translator_id
      || location.hash.match(/t:(\d+)-s:/)?.[1]
      || location.pathname.match(/\/(\d+)-[^/]+\/\d+-season/)?.[1]
      || initial?.[2]);
    if (!translator || (route[1] === 'series' && !episode)) return null;
    const id = Number(route[2]);
    const season = route[1] === 'series' ? Number(episode.dataset.season_id) : 0;
    const number = route[1] === 'series' ? Number(episode.dataset.episode_id) : 0;
    const url = new URL(location.href);
    url.search = '';
    if (route[1] === 'series') {
      url.pathname = `${location.pathname.split('/').slice(0, 4).join('/').replace(/\.html$/, '')}.html`;
      url.hash = `t:${translator}-s:${season}-e:${number}`;
    }
    const episodeNumbers = RezkaParser.episodes(document).map(key => key.split(':').map(Number)).filter(([s]) => s === season).map(([, e]) => e);
    const info = Array.from(document.querySelectorAll('.b-post__info tr, .b-post__infotable tr'))
      .find(row => /Дата выхода|Год выхода/i.test(row.textContent))?.textContent || '';
    const projectStatus = document.querySelector('.b-post__status')?.textContent || '';
    return {
      posterUrl: posterUrl(),
      year: info.match(/\b(?:19|20)\d{2}(?:\s*[-–]\s*(?:19|20)\d{2})?\b/)?.[0] || null,
      projectCompleted: /(?:не заверш|продолжа|выходит)/i.test(projectStatus) ? false : /заверш[её]н/i.test(projectStatus) ? true : null,
      availableEpisodes: RezkaParser.episodes(document),
      seasonEpisodeCount: episodeNumbers.length || null,
      remainingEpisodes: episodeNumbers.length ? episodeNumbers.filter(value => value > number).length : null,
      key: `progress:${id}:${translator}:${season}:${number}`,
      id, title: (document.querySelector('.b-post__title h1')?.textContent.trim() || document.querySelector('h1')?.textContent.trim() || document.title).replace(/\s+(?:смотреть\s+онлайн|смотреть\s+все|в\s+озвучке|\d+\s+сезон).*$/iu, ''),
      translatorName: document.querySelector('.b-translator__item.active')?.textContent.trim() || null,
      season, episode: number, translator, url: url.pathname + url.search + url.hash
    };
  }

  function clock(seconds) {
    return new Date(Math.floor(seconds) * 1000).toISOString().slice(11, 19);
  }

  async function showSaved() {
    const current = context();
    const ticket = ++revision;
    resume.hidden = true;
    if (!current) {
      status.textContent = 'Ожидаю выбор серии или перевода.';
      return;
    }
    const saved = (await chrome.storage.local.get(current.key))[current.key];
    if (ticket !== revision) return;
    const label = current.season ? `Сезон ${current.season}, серия ${current.episode}` : current.title;
    status.textContent = saved ? `${label} · ${clock(saved.time)} / ${clock(saved.duration)}` : `${label} · прогресс ещё не сохранён`;
    syncStatus.textContent = saved?.sync?.message || 'Прогресс сохраняется локально; после входа можно отправить его в аккаунт.';
    const video = document.querySelector(episodeVideo);
    resume.hidden = !saved || saved.completed || !video || video.readyState < 1 || saved.time < video.currentTime + 3;
    resume.textContent = saved ? `Продолжить с ${clock(saved.time)}` : 'Продолжить';
    resume.onclick = () => {
      if (context()?.key !== current.key) return;
      video.currentTime = Math.min(saved.time, video.duration);
      resume.hidden = true;
    };
  }

  async function save(video, force = false) {
    if (!playback || playback.video !== video || playback.key !== context()?.key) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.seeking) return;
    if (!force && (video.paused || Date.now() - lastWrite < 5000)) return;
    lastWrite = Date.now();
    const { video: activeVideo, ...identity } = playback;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'rezka:save-progress', force, loggedIn: loggedIn(),
        entry: {
          ...identity, time: video.currentTime, duration: video.duration,
          completed: video.ended, updatedAt: Date.now()
        }
      });
      if (!response.ok) syncStatus.textContent = response.error;
      else await showSaved();
    } catch {
      syncStatus.textContent = 'Связь с расширением прервана. Обнови страницу.';
    }
  }

  function scan() {
    void savePage();
    const holder = document.querySelector('#cdnplayer-container');
    if (holder && !panel.isConnected) holder.after(panel);
    if (playback && playback.key !== context()?.key) {
      playback = null;
      void showSaved();
    }
    for (const video of document.querySelectorAll(episodeVideo)) {
      if (attached.has(video)) continue;
      attached.add(video);
      video.addEventListener('playing', () => {
        const current = context();
        if (!current) return;
        playback = { ...current, video };
        lastWrite = 0;
        void showSaved();
      });
      video.addEventListener('emptied', () => {
        if (playback?.video === video) playback = null;
        void showSaved();
      });
      video.addEventListener('loadedmetadata', () => { void showSaved(); });
      video.addEventListener('timeupdate', () => { void save(video); });
      for (const event of ['pause', 'seeked', 'ended']) {
        video.addEventListener(event, () => { void save(video, true); });
      }
      void showSaved();
    }
  }

  new MutationObserver(scan).observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'src', 'content']
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id === chrome.runtime.id && message.type === 'rezka:page-context') respond(context() || pageMetadata());
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && playback) void save(playback.video, true);
  });
  window.addEventListener('pagehide', () => {
    if (playback) void save(playback.video, true);
  });
  window.addEventListener('popstate', () => { playback = null; void showSaved(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[context()?.key]) void showSaved();
  });
  scan();
  void showSaved();
})();
