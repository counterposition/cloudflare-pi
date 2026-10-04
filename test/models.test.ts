import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Type,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Tool,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createWorkersAiModels } from "../src/models";

/**
 * Real Workers AI SSE wire, recorded verbatim from a live authenticated
 * `env.AI`-equivalent run of @cf/deepseek-ai/deepseek-v4-flash-0731
 * (max_completion_tokens=256, reasoning_effort=none, stream=true,
 * tool_choice="required", tool record_result). Tests drive the real Pi
 * pipeline — Models.stream → provider → openai-completions → OpenAI SDK →
 * Ai.run transport bridge → this recorded body — and never re-implement or
 * copy the decoder.
 */
const RECORDED_SSE = readFileSync(
  join(import.meta.dirname, "fixtures", "workers-ai-deepseek-v4-flash-0731.sse.txt"),
  "utf8",
);

interface RunCall {
  model: string;
  inputs: Record<string, unknown>;
  options: { returnRawResponse?: boolean; signal?: AbortSignal } | undefined;
}

function fakeBinding(response: Response | ((call: RunCall) => Response)): {
  binding: Ai;
  calls: RunCall[];
} {
  const calls: RunCall[] = [];
  const binding = {
    run: (
      model: string,
      inputs: Record<string, unknown>,
      options?: { returnRawResponse?: boolean; signal?: AbortSignal },
    ): Promise<Response> => {
      const call: RunCall = { model, inputs, options };
      calls.push(call);
      return Promise.resolve(typeof response === "function" ? response(call) : response);
    },
  };
  return { binding: binding as unknown as Ai, calls };
}

function recordResultTool(): Tool {
  return {
    name: "record_result",
    description: "Record the check result",
    parameters: Type.Object({ value: Type.String() }),
  };
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/** Forbids any network outside the binding bridge for the duration of `run`. */
async function withoutGlobalFetch(run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("external network attempted; inference must use the AI binding only");
  }) as typeof globalThis.fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

describe("createWorkersAiModels", () => {
  it("streams the recorded tool-call wire through the binding bridge with exact tool identity, finish reason and final native usage", async () => {
    const { binding } = fakeBinding(
      new Response(RECORDED_SSE, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const { models, model } = createWorkersAiModels(binding);
    const context: Context = {
      messages: [{ role: "user", content: "Record the check result", timestamp: 0 }],
      tools: [recordResultTool()],
    };

    let doneMessage: AssistantMessage | undefined;
    await withoutGlobalFetch(async () => {
      const events = await collect(
        models.stream(models.getModel(model.provider, model.modelId)!, context, {
          toolChoice: { type: "function", function: { name: "record_result" } },
        }),
      );
      const done = events.find((event) => event.type === "done");
      doneMessage = done && done.type === "done" ? done.message : undefined;

      // Decoder contract over the real wire: tool call start/delta/end with
      // preserved id, name and parsed arguments — never translated to text.
      const starts = events.filter((event) => event.type === "toolcall_start");
      expect(starts).toHaveLength(1);
      const deltas = events.filter((event) => event.type === "toolcall_delta");
      expect(deltas.length).toBeGreaterThanOrEqual(1);
      const end = events.find((event) => event.type === "toolcall_end");
      expect(end && end.type === "toolcall_end" ? end.toolCall : undefined).toEqual({
        type: "toolCall",
        id: "call_46f9c82b69d943829dfdd002",
        name: "record_result",
        arguments: { value: "durable-cloudflare-check" },
      });
      // reasoning_content was null on every delta — no fabricated thinking or text blocks.
      expect(
        events.some((event) => event.type === "thinking_start" || event.type === "text_start"),
      ).toBe(false);

      // Finish reason from the wire, not inferred success.
      expect(doneMessage?.stopReason).toBe("toolUse");
      expect(doneMessage?.responseId).toBe("3e68bd4eca1c4584b2cb40277994bfd0");
      // The final native `{"response":"","usage":{...}}` event (no `choices`)
      // carries the cumulative usage and must win over the incremental
      // per-chunk usage (which ends at completion_tokens=7).
      expect(doneMessage?.usage).toMatchObject({
        input: 290,
        output: 49,
        cacheRead: 0,
        totalTokens: 339,
      });
    });
  });

  it("surfaces aborted requests as aborted streams and forwards the abort signal to the binding", async () => {
    // Emulates the binding transport: the upstream SSE body dies when the
    // forwarded signal aborts (workerd wires Ai.run's signal into the
    // internal inference fetch).
    const calls: RunCall[] = [];
    let upstreamAborted = false;
    const firstLine = RECORDED_SSE.slice(0, RECORDED_SSE.indexOf("\n\n") + 2);
    const binding = {
      run: (
        model: string,
        inputs: Record<string, unknown>,
        options?: { returnRawResponse?: boolean; signal?: AbortSignal },
      ): Promise<Response> => {
        calls.push({ model, inputs, options });
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => {
                controller.enqueue(new TextEncoder().encode(firstLine));
                options?.signal?.addEventListener(
                  "abort",
                  () => {
                    upstreamAborted = true;
                    controller.error(new Error("The operation was aborted"));
                  },
                  { once: true },
                );
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        );
      },
    } as unknown as Ai;
    const { models, model } = createWorkersAiModels(binding);
    const controller = new AbortController();

    const stream = models.stream(
      models.getModel(model.provider, model.modelId)!,
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      { signal: controller.signal },
    );
    const events: AssistantMessageEvent[] = [];
    let resolveFirstEvent!: () => void;
    const firstEvent = new Promise<void>((resolve) => {
      resolveFirstEvent = resolve;
    });
    const collecting = (async () => {
      for await (const event of stream) {
        events.push(event);
        resolveFirstEvent();
      }
    })();
    await firstEvent;
    controller.abort();
    await collecting;

    const error = events.find((event) => event.type === "error");
    expect(error && error.type === "error" ? error.error.stopReason : undefined).toBe("aborted");
    expect(events.some((event) => event.type === "done")).toBe(false);
    // Transport contract: the bridge hands the caller's signal to Ai.run and
    // the upstream run actually observed the abort.
    expect(calls[0]?.options?.signal?.aborted).toBe(true);
    expect(upstreamAborted).toBe(true);
  });

  it("reports upstream failures as stream errors instead of fabricated success", async () => {
    const { binding } = fakeBinding(
      new Response(JSON.stringify({ errors: [{ code: 7002, message: "Authentication error" }] }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const { models, model } = createWorkersAiModels(binding);

    const events = await collect(
      models.stream(models.getModel(model.provider, model.modelId)!, {
        messages: [{ role: "user", content: "hi", timestamp: 0 }],
      }),
    );
    const error = events.find((event) => event.type === "error");
    expect(error && error.type === "error" ? error.error.stopReason : undefined).toBe("error");
    expect(error && error.type === "error" ? error.error.errorMessage : undefined).toContain(
      "Authentication error",
    );
    expect(events.some((event) => event.type === "done")).toBe(false);
  });
});
