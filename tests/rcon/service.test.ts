import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Fake RCON client driven by the tests (no real socket). */
const fake = vi.hoisted(() => ({
  instances: [] as { password: string }[],
  onConnect: null as null | (() => Promise<void>),
  onSend: null as null | ((command: string) => Promise<string>),
  concurrent: 0,
  maxConcurrent: 0,
}));

vi.mock("rcon-client", () => ({
  Rcon: class {
    config: { password: string };

    constructor(config: { password: string }) {
      this.config = config;
    }

    on() {}

    async connect() {
      if (fake.onConnect) await fake.onConnect();
      fake.instances.push({ password: this.config.password });
      return this;
    }

    async send(command: string) {
      fake.concurrent += 1;
      fake.maxConcurrent = Math.max(fake.maxConcurrent, fake.concurrent);
      try {
        return fake.onSend ? await fake.onSend(command) : `écho: ${command}`;
      } finally {
        fake.concurrent -= 1;
      }
    }

    async end() {}
  },
}));

const { RconService } = await import("@/server/rcon/service");

function service(overrides: Partial<ConstructorParameters<typeof RconService>[0]> = {}) {
  return new RconService({
    host: "factorio",
    port: 27015,
    timeoutMs: 500,
    maxQueue: 20,
    password: "secret",
    passwordFile: "/inexistant",
    ...overrides,
  });
}

beforeEach(() => {
  fake.instances = [];
  fake.onConnect = null;
  fake.onSend = null;
  fake.concurrent = 0;
  fake.maxConcurrent = 0;
});

describe("RconService", () => {
  it("runs a command and measures how long it took", async () => {
    const result = await service().execute("/players");

    expect(result.output).toBe("écho: /players");
    expect(result.command).toBe("/players");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reuses the connection between two commands", async () => {
    const rcon = service();
    await rcon.execute("/players");
    await rcon.execute("/version");

    expect(fake.instances).toHaveLength(1);
    expect(rcon.getStats().connections).toBe(1);
  });

  it("serialises commands: never two in flight on the socket", async () => {
    const rcon = service();
    fake.onSend = async (command) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return command;
    };

    const results = await Promise.all([
      rcon.execute("/a"),
      rcon.execute("/b"),
      rcon.execute("/c"),
    ]);

    expect(results.map((r) => r.output)).toEqual(["/a", "/b", "/c"]);
    expect(fake.maxConcurrent).toBe(1);
  });

  it("refuses past the maximum queue instead of piling up forever", async () => {
    const rcon = service({ maxQueue: 2 });
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    fake.onSend = async (command) => {
      await gate;
      return command;
    };

    const first = rcon.execute("/a");
    const second = rcon.execute("/b");

    // The first two fill the queue; the third is refused straight away.
    await expect(rcon.execute("/c")).rejects.toMatchObject({ code: "backpressure" });

    open();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(rcon.getStats().queueDepth).toBe(0);
  });

  it("classifies an authentication refusal", async () => {
    fake.onConnect = async () => {
      throw new Error("Authentication failed");
    };

    await expect(service().execute("/players")).rejects.toMatchObject({
      code: "authentication",
    });
  });

  it("classifies a network error without leaking the host to the client", async () => {
    fake.onConnect = async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    };

    const error = await service()
      .execute("/players")
      .catch((caught) => caught);

    expect(error.code).toBe("connection");
    expect(error.message).not.toContain("27015");
    // The technical detail stays available for the server logs.
    expect(error.detail).toContain("ECONNREFUSED");
    expect(error.detail).toContain("port=27015");
  });

  it("retries once after a dropped socket", async () => {
    const rcon = service();
    let attempt = 0;
    fake.onSend = async (command) => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error("socket fermée"), { code: "ECONNRESET" });
      return command;
    };

    await expect(rcon.execute("/players")).resolves.toMatchObject({ output: "/players" });
    expect(fake.instances).toHaveLength(2);
  });

  it("re-reads the password file on every new connection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rconpw-"));
    const file = join(dir, "rconpw");
    writeFileSync(file, "premier\n");

    const rcon = service({ password: undefined, passwordFile: file });
    await rcon.execute("/players");

    // Factorio restarts: the password is regenerated and the socket drops.
    writeFileSync(file, "second\n");
    await rcon.disconnect();
    await rcon.execute("/players");

    expect(fake.instances.map((instance) => instance.password)).toEqual(["premier", "second"]);
  });

  it("reports a configuration error when the file is absent", async () => {
    const rcon = service({ password: undefined, passwordFile: "/inexistant/rconpw" });

    await expect(rcon.execute("/players")).rejects.toMatchObject({ code: "configuration" });
  });

  it("counts failures in the metrics", async () => {
    const rcon = service();
    fake.onSend = async () => {
      throw Object.assign(new Error("nope"), { code: "ECONNRESET" });
    };

    await rcon.execute("/players").catch(() => undefined);

    const stats = rcon.getStats();
    expect(stats.failedCommands).toBe(1);
    expect(stats.lastErrorAt).not.toBeNull();
    expect(stats.queueDepth).toBe(0);
  });
});

