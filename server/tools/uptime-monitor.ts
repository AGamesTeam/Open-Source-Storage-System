// Uptime monitor: checks your OSSS server and posts to Discord when it goes down or comes back.
//
// Run it on a different machine from the server if you can. If it runs on the same PC and the
// whole PC goes down, it can't tell you.
//
// Settings (environment variables):
//   MONITOR_URL            Your server's health URL, e.g. https://storage.example.com/health  (required)
//   DISCORD_WEBHOOK_URL    Discord webhook to post alerts to. Without it, alerts only go to the console.
//   MONITOR_NAME           Name used in alerts. Default "OSSS".
//   MONITOR_EVERY_SECONDS  How often to check. Default 60.
//   MONITOR_FAILURES       Failed checks in a row before alerting. Default 2.
//
// Usage: npm run monitor   (reads .env), or: node tools/uptime-monitor.ts
import { COLORS, postMessage, requireEnv, type Embed } from "./discord.ts";

const url = requireEnv("MONITOR_URL");
const webhook = process.env.DISCORD_WEBHOOK_URL ?? "";
const name = process.env.MONITOR_NAME || "OSSS";
const everyMs = Number(process.env.MONITOR_EVERY_SECONDS || 60) * 1000;
const failuresBeforeAlert = Number(process.env.MONITOR_FAILURES || 2);

let failures = 0;
let downSince: number | null = null;

async function check(): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    return (err as Error).cause ? String((err as Error).cause) : (err as Error).message;
  }
}

async function alert(embed: Embed): Promise<void> {
  console.log(`[monitor] ${embed.title}${embed.description ? `: ${embed.description}` : ""}`);
  if (!webhook) return;
  try {
    await postMessage(webhook, { ...embed, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error("[monitor] Couldn't post to Discord:", (err as Error).message);
  }
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

async function tick(): Promise<void> {
  const problem = await check();
  if (problem === null) {
    if (downSince !== null) {
      await alert({ title: `🟢 ${name} is back up`, description: `It was down for ${formatDuration(Date.now() - downSince)}.`, color: COLORS.green });
    }
    failures = 0;
    downSince = null;
    return;
  }

  failures++;
  if (failures === failuresBeforeAlert) {
    downSince = Date.now() - (failuresBeforeAlert - 1) * everyMs;
    await alert({
      title: `🔴 ${name} is down`,
      description: `${url} isn't responding (${problem}). Games can't load or save data until it's back.`,
      color: COLORS.red,
    });
  }
}

await alert({ title: `👀 Watching ${name}`, description: `Checking ${url} every ${everyMs / 1000}s.`, color: COLORS.gold });
await tick();
setInterval(tick, everyMs);
