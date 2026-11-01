import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { runBackup } from "../src/backup.ts";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/server.ts";
import { Storage } from "../src/storage.ts";

const API_KEY = "test-key-that-is-long-enough-for-osss-0001";
const READ_KEY = "read-only-key-that-is-long-enough-0000001";
const SCOPED_KEY = "scoped-write-key-that-is-long-enough-00001";

let baseUrl: string;
let storage: Storage;
let close: () => Promise<void>;
const tempDir = mkdtempSync(join(tmpdir(), "osss-test-"));

before(async () => {
  const keysFile = join(tempDir, "keys.json");
  writeFileSync(
    keysFile,
    JSON.stringify([
      { name: "reader", key: READ_KEY, access: "read" },
      { name: "scoped", key: SCOPED_KEY, access: "write", stores: ["allowed"] },
    ]),
  );
  const config = loadConfig({ OSSS_API_KEYS: API_KEY, OSSS_KEYS_FILE: keysFile, OSSS_MAX_BODY_BYTES: "1024" });
  storage = new Storage(join(tempDir, "test.db"));
  const server = createApp(config, storage);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () =>
    new Promise((resolve) =>
      server.close(() => {
        storage.close();
        resolve();
      }),
    );
});

after(async () => {
  await close();
  rmSync(tempDir, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: any }> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

describe("auth", () => {
  test("health check needs no key", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
  });

  test("rejects a missing or wrong key", async () => {
    assert.equal((await fetch(`${baseUrl}/v1/stores/a/keys/b`)).status, 401);
    const res = await fetch(`${baseUrl}/v1/stores/a/keys/b`, { headers: { Authorization: "Bearer nope" } });
    assert.equal(res.status, 401);
  });

  test("refuses to start without a key", () => {
    assert.throws(() => loadConfig({}), /OSSS_API_KEYS/);
    assert.throws(() => loadConfig({ OSSS_API_KEYS: "short" }), /at least 32/);
  });

  test("whoami describes the key", async () => {
    const me = await call("GET", "/v1/whoami", undefined, { Authorization: `Bearer ${READ_KEY}` });
    assert.deepEqual(me.data, { name: "reader", access: "read", stores: null });
  });

  test("read-only keys can read but not write", async () => {
    await call("PUT", "/v1/stores/perm/keys/a", { value: 1 });
    const reader = { Authorization: `Bearer ${READ_KEY}` };
    assert.equal((await call("GET", "/v1/stores/perm/keys/a", undefined, reader)).status, 200);
    assert.equal((await call("PUT", "/v1/stores/perm/keys/a", { value: 2 }, reader)).status, 403);
    assert.equal((await call("DELETE", "/v1/stores/perm/keys/a/lock?force=true", undefined, reader)).status, 403);

    const batch = await call("POST", "/v1/batch", {
      operations: [
        { op: "get", store: "perm", key: "a" },
        { op: "set", store: "perm", key: "a", value: 3 },
      ],
    }, reader);
    assert.equal(batch.data.results[0].ok, true);
    assert.equal(batch.data.results[1].status, 403);
  });

  test("store-scoped keys only see their stores", async () => {
    const scoped = { Authorization: `Bearer ${SCOPED_KEY}` };
    assert.equal((await call("PUT", "/v1/stores/allowed/keys/a", { value: 1 }, scoped)).status, 200);
    assert.equal((await call("PUT", "/v1/stores/other/keys/a", { value: 1 }, scoped)).status, 403);
    assert.equal((await call("GET", "/v1/stores/perm/keys/a", undefined, scoped)).status, 403);

    const { data } = await call("GET", "/v1/stores", undefined, scoped);
    assert.deepEqual(data.stores.map((s: { name: string }) => s.name), ["allowed"]);
  });
});

describe("dashboard", () => {
  test("is served without a key, with a strict content policy", async () => {
    const res = await fetch(`${baseUrl}/dashboard`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.match(await res.text(), /OSSS Dashboard/);
  });
});

describe("keys", () => {
  test("set, get and remove a value", async () => {
    const value = { coins: 10, items: ["sword", "shield"] };
    assert.equal((await call("GET", "/v1/stores/players/keys/1")).status, 404);

    const set = await call("PUT", "/v1/stores/players/keys/1", { value });
    assert.equal(set.status, 200);
    assert.equal(set.data.version, 1);

    const got = await call("GET", "/v1/stores/players/keys/1");
    assert.deepEqual(got.data.value, value);
    assert.equal(got.data.version, 1);

    const removed = await call("DELETE", "/v1/stores/players/keys/1");
    assert.deepEqual(removed.data.value, value);
    assert.equal((await call("GET", "/v1/stores/players/keys/1")).status, 404);
  });

  test("keys and stores with special characters round-trip", async () => {
    const path = `/v1/stores/${encodeURIComponent("my store")}/keys/${encodeURIComponent("a/b?c%d")}`;
    await call("PUT", path, { value: "ok" });
    assert.equal((await call("GET", path)).data.value, "ok");
  });

  test("ifVersion rejects a stale write and returns the current value", async () => {
    const path = "/v1/stores/players/keys/versioned";
    assert.equal((await call("PUT", path, { value: 1, ifVersion: 0 })).status, 200);
    assert.equal((await call("PUT", path, { value: 2, ifVersion: 0 })).status, 409);

    const conflict = await call("PUT", path, { value: 2, ifVersion: 5 });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.current.value, 1);
    assert.equal(conflict.data.current.version, 1);

    assert.equal((await call("PUT", path, { value: 2, ifVersion: 1 })).data.version, 2);
  });

  test("increment adds to a number and rejects non-numbers", async () => {
    const path = "/v1/stores/counters/keys/visits";
    assert.equal((await call("POST", `${path}/increment`, {})).data.value, 1);
    assert.equal((await call("POST", `${path}/increment`, { delta: 5 })).data.value, 6);

    await call("PUT", "/v1/stores/counters/keys/text", { value: "hi" });
    assert.equal((await call("POST", "/v1/stores/counters/keys/text/increment", { delta: 1 })).status, 409);
  });

  test("lists keys by prefix with paging", async () => {
    for (const key of ["p_1", "p_2", "p_3", "q_1"]) await call("PUT", `/v1/stores/list/keys/${key}`, { value: true });

    const page1 = await call("GET", "/v1/stores/list/keys?prefix=p_&limit=2");
    assert.deepEqual(page1.data.keys, ["p_1", "p_2"]);
    assert.equal(page1.data.nextCursor, "p_2");

    const page2 = await call("GET", `/v1/stores/list/keys?prefix=p_&limit=2&cursor=${page1.data.nextCursor}`);
    assert.deepEqual(page2.data.keys, ["p_3"]);
    assert.equal(page2.data.nextCursor, null);
  });

  test("lists stores with key counts", async () => {
    const { data } = await call("GET", "/v1/stores");
    const list = data.stores.find((s: { name: string }) => s.name === "list");
    assert.equal(list.keys, 4);
  });

  test("sorts numeric values for leaderboards", async () => {
    const scores: Record<string, unknown> = { ann: 50, bob: 120, cat: 75, dan: 120, eve: "not a number" };
    for (const [key, value] of Object.entries(scores)) await call("PUT", `/v1/stores/scores/keys/${key}`, { value });

    const top = await call("GET", "/v1/stores/scores/sorted?limit=3");
    assert.deepEqual(top.data.entries, [
      { key: "bob", value: 120 },
      { key: "dan", value: 120 },
      { key: "cat", value: 75 },
    ]);
    const next = await call("GET", `/v1/stores/scores/sorted?limit=3&cursor=${top.data.nextCursor}`);
    assert.deepEqual(next.data.entries, [{ key: "ann", value: 50 }]);
    assert.equal(next.data.nextCursor, null);

    const ranged = await call("GET", "/v1/stores/scores/sorted?order=asc&min=60&max=100");
    assert.deepEqual(ranged.data.entries, [{ key: "cat", value: 75 }]);
  });

  test("rejects bad bodies", async () => {
    assert.equal((await call("PUT", "/v1/stores/a/keys/b", { nope: 1 })).status, 400);
    const big = await call("PUT", "/v1/stores/a/keys/b", { value: "x".repeat(2000) });
    assert.equal(big.status, 413);
  });
});

describe("session locks", () => {
  const path = "/v1/stores/players/keys/locked";
  const serverA = { "OSSS-Lock-Owner": "server-a" };
  const serverB = { "OSSS-Lock-Owner": "server-b" };

  test("only the lock owner can write", async () => {
    assert.equal((await call("POST", `${path}/lock`, { ttlSeconds: 60 }, serverA)).status, 200);

    const blocked = await call("POST", `${path}/lock`, { ttlSeconds: 60 }, serverB);
    assert.equal(blocked.status, 423);
    assert.equal(blocked.data.owner, "server-a");

    assert.equal((await call("PUT", path, { value: 1 }, serverB)).status, 423);
    assert.equal((await call("PUT", path, { value: 1 })).status, 423);
    assert.equal((await call("PUT", path, { value: 1 }, serverA)).status, 200);
    assert.equal((await call("GET", path, undefined, serverB)).status, 200);
  });

  test("anyone with read access can see the lock, and admins can force it open", async () => {
    const seen = await call("GET", `${path}/lock`);
    assert.equal(seen.data.lock.owner, "server-a");

    assert.equal((await call("DELETE", `${path}/lock?force=true`)).data.released, true);
    assert.equal((await call("GET", `${path}/lock`)).data.lock, null);
    await call("POST", `${path}/lock`, { ttlSeconds: 60 }, serverA);
  });

  test("unlocking lets other servers in", async () => {
    assert.equal((await call("DELETE", `${path}/lock`, undefined, serverB)).data.released, false);
    assert.equal((await call("DELETE", `${path}/lock`, undefined, serverA)).data.released, true);
    assert.equal((await call("PUT", path, { value: 2 }, serverB)).status, 200);
  });
});

describe("batch", () => {
  test("runs several operations and reports each result", async () => {
    const res = await call("POST", "/v1/batch", {
      operations: [
        { op: "set", store: "batch", key: "a", value: { n: 1 } },
        { op: "increment", store: "batch", key: "b", delta: 3 },
        { op: "get", store: "batch", key: "a" },
        { op: "get", store: "batch", key: "missing" },
        { op: "set", store: "batch", key: "a", value: 2, ifVersion: 0 },
        { op: "explode", store: "batch", key: "a" },
      ],
    });
    assert.equal(res.status, 200);
    const [set, inc, get, missing, conflict, bad] = res.data.results;
    assert.equal(set.ok, true);
    assert.equal(inc.value, 3);
    assert.deepEqual(get.value, { n: 1 });
    assert.equal(missing.version, 0);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.status, 409);
    assert.equal(bad.status, 400);
  });

  test("batch keys are used as-is, not URL-decoded", async () => {
    await call("POST", "/v1/batch", { operations: [{ op: "set", store: "batch", key: "100%", value: 1 }] });
    assert.equal((await call("GET", `/v1/stores/batch/keys/${encodeURIComponent("100%")}`)).data.value, 1);
  });
});

