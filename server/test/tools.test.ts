import assert from "node:assert/strict";
import { test } from "node:test";
import { formatLeaderboard } from "../tools/discord.ts";

test("leaderboard shows medals, then numbers, with escaped names", () => {
  const embed = formatLeaderboard("Top", [
    { name: "ann", score: 1200 },
    { name: "bob_the_*builder*", score: 880 },
    { name: "cat", score: 75 },
    { name: "dan", score: 5 },
  ]);
  assert.equal(
    embed.description,
    ["🥇 ann: **1,200**", "🥈 bob\\_the\\_\\*builder\\*: **880**", "🥉 cat: **75**", "**4.** dan: **5**"].join("\n"),
  );
});

test("empty leaderboard says so", () => {
  assert.equal(formatLeaderboard("Top", []).description, "No scores yet.");
});
