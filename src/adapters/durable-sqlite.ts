/**
 * Pi `SqliteDatabase` adapter over a Durable Object's SQLite-backed storage.
 *
 * All SQL executes on `storage.sql` inside the owning Durable Object; the adapter adds the
 * serialization, transaction, and value-mapping semantics that Pi's portable `SqliteStorage`
 * core requires. Nothing here deletes Durable Object storage: `close()` is purely logical.
 *
 * This module is Workers-only. It must not import Node built-ins; `DurableObjectStorage`,
 * `SqlStorage`, and `SqlStorageValue` are ambient types from `@cloudflare/workers-types`.
 */
import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

type RowObject = Record<string, SqlStorageValue>;

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Maps a Pi binding onto the value types Durable Object SQL accepts. Durable Object SQL binds
 * `string | number | ArrayBuffer | null` only: bigints outside the safe integer range would lose
 * precision (store them as TEXT instead) and non-finite numbers have no SQLite representation,
 * so both are rejected instead of silently corrupted.
 */
function toSqlBinding(value: SqliteValue): SqlStorageValue {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      return value;
    case "number":
      if (Number.isFinite(value)) return value;
      throw new RangeError(`Durable Object SQL cannot bind non-finite number ${String(value)}`);
    case "bigint":
      if (value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT) return Number(value);
      throw new RangeError(
        "Durable Object SQL cannot bind bigint values beyond Number.MAX_SAFE_INTEGER without loss of precision",
      );
    default:
      // Uint8Array: copy into a standalone ArrayBuffer of exactly the bound bytes.
      return value.slice().buffer;
  }
}

/** Maps a Durable Object SQL row back onto Pi's value domain (BLOBs arrive as ArrayBuffer). */
function fromRow(row: RowObject): Record<string, SqliteValue> {
  const mapped: Record<string, SqliteValue> = {};
  for (const [column, value] of Object.entries(row)) {
    mapped[column] = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  }
  return mapped;
}

/**
 * Runs operations in call order. An operation starts immediately when nothing is running or
 * waiting; otherwise it waits for everything before it. An asynchronous operation holds the
 * queue until it settles. The barrier for an asynchronous operation is published before the
 * operation starts, so calls it makes synchronously wait behind it instead of bypassing the queue.
 */
class SerialOperationQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  run<T>(operation: () => T): Promise<T> {
    if (this.pending > 0) return this.enqueue(operation);
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  runAsync<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending > 0) return this.enqueue(operation);
    this.pending++;
    // Publish the barrier before the operation starts, so calls it makes synchronously wait behind it.
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    this.tail = barrier;
    let started: Promise<T>;
    try {
      started = operation();
    } catch (error) {
      started = Promise.reject(error);
    }
    return started.finally(() => {
      this.pending--;
      releaseBarrier();
    });
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    this.pending++;
    return this.release(this.tail.then(operation));
  }

  private release<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.finally(() => {
      this.pending--;
    });
    this.tail = settled.then(
      () => {},
      () => {},
    );
    return settled;
  }
}

type TransactionScope = { active: boolean };

/**
 * Executes SQL directly on the Durable Object's SQLite database. Durable Object SQL cursors are
 * lazily stepped and hold no stable snapshot across awaits, so every statement materializes its
 * cursor synchronously before returning.
 */
abstract class DurableSqliteExecutor implements SqliteExecutor {
  protected constructor(private readonly sql: SqlStorage) {}

  exec(sql: string): Promise<void> {
    return this.runOperation(() => {
      this.materialize(sql, []);
    });
  }

  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.runOperation(() => {
      this.materialize(sql, params);
    });
  }

  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.runOperation(() => {
      const row = this.materialize(sql, params)[0];
      return (row === undefined ? undefined : row) as T | undefined;
    });
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.runOperation(() => this.materialize(sql, params) as T[]);
  }

  protected abstract runOperation<T>(operation: () => T): Promise<T>;

  private materialize(sql: string, params: readonly SqliteValue[]): Record<string, SqliteValue>[] {
    const bindings = params.map(toSqlBinding);
    return this.sql
      .exec<RowObject>(sql, ...bindings)
      .toArray()
      .map(fromRow);
  }
}

/**
 * Transaction-local executor handed to `transaction` callbacks. Work must go through this
 * handle; the handle is invalidated as soon as the transaction settles, so handles that
 * escape the callback reject instead of bypassing the queue or the closed transaction.
 */
class DurableSqliteTransaction extends DurableSqliteExecutor {
  constructor(
    sql: SqlStorage,
    private readonly scope: TransactionScope,
  ) {
    super(sql);
  }

  protected async runOperation<T>(operation: () => T): Promise<T> {
    if (!this.scope.active)
      throw new Error("Durable SQLite transaction handle is no longer active");
    return operation();
  }
}

/**
 * `SqliteDatabase` adapter backed by a Durable Object's SQLite storage.
 *
 * `exec`/`run`/`get`/`all`, `transaction`, and `close` all run through one serial queue, so
 * unrelated operations and other transactions queue behind an open transaction and can never
 * observe its uncommitted writes. Calling the database from inside a transaction callback
 * therefore waits for that transaction and never settles, matching the upstream contract;
 * transaction callbacks must use the handle they receive.
 *
 * Transactions run in `storage.transaction()`. Durable Object storage itself guarantees the
 * rollback, and if the callback rejects the adapter rethrows the callback's own error; if the
 * rollback cannot confirm the callback error, the failure surfaces as an `AggregateError`.
 * `close()` only marks the adapter closed after prior operations finish; it never touches
 * the underlying Durable Object storage, which stays readable by a fresh adapter.
 */
export class DurableSqliteDatabase extends DurableSqliteExecutor implements SqliteDatabase {
  private readonly access = new SerialOperationQueue();
  private closed = false;

  constructor(private readonly storage: DurableObjectStorage) {
    super(storage.sql);
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.access.runAsync(async () => {
      if (this.closed) throw new Error("Durable SQLite database is closed");
      let callbackSettled = false;
      let callbackError: unknown;
      try {
        return await this.storage.transaction(async () => {
          const scope: TransactionScope = { active: true };
          try {
            const result = await callback(new DurableSqliteTransaction(this.storage.sql, scope));
            scope.active = false;
            return result;
          } catch (error) {
            scope.active = false;
            callbackSettled = true;
            callbackError = error;
            // Rejecting rolls the Durable Object transaction back before the caller sees the error.
            throw error;
          }
        });
      } catch (error) {
        if (callbackSettled && error !== callbackError) {
          throw new AggregateError(
            [error, callbackError],
            "Durable SQLite transaction failed and its rollback did not report the callback error",
          );
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.access.run(() => {
      this.closed = true;
    });
  }

  protected runOperation<T>(operation: () => T): Promise<T> {
    return this.access.run(() => {
      if (this.closed) throw new Error("Durable SQLite database is closed");
      return operation();
    });
  }
}
