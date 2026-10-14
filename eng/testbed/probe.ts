// Wakes the example-testbed services on Railway and proves each one answers a real query:
//
//   bun eng/testbed/probe.ts
//
// Reads ~/.config/vitals/example-testbed.env (written by eng/testbed/provision.sh), connects to
// every service at once and retries each until it answers or <PREFIX>_WAKE_SECONDS_MAX runs out. A
// sleeping service wakes on the first connection through its TCP proxy, so the time printed per
// service is wake plus connect plus query. Exits 1 when any service fails. --verbose prints every
// failed attempt.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Redis from "ioredis";
import pg from "pg";

// Adopting the pattern: the same two names as eng/testbed/provision.sh.
const PROJECT = "example-testbed";
const PREFIX = "EXAMPLE_TESTBED";

const ENV_FILE = join(homedir(), ".config", "vitals", `${PROJECT}.env`);
const KEYS = [`${PREFIX}_POSTGRES_URL`, `${PREFIX}_REDIS_URL`, `${PREFIX}_WAKE_SECONDS_MAX`] as const;
type Env = Record<(typeof KEYS)[number], string>;

// One attempt may not outlast this; a wake that holds the connection open is retried.
const ATTEMPT_SECONDS = 30;
const RETRY_PAUSE_MS = 2_000;

function readEnv(): Env {
  const values = new Map<string, string>();
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0 && !line.startsWith("#")) values.set(line.slice(0, at), line.slice(at + 1));
  }
  const missing = KEYS.filter((key) => !values.get(key));
  if (missing.length > 0) throw new Error(`${ENV_FILE} lacks ${missing.join(", ")}`);
  return Object.fromEntries(KEYS.map((key) => [key, values.get(key)!])) as Env;
}

// The ADO.NET form: Key=Value pairs separated by ';', keys compared case-insensitively.
function adoNet(connectionString: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const part of connectionString.split(";")) {
    const at = part.indexOf("=");
    if (at > 0) pairs.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
  }
  return pairs;
}

function required(pairs: Map<string, string>, key: string): string {
  const value = pairs.get(key);
  if (value === undefined) throw new Error(`connection string lacks ${key}`);
  return value;
}

function withTimeout<T>(work: Promise<T>, seconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`attempt exceeded ${seconds}s`)), seconds * 1000);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

type Check = (env: Env) => Promise<string>;

// One entry per service in .railway/railway.ts: a real round trip, not a port check.
const checks: Record<string, Check> = {
  async postgres(env) {
    const pairs = adoNet(env[`${PREFIX}_POSTGRES_URL`]);
    const client = new pg.Client({
      host: required(pairs, "host"),
      port: Number(required(pairs, "port")),
      user: required(pairs, "username"),
      password: required(pairs, "password"),
      database: required(pairs, "database"),
      connectionTimeoutMillis: 10_000,
    });
    client.on("error", () => {});
    try {
      await client.connect();
      const { rows } = await client.query("SELECT current_database() AS db, current_setting('server_version') AS version");
      return `SELECT in ${rows[0].db}, PostgreSQL ${rows[0].version}`;
    } finally {
      await client.end().catch(() => {});
    }
  },

  async redis(env) {
    const redis = new Redis(env[`${PREFIX}_REDIS_URL`], {
      lazyConnect: true,
      connectTimeout: 10_000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    redis.on("error", () => {});
    try {
      await redis.connect();
      const nonce = randomUUID();
      await redis.set("testbed-probe", nonce, "EX", 60);
      if ((await redis.get("testbed-probe")) !== nonce) throw new Error("GET did not return the SET value");
      const server = (await redis.info("server")).match(/redis_version:(\S+)/)?.[1];
      return `SET+GET round trip, Redis ${server}`;
    } finally {
      redis.disconnect();
    }
  },
};

type Outcome = { name: string; ok: boolean; seconds: number; attempts: number; detail: string };

async function probe(name: string, check: Check, env: Env, deadline: number): Promise<Outcome> {
  const started = performance.now();
  let attempts = 0;
  let lastError = "";
  while (true) {
    attempts++;
    try {
      const detail = await withTimeout(check(env), ATTEMPT_SECONDS);
      return { name, ok: true, seconds: (performance.now() - started) / 1000, attempts, detail };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (verbose) {
        const at = ((performance.now() - started) / 1000).toFixed(1);
        console.error(`     ${name} attempt ${attempts} failed at ${at}s: ${redact(lastError, env)}`);
      }
    }
    if (performance.now() + RETRY_PAUSE_MS >= deadline) {
      return { name, ok: false, seconds: (performance.now() - started) / 1000, attempts, detail: lastError };
    }
    await Bun.sleep(RETRY_PAUSE_MS);
  }
}

// Driver errors can quote what they were given; no secret from the env file reaches the terminal.
// provision.sh generates every secret as 32 letters and digits.
function redact(text: string, env: Env): string {
  const secrets = new Set<string>();
  for (const key of KEYS) {
    for (const match of env[key].matchAll(/(?:password=|:)([A-Za-z0-9]{32})(?=[@;]|$)/gi)) secrets.add(match[1]!);
  }
  let redacted = text;
  for (const secret of secrets) redacted = redacted.replaceAll(secret, "***");
  return redacted.replaceAll(/\s+/g, " ").slice(0, 300);
}

const verbose = process.argv.includes("--verbose");
const env = readEnv();
const wakeSecondsMax = Number(env[`${PREFIX}_WAKE_SECONDS_MAX`]);
if (!Number.isFinite(wakeSecondsMax) || wakeSecondsMax <= 0) {
  throw new Error(`${PREFIX}_WAKE_SECONDS_MAX is not a positive number`);
}
const deadline = performance.now() + wakeSecondsMax * 1000;
const color = process.stdout.isTTY;
const paint = (ok: boolean, text: string) => (color ? `\x1b[${ok ? 32 : 31}m${text}\x1b[0m` : text);

const outcomes = await Promise.all(
  Object.entries(checks).map(async ([name, check]) => {
    const outcome = await probe(name, check, env, deadline);
    console.log(
      paint(
        outcome.ok,
        `${outcome.ok ? "ok  " : "FAIL"} ${name.padEnd(10)} ${outcome.seconds.toFixed(1).padStart(6)}s  ` +
          `${String(outcome.attempts).padStart(3)} attempt${outcome.attempts === 1 ? " " : "s"}  ${redact(outcome.detail, env)}`,
      ),
    );
    return outcome;
  }),
);

const failed = outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.name);
console.log(
  failed.length === 0
    ? `all ${outcomes.length} testbed services answered; slowest ${Math.max(...outcomes.map((o) => o.seconds)).toFixed(1)}s of ${wakeSecondsMax}s allowed`
    : `failed: ${failed.join(", ")}`,
);
process.exit(failed.length === 0 ? 0 : 1);
