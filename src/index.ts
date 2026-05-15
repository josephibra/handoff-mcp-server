import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

type Status = "open" | "claimed" | "completed" | "cancelled";
type Priority = "low" | "normal" | "high" | "urgent";
type Visibility = "private" | "shared";

type Handoff = {
  id: string;
  from_agent: string;
  to_agent?: string;
  claimed_by?: string;
  task: string;
  context: string;
  priority: Priority;
  tags: string[];
  status: Status;
  result?: string;
  created_at: string;
  updated_at: string;
  expires_at?: string;
};

type Scratch = {
  key: string;
  agent_id: string;
  value: string;
  visibility: Visibility;
  created_at: string;
  updated_at: string;
  expires_at?: string;
};

type State = {
  version: number;
  handoffs: Handoff[];
  scratchpad: Scratch[];
};

const NAME = "handoff-mcp-server";
const VERSION = "1.0.0";
const PROTOCOL = "2024-11-05";
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || "/data";
const MCP_API_KEY = process.env.MCP_API_KEY || "";
const PUBLIC_MCP_DISCOVERY = process.env.PUBLIC_MCP_DISCOVERY !== "false";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

function now(): string {
  return new Date().toISOString();
}

function expiry(minutes: unknown): string | undefined {
  if (minutes === undefined || minutes === null) return undefined;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) {
    throw new Error("ttl_minutes must be a non-negative number");
  }
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function expired(x: { expires_at?: string }): boolean {
  return !!x.expires_at && Date.parse(x.expires_at) <= Date.now();
}

function obj(x: unknown): Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x) ? x as Record<string, unknown> : {};
}

function args(params: unknown): Record<string, unknown> {
  return obj(obj(params).arguments);
}

function str(a: Record<string, unknown>, key: string, required = true): string {
  const v = a[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error(`Missing required string: ${key}`);
    return "";
  }
  if (typeof v !== "string") throw new Error(`Invalid string: ${key}`);
  if (v.length > 50000) throw new Error(`${key} too long`);
  return v.trim();
}

function arr(a: Record<string, unknown>, key: string): string[] {
  const v = a[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`Invalid array: ${key}`);
  return v.filter((x): x is string => typeof x === "string").map(x => x.trim()).filter(Boolean).slice(0, 50);
}

function priority(a: Record<string, unknown>): Priority {
  const v = a.priority ?? "normal";
  if (v === "low" || v === "normal" || v === "high" || v === "urgent") return v;
  throw new Error("priority must be low, normal, high, or urgent");
}

function visibility(a: Record<string, unknown>): Visibility {
  const v = a.visibility ?? "shared";
  if (v === "private" || v === "shared") return v;
  throw new Error("visibility must be private or shared");
}

class Store {
  file: string;
  state: State = { version: 1, handoffs: [], scratchpad: [] };
  saving: Promise<void> = Promise.resolve();

