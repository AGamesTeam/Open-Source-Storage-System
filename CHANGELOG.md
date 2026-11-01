# Changelog

## 0.2.0

**Version history**
- Every write is recorded. The last 20 versions of each key are kept for up to 30 days (`OSSS_HISTORY_VERSIONS`, `OSSS_HISTORY_DAYS`).
- New Luau methods: `ListVersionsAsync`, `GetVersionAsync` and `RestoreVersionAsync`.
- The dashboard has a **History** list for each key, where you can view and restore old versions.
- Deleted keys keep their history, so they can be brought back.

**Live change notifications**
- New Luau method `store:Watch(callback)`: every server hears about changes to a store within about a second, including whether the change came from itself.
- New `GET /v1/stores/{store}/changes` long-polling endpoint.

**Backups and tools**
- `OSSS_BACKUP_COPY_DIR` copies every backup to a second folder, such as another drive.
- `npm run monitor`: Discord alerts when the server goes down and comes back.
- `npm run discord-leaderboard`: keeps a Discord message updated with a store's top scores.

**Other**
- Clicker example game in `examples/clicker`.
- On shutdown, open change-feed requests are closed right away instead of holding the server open.

Existing databases are upgraded automatically on startup. History starts from the first write after upgrading.

## 0.1.0

First release: self-hosted server with SQLite, a DataStore-style Luau module, versioned writes, session locks, batching, leaderboards, admin dashboard, limited-access keys, backups, export, caching and a migration helper.