describe("backup and export", () => {
  test("backups are complete copies and old ones are pruned", async () => {
    const dir = join(tempDir, "backups");
    for (let i = 0; i < 3; i++) {
      await runBackup(storage, dir, 2);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const files = readdirSync(dir);
    assert.equal(files.length, 2);

    const copy = new Storage(join(dir, files[1]));
    assert.deepEqual(copy.get("players", "versioned")?.value, 2);
    copy.close();
  });

  test("export yields every entry", () => {
    const entries = [...storage.exportAll()];
    assert.ok(entries.some((e) => e.store === "scores" && e.key === "bob" && e.value === 120));
  });
});

describe("version history", () => {
  const path = "/v1/stores/hist/keys/player";

  test("records every write, newest first, and can show any version", async () => {
    await call("PUT", path, { value: { coins: 1 } }, { "OSSS-Lock-Owner": "server-a" });
    await call("PUT", path, { value: { coins: 2 } });
    await call("PUT", path, { value: { coins: 3 } });

    const { data } = await call("GET", `${path}/history`);
    assert.deepEqual(data.versions.map((v: { version: number }) => v.version), [3, 2, 1]);
    assert.equal(data.versions[2].author, "server-a");
    assert.ok(data.versions[0].size > 0);

    const old = await call("GET", `${path}/history/${data.versions[2].id}`);
    assert.deepEqual(old.data.value, { coins: 1 });
  });

  test("restore writes an old value back as a new version", async () => {
    const { data } = await call("GET", `${path}/history`);
    const first = data.versions[data.versions.length - 1];

    const restored = await call("POST", `${path}/restore`, { id: first.id, ifVersion: 3 });
    assert.equal(restored.status, 200);
    assert.equal(restored.data.version, 4);
    assert.deepEqual((await call("GET", path)).data.value, { coins: 1 });

    assert.equal((await call("POST", `${path}/restore`, { id: first.id, ifVersion: 3 })).status, 409);
    assert.equal((await call("POST", `${path}/restore`, { id: 999999 })).status, 404);
  });

  test("removes are recorded and can be undone", async () => {
    await call("DELETE", path);
    const { data } = await call("GET", `${path}/history`);
    assert.equal(data.versions[0].op, "remove");
    assert.equal((await call("POST", `${path}/restore`, { id: data.versions[0].id })).status, 404);

    await call("POST", `${path}/restore`, { id: data.versions[1].id });
    assert.deepEqual((await call("GET", path)).data.value, { coins: 1 });
  });

  test("keeps only the newest versions of each key", () => {
    const small = new Storage(":memory:", { historyVersions: 3 });
    for (let i = 1; i <= 5; i++) small.set("s", "k", i);
    assert.deepEqual(small.history("s", "k", 10).map((v) => v.version), [5, 4, 3]);
    small.close();
  });

  test("pruning by age keeps each key's newest version", () => {
    const small = new Storage(":memory:");
    small.set("s", "a", 1);
    small.set("s", "a", 2);
    small.set("s", "b", 1);
    assert.equal(small.pruneHistory(-1000), 1);
    assert.deepEqual(small.history("s", "a", 10).map((v) => v.version), [2]);
    assert.equal(small.history("s", "b", 10).length, 1);
    small.close();
  });
});

describe("change feed", () => {
  test("starts from now, then returns new writes with values", async () => {
    const start = await call("GET", "/v1/stores/feed/changes");
    assert.deepEqual(start.data.changes, []);

    await call("PUT", "/v1/stores/feed/keys/a", { value: 1 }, { "OSSS-Lock-Owner": "server-a" });
    await call("PUT", "/v1/stores/other/keys/a", { value: 1 });
    await call("DELETE", "/v1/stores/feed/keys/a");

    const next = await call("GET", `/v1/stores/feed/changes?since=${start.data.cursor}`);
    assert.deepEqual(
      next.data.changes.map((c: { key: string; op: string; value: unknown; author: string | null }) => [c.key, c.op, c.value, c.author]),
      [["a", "set", 1, "server-a"], ["a", "remove", null, null]],
    );
    assert.equal(next.data.reset, false);

    const empty = await call("GET", `/v1/stores/feed/changes?since=${next.data.cursor}`);
    assert.deepEqual(empty.data.changes, []);
  });

  test("waits for the next write when asked to", async () => {
    const { data } = await call("GET", "/v1/stores/feed/changes");
    const started = Date.now();
    const waiting = call("GET", `/v1/stores/feed/changes?since=${data.cursor}&wait=5`);
    setTimeout(() => call("PUT", "/v1/stores/feed/keys/b", { value: "hi" }), 200);

    const result = await waiting;
    assert.equal(result.data.changes[0].value, "hi");
    assert.ok(Date.now() - started < 3000, "should return as soon as the write happens");
  });

  test("a wait with no writes times out with no changes", async () => {
    const { data } = await call("GET", "/v1/stores/feed/changes");
    const result = await call("GET", `/v1/stores/feed/changes?since=${data.cursor}&wait=1`);
    assert.deepEqual(result.data.changes, []);
    assert.equal(result.data.cursor >= data.cursor, true);
  });
});

describe("backup copies", () => {
  test("copies each backup to a second folder", async () => {
    const dir = join(tempDir, "backups-main");
    const copyDir = join(tempDir, "backups-copy");
    await runBackup(storage, dir, 5, copyDir);
    assert.equal(readdirSync(copyDir).length, 1);
    assert.deepEqual(readdirSync(copyDir), readdirSync(dir));
  });
});
