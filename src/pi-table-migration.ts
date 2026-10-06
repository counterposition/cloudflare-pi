/**
 * Moves Pi's tables between the unprefixed layout the hand-rolled Session used and the `pi_`
 * layout `PiHarness` opens (`agents/harness/pi` always opens Pi's store with `openPiSessionStore`
 * and its default `pi_` prefix, which `PiHarness` does not let a host change).
 *
 * Both directions run synchronously in one `transactionSync`, so a Durable Object never observes
 * a half-moved schema: index definitions are read from `sqlite_master`, dropped, every Pi table is
 * renamed, and the indexes are recreated under the target names. Index names have to be rewritten
 * explicitly: SQLite keeps an index's name across a table rename, and Pi's prefixing store rewrites
 * index names in every future Pi migration, so a stale unprefixed index name would collide.
 *
 * Both directions are idempotent and refuse to run when both layouts exist, rather than guess
 * which copy is authoritative. Names come from Pi's own migration list with the same
 * identifier rewrite the upstream store uses, so a Pi release that adds a table is covered.
 *
 * Synchronous on purpose: the forward migration runs as a `Lifecycle` capability installed ahead
 * of `PiHarness`, so it finishes before `PiHarness` opens (and migrates) Pi's store.
 */
import { SQLITE_MIGRATIONS } from "@earendil-works/pi-durable/storage/sqlite";
import type { DurableObjectCapability } from "agents/lifecycle";

/** The prefix `PiHarness` opens Pi's store with (`openPiSessionStore`'s default). */
export const PI_TABLE_PREFIX = "pi_";

/** Pi's schema-version table; created by the migration runner, not by a migration statement. */
const SCHEMA_TABLE = "durable_schema";

/** Every table and index name Pi's migrations create, in any version (as upstream derives them). */
function piSchemaNames(): string[] {
  const names = new Set([SCHEMA_TABLE]);
  const pattern =
    /\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const migration of SQLITE_MIGRATIONS) {
    for (const statement of migration.statements) {
      for (const match of statement.matchAll(pattern)) names.add(match[1]!);
    }
  }
  return [...names];
}

const NAMES = piSchemaNames();

/**
 * Renames Pi schema identifiers carrying the `from` prefix to the `to` prefix, outside string
 * literals and on word boundaries, so column names such as `conversation_id` are left alone. The
 * same identifier rule as the upstream store's prefixer, applied to an existing prefix.
 */
function renameIdentifiers(sql: string, from: string, to: string): string {
  const pattern = new RegExp(`\\b${from}(${NAMES.join("|")})\\b`, "g");
  return sql
    .split(/('(?:[^']|'')*')/)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(pattern, (_match, name: string) => `${to}${name}`),
    )
    .join("");
}

interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
  [column: string]: SqlStorageValue;
}

function masterRows(sql: SqlStorage): MasterRow[] {
  return sql
    .exec<MasterRow>(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index')",
    )
    .toArray();
}

/** Outcome of one migration call; `moved` is the number of tables renamed. */
export interface PiTableMove {
  readonly moved: number;
}

function move(storage: DurableObjectStorage, from: string, to: string): PiTableMove {
  return storage.transactionSync(() => {
    const rows = masterRows(storage.sql);
    const tables = new Set(rows.filter((row) => row.type === "table").map((row) => row.name));
    const sources = NAMES.filter((name) => tables.has(`${from}${name}`));
    const targets = NAMES.filter((name) => tables.has(`${to}${name}`));
    if (sources.length > 0 && targets.length > 0) {
      throw new Error(
        `Pi tables exist both ${from === "" ? "unprefixed" : `with prefix ${from}`} and ` +
          `${to === "" ? "unprefixed" : `with prefix ${to}`}; refusing to migrate either copy`,
      );
    }
    if (sources.length === 0) return { moved: 0 };

    const sourceTables = new Set(sources.map((name) => `${from}${name}`));
    // Explicit indexes only: automatic ones (`sqlite_autoindex_*`, null sql) follow their table.
    const indexes = rows.filter(
      (row) => row.type === "index" && row.sql !== null && sourceTables.has(row.tbl_name),
    );
    for (const index of indexes) storage.sql.exec(`DROP INDEX "${index.name}"`);
    for (const name of sources) {
      storage.sql.exec(`ALTER TABLE "${from}${name}" RENAME TO "${to}${name}"`);
    }
    for (const index of indexes) {
      // Stored index SQL names the source index and table; rewrite both to the target layout.
      storage.sql.exec(renameIdentifiers(index.sql!, from, to));
    }
    return { moved: sources.length };
  });
}

/**
 * Moves an unprefixed (pre-`PiHarness`) Pi schema under `pi_`. A no-op on a fresh object or one
 * already migrated; throws when both layouts exist.
 */
export function migrateLegacyPiTables(storage: DurableObjectStorage): PiTableMove {
  return move(storage, "", PI_TABLE_PREFIX);
}

/**
 * The forward migration as a `Lifecycle` capability. Install it before `PiHarness`: capabilities
 * start in install order, and `PiHarness` opens its store before calling the host factory, so
 * the factory is too late. A refusal fails that startup honestly and the next call retries,
 * where a throwing constructor would leave the object unreachable for repair.
 */
export function legacyPiTableMigration(storage: DurableObjectStorage): DurableObjectCapability {
  return {
    onStart: () => {
      migrateLegacyPiTables(storage);
    },
  };
}

/**
 * Rollback inverse of {@link migrateLegacyPiTables}: moves the `pi_` schema back to the
 * unprefixed layout the previous Session reads. Call it before the old code opens its storage.
 */
export function restoreLegacyPiTables(storage: DurableObjectStorage): PiTableMove {
  return move(storage, PI_TABLE_PREFIX, "");
}
