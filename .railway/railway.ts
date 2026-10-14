import { defineRailway, image, preserve, project, service } from "railway/iac";

// The Railway project example-testbed: the databases and brokers this repository's tests connect
// to, so no developer machine pulls or runs their containers. The repository owns the whole
// project and still exports a named partial, so another repository can add its own slice of the
// same project without this file deleting it.
//
// Every service sleeps once Railway has seen no outbound traffic from it for 5 to 10 minutes and
// wakes on the next connection through its TCP proxy. No volumes: a woken service keeps its
// container filesystem, and only a deploy starts it again from the image.
//
// Passwords exist only on Railway (preserve()); eng/testbed/provision.sh generates the missing
// ones before an apply and writes the connection strings to ~/.config/vitals/example-testbed.env.
export const partial = "testbed";

const REGION = "europe-west4-drams3a";
const MIB = 1024 * 1024;

type Env = Record<string, string | ReturnType<typeof preserve>>;

// One sleeping service from a public image, one replica, reachable only through a TCP proxy
// (no HTTP domain), with its own CPU and memory ceiling.
function backing(
  name: string,
  config: { image: string; port: number; cpu: number; memoryMiB: number; start?: string; env: Env },
) {
  return service(name, {
    source: image(config.image),
    deploy: {
      ...(config.start === undefined ? {} : { startCommand: config.start }),
      sleepApplication: true,
      limitOverride: { containers: { cpu: config.cpu, memoryBytes: config.memoryMiB * MIB } },
    },
    replicas: { [REGION]: 1 },
    tcp: [config.port],
    env: config.env,
  });
}

export default defineRailway(() => {
  // The image reads its password from a variable.
  const postgres = backing("postgres", {
    image: "postgres:18-alpine",
    port: 5432,
    cpu: 1,
    memoryMiB: 512,
    env: {
      POSTGRES_USER: "app",
      POSTGRES_DB: "app",
      POSTGRES_PASSWORD: preserve(),
    },
  });

  // The image reads no password variable, so the start command passes it; nothing is saved.
  const redis = backing("redis", {
    image: "redis:8-alpine",
    port: 6379,
    cpu: 1,
    memoryMiB: 512,
    start: `/bin/sh -c 'exec redis-server --requirepass "$REDIS_PASSWORD" --save "" --appendonly no'`,
    env: {
      REDIS_PASSWORD: preserve(),
    },
  });

  return project("example-testbed", { resources: [postgres, redis] });
});
