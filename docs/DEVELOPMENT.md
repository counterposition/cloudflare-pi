# Development

Working on the code. To deploy your own copy, follow `README.md`; for how it works, see `docs/ARCHITECTURE.md`.

## Toolchain

- **Node.js >= 24**
- **pnpm 12.9.1** (pinned via `packageManager`; Corepack: `corepack enable pnpm`)
- **Docker** — the container image is built from the repo `Dockerfile` (Node 24 Debian with bash, git, ripgrep, coreutils, certificates). The build context is restricted to `Dockerfile` and `container/`.
- **Wrangler** (installed as a dev dependency).

With [mise](https://mise.jdx.dev), `mise install` provisions Node 24 and pnpm 12.9.1 from `mise.toml`, and `mise run <task>` wraps the package scripts (`mise run check` runs format check, typecheck, lint, tests, and dry-run build).

Install with a frozen lockfile:

```sh
pnpm install --frozen-lockfile
```

## The original deployment's account

That account already has every Cloudflare resource provisioned: R2 enabled with its zero-base-price usage subscription, the `workspace-backups` bucket, and an Access application with an owner-only email allow policy whose AUD is the one in `wrangler.jsonc`. If you're working against it, don't recreate them. Don't bypass Access for testing; anonymous requests are expected to be redirected (302) to Access.

## Gates

```sh
pnpm dev          # wrangler dev
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test         # vitest: node, workerd SQL, and workerd PiHarness projects
pnpm build        # wrangler deploy --dry-run
pnpm deploy
pnpm exec wrangler tail cloudflare-pi --format pretty   # live tail of the deployed Worker
```

TypeScript is pinned at 7.0.2 and the compatibility date at 2026-10-03 (`pnpm-workspace.yaml` pins workerd `1.20261001.1` to support it). Do not downgrade either to evade test failures.

## Local limitations

Local dev depends on Docker and authenticated remote bindings for platform-backed services, and it doesn't prove production Access configuration or hosted durability. Passing local gates is not runtime proof; see _What counts as proof_ in `docs/VERIFICATION.md`.
