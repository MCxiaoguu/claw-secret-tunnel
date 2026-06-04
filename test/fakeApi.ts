import type { OpenClawPluginApi, AgentTool, PluginHookName, HttpRouteHandler } from "../src/openclaw.js";
export function fakeApi(overrides: Partial<OpenClawPluginApi> = {}) {
  const tools: AgentTool[] = [];
  const hooks: Record<string, Function[]> = {};
  const routes: Array<{ path: string; handler: HttpRouteHandler }> = [];
  const logs: { level: string; args: unknown[] }[] = [];
  const api: OpenClawPluginApi = {
    id: "credential-vanisher", name: "Credential Vanisher", source: "test",
    config: {}, pluginConfig: {}, runtime: {},
    logger: {
      info: (...a) => logs.push({ level: "info", args: a }),
      warn: (...a) => logs.push({ level: "warn", args: a }),
      error: (...a) => logs.push({ level: "error", args: a }),
      debug: (...a) => logs.push({ level: "debug", args: a }),
    },
    registerTool: (t) => { tools.push(t); },
    on: (h: PluginHookName, fn) => { (hooks[h] ??= []).push(fn); },
    registerHttpRoute: (r) => { routes.push(r); },
    resolvePath: (p) => p,
    ...overrides,
  };
  return { api, tools, hooks, routes, logs };
}
