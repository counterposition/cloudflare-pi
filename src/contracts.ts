import type { ConversationView } from "@earendil-works/pi-durable";
import type { SessionIdentity } from "./env";

/**
 * Public RPC surface of the Session Durable Object, as invoked by the worker
 * through the `SESSIONS` namespace binding. Declared as this fixed structural
 * interface — branded like every Durable Object RPC type — instead of
 * reflecting the concrete `Session` class: the class extends
 * `DurableObject<AppEnv>` and `AppEnv.SESSIONS` is itself typed from the
 * class, so reflecting the whole class (including its private surface and the
 * recursive `env` property) made whole-program instantiation infinitely deep.
 * `Session` implements this structurally via its public methods; only these
 * methods are reachable over RPC by the worker.
 *
 * `snapshot` and `restore` return the JSON serialization of {@link SessionSnapshot}
 * as a string, produced at the typed boundary inside the DO. This keeps the
 * recursive `ConversationView` out of the RPC metatype expansion while the
 * worker forwards the pre-serialized bytes as the public `application/json`
 * body, byte-identical to serializing the typed snapshot directly.
 */
export interface SessionRpcApi extends Rpc.DurableObjectBranded {
  snapshot(identity: SessionIdentity): Promise<string>;
  events(identity: SessionIdentity): Promise<Response>;
  submit(identity: SessionIdentity, input: SubmitInput): Promise<SubmitReceipt>;
  abort(identity: SessionIdentity): Promise<void>;
  checkpoint(identity: SessionIdentity): Promise<WorkspaceCheckpoint>;
  restore(identity: SessionIdentity): Promise<string>;
}

export interface WorkspaceCheckpoint {
  key: string;
  createdAt: number;
}

export interface WorkspaceStatus {
  state: "stopped" | "starting" | "ready" | "restoring" | "error";
  checkpoint?: WorkspaceCheckpoint;
  error?: string;
}

export interface SessionSnapshot {
  sessionId: string;
  conversation: ConversationView;
  workspace: WorkspaceStatus;
  notices: readonly string[];
}

export interface SubmitInput {
  text: string;
  requestId: string;
  whenBusy: "steer" | "followUp";
}

/**
 * Durable admission receipt. `operationId` is the request's `requestId`; `accepted` is false when
 * that requestId was already admitted (a retry), in which case nothing new was queued.
 */
export interface SubmitReceipt {
  operationId: string;
  accepted: boolean;
}

export interface ApiError {
  error: string;
}