  constructor(public dir: string) {
    this.file = path.join(dir, "handoff-mcp-store.json");
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    if (!existsSync(this.file)) {
      await this.save();
      return;
    }

    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<State>;
      this.state = {
        version: 1,
        handoffs: Array.isArray(parsed.handoffs) ? parsed.handoffs as Handoff[] : [],
        scratchpad: Array.isArray(parsed.scratchpad) ? parsed.scratchpad as Scratch[] : []
      };
      if (this.clean()) await this.save();
    } catch {
      await rename(this.file, `${this.file}.corrupt-${Date.now()}`);
      this.state = { version: 1, handoffs: [], scratchpad: [] };
      await this.save();
    }
  }

  clean(): boolean {
    const h = this.state.handoffs.length;
    const s = this.state.scratchpad.length;
    this.state.handoffs = this.state.handoffs.filter(x => !expired(x));
    this.state.scratchpad = this.state.scratchpad.filter(x => !expired(x));
    return h !== this.state.handoffs.length || s !== this.state.scratchpad.length;
  }

  async save(): Promise<void> {
    const data = JSON.stringify(this.state, null, 2);
    this.saving = this.saving.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, data, "utf8");
      await rename(tmp, this.file);
    });
    await this.saving;
  }

  stats(): Record<string, unknown> {
    this.clean();
    return {
      data_dir: this.dir,
      store_file: this.file,
      handoffs: this.state.handoffs.length,
      scratchpad_entries: this.state.scratchpad.length
    };
  }

  async createHandoff(a: Record<string, unknown>): Promise<Handoff> {
    this.clean();
    const item: Handoff = {
      id: randomUUID(),
      from_agent: str(a, "from_agent"),
      to_agent: str(a, "to_agent", false) || undefined,
      task: str(a, "task"),
      context: str(a, "context", false),
      priority: priority(a),
      tags: arr(a, "tags"),
      status: "open",
      created_at: now(),
      updated_at: now(),
      expires_at: expiry(a.ttl_minutes)
    };
    this.state.handoffs.push(item);
    await this.save();
    return item;
  }

  async listHandoffs(a: Record<string, unknown>): Promise<Handoff[]> {
    if (this.clean()) await this.save();
    const agent = str(a, "agent_id", false);
    const status = str(a, "status", false);
    const includeCompleted = a.include_completed === true;

    return this.state.handoffs
      .filter(h => !status || h.status === status)
      .filter(h => includeCompleted || h.status !== "completed")
      .filter(h => !agent || h.from_agent === agent || h.to_agent === agent || h.claimed_by === agent || !h.to_agent)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async getHandoff(a: Record<string, unknown>): Promise<Handoff> {
    if (this.clean()) await this.save();
    const id = str(a, "id");
    const h = this.state.handoffs.find(x => x.id === id);
    if (!h) throw new Error("Handoff not found");
    return h;
  }

  async claimHandoff(a: Record<string, unknown>): Promise<Handoff> {
    this.clean();
    const id = str(a, "id");
    const agent = str(a, "agent_id");
    const h = this.state.handoffs.find(x => x.id === id);
    if (!h) throw new Error("Handoff not found");
    if (h.status !== "open") throw new Error(`Handoff is not open: ${h.status}`);
    if (h.to_agent && h.to_agent !== agent) throw new Error(`This handoff is assigned to ${h.to_agent}, not ${agent}`);
    h.status = "claimed";
    h.claimed_by = agent;
    h.updated_at = now();
    await this.save();
    return h;
  }

  async completeHandoff(a: Record<string, unknown>): Promise<Handoff> {
    this.clean();
    const id = str(a, "id");
    const agent = str(a, "agent_id", false);
    const h = this.state.handoffs.find(x => x.id === id);
    if (!h) throw new Error("Handoff not found");
    if (h.claimed_by && agent && h.claimed_by !== agent) throw new Error(`Claimed by ${h.claimed_by}, not ${agent}`);
    h.status = "completed";
    h.result = str(a, "result", false);
    h.updated_at = now();
    await this.save();
    return h;
  }

  async setScratch(a: Record<string, unknown>): Promise<Scratch> {
    this.clean();
    const key = str(a, "key");
    const agent = str(a, "agent_id");
    const value = str(a, "value");
    let e = this.state.scratchpad.find(x => x.key === key);

    if (e && e.agent_id !== agent) throw new Error(`Scratchpad key belongs to ${e.agent_id}`);

    if (!e) {
      e = {
        key,
        agent_id: agent,
        value,
        visibility: visibility(a),
        created_at: now(),
        updated_at: now(),
        expires_at: expiry(a.ttl_minutes)
      };
      this.state.scratchpad.push(e);
    }

    e.value = value;
    e.visibility = visibility(a);
    e.updated_at = now();
    e.expires_at = expiry(a.ttl_minutes);
    await this.save();
    return e;
  }

  async getScratch(a: Record<string, unknown>): Promise<Scratch> {
    if (this.clean()) await this.save();
    const key = str(a, "key");
    const agent = str(a, "agent_id", false);
    const e = this.state.scratchpad.find(x => x.key === key);
    if (!e) throw new Error("Scratchpad entry not found");
    if (e.visibility === "private" && e.agent_id !== agent) throw new Error("Scratchpad entry is private");
    return e;
  }

  async listScratch(a: Record<string, unknown>): Promise<Scratch[]> {
    if (this.clean()) await this.save();
    const agent = str(a, "agent_id", false);
    const prefix = str(a, "prefix", false);

    return this.state.scratchpad
      .filter(e => !prefix || e.key.startsWith(prefix))
      .filter(e => e.visibility !== "private" || e.agent_id === agent)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async deleteScratch(a: Record<string, unknown>): Promise<Record<string, boolean>> {
    this.clean();
    const key = str(a, "key");
    const agent = str(a, "agent_id", false);
    const before = this.state.scratchpad.length;

    this.state.scratchpad = this.state.scratchpad.filter(e => {
      if (e.key !== key) return true;
      if (agent && e.agent_id !== agent) return true;
      return false;
    });

    await this.save();
    return { deleted: before !== this.state.scratchpad.length };
  }
}

const tools = [
  {
    name: "handoff_create",
    description: "Create a durable handoff.",
    inputSchema: {
      type: "object",
      required: ["from_agent", "task"],
      properties: {
        from_agent: { type: "string" },
        to_agent: { type: "string" },
        task: { type: "string" },
        context: { type: "string" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        tags: { type: "array", items: { type: "string" } },
        ttl_minutes: { type: "number" }
      }
    }
  },
  {
    name: "handoff_list",
    description: "List durable handoffs.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        status: { type: "string" },
        include_completed: { type: "boolean" }
      }
    }
  },
  {
    name: "handoff_get",
    description: "Get one handoff.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } }
    }
  },
  {
    name: "handoff_claim",
    description: "Claim an open handoff.",
    inputSchema: {
      type: "object",
      required: ["id", "agent_id"],
      properties: {
        id: { type: "string" },
        agent_id: { type: "string" }
      }
    }
  },
  {
    name: "handoff_complete",
    description: "Complete a handoff.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        agent_id: { type: "string" },
        result: { type: "string" }
      }
    }
  },
  {
    name: "scratchpad_set",
    description: "Set durable scratchpad value.",
    inputSchema: {
      type: "object",
      required: ["agent_id", "key", "value"],
      properties: {
        agent_id: { type: "string" },
        key: { type: "string" },
        value: { type: "string" },
        visibility: { type: "string", enum: ["private", "shared"] },
        ttl_minutes: { type: "number" }
      }
    }
  },
  {
    name: "scratchpad_get",
    description: "Get scratchpad value.",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: {
        key: { type: "string" },
        agent_id: { type: "string" }
      }
    }
  },
  {
    name: "scratchpad_list",
    description: "List scratchpad entries.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        prefix: { type: "string" }
      }
    }
  },
  {
    name: "scratchpad_delete",
    description: "Delete scratchpad entry.",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: {
        key: { type: "string" },
        agent_id: { type: "string" }
      }
    }
  }
];

