import OpenAI from "openai";

/** Minimal, provider-neutral chat shapes. Keeps the agent independent of any SDK. */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string exactly as the model produced it. */
  arguments: string;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  messages: ChatMessage[];
  tools: LlmToolSpec[];
  maxTokens: number;
}

export interface LlmResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmPort {
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** Works with OpenAI and any OpenAI-compatible endpoint (set LLM_BASE_URL). */
export class OpenAiLlm implements LlmPort {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    baseURL: string,
    readonly model: string,
  ) {
    // Fail within 45s and retry once, so a slow provider doesn't leave a chat user waiting.
    this.client = new OpenAI({ apiKey, baseURL, timeout: 45_000, maxRetries: 1 });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0.2, // low: answers should stay factual and repeatable
      max_completion_tokens: req.maxTokens,
      messages: req.messages.map(toOpenAi),
      // Only send "tools" when there are some (none are offered on the final round).
      ...(req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: "function" as const,
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    });
    const msg = res.choices[0]?.message;
    const toolCalls: ToolCall[] = [];
    for (const c of msg?.tool_calls ?? []) {
      // Only "function" calls are supported; other call types are ignored.
      if (c.type === "function") {
        toolCalls.push({ id: c.id, name: c.function.name, arguments: c.function.arguments });
      }
    }
    return {
      content: msg?.content ?? null,
      toolCalls,
      usage: {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      },
    };
  }
}

// Converts our neutral message shape to OpenAI's (tool_call_id / tool_calls naming).
function toOpenAi(m: ChatMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  switch (m.role) {
    case "system":
    case "user":
      return { role: m.role, content: m.content };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
        ...(m.toolCalls && m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      };
  }
}
