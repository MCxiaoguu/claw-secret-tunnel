// Minimal vendored subset of OpenClaw's plugin SDK types. Type-only; erased at compile time.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TSchema } from "@sinclair/typebox";

export type ToolResult = { content: Array<{ type: "text"; text: string }>; details?: unknown };
export type AgentTool = {
  name: string;
  description: string;
  parameters: TSchema;
  execute: (callId: string, params: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
};

export type BeforeToolCallEvent = { toolName: string; params: Record<string, unknown> };
export type BeforeToolCallResult = { params?: Record<string, unknown>; block?: boolean; blockReason?: string } | void;
export type AfterToolCallEvent = { toolName: string; params: Record<string, unknown>; result?: unknown; error?: string };
export type MessageSendingEvent = { to: string; content: string; metadata?: Record<string, unknown> };
export type MessageSendingResult = { content?: string; cancel?: boolean; cancelReason?: string } | void;
export type ToolResultPersistEvent = { toolName?: string; toolCallId?: string; message: { content?: string; [k: string]: unknown }; isSynthetic?: boolean };
export type ToolResultPersistResult = { message?: { content?: string; [k: string]: unknown } } | void;
export type SessionEndEvent = { sessionId: string };
export type GatewayStopEvent = { reason?: string };

export type PluginHookName =
  | "before_tool_call" | "after_tool_call" | "message_sending"
  | "tool_result_persist" | "session_end" | "gateway_stop";

export type HttpRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

export type PluginRuntime = {
  // best-effort per-channel senders; all optional in our usage
  [k: string]: unknown;
};

export type PluginLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};

export type OpenClawPluginApi = {
  id: string; name: string; source: string;
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  runtime: PluginRuntime;
  logger: PluginLogger;
  registerTool: (tool: AgentTool, opts?: { optional?: boolean }) => void;
  on: (hook: PluginHookName, handler: (event: any, ctx?: any) => any, opts?: { priority?: number }) => void;
  registerHttpRoute: (params: { path: string; handler: HttpRouteHandler }) => void;
  resolvePath?: (p: string) => string;
};

export type OpenClawPlugin = {
  id: string; name?: string; description?: string; version?: string;
  configSchema: Record<string, unknown>;
  register: (api: OpenClawPluginApi) => void | Promise<void>;
};
