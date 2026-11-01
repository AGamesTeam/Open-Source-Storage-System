# HTTP API

The Luau module uses this API, but you can call it from anything: an admin dashboard, a Discord bot, or a migration script.

All requests and responses are JSON. Store names and keys in URLs must be URL-encoded, and can be 1 to 512 characters.

## Auth

Every endpoint except `/health` needs your API key:

```
Authorization: Bearer <your API key>
```

Writes can also send `OSSS-Lock-Owner: <server id>` to identify who is writing, for [session locks](#session-locks). The Luau module sets it to the server's `JobId`.

## Endpoints

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/health` | | `{ "ok": true }` |
| `GET` | `/dashboard` | | The [admin dashboard](self-hosting.md#dashboard) page (no key needed to load it) |
| `GET` | `/v1/whoami` | | `{ name, access, stores }` for the key you used |
| `GET` | `/v1/stores` | | `{ stores: [{ name, keys }] }`, only stores your key can read |
| `GET` | `/v1/stores/{store}/keys/{key}` | | `{ value, version, updatedAt }` or `404` |
| `PUT` | `/v1/stores/{store}/keys/{key}` | `{ value, ifVersion? }` | `{ version, updatedAt }` |
| `DELETE` | `/v1/stores/{store}/keys/{key}?ifVersion=` | | `{ value, version, updatedAt }` (the removed entry) or `404` |
| `POST` | `/v1/stores/{store}/keys/{key}/increment` | `{ delta? }` | `{ value, version, updatedAt }` |
| `GET` | `/v1/stores/{store}/keys?prefix=&limit=&cursor=` | | `{ keys, nextCursor }` |
| `GET` | `/v1/stores/{store}/sorted?order=&limit=&cursor=&min=&max=` | | `{ entries: [{ key, value }], nextCursor }` |
| `GET` | `/v1/stores/{store}/keys/{key}/history?limit=` | | `{ versions: [{ id, version, op, updatedAt, size, author }] }`, newest first |
| `GET` | `/v1/stores/{store}/keys/{key}/history/{id}` | | `{ id, version, op, value, updatedAt, author }` |
| `POST` | `/v1/stores/{store}/keys/{key}/restore` | `{ id, ifVersion? }` | `{ version, updatedAt }` |
| `GET` | `/v1/stores/{store}/changes?since=&wait=&limit=` | | `{ changes, cursor, reset }`. See [change feed](#change-feed). |
| `GET` | `/v1/stores/{store}/keys/{key}/lock` | | `{ lock: { owner, expiresAt } }` or `{ lock: null }` |
| `POST` | `/v1/stores/{store}/keys/{key}/lock` | `{ ttlSeconds }` | `{ owner, expiresAt }` |
| `DELETE` | `/v1/stores/{store}/keys/{key}/lock` | | `{ released }` |
| `DELETE` | `/v1/stores/{store}/keys/{key}/lock?force=true` | | `{ released }`. Admin keys only. Removes anyone's lock. |
| `POST` | `/v1/batch` | `{ operations }` | `{ results }` |

- `version` goes up by 1 on every write, starting at 1. It restarts if the key is removed.
- `updatedAt` is a Unix timestamp in milliseconds.
- `limit` for listing defaults to 100, max 1000. Pass the returned `nextCursor` as `cursor` to get the next page.
- `sorted` only includes keys whose value is a number. `order` is `desc` (default) or `asc`. Ties are sorted by key.

## Permissions

What a key can do depends on its `access` level and `stores` list. See [limited-access keys](self-hosting.md#limited-access-keys).

| Needs | Endpoints |
| --- | --- |
| `read` | Every `GET`, and `get` in a batch |
| `write` | `PUT`, `DELETE`, increment, lock and unlock, and other batch operations |
| `admin` | Force unlock |

A request the key isn't allowed to make gets `403`. In a batch, only that operation fails.

## Safe updates with `ifVersion`

Send `ifVersion` to write only if the stored version still matches. Use `0` to mean "only if the key doesn't exist yet."

If someone else wrote first, you get `409` with the current entry, so you can retry without another read:

```json
{
  "error": "version_conflict",
  "message": "The value was changed by someone else. Read it again and retry.",
  "current": { "value": { "coins": 50 }, "version": 7, "updatedAt": 1793531397946 }
}
```

## Version history

Every write is recorded. The server keeps the newest `OSSS_HISTORY_VERSIONS` versions of each key (20 by default), for up to `OSSS_HISTORY_DAYS` days (30 by default). Each key's newest version is always kept.

- `op` is `set` for a saved value, or `remove` for a deletion. Removes have no value.
- `author` is the `OSSS-Lock-Owner` of whoever wrote it, if they sent one. For the Luau module, that's the game server's `JobId`.
- `id` identifies one recorded write. Use it to fetch or restore that version.

`restore` saves an old version's value as a new version. It goes through the same lock and `ifVersion` checks as `PUT`, and the value it replaces stays in history, so a restore can be undone too. Restoring an `id` whose `op` is `remove`, or one that's been pruned, returns `404`.

To bring back a deleted key, list its history (it still has one after deletion) and restore the last `set`.

## Change feed

Lets other servers find out when keys change, without checking every key.

1. Call `GET /v1/stores/{store}/changes` with no `since`. It returns `cursor`, the starting point.
2. Call it again with `since=<cursor>&wait=20`. If something already changed, it returns at once. Otherwise it waits up to `wait` seconds (max 25) for a write, then returns.
3. Each change is `{ id, key, op, version, value, updatedAt, author }`, oldest first. Use the returned `cursor` as `since` next time.

`reset` is `true` if history was pruned past your `since`, so changes in between may be missing. Re-read anything you care about. If a key changes more than `OSSS_HISTORY_VERSIONS` times between two polls, only the newest versions are returned. You always get the latest value.

## Session locks

`POST .../lock` with an `OSSS-Lock-Owner` header takes the lock, or renews it if you already hold it. `ttlSeconds` can be 1 to 86400.

While a key is locked, any write to it (`PUT`, `DELETE`, increment, or batch) from a different owner, or with no owner, fails with `423`:

```json
{ "error": "locked", "message": "The key is locked by another server.", "owner": "job-id", "expiresAt": 1793531697946 }
```

Reads are never blocked. Locks expire on their own at `expiresAt`.

## Batch

Runs up to 100 operations in one request. Each one succeeds or fails on its own.

```json
{
  "operations": [
    { "op": "get", "store": "PlayerData", "key": "123" },
    { "op": "set", "store": "PlayerData", "key": "123", "value": { "coins": 5 }, "ifVersion": 3 },
    { "op": "remove", "store": "PlayerData", "key": "old" },
    { "op": "increment", "store": "Stats", "key": "visits", "delta": 1 }
  ]
}
```

Inside a batch, store names and keys are plain strings, not URL-encoded. Results come back in the same order. A missing key in `get` or `remove` returns `{ "ok": true, "value": null, "version": 0 }`. A failed operation returns `{ "ok": false, "status": 409, "error": "...", "message": "..." }`.

## Errors

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | The request is missing something or has the wrong type. |
| 401 | `unauthorized` | Missing or wrong API key. |
| 403 | `forbidden` | The key doesn't have access to that store or action. |
| 404 | `not_found` | No value for that key, no such history version, or unknown endpoint. |
| 409 | `version_conflict` | `ifVersion` didn't match. |
| 409 | `not_a_number` | Tried to increment a value that isn't a number. |
| 413 | `too_large` | Body is bigger than `OSSS_MAX_BODY_BYTES`. |
| 423 | `locked` | Another server holds the session lock. |
| 500 | `internal` | Server error. Check the server logs. |
