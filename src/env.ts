import type { SessionRpcApi } from "./contracts";

export interface AppEnv {
  AI: Ai;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  WORKSPACE_BACKUPS: R2Bucket;
  /**
   * One session per verified identity; the DO name is the identity id. Stubs
   * expose the fixed public RPC surface, never the recursive Session class type.
   */
  SESSIONS: DurableObjectNamespace<SessionRpcApi>;
}

export interface SessionIdentity {
  id: string;
  email: string;
}
