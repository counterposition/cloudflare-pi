import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { DurableSqliteDatabase } from "../src/adapters/durable-sqlite";

/**
 * Opens Pi's portable store unprefixed over a Durable Object's storage: the layout the
 * pre-`PiHarness` Session wrote, which production now only migrates away from.
 */
export async function openDurableStorage(storage: DurableObjectStorage): Promise<SqliteStorage> {
  return SqliteStorage.open(new DurableSqliteDatabase(storage));
}
