# railway-testbed

A pattern for running a repository's test databases and brokers as **sleeping Railway services**
instead of local containers. Tests connect over public TCP proxies; a service that nobody talks to
sleeps and costs nothing, and the next connection wakes it. No Docker, OrbStack or Testcontainers
on the developer machine, and nothing to start before a test run.

This repository is the pattern, not a product: two example services (PostgreSQL and Redis) and the
three files that carry them. Copy them into a repository and replace the examples with what its
tests need. It was extracted from
[Qyl.Telemetry.AutoInstrumentation](https://github.com/ANcpLua/Qyl.Telemetry.AutoInstrumentation),
whose eight-service testbed (RabbitMQ, Kafka, MongoDB, Redis, PostgreSQL, MySQL, Oracle, SQL Server)
runs this way.

| File | Role |
| --- | --- |
| [`.railway/railway.ts`](.railway/railway.ts) | The Railway project as code: one `backing()` call per service, a named partial, secrets as `preserve()` |
| [`eng/testbed/provision.sh`](eng/testbed/provision.sh) | Creates missing services, generates missing passwords, applies the config, writes the env file |
| [`eng/testbed/probe.ts`](eng/testbed/probe.ts) | Wakes every service at once and proves each answers a real query |

## The model

- **Sleeping services.** Every service has Railway's Serverless setting (`sleepApplication`) on.
  Railway stops a service once it has sent no outbound packet for 5 minutes, sampled, so 5 to 10
  minutes after the last client disconnects. The next connection through its TCP proxy starts it
  again; that first connection is reset while it starts, so a client retries until it answers.
- **TCP proxies, no HTTP domains.** Each service exposes its native port through one Railway TCP
  proxy (`tcp: [port]`); the proxy address is what the tests connect to.
- **No volumes.** Sleeping keeps the container filesystem, so a woken database still holds what
  was written before; only a deploy starts again from the image. Tests create what they need
  idempotently or under a unique name.
- **One replica, its own limits.** Each service runs one replica with a CPU and memory ceiling,
  which is also the upper bound of its bill.
- **Code, never the dashboard.** `.railway/railway.ts` is the project; change it there and apply.
  It exports a named `partial`, so another repository can own its own slice of the same project.

## Wake budget

`<PREFIX>_WAKE_SECONDS_MAX` is how long a client retries a sleeping service before it fails: 120.
Measured with eight services woken together from Berlin (2026-10-12): a slept service answered
within 10 s of the first connection (PostgreSQL and Redis under 2 s), a fresh container after a
redeploy within 25 s. The rest is room for a wake on another Railway host that has to pull the image
first. Test fixtures read the same key, so the budget lives in one place.

## Cost

Railway Pro bills per minute only while a service runs: $10 per GB-month of memory and $20 per
vCPU-month ($0.000231 per GB-minute, $0.000463 per vCPU-minute). Asleep the project costs nothing:
no volumes, and TCP proxies are free. The eight-service original costs at most $0.10 for a full
15-minute wake at its limits and about $0.02 at measured usage.

## Env-file contract

The connection strings live in one owner-only file per project, registered in Vitals (the
credential registry, `vitals keys`) as "<project> connection strings (Railway <project>)":

```text
~/.config/vitals/<project>.env        chmod 600, KEY=value lines, no quotes, no export
```

- Keys are `<PREFIX>_<SERVICE>_URL`, one per service, plus `<PREFIX>_WAKE_SECONDS_MAX`. A service
  that needs more than one value adds `<PREFIX>_<SERVICE>_<PART>` (the original's Kafka has
  `_BOOTSTRAP`, `_USER`, `_PASSWORD`).
- Each value is in the form the tests' own client library takes (an Npgsql connection string, a
  Redis URL, an AMQP URI), so a test reads one key and passes it on unchanged.
- Passwords are 32 random letters and digits that exist only as Railway variables (`preserve()` in
  the partial) and as copies in this file. Nothing secret is committed; `provision.sh env` rewrites
  the file from Railway at any time.

For this template: project `example-testbed`, prefix `EXAMPLE_TESTBED`, file
`~/.config/vitals/example-testbed.env` with `EXAMPLE_TESTBED_POSTGRES_URL`,
`EXAMPLE_TESTBED_REDIS_URL` and `EXAMPLE_TESTBED_WAKE_SECONDS_MAX`.

## Adopt it in a repository

1. Copy `.railway/` (railway.ts, package.json) and `eng/testbed/` (provision.sh, probe.ts,
   package.json) into the repository; ignore `node_modules/`.
2. Name the project and prefix: `<repo>-testbed` and `<REPO>_TESTBED` in railway.ts
   (`project(...)`, the header comment), provision.sh (`PROJECT`, `PREFIX`) and probe.ts.
3. Replace the example services: one `backing()` call per image the tests pinned; per service its
   password variable in `SECRETS`, its line in `write_env`, its round trip in `checks`.
4. Create and fill the project:

   ```bash
   railway init --name <repo>-testbed       # or: railway link --project <repo>-testbed
   bun install --cwd .railway
   eng/testbed/provision.sh
   railway config plan --detailed-exit-code  # exits 0 when Railway and the file agree
   bun install --cwd eng/testbed && bun eng/testbed/probe.ts
   ```

5. Register the env file in Vitals, point the test fixtures at the keys (retrying for
   `<PREFIX>_WAKE_SECONDS_MAX` seconds), and delete the compose file or container fixtures the
   testbed replaces.

## Skills

The adoption steps also ship as an agent skill: [`.claude/skills/railway-testbed/SKILL.md`](.claude/skills/railway-testbed/SKILL.md)
for Claude Code and [`.agents/skills/railway-testbed/SKILL.md`](.agents/skills/railway-testbed/SKILL.md)
for Codex (with its `agents/openai.yaml`); the two `SKILL.md` files are identical, so an edit goes
into both. Install one by copying or linking its folder into `~/.claude/skills/` or
`~/.agents/skills/`.

## License

MIT
