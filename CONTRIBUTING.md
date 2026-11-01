# Contributing to OSSS

Thanks for helping out! Bug reports, ideas, docs fixes and code are all welcome.

## Ways to help

- **Report a bug or ask for a feature** by [opening an issue](https://github.com/AGamesTeam/Open-Source-Storage-System/issues/new/choose).
- **Try it in your game** and tell us what was confusing. Docs fixes count as contributions too.
- **Pick up an issue.** Leave a comment first so two people don't work on the same thing.

## Working on the code

You need [Node.js](https://nodejs.org/) 22.18 or newer. Roblox Studio is only needed to test the Luau module.

```bash
git clone https://github.com/AGamesTeam/Open-Source-Storage-System
cd Open-Source-Storage-System/server
npm install
npm test
npm run typecheck
```

To run a local server while you work:

```bash
cp .env.example .env    # then put a key from `npm run gen-key` in it
npm start
```

### Where things are

| Path | What it is |
| --- | --- |
| `server/src/storage.ts` | All database reads and writes (SQLite) |
| `server/src/server.ts` | HTTP routes, auth and permissions |
| `server/src/config.ts` | Environment variables and API keys |
| `server/public/dashboard.html` | The admin dashboard (one file, no build step) |
| `server/test/` | Server tests (`node:test`) |
| `roblox/src/init.luau` | The Luau client module |
| `roblox/src/Migrate.luau` | DataStore migration helpers |
| `docs/` | Guides |

### Guidelines

- **Keep the server dependency-free at runtime.** It runs straight from TypeScript using Node's built-in type stripping, so only use syntax Node can strip (no `enum`s or parameter properties). `npm run typecheck` checks this.
- **Add a test** for any server change in `server/test/`.
- **Keep the Luau API close to Roblox DataStores** so it's familiar. If you add a method, add it to [docs/roblox.md](docs/roblox.md).
- **Test Luau changes in Studio** and say what you tried in the pull request, since CI can only check syntax.
- **Update the docs** when behavior changes.

## Pull requests

1. Fork the repo and make a branch.
2. Make your change, with tests and docs.
3. Run `npm test` and `npm run typecheck` in `server/`.
4. Open a pull request saying what changed and why.

By contributing, you agree your work is released under the [MIT License](LICENSE).
