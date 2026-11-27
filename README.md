# Haiwell Cloud SCADA Develop MCP

Headless Model Context Protocol (MCP) server for Haiwell Cloud SCADA Develop: tag/device/HMI/script/alarm tooling, IEC 61131-3 helpers, and `.hwExport` generation.

## Quick start
```bash
npm install
cp .env.example .env   # optional; set HAIWELL_MCP_AUTH_TOKEN before exposing the HTTP server
npm start              # HTTP server
npm run mcp:stdio      # stdio transport
```

See `SKILL.md` for the tool catalog and workflow guide.

> Never commit `.env` files, project exports (`*.hwdev`, `*.hwrun`, `*.hwExport`) or personal documents.
