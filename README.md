# handoff-mcp-server

Durable handoffs and shared scratchpad for multi-agent workflows over MCP (HTTP transport).

## Endpoints

- `GET /` basic service info
- `GET /health` health and storage stats
- `POST /mcp` JSON-RPC MCP endpoint
- `GET /robots.txt` discovery file
- `GET /llms.txt` discovery file
- `GET /sitemap.xml` discovery file

## Environment Variables

- `PORT` default `3000`
- `DATA_DIR` default `/data`
- `MCP_API_KEY` required in production (`NODE_ENV=production`)
- `PUBLIC_MCP_DISCOVERY` default `true`
- `PUBLIC_BASE_URL` optional, used for absolute links in discovery files

## Local Run

```bash
npm ci
npm run build
MCP_API_KEY=test-secret node dist/index.js
```

## MCP Auth Behavior

- Discovery methods (`initialize`, `tools/list`, `resources/list`, `prompts/list`, `ping`) can be public when `PUBLIC_MCP_DISCOVERY=true`.
- `tools/call` requires valid upstream auth when `MCP_API_KEY` is set:
  - `Authorization: Bearer <MCP_API_KEY>` or
  - `x-api-key: <MCP_API_KEY>`

## Xpay + Railway Configuration (Required)

1. Railway variables:
- `MCP_API_KEY=<your-strong-key>`
- `PUBLIC_MCP_DISCOVERY=true`
- `PUBLIC_BASE_URL=https://handoff-mcp-server-production.up.railway.app`

2. Xpay MCP URL:
- Use `https://handoff-mcp-server-production.mcp.xpay.sh/mcp?key=xpay_sk_...`
- Without `?key=...`, Xpay returns auth required and requests will not forward.

3. Client calls through Xpay:
- Keep the Xpay key in URL.
- Also send upstream auth header for `tools/call` (`x-api-key` or Bearer token matching `MCP_API_KEY`).

## Publishing

### MCP Registry

- Server name: `io.github.josephibra/handoff-mcp-server`
- Primary remote: Xpay URL (with key at client usage time, not committed)
- Secondary remote: Railway URL

### Smithery

- Namespace: `josephibrahim`
- Server ID: `handoff-mcp-server`
- MCP Server URL: `https://handoff-mcp-server-production.mcp.xpay.sh/mcp?key=xpay_sk_...`

### Agentverse

- Create a new agent and attach MCP server:
  - URL: `https://handoff-mcp-server-production.mcp.xpay.sh/mcp?key=xpay_sk_...`
  - Headers: `x-api-key: <MCP_API_KEY>` for tool execution paths

## Recommended Extra Discovery Listings

- PulseMCP directory
- mcp.so
- OpenTools catalog
- MCPmarket / mcpservers.org

Use the same canonical MCP URL and matching auth notes everywhere to avoid inconsistent behavior.