let store: Store;

function result(id: unknown, value: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function error(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

async function callTool(name: string, a: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (name === "handoff_create") return toolResult(await store.createHandoff(a));
  if (name === "handoff_list") return toolResult(await store.listHandoffs(a));
  if (name === "handoff_get") return toolResult(await store.getHandoff(a));
  if (name === "handoff_claim") return toolResult(await store.claimHandoff(a));
  if (name === "handoff_complete") return toolResult(await store.completeHandoff(a));
  if (name === "scratchpad_set") return toolResult(await store.setScratch(a));
  if (name === "scratchpad_get") return toolResult(await store.getScratch(a));
  if (name === "scratchpad_list") return toolResult(await store.listScratch(a));
  if (name === "scratchpad_delete") return toolResult(await store.deleteScratch(a));
  throw new Error(`Unknown tool: ${name}`);
}

async function rpc(body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const id = body.id;
  const method = String(body.method || "");

  if (!method) return error(id, -32600, "Invalid request");
  if (id === undefined && method.startsWith("notifications/")) return undefined;

  try {
    if (method === "initialize") {
      return result(id, {
        protocolVersion: PROTOCOL,
        capabilities: {
          tools: { listChanged: false },
          resources: {},
          prompts: {}
        },
        serverInfo: {
          name: NAME,
          version: VERSION
        }
      });
    }

    if (method === "ping") return result(id, {});
    if (method === "tools/list") return result(id, { tools });
    if (method === "resources/list") return result(id, { resources: [] });
    if (method === "prompts/list") return result(id, { prompts: [] });

    if (method === "tools/call") {
      const p = obj(body.params);
      const name = String(p.name || "");
      if (!name) throw new Error("Missing tool name");
      return result(id, await callTool(name, args(p)));
    }

    return error(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    return error(id, -32000, e instanceof Error ? e.message : String(e));
  }
}

function isPublicDiscoveryMethod(method: string): boolean {
  return method === "initialize" ||
    method === "ping" ||
    method === "tools/list" ||
    method === "resources/list" ||
    method === "prompts/list" ||
    method === "notifications/initialized";
}

function allowsPublicDiscovery(body: Record<string, unknown> | Record<string, unknown>[]): boolean {
  if (!PUBLIC_MCP_DISCOVERY) return false;

  const items = Array.isArray(body) ? body : [body];
  return items.every(item => isPublicDiscoveryMethod(String(item.method || "")));
}

function authorized(req: http.IncomingMessage): boolean {
  if (!MCP_API_KEY) return true;

  const bearer = req.headers.authorization;
  const apiKey = req.headers["x-api-key"];

  if (typeof bearer === "string" && bearer === "Bearer " + MCP_API_KEY) return true;
  if (typeof apiKey === "string" && apiKey === MCP_API_KEY) return true;

  return false;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,mcp-protocol-version,authorization,x-api-key",
    "mcp-protocol-version": PROTOCOL
  });
  res.end(text);
}

function sendText(res: http.ServerResponse, status: number, contentType: string, text: string): void {
  res.writeHead(status, {
    "content-type": contentType,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,mcp-protocol-version,authorization,x-api-key"
  });
  res.end(text);
}

function publicUrl(pathname: string): string {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/+$/, "") + pathname;
  return pathname;
}

