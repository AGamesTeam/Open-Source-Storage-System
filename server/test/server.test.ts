import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/server.ts";
import { Storage } from "../src/storage.ts";

const API_KEY = "test-key-that-is-long-enough-for-osss-0001";

let baseUrl: string;
let close: () => Promise<void>;

before(async () => {
  const config = loadConfig({ OSSS_API_KEYS: API_KEY, OSSS_MAX_BODY_BYTES: "1024" });
  const storage = new Storage(":memory:");
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

after(() => close());

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
