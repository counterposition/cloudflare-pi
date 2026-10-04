/**
 * Regression and upstream-conformance tests for the Durable Object SQLite adapter.
 *
 * Runs on real workerd SQLite through the `cloudflare` Vitest pool; each test opens its own
 * Durable Object instance, so tests share no state.
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DocumentId, EntryId, TaskId } from "@earendil-works/pi-durable";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import {
  SqliteStorage,
  type SqliteDatabase,
  type SqliteExecutor,
  type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import type {
  StorageConformanceAssertions,
  StorageConformanceProvider,
} from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { Session } from "../src/session";
import type { AppEnv, SessionIdentity } from "../src/env";
import { DurableSqliteDatabase, openDurableStorage } from "../src/adapters/durable-sqlite";

// `env` from `cloudflare:workers` is typed `Cloudflare.Env` by @cloudflare/workers-types; merge
// the test config's SESSIONS binding into that interface instead of a pool-specific alias.
declare global {
  namespace Cloudflare {
    interface Env {
      SESSIONS: DurableObjectNamespace;
    }
  }
}

const context = BACKGROUND_CONTEXT;

/** Runs the callback inside a fresh SQLite-backed Durable Object with real workerd storage. */
async function withDurableObject(
  run: (storage: DurableObjectStorage) => Promise<void>,
): Promise<void> {
  const id = env.SESSIONS.newUniqueId();
  await runInDurableObject(env.SESSIONS.get(id), async (_instance, state) => run(state.storage));
}

const assertions: StorageConformanceAssertions = {
  ok: (value, message) => expect(value, message).toBeTruthy(),
  strictEqual: (actual, expected) => expect(actual).toBe(expected),
  deepEqual: (actual, expected) => expect(actual).toEqual(expected),
  partialDeepEqual: (actual, expected) => {
    // Vitest's `toMatchObject` only accepts object expectations; the conformance facade only
    // produces them, so narrow explicitly instead of casting unknown.
    if (typeof expected !== "object" || expected === null) {
      throw new TypeError("partialDeepEqual expects an object or array expectation");
    }
    expect(actual).toMatchObject(expected);
  },
  greaterThan: (actual, expected) => expect(actual).toBeGreaterThan(expected),
  rejects: async (operation, messageIncludes) => {
    await expect(operation).rejects.toThrowError(messageIncludes);
  },
};

const withStorage: StorageConformanceProvider = async (use) => {
  await withDurableObject(async (storage) => {
    const opened = await openDurableStorage(storage);
    await use(opened);
    await opened.close(context);
  });
};

describe("DurableSqliteDatabase upstream storage conformance", () => {
  for (const conformanceCase of createStorageConformance({ assertions, withStorage })) {
    it(conformanceCase.name, () => conformanceCase.run());
  }
});

