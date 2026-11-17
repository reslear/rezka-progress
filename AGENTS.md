# Repository instructions

- Keep this extension dependency-free and build-free unless the task explicitly requires otherwise.
- Run `node --test extension.test.mjs` for changes to data, parsing or messaging.
- Never commit browsing history, account comparison files, backups, cookies, tokens or signed media URLs.
- Do not add automatic crawling of title pages or retries after HTTP 403/429.
- Preserve compatibility with existing storage and backup formats.
