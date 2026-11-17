import { normalizeTitleUrls } from './history.mjs';
export async function encodeBackup(state) {
  const json = JSON.stringify(packBackup(state), null, 2) + '\n';
  return new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

export async function decodeBackup(file) {
  const bytes = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const text = bytes[0] === 0x1f && bytes[1] === 0x8b
    ? await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text()
    : await file.text();
  return unpackBackup(JSON.parse(text));
}

export function compactBackupState(state) {
  const compact = normalizeTitleUrls(state);
  for (const key of Object.keys(compact)) {
    // Cache of the removed automatic release checker.
    if (key.startsWith('releases:')) delete compact[key];
    if (key.startsWith('library:')) {
      const library = compact[key];
      if (library.state !== 'trash') delete library.previousState;
      if (library.entry) {
        for (const field of ['current', 'searchScore', 'watchedAt', 'provider', 'libraryState', 'favorite']) delete library.entry[field];
      }
    }
  }
  if (compact.accountHistory) {
    delete compact.accountHistory.links;
    compact.accountHistory.importId = null;
    for (const entry of compact.accountHistory.entries) {
      // Display text is built from the parsed fields, not this original row text.
      delete entry.description;
      delete entry.linkError;
      if (entry.episodeLabel !== 'Special') delete entry.episodeLabel;
      if (entry.nextUrl === entry.url) delete entry.nextUrl;
      for (const key of Object.keys(entry)) if (entry[key] === null) delete entry[key];
    }
  }
  return compact;
}


export function packBackup(state) {
  const packed = compactBackupState(state);
  if (packed.accountHistory) {
    const entries = packed.accountHistory.entries;
    const fields = [...new Set(entries.flatMap(entry => Object.keys(entry)))];
    packed.accountHistory.entries = {
      fields,
      rows: entries.map(entry => fields.map(field => entry[field] ?? null))
    };
  }
  return { format: 'rezka-progress', version: 3, exportedAt: Date.now(), state: packed };
}

export function unpackBackup(backup) {
  if (backup?.format !== 'rezka-progress' || backup.version !== 3) return backup;
  const state = structuredClone(backup.state);
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw Error('Некорректное состояние в копии.');
  if (state.accountHistory) {
    const table = state.accountHistory.entries;
    if (!Array.isArray(table?.fields) || !table.fields.every(field => typeof field === 'string')
      || new Set(table.fields).size !== table.fields.length || !Array.isArray(table.rows)) throw Error('Некорректная таблица истории.');
    state.accountHistory.entries = table.rows.map(row => {
      if (!Array.isArray(row) || row.length !== table.fields.length) throw Error('Некорректная строка истории.');
      return Object.fromEntries(table.fields.flatMap((field, index) => row[index] === null ? [] : [[field, row[index]]]));
    });
  }
  return { ...backup, version: 2, state };
}