async function read(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (size > 2_000_000) throw new Error("Request too large");
    chunks.push(b);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function handler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,mcp-protocol-version,authorization,x-api-key"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, {
      ok: true,
      name: NAME,
      version: VERSION,
      stats: store.stats()
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    send(res, 200, {
      ok: true,
      name: NAME,
      mcp_endpoint: "/mcp",
      health_endpoint: "/health"
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/robots.txt") {
    sendText(
      res,
      200,
      "text/plain; charset=utf-8",
      `User-agent: *\nAllow: /\nSitemap: ${publicUrl("/sitemap.xml")}\n`
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/llms.txt") {
    sendText(
      res,
      200,
      "text/plain; charset=utf-8",
      [
        "# handoff-mcp-server",
        "",
        "Durable handoffs and shared scratchpad for multi-agent workflows.",
        "",
        `- MCP endpoint: ${publicUrl("/mcp")}`,
        `- Health endpoint: ${publicUrl("/health")}`,
        `- Tools list: ${publicUrl("/mcp")} (POST tools/list JSON-RPC)`
      ].join("\n")
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/sitemap.xml") {
    sendText(
      res,
      200,
      "application/xml; charset=utf-8",
      [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">",
        `  <url><loc>${publicUrl("/")}</loc></url>`,
        `  <url><loc>${publicUrl("/health")}</loc></url>`,
        `  <url><loc>${publicUrl("/mcp")}</loc></url>`,
        `  <url><loc>${publicUrl("/llms.txt")}</loc></url>`,
        "</urlset>"
      ].join("\n")
    );
    return;
  }

  if (url.pathname === "/mcp" && req.method === "GET") {
    send(res, 405, { error: "Use POST /mcp" });
    return;
  }

  if (url.pathname !== "/mcp" || req.method !== "POST") {
    send(res, 404, { error: "Not found" });
    return;
  }

  try {
    const raw = await read(req);
    const parsed = JSON.parse(raw) as Record<string, unknown> | Record<string, unknown>[];

    if (!authorized(req) && !allowsPublicDiscovery(parsed)) {
      send(res, 401, { error: "Unauthorized" });
      return;
    }

    if (Array.isArray(parsed)) {
      const out: Record<string, unknown>[] = [];
      for (const item of parsed) {
        const r = await rpc(item);
        if (r) out.push(r);
      }
      if (out.length === 0) {
        res.writeHead(202);
        res.end();
        return;
      }
      send(res, 200, out);
      return;
    }

    const r = await rpc(parsed);
    if (!r) {
      res.writeHead(202);
      res.end();
      return;
    }

    send(res, 200, r);
  } catch (e) {
    send(res, 400, error(null, -32700, e instanceof Error ? e.message : String(e)));
  }
}

async function makeStore(): Promise<Store> {
  try {
    const s = new Store(DATA_DIR);
    await s.init();
    return s;
  } catch {
    const fallback = new Store(path.join(process.cwd(), "data"));
    await fallback.init();
    return fallback;
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production" && !MCP_API_KEY) {
    console.error("FATAL: MCP_API_KEY is required in production.");
    process.exit(1);
  }

  store = await makeStore();

  const server = http.createServer((req, res) => {
    handler(req, res).catch(e => send(res, 500, { error: e instanceof Error ? e.message : String(e) }));
  });

  async function shutdown(): Promise<void> {
    await store.saving;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`${NAME} ${VERSION} listening on ${PORT}`);
    console.log(`DATA_DIR=${store.dir}`);
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