describe("DurableSqliteDatabase over Durable Object SQL", () => {
  it("initializes the Pi schema, stores mixed history atomically, and reopens intact", async () => {
    await withDurableObject(async (doStorage) => {
      const storage = await openDurableStorage(doStorage);
      const rootId = ROOT_CONVERSATION_ID;
      await storage.commit([{ type: "conversation", value: { id: rootId } }], context);

      const entryId = await storage.mintId<EntryId>();
      const taskId = await storage.mintId<TaskId<JsonValue>>();
      const documentId = await storage.mintId<DocumentId>();
      await storage.commit(
        [
          { type: "entry", value: { id: entryId, conversationId: rootId, kind: "message" } },
          {
            type: "task",
            value: {
              id: taskId,
              conversationId: rootId,
              kind: "test.task",
              version: 1,
              input: { value: taskId },
              state: { status: "pending", checkpoint: { phase: "ready" } },
              background: false,
              abortRequested: false,
            },
          },
          {
            type: "document.create",
            record: { id: documentId, kind: "cache", scope: { kind: "session" } },
            content: { kind: "base", version: 1, value: { count: 1 } },
          },
        ],
        context,
      );

      // A logical close keeps the Durable Object's SQLite database intact for reopen.
      await storage.close(context);
      const reopened = await openDurableStorage(doStorage);
      expect(await reopened.conversation(rootId, context)).toEqual({ id: rootId });
      const entry = await reopened.entry(entryId, context);
      expect(entry?.entry).toEqual({ id: entryId, conversationId: rootId, kind: "message" });
      expect((await reopened.task(taskId, context))?.id).toBe(taskId);
      const document = await reopened.document(documentId, "current", context);
      expect(document?.record.id).toBe(documentId);
      expect(document?.value).toEqual({ count: 1 });
      await reopened.close(context);
    });
  });

  it("queues unrelated reads behind an open async transaction", async () => {
    await withDurableObject(async (doStorage) => {
      const db = new DurableSqliteDatabase(doStorage);
      await db.exec("CREATE TABLE probe (v TEXT)");

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const transaction = db.transaction(async (tx) => {
        await tx.run("INSERT INTO probe (v) VALUES (?)", "staged");
        await gate;
        // Commit the final value inside the transaction so the queued outside read exercises
        // the committed database contents, not the staged intermediate write.
        await tx.run("UPDATE probe SET v = ?", "committed");
        return "committed";
      });

      // The database-level read must be queued behind the transaction barrier, so it can
      // neither run early nor observe the transaction's uncommitted row.
      let readSettled = false;
      const outside = db.get<{ v: string }>("SELECT v FROM probe");
      void outside.then(() => {
        readSettled = true;
      });
      expect(readSettled).toBe(false);

      release();
      await expect(transaction).resolves.toBe("committed");
      await expect(outside).resolves.toEqual({ v: "committed" });
      await db.close();
    });
  });

  it("rolls back atomically on a rejected callback and leaves the queue usable", async () => {
    await withDurableObject(async (doStorage) => {
      const db = new DurableSqliteDatabase(doStorage);
      await db.exec("CREATE TABLE probe (v TEXT)");
      await db.run("INSERT INTO probe (v) VALUES (?)", "before");

      const doomed = db.transaction(async (tx) => {
        await tx.exec("CREATE TABLE scratch (v TEXT)");
        await tx.run("INSERT INTO scratch (v) VALUES (?)", "doomed");
        expect(await tx.all<{ v: string }>("SELECT v FROM scratch")).toEqual([{ v: "doomed" }]);
        throw new Error("boom");
      });

      // The post-rollback read queues behind the transaction; it must observe pre-transaction state.
      const after = db.all<{ v: string }>("SELECT v FROM probe ORDER BY v");
      await expect(doomed).rejects.toThrowError("boom");
      expect(await after).toEqual([{ v: "before" }]);
      // Even transactional DDL rolled back, and the queue still serves new work.
      await expect(db.all("SELECT v FROM scratch")).rejects.toThrowError(/no such table/i);
      await db.run("INSERT INTO probe (v) VALUES (?)", "later");
      await expect(db.all<{ v: string }>("SELECT v FROM probe ORDER BY v")).resolves.toEqual([
        { v: "before" },
        { v: "later" },
      ]);
      await db.close();
    });
  });

  it("invalidates transaction handles that escape the callback", async () => {
    await withDurableObject(async (doStorage) => {
      const db = new DurableSqliteDatabase(doStorage);
      let escaped: SqliteExecutor | undefined;
      await db.transaction(async (tx) => {
        escaped = tx;
        await expect(tx.get<{ one: number }>("SELECT 1 AS one")).resolves.toEqual({ one: 1 });
      });
      await expect(escaped?.get("SELECT 1 AS one")).rejects.toThrowError(/no longer active/i);
      // The database itself is unaffected by escaped-handle misuse.
      await expect(db.get<{ one: number }>("SELECT 1 AS one")).resolves.toEqual({ one: 1 });
      await db.close();
    });
  });

  it("waits for prior operations before a logical close that keeps durable history", async () => {
    await withDurableObject(async (doStorage) => {
      const db = new DurableSqliteDatabase(doStorage);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const transaction = db.transaction(async (tx) => {
        await tx.exec("CREATE TABLE late (v TEXT)");
        await tx.run("INSERT INTO late (v) VALUES (?)", "during");
        await gate;
      });

      // close() queues behind the open transaction instead of racing it.
      let closeSettled = false;
      const closing = db.close();
      void closing.then(() => {
        closeSettled = true;
      });
      expect(closeSettled).toBe(false);

      release();
      await transaction;
      await closing;
      await expect(db.get("SELECT 1 AS one")).rejects.toThrowError(/closed/i);

      // The closed adapter never erased Durable Object storage.
      const fresh = new DurableSqliteDatabase(doStorage);
      await expect(fresh.all<{ v: string }>("SELECT v FROM late")).resolves.toEqual([
        { v: "during" },
      ]);
      await fresh.close();
    });
  });

  it("closes a usable gate when Pi storage open fails and reopens its data on a fresh gate", async () => {
    const injected = new Error("injected metadata-read failure");
    await withDurableObject(async (doStorage) => {
      const db = new DurableSqliteDatabase(doStorage);
      await db.run("CREATE TABLE probe (v TEXT)");
      await db.run("INSERT INTO probe (v) VALUES (?)", "durable");

      // One-shot failure injector: the wrapper forwards everything — including `close` — to the
      // real, usable gate, except its first outer `get`, which is exactly the metadata read
      // `SqliteStorage.open` makes after migrations succeed.
      class FailingMetadataRead implements SqliteDatabase {
        private armed = true;
        constructor(private readonly inner: SqliteDatabase) {}
        exec(sql: string): Promise<void> {
          return this.inner.exec(sql);
        }
        run(sql: string, ...params: SqliteValue[]): Promise<void> {
          return this.inner.run(sql, ...params);
        }
        get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
          if (this.armed) {
            this.armed = false;
            return Promise.reject(injected);
          }
          return this.inner.get<T>(sql, ...params);
        }
        all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
          return this.inner.all<T>(sql, ...params);
        }
        transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
          return this.inner.transaction(callback);
        }
        close(): Promise<void> {
          return this.inner.close();
        }
      }

      // The open fails with the original injected cause (not a wrapper artifact), and the
      // upstream failure path closes the underlying usable gate.
      await expect(SqliteStorage.open(new FailingMetadataRead(db))).rejects.toBe(injected);
      await expect(db.get("SELECT 1 AS one")).rejects.toThrowError(/closed/i);

      // The cleanup premise: a fresh gate over the same Durable Object storage reopens the same
      // persisted state, so adopting it after the confirmed closure loses nothing.
      const fresh = new DurableSqliteDatabase(doStorage);
      await expect(fresh.all<{ v: string }>("SELECT v FROM probe")).resolves.toEqual([
        { v: "durable" },
      ]);
      await fresh.close();
    });
  });

  it("maps positional bindings and result values across the Durable Object SQL boundary", async () => {
    await withDurableObject(async (doStorage) => {
      const db = new DurableSqliteDatabase(doStorage);
      await db.exec(
        "CREATE TABLE bindings (id INTEGER PRIMARY KEY, blob BLOB, text TEXT, real REAL, integer INTEGER)",
      );

      const blob = new Uint8Array([1, 2, 3, 254, 255]);
      await db.run(
        "INSERT INTO bindings (blob, text, real, integer) VALUES (?, ?, ?, ?)",
        blob,
        "text",
        1.5,
        -7,
      );
      await expect(
        db.get("SELECT id, blob, text, real, integer FROM bindings WHERE id = ?", 1),
      ).resolves.toEqual({ id: 1, blob, text: "text", real: 1.5, integer: -7 });

      // Safe bigints bind as integers; anything the Durable Object SQL boundary cannot
      // represent losslessly is rejected instead of silently truncated.
      await db.run("UPDATE bindings SET integer = ? WHERE id = ?", 9007199254740991n, 1);
      await expect(
        db.get<{ integer: number }>("SELECT integer FROM bindings WHERE id = ?", 1),
      ).resolves.toEqual({ integer: 9007199254740991 });
      await expect(
        db.run("UPDATE bindings SET integer = ? WHERE id = ?", 9007199254740992n, 1),
      ).rejects.toThrowError(RangeError);
      await expect(
        db.run("UPDATE bindings SET real = ? WHERE id = ?", Number.NaN, 1),
      ).rejects.toThrowError(RangeError);
      await db.close();
    });
  });
});

