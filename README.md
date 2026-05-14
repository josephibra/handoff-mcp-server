# handoff-mcp-server

Deploy-once MCP handoff and scratchpad server.

Endpoints:

GET /health
POST /mcp

Persistence:

DATA_DIR=/data

On Railway, add a volume mounted at:

/data

Local test:

npm install
npm run build
npm test

Expected:

25/25 passed
