/* Shared by content scripts and the popup; never executes scripts from the site. */
globalThis.RezkaParser = {
  resolveContinueLink(page, entry) {
    const initial = Array.from(page.scripts).map(script => script.textContent.match(/initCDNSeriesEvents\(\s*(\d+)\s*,\s*(\d+)/)).find(Boolean);
    if (Number(initial?.[1]) !== entry.id) throw Error('Страница сериала недоступна');
    if (!entry.translatorName) throw Error('В истории нет названия озвучки');
    const voices = Array.from(page.querySelectorAll('.b-translator__item'))
      .filter(item => item.textContent.trim() === entry.translatorName && Number(item.dataset.translator_id) > 0);
    if (voices.length !== 1) throw Error('Озвучка не найдена однозначно');
    const translator = Number(voices[0].dataset.translator_id);
    const url = new URL(entry.url, 'https://hdrezka-home.tv');
    url.hash = `t:${translator}-s:${entry.season}-e:${entry.episode}`;
    return { ...entry, translator, url: url.pathname + url.search + url.hash, linkError: null };
  },
  episodes(page) {
    return [...new Set(Array.from(page.querySelectorAll('#simple-episodes-tabs .b-simple_episode__item'))
      .filter(item => /^\d+$/.test(item.dataset?.season_id) && /^\d+$/.test(item.dataset?.episode_id))
      .map(item => `${Number(item.dataset.season_id)}:${Number(item.dataset.episode_id)}`))]
      .sort((a, b) => { const [s, e] = a.split(':').map(Number); const [t, f] = b.split(':').map(Number); return s - t || e - f; });
  },
  continueHistory(page, origin, now = new Date()) {
    const list = page.querySelector('#videosaves-list');
    if (!list) throw Error('Список «Досмотреть» не найден. Открой его после входа в аккаунт.');
    return Array.from(list.querySelectorAll('.b-videosaves__list_item[id^="videosave-"]')).map(row => {
      const link = row.querySelector('.td.title a');
      const url = new URL(link.getAttribute('href'), origin);
      if (url.pathname === '/0-.html') return null; // Removed title in the site's history.
      const id = Number(url.pathname.match(/^\/[^/]+\/[^/]+\/(\d+)-/)?.[1]);
      if (!id || url.origin !== origin) throw Error('Не удалось распознать ссылку в «Досмотреть».');
      const metadata = row.querySelector('.td.title small')?.textContent || '';
      const info = row.querySelector('.td.info').cloneNode(true);
      info.querySelector('.info-holder')?.remove();
      const description = info.textContent.trim();
      const episode = description.match(/^(\d+)\s+сезон\s+(\d+|Special)(?:\s+серия)?(?:\s+\((.*)\))?$/i);
      const next = row.querySelector('.info-holder')?.textContent.trim() || null;
      const nextHref = row.querySelector('.info-holder a')?.getAttribute('href');
      const nextAddress = nextHref ? new URL(nextHref, origin) : null;
      const remaining = next?.match(/смотреть ещё\s+(\d+)\s+сери[юий]\s+в\s+(\d+)\s+сезоне/i);
      let dateLabel = row.querySelector('.td.date').textContent.trim();
      if (/^(сегодня|вчера)$/i.test(dateLabel)) {
        const date = new Date(now);
        if (/вчера/i.test(dateLabel)) date.setDate(date.getDate() - 1);
        dateLabel = [String(date.getDate()).padStart(2, '0'), String(date.getMonth() + 1).padStart(2, '0'), date.getFullYear()].join('-');
      }
      url.hash = 'continue';
      return {
        id, title: link.textContent.trim(), url: url.pathname + url.search + url.hash,
        posterUrl: link.getAttribute('data-cover_url') || null,
        dateLabel,
        year: metadata.match(/(?:19|20)\d{2}(?:\s*[-–]\s*(?:(?:19|20)\d{2}|\.\.\.))?/)?.[0] || null,
        projectCompleted: /проект заверш[её]н/i.test(metadata) ? true : /\.\.\./.test(metadata) ? false : null,
        season: episode ? Number(episode[1]) : 0,
        episode: episode && episode[2] !== 'Special' ? Number(episode[2]) : null,
        episodeLabel: episode?.[2] || null,
        translatorName: episode ? episode[3] || null : description || null,
        remainingEpisodes: remaining && Number(remaining[2]) === Number(episode?.[1]) ? Number(remaining[1]) : null,
        next, nextUrl: nextAddress ? nextAddress.origin === origin ? nextAddress.pathname + nextAddress.search + nextAddress.hash : nextAddress.href : null, description
      };
    }).filter(Boolean);
  }
};
