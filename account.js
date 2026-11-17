(() => {
  if (chrome.extension.inIncognitoContext) return;
  const bridgeId = crypto.randomUUID();
  void chrome.runtime.sendMessage({ type: 'rezka:mirror-seen' }).catch(() => {});
  const loggedIn = () => !!document.querySelector('a[href="/continue/"]');

  async function save({ entry, bridgeId: expectedBridge }) {
    if (expectedBridge !== bridgeId) throw new Error('Вкладка аккаунта обновилась. Привяжи её заново.');
    if (!loggedIn()) throw new Error('Войди в аккаунт в обычной вкладке сайта.');
    const response = await fetch(`/ajax/send_save/?t=${Date.now()}`, {
      method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(10000),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: new URLSearchParams({
        post_id: String(entry.id), translator_id: String(entry.translator),
        season: String(entry.season), episode: String(entry.episode),
        current_time: String(entry.time), duration: String(entry.duration)
      })
    });
    if (new URL(response.url).pathname.startsWith('/premium')) throw new Error('Сайт перенаправил сохранение на Premium. Прогресс остался локально.');
    if (!response.ok) throw Object.assign(new Error(`Сайт не принял прогресс: HTTP ${response.status}.`), { status: response.status });
    const result = await response.json();
    if (result.success !== true) throw new Error('Сайт не подтвердил сохранение прогресса.');
    return { ok: true };
  }

  async function importHistory() {
    if (!loggedIn() || location.pathname !== '/continue/') throw Error('Открой «Досмотреть» в нужном аккаунте и повтори импорт.');
    const entries = RezkaParser.continueHistory(document, location.origin);
    const previous = (await chrome.storage.local.get('accountHistory')).accountHistory;
    const known = new Map((previous?.entries || []).map(entry => [entry.id, entry]));
    for (const entry of entries) {
      const saved = known.get(entry.id);
      if (!saved?.translator || !entry.translatorName || saved.translatorName !== entry.translatorName || !entry.season || !Number.isInteger(entry.episode)) continue;
      entry.translator = saved.translator;
      const url = new URL(entry.url, location.origin);
      url.hash = `t:${entry.translator}-s:${entry.season}-e:${entry.episode}`;
      entry.url = url.pathname + url.search + url.hash;
    }
    await chrome.storage.local.set({ accountHistory: { entries, importId: null, origin: location.origin, readAt: Date.now() } });
    return { ok: true, count: entries.length };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'rezka:profile-status') {
      respond({ bridgeId, loggedIn: loggedIn(), origin: location.origin });
      return;
    }
    if (message.type === 'rezka:read-continue') {
      importHistory().then(respond, error => respond({ ok: false, error: error.message }));
      return true;
    }
    if (message.type !== 'rezka:profile-save') return;
    save(message).then(respond, error => respond({ ok: false, error: error.message, status: error.status }));
    return true;
  });
})();
