import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

const root = process.cwd();
const dataDir = await mkdtemp(path.join(tmpdir(), "handoff-mcp-test-"));

let passed = 0;
let total = 0;
let id = 1;

function check(name, condition) {
  total++;
  if (!condition) {
    throw new Error("FAILED: " + name);
  }
  passed++;
  console.log("ok " + passed + " - " + name);
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not get free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 8000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("Server exited early with code " + child.exitCode);
    }

    try {
      const res = await fetch(baseUrl + "/health");
      if (res.ok) return;
    } catch {}

    await new Promise((r) => setTimeout(r, 100));
  }

  throw new Error("Server did not become healthy");
}

async function startServer(port) {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (d) => process.stdout.write("[server] " + d));
  child.stderr.on("data", (d) => process.stderr.write("[server] " + d));

  const baseUrl = "http://127.0.0.1:" + port;
  await waitForHealth(baseUrl, child);

  return { child, baseUrl };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;

  child.kill("SIGTERM");

  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function rpc(baseUrl, method, params = {}) {
  const res = await fetch(baseUrl + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: id++,
      method,
      params
    })
  });

  const json = await res.json();

  if (json.error) {
    throw new Error(method + " error: " + json.error.message);
  }

  return json.result;
}

async function rpcError(baseUrl, method, params = {}) {
  const res = await fetch(baseUrl + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: id++,
      method,
      params
    })
  });

  const json = await res.json();

  if (!json.error) {
    throw new Error(method + " should have failed");
  }

  return json.error;
}

function parseTool(result) {
  return JSON.parse(result.content[0].text);
}

const port = await getFreePort();
let server = await startServer(port);

try {
  const health = await fetch(server.baseUrl + "/health").then((r) => r.json());
  check("health returns ok", health.ok === true);
  check("health includes stats", typeof health.stats === "object");

  const init = await rpc(server.baseUrl, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "test-client",
      version: "1.0.0"
    }
  });

  check("initialize returns server name", init.serverInfo.name === "handoff-mcp-server");
  check("initialize returns protocol version", typeof init.protocolVersion === "string");

  const tools = await rpc(server.baseUrl, "tools/list");
  check("tools/list returns array", Array.isArray(tools.tools));
  check("tools/list has 9 tools", tools.tools.length === 9);
  check("has handoff_create", tools.tools.some((t) => t.name === "handoff_create"));
  check("has handoff_claim", tools.tools.some((t) => t.name === "handoff_claim"));
  check("has scratchpad_set", tools.tools.some((t) => t.name === "scratchpad_set"));

  const targeted = parseTool(await rpc(server.baseUrl, "tools/call", {
    name: "handoff_create",
    arguments: {
      from_agent: "planner",
      to_agent: "beta",
      task: "Targeted task for beta only",
      priority: "high"
    }
  }));

  const wrongClaim = await rpcError(server.baseUrl, "tools/call", {
    name: "handoff_claim",
    arguments: {
      id: targeted.id,
      agent_id: "gamma"
    }
  });

  check("wrong agent cannot claim targeted handoff", wrongClaim.message.includes("assigned to beta"));

  const created = parseTool(await rpc(server.baseUrl, "tools/call", {
    name: "handoff_create",
    arguments: {
      from_agent: "planner",
      to_agent: "reviewer",
      task: "Review final deployment package",
      context: "No manual maintenance allowed.",
      priority: "urgent",
      tags: ["deploy-once", "railway"]
    }
  }));

  check("handoff_create returns id", typeof created.id === "string" && created.id.length > 10);
  check("handoff status is open", created.status === "open");

  const listed = parseTool(await rpc(server.baseUrl, "tools/call", {
    name: "handoff_list",
    arguments: {
      agent_id: "reviewer"
    }
  }));

  check("handoff_list includes created item", listed.some((h) => h.id === created.id));

  const fetched = parseTool(await rpc(server.baseUrl, "tools/call", {
    name: "handoff_get",
    arguments: {
      id: created.id
    }
  }));

  check("handoff_get returns same id", fetched.id === created.id);

  const claimed = parseTool(await rpc(server.baseUrl, "tools/call", {
    name: "handoff_claim",
    arguments: {
      id: created.id,
      agent_id: "reviewer"
    }
  }));

  check("handoff_claim sets status claimed", claimed.status === "claimed");
  check("handoff_claim sets claimed_by", claimed.claimed_by === "reviewer");

  const completed = parseTool(await rpc(server.baseUrl, "tools/call", {
    name: "handoff_complete",
    arguments: {
      id: created.id,
      agent_id: "reviewer",
      result: "Deployment package verified."
    }
  }));

  check("handoff_complete sets completed", completed.status === "completed");
  check("handoff_complete saves result", completed.result === "Deployment package verified.");

  const scratchSet = parseTool(await rpc(server.baseUrl, "tools/call", {
    name: "scratchpad_set",
    arguments: {
      agent_id: "planner",
      key: "deploy/status",
      value: "ready",
      visibility: "shared"
    }
  }));

  check("scratchpad_set returns key", scratchSet.key === "deploy/status");

  const scratchGet = parseTool(await rpc(server.baseUrl, "tools/call", {
    name: "scratchpad_get",
    arguments: {
      key: "deploy/status",
      agent_id: "reviewer"
    }
  }));

  check("scratchpad_get returns value", scratchGet.value === "ready");

  const scratchList = parseTool(await rpc(server.baseUrl, "tools/call", {
    name: "scratchpad_list",
    arguments: {
      prefix: "deploy/"
    }
  }));

  check("scratchpad_list finds prefix", scratchList.some((x) => x.key === "deploy/status"));

  const batch = await fetch(server.baseUrl + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify([
      {
        jsonrpc: "2.0",
        id: id++,
        method: "ping",
        params: {}
      },
      {
        jsonrpc: "2.0",
        id: id++,
        method: "tools/list",
        params: {}
      }
    ])
  }).then((r) => r.json());

  check("batch request returns 2 replies", Array.isArray(batch) && batch.length === 2);

  const mcpGet = await fetch(server.baseUrl + "/mcp");
  check("GET /mcp returns 405", mcpGet.status === 405);

  await stopServer(server.child);

  server = await startServer(port);

  const persisted = parseTool(await rpc(server.baseUrl, "tools/call", {
    name: "handoff_get",
    arguments: {
      id: created.id
    }
  }));

  check("handoff survives restart", persisted.id === created.id);
  check("completed status survives restart", persisted.status === "completed");

  const scratchPersisted = parseTool(await rpc(server.baseUrl, "tools/call", {
    name: "scratchpad_get",
    arguments: {
      key: "deploy/status",
      agent_id: "reviewer"
    }
  }));

  check("scratchpad survives restart", scratchPersisted.value === "ready");

  const deleted = parseTool(await rpc(server.baseUrl, "tools/call", {
    name: "scratchpad_delete",
    arguments: {
      key: "deploy/status",
      agent_id: "planner"
    }
  }));

  check("scratchpad_delete returns deleted true", deleted.deleted === true);

  console.log("");
  console.log(passed + "/" + total + " passed");
} finally {
  await stopServer(server.child);
  await rm(dataDir, {
    recursive: true,
    force: true
  });
}