describe("service shutdown", () => {
  /** Holds the in-flight command until the test releases it. */
  function gate() {
    let open: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    fake.onSend = async (command) => {
      await held;
      return command;
    };
    return open;
  }

  it("refuses commands already queued", async () => {
    const rcon = service();
    const open = gate();

    const first = rcon.execute("/a");
    const queued = rcon.execute("/b");
    const alsoQueued = rcon.execute("/c");

    await rcon.shutdown();

    // Refused immediately, without waiting for the in-flight one to finish.
    await expect(queued).rejects.toMatchObject({ key: "service_stopping", code: "unavailable" });
    await expect(alsoQueued).rejects.toMatchObject({ key: "service_stopping" });

    open();
    await first.catch(() => undefined);
    expect(rcon.getStats().queueDepth).toBe(0);
  });

  it("never reopens a connection once shutdown has begun", async () => {
    const rcon = service();
    await rcon.execute("/players");
    expect(fake.instances).toHaveLength(1);

    await rcon.shutdown();
    await expect(rcon.execute("/players")).rejects.toMatchObject({ key: "service_stopping" });

    // This was the bug's scenario: the queue woke up after the close and opened
    // a second socket right after the shutdown signal.
    expect(fake.instances).toHaveLength(1);
    expect(rcon.getStats().connected).toBe(false);
  });

  it("does not reconnect from an in-flight command's retry either", async () => {
    const rcon = service();
    await rcon.execute("/players");

    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    // The socket drops mid-send: `run()` would want to retry, and therefore
    // reconnect — shutdown must prevent it.
    fake.onSend = async () => {
      started();
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw Object.assign(new Error("socket fermée"), { code: "ECONNRESET" });
    };

    const inFlight = rcon.execute("/a");
    await running;
    await rcon.shutdown();

    await expect(inFlight).rejects.toMatchObject({ key: "service_stopping" });
    expect(fake.instances).toHaveLength(1);
  });

  it("is idempotent", async () => {
    const rcon = service();
    await rcon.execute("/players");

    const [a, b, c] = [rcon.shutdown(), rcon.shutdown(), rcon.shutdown()];
    // The same shared promise: three calls, a single close.
    expect(a).toBe(b);
    expect(b).toBe(c);

    await expect(Promise.all([a, b, c])).resolves.toHaveLength(3);
    await expect(rcon.shutdown()).resolves.toBeUndefined();
  });

  it("refuses any new command after shutdown", async () => {
    const rcon = service();
    await rcon.shutdown();

    await expect(rcon.execute("/players")).rejects.toMatchObject({ key: "service_stopping" });
    // Including invalid input: shutdown takes precedence over validation.
    await expect(rcon.execute("   ")).rejects.toMatchObject({ key: "service_stopping" });

    const probe = await rcon.healthCheck();
    expect(probe.ok).toBe(false);
  });
});
