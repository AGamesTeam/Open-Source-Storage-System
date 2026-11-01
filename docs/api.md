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
| `GET` | `/v1/stores/{store}/keys/{key}` | | `{ value, version, updatedAt }` or `404` |
| `PUT` | `/v1/stores/{store}/keys/{key}` | `{ value, ifVersion? }` | `{ version, updatedAt }` |
| `DELETE` | `/v1/stores/{store}/keys/{key}?ifVersion=` | | `{ value, version, updatedAt }` (the removed entry) or `404` |
| `POST` | `/v1/stores/{store}/keys/{key}/increment` | `{ delta? }` | `{ value, version, updatedAt }` |
| `GET` | `/v1/stores/{store}/keys?prefix=&limit=&cursor=` | | `{ keys, nextCursor }` |
| `POST` | `/v1/stores/{store}/keys/{key}/lock` | `{ ttlSeconds }` | `{ owner, expiresAt }` |
| `DELETE` | `/v1/stores/{store}/keys/{key}/lock` | | `{ released }` |
| `POST` | `/v1/batch` | `{ operations }` | `{ results }` |

- `version` goes up by 1 on every write, starting at 1. It restarts if the key is removed.
- `updatedAt` is a Unix timestamp in milliseconds.
- `limit` for listing defaults to 100, max 1000. Pass the returned `nextCursor` as `cursor` to get the next page.

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
| 404 | `not_found` | No value for that key, or unknown endpoint. |
| 409 | `version_conflict` | `ifVersion` didn't match. |
| 409 | `not_a_number` | Tried to increment a value that isn't a number. |
| 413 | `too_large` | Body is bigger than `OSSS_MAX_BODY_BYTES`. |
| 423 | `locked` | Another server holds the session lock. |
| 500 | `internal` | Server error. Check the server logs. |