describe("Session initialization gate recovery over real workerd storage", () => {
  it("retries initialization on a fresh gate after a failed Pi storage open", async () => {
    const id = env.SESSIONS.newUniqueId();
    await runInDurableObject(env.SESSIONS.get(id), async (_instance, state) => {
      // Test-only availability handles (never behavior): Session requires a container, the
      // backup gateway export, and the AI binding handle before its initializer can reach the
      // storage stage under test. The handles are inert — the initializer runs over real workerd
      // storage and, once storage succeeds, fails honestly at the unavailable container image
      // boundary. No production behavior is mocked.
      const container = { running: false, images: {} };
      const exported = { DirectoryBackupGateway: () => undefined };
      const ai = {
        run(): never {
          throw new Error("test AI binding must never be called");
        },
      };
      const proxiedState = new Proxy(state, {
        get(target, property) {
          if (property === "container") return container;
          if (property === "exports") return exported;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      // workerd's DurableObject constructor accepts only a native state, so the Session is built
      // with the real one and the availability handles are layered on afterward: shadow the
      // instance `ctx` when the runtime exposes it as a shadowable property, otherwise define
      // the test-only properties on the native state and restore them when the test ends.
      const session = new Session(state, { ...env, AI: ai } as unknown as AppEnv);
      const shadowableCtx = session as unknown as { ctx?: DurableObjectState };
      let restoreNativeState: (() => void) | undefined;
      if (shadowableCtx.ctx !== undefined) {
        Object.defineProperty(shadowableCtx, "ctx", { value: proxiedState, configurable: true });
      } else {
        const previousContainer = Object.getOwnPropertyDescriptor(state, "container");
        const previousExports = Object.getOwnPropertyDescriptor(state, "exports");
        Object.defineProperty(state, "container", { value: container, configurable: true });
        Object.defineProperty(state, "exports", { value: exported, configurable: true });
        restoreNativeState = () => {
          for (const [property, descriptor] of [
            ["container", previousContainer],
            ["exports", previousExports],
          ] as const) {
            if (descriptor !== undefined) {
              Object.defineProperty(state, property, descriptor);
            } else {
              delete (state as unknown as Record<string, unknown>)[property];
            }
          }
        };
      }
      const identity: SessionIdentity = { id: "owner-1", email: "owner@example.com" };
      try {
        // The recoverable fault, written through NATIVE storage before any initializer runs: a
        // durable schema version the shipped migrations cannot be newer-checked against.
        state.storage.sql.exec(
          "CREATE TABLE durable_schema (" +
            "singleton INTEGER PRIMARY KEY CHECK (singleton = 1), " +
            "version INTEGER NOT NULL CHECK (version >= 0)) STRICT",
        );
        state.storage.sql.exec("INSERT INTO durable_schema VALUES (1, 99)");

        // First snapshot: identity is verified and persisted, then the initializer reaches its
        // storage stage, the conflicting migration fails the open, and the original cause — not
        // a wrapper or close artifact — surfaces to the caller.
        await expect(session.snapshot(identity)).rejects.toThrowError(/newer than supported/);

        // Remove the fault through native storage; nothing else changed.
        state.storage.sql.exec("UPDATE durable_schema SET version = 0");

        // Second snapshot: the storage stage passes (migrations apply, the harness opens), and
        // the initializer honestly fails at the unavailable container image boundary — proof the
        // gate was re-adopted rather than left closed.
        await expect(session.snapshot(identity)).rejects.toThrowError(
          /Container image 'workspace' is not configured/,
        );

        // Still not closed: a third attempt fails the same honest way, and the verified owner is
        // persisted in the app tables through every retry.
        await expect(session.snapshot(identity)).rejects.toThrowError(
          /Container image 'workspace' is not configured/,
        );
        const owner = [
          ...state.storage.sql.exec<{ id: string; email: string }>(
            "SELECT id, email FROM app_owner WHERE singleton = 1",
          ),
        ][0];
        expect(owner).toEqual({ id: "owner-1", email: "owner@example.com" });
      } finally {
        restoreNativeState?.();
      }
    });
  });
});
