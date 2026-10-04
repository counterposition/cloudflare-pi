/**
 * Test-only Durable Object for the SQL adapter suite.
 *
 * Exports a minimal SQLite-backed class so `cloudflare:test`'s `runInDurableObject` can run
 * against real workerd storage without the application worker. The test only uses
 * `state.storage`; the inherited `DurableObject` constructor is all this class needs.
 */
import { DurableObject } from "cloudflare:workers";

export class TestSession extends DurableObject {}
