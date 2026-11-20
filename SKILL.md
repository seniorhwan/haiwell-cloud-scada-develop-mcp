---
name: haiwell-cloud-scada-develop
description: Production-grade headless Model Context Protocol (MCP) server and skill suite for Haiwell Cloud SCADA Develop. Enables AI agents in VS Code, Google Antigravity, Claude Code, and Codex to engineer PLC drivers, validate IEC 61131-3 ST/LD/FBD logic, auto-generate ISA-101 HMI layouts, manage tags/alarms/recipes/trends/Data-Link/schedules/reports/cameras/i18n/RBAC, and integrate MQTT Sparkplug B and OPC UA NodeSet2 XML.
transports:
  - streamable-http: http://localhost:3000/mcp
  - stdio: npx tsx src/mcp/stdio.ts
---

# Haiwell Cloud SCADA Develop — MCP Agent Skill

## Quick Connect

- **Streamable HTTP**: `POST http://localhost:3000/mcp` (JSON-RPC 2.0, MCP 2025-03-26)
- **Local stdio**: `npx tsx src/mcp/stdio.ts`
- **Machine-Readable Discovery**: `GET /llms.txt`, `GET /openapi.json`, `GET /api/manifest`
- **Direct Batch RPC**: `POST /api/rpc`

## Mandatory Industrial Safety Protocol

1. **Validate every PLC address first** via `haiwell_device_validate_address`. Never write to read-only physical inputs (`X0..X1023`, `AI0..AI255`, `%IX`, `%IW`).
2. **Dry-run all control writes** via `haiwell_tag_read_write` with `dryRun: true` before committing. Interlocked SIL2/SIL3 outputs require explicit `confirmSafetyOverride: true` and an audit `reason`.
3. **Never deploy unvalidated PLC logic**: run `haiwell_iec61131_validate` (catches `WHILE TRUE` watchdog faults, division by zero, `REAL` exact equality, `VAR_INPUT`/`%I` writes, implicit narrowing, and Ladder double-coil hazards) before `haiwell_iec61131_pou_save`.
4. **Enforce IIoT transport security**: enable TLS for MQTT remote writes, `Basic256Sha256` + `SignAndEncrypt` for OPC UA, and Haiwell A/B Key for Cloud Transparent Transmission.
5. **Gate every export with `haiwell_project_audit_safety`**: ensure `deploymentReady: true` prior to `haiwell_project_export`.
