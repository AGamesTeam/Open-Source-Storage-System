# Clicker example

A tiny working game that saves to OSSS. It shows the main features in about 300 lines:

- A big green **button** in the world. Clicking it raises your **Clicks** leaderstat.
- **Saves every 5 seconds** and when you leave. Each save writes your data and your leaderboard score in one request with `BatchAsync`.
- **Session locking:** your data can't be saved by two servers at once, and the lock is renewed while you play.
- An **all-time top 10 board** in the world, read with `GetSortedAsync`.

## Try it

1. Run an OSSS server and give it an HTTPS address. See [self-hosting](../../docs/self-hosting.md).
2. In Studio, publish your place and turn on *Game Settings → Security → Allow HTTP Requests*.
3. Add the [OSSS module](../../roblox/src/init.luau) as a ModuleScript named `OSSS` in `ServerScriptService`.
4. Add [`ClickerDemo.server.luau`](ClickerDemo.server.luau) as a Script in `ServerScriptService`. Set `URL` and `API_KEY` at the top.
5. Press **Play** and click the button.

Then open your server's `/dashboard`. `PlayerData` has a key for your UserId holding `{ "clicks": N }`, and `ClickLeaderboard` has your score. Stop and press Play again, and your clicks load back from the database.

Before real players join, move the key into a Roblox Secret. The comment at the top of the script shows how.
