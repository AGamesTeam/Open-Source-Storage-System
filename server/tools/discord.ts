// Small helpers for posting to a Discord webhook.

export interface Embed {
  title?: string;
  description?: string;
  color?: number;
  footer?: { text: string };
  timestamp?: string;
}

export const COLORS = { green: 0x2ecc71, red: 0xe74c3c, gold: 0xf1c40f };

/** Posts a message and returns its id. */
export async function postMessage(webhookUrl: string, embed: Embed): Promise<string> {
  const res = await fetch(withWait(webhookUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Discord returned HTTP ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

/** Edits a message this webhook posted. Returns false if the message no longer exists. */
export async function editMessage(webhookUrl: string, messageId: string, embed: Embed): Promise<boolean> {
  const url = new URL(webhookUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/messages/${messageId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Discord returned HTTP ${res.status}: ${await res.text()}`);
  return true;
}

function withWait(webhookUrl: string): URL {
  const url = new URL(webhookUrl);
  url.searchParams.set("wait", "true");
  return url;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. See the comment at the top of this file.`);
    process.exit(1);
  }
  return value;
}

export interface Row {
  name: string;
  score: number;
}

const MEDALS = ["🥇", "🥈", "🥉"];

export function formatLeaderboard(title: string, rows: Row[]): Embed {
  const lines = rows.map((row, i) => `${MEDALS[i] ?? `**${i + 1}.**`} ${escapeMarkdown(row.name)}: **${row.score.toLocaleString("en-US")}**`);
  return {
    title,
    description: lines.length > 0 ? lines.join("\n") : "No scores yet.",
    color: COLORS.gold,
    footer: { text: "Live from OSSS" },
  };
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>])/g, "\\$1");
}
