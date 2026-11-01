// Discord leaderboard: keeps one message in a Discord channel updated with a store's top scores.
// Works with any store of numbers, such as the clicker example's ClickLeaderboard.
//
// Settings (environment variables):
//   OSSS_URL                   Your server's address, e.g. https://storage.example.com  (required)
//   OSSS_API_KEY               An API key. A read-only key limited to the store is best.  (required)
//   DISCORD_WEBHOOK_URL        Discord webhook for the channel to post in.  (required)
//   LEADERBOARD_STORE          Store to show. Default "ClickLeaderboard".
//   LEADERBOARD_TITLE          Message title. Default "🏆 Leaderboard".
//   LEADERBOARD_SIZE           How many places to show. Default 10.
//   LEADERBOARD_EVERY_SECONDS  How often to refresh. Default 60.
//   LEADERBOARD_STATE_FILE     Where to remember which message to edit. Default ".leaderboard-message".
//
// Keys are treated as Roblox UserIds and shown as usernames.
//
// Usage: npm run discord-leaderboard   (reads .env), or: node tools/discord-leaderboard.ts
import { readFileSync, writeFileSync } from "node:fs";
import { editMessage, formatLeaderboard, postMessage, requireEnv } from "./discord.ts";

const nameCache = new Map<string, string>();

/** Turns UserId keys into Roblox usernames, in one request for all unknown ones. */
async function resolveNames(keys: string[]): Promise<void> {
  const unknown = keys.filter((key) => !nameCache.has(key) && /^\d+$/.test(key));
  if (unknown.length > 0) {
    try {
      const res = await fetch("https://users.roblox.com/v1/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: unknown.map(Number), excludeBannedUsers: false }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const { data } = (await res.json()) as { data: { id: number; name: string }[] };
        for (const user of data) nameCache.set(String(user.id), user.name);
      }
    } catch (err) {
      console.error("[leaderboard] Couldn't look up usernames:", (err as Error).message);
    }
  }
  for (const key of keys) if (!nameCache.has(key)) nameCache.set(key, `Player ${key}`);
}

async function main(): Promise<void> {
  const osssUrl = requireEnv("OSSS_URL").replace(/\/+$/, "");
  const apiKey = requireEnv("OSSS_API_KEY");
  const webhook = requireEnv("DISCORD_WEBHOOK_URL");
  const store = process.env.LEADERBOARD_STORE || "ClickLeaderboard";
  const title = process.env.LEADERBOARD_TITLE || "🏆 Leaderboard";
  const size = Number(process.env.LEADERBOARD_SIZE || 10);
  const everyMs = Number(process.env.LEADERBOARD_EVERY_SECONDS || 60) * 1000;
  const stateFile = process.env.LEADERBOARD_STATE_FILE || ".leaderboard-message";

  let messageId: string | null = null;
  try {
    messageId = readFileSync(stateFile, "utf8").trim() || null;
  } catch {}
  let lastDescription = "";

  async function refresh(): Promise<void> {
    const res = await fetch(`${osssUrl}/v1/stores/${encodeURIComponent(store)}/sorted?limit=${size}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`OSSS returned HTTP ${res.status}: ${await res.text()}`);
    const { entries } = (await res.json()) as { entries: { key: string; value: number }[] };

    await resolveNames(entries.map((e) => e.key));
    const embed = formatLeaderboard(title, entries.map((e) => ({ name: nameCache.get(e.key)!, score: e.value })));
    if (embed.description === lastDescription && messageId) return; // nothing changed

    embed.timestamp = new Date().toISOString();
    if (!messageId || !(await editMessage(webhook, messageId, embed))) {
      messageId = await postMessage(webhook, embed);
      writeFileSync(stateFile, messageId);
      console.log(`[leaderboard] Posted a new leaderboard message (${messageId})`);
    }
    lastDescription = embed.description ?? "";
  }

  const run = async (): Promise<void> => {
    try {
      await refresh();
    } catch (err) {
      console.error("[leaderboard] Refresh failed:", (err as Error).message);
    }
  };
  console.log(`[leaderboard] Showing the top ${size} of "${store}", refreshing every ${everyMs / 1000}s`);
  await run();
  setInterval(run, everyMs);
}

await main();
