# Security

OSSS stores game data, so security problems matter. Thanks for reporting them responsibly.

## Reporting a problem

**Don't open a public issue.** Instead, [report it privately on GitHub](https://github.com/AGamesTeam/Open-Source-Storage-System/security/advisories/new). Include what you found, how to reproduce it, and what an attacker could do with it.

We'll reply as soon as we can and keep you updated while it's fixed.

## Supported versions

Only the latest release gets security fixes while OSSS is before 1.0.

## Keeping your server safe

- Always put the server behind **HTTPS**. Your API key is sent with every request.
- Store your key in **Roblox Secrets**, never in a script.
- Give each tool its **own key** with only the access it needs. See [limited-access keys](docs/self-hosting.md#limited-access-keys).
- Only share the dashboard address with people you trust. It needs an API key, but there's no reason to make it easy to find.
- Keep **backups** and keep the server **up to date**.
