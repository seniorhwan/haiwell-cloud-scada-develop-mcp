/**
 * Hardened Industrial Protocol Adapters for Haiwell Cloud SCADA MCP:
 * - Strict MQTT 3.1.1 / 5.0 Topic Spec Validator (+/# level integrity, $SYS publish guard)
 * - Sparkplug B / JSON payload serializer
 * - SSRF-safe TCP reachability probe (blocks cloud metadata / link-local endpoints)
 * - OPC UA Part 6 AddressSpace mapper & UANodeSet2 XML generator (full XML escaping + duplicate NodeId guard)
 */

import dns from 'node:dns';
import net from 'node:net';
import type { HaiwellProject, MqttTopicBinding, OpcUaNodeMapping, TagDataType } from './types';

export interface MqttValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateMqttTopic(topic: string, direction: MqttTopicBinding['direction']): MqttValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!topic || Buffer.byteLength(topic, 'utf8') > 65535) {
    errors.push('MQTT topic must be non-empty and <= 65535 UTF-8 bytes.');
    return { valid: false, errors, warnings };
  }
  if (topic.includes('\u0000')) {
    errors.push('MQTT topic must not contain NULL (U+0000) character.');
  }
  if ((direction === 'PUBLISH' || direction === 'BIDIRECTIONAL') && (topic.includes('+') || topic.includes('#'))) {
    errors.push(`Publish/bidirectional topic "${topic}" cannot contain wildcards (+ or #).`);
  }
  if (
    (direction === 'PUBLISH' || direction === 'BIDIRECTIONAL') &&
    (topic === '$SYS' || topic.startsWith('$SYS/') || topic.startsWith('$share/'))
  ) {
    errors.push(`Publishing to broker system/shared namespace ("${topic}") is forbidden by MQTT 3.1.1/5.0.`);
  }

  // Strict per-level wildcard validation (MQTT 3.1.1 §4.7.1.2 & §4.7.1.3)
  const levels = topic.split('/');
  levels.forEach((lvl, idx) => {
    if (lvl.includes('+') && lvl !== '+') {
      errors.push(`Invalid single-level wildcard in level "${lvl}": "+" must occupy the entire topic level.`);
    }
    if (lvl.includes('#')) {
      if (lvl !== '#') {
        errors.push(`Invalid multi-level wildcard in level "${lvl}": "#" must occupy the entire topic level (e.g., "plant/#").`);
      } else if (idx !== levels.length - 1) {
        errors.push(`Multi-level wildcard "#" must be the final level in topic "${topic}".`);
      }
    }
  });

  if (topic.startsWith('/')) {
    warnings.push(`Leading slash in "${topic}" creates an empty root level; prefer relative namespaces like "plant/area/device".`);
  }
  if (topic.includes('//')) {
    warnings.push(`Empty level ("//") in topic "${topic}" can cause broker/client subscription mismatches.`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

const sparkplugSeqByProject = new Map<string, number>();

function nextSparkplugSeq(projectId: string): number {
  const next = ((sparkplugSeqByProject.get(projectId) ?? -1) + 1) % 256;
  sparkplugSeqByProject.set(projectId, next);
  return next;
}

function mapTagTypeToSparkplugB(dt: TagDataType): string {
  switch (dt) {
    case 'BOOL':
      return 'Boolean';
    case 'INT16':
      return 'Int16';
    case 'UINT16':
    case 'BCD16':
      return 'UInt16';
    case 'INT32':
      return 'Int32';
    case 'UINT32':
    case 'BCD32':
      return 'UInt32';
    case 'FLOAT32':
      return 'Float';
    case 'FLOAT64':
      return 'Double';
    case 'STRING':
      return 'String';
  }
}

export function buildMqttPayload(
  project: HaiwellProject,
  binding: MqttTopicBinding
): Record<string, unknown> {
  const ts = Date.now();
  const getTag = (name: string) =>
    Object.prototype.hasOwnProperty.call(project.tags, name) ? project.tags[name] : undefined;

  if (binding.format === 'SPARKPLUG_B') {
    return {
      timestamp: ts,
      seq: nextSparkplugSeq(project.id),
      metrics: binding.tags.map((tagName) => {
        const tag = getTag(tagName);
        return {
          name: tagName,
          timestamp: ts,
          dataType: tag ? mapTagTypeToSparkplugB(tag.dataType) : 'Float',
          value: tag?.currentValue ?? null,
          properties: {
            quality: tag?.quality ?? 'UNCERTAIN',
            unit: tag?.unit ?? '',
          },
        };
      }),
    };
  }

  if (binding.format === 'RAW_VALUE') {
    if (binding.tags.length === 1) {
      const tag = getTag(binding.tags[0]);
      return { value: tag?.currentValue ?? null };
    }
    const rawValues = Object.create(null) as Record<string, unknown>;
    for (const tagName of binding.tags) {
      rawValues[tagName] = getTag(tagName)?.currentValue ?? null;
    }
    return { rawValues };
  }

  const values = Object.create(null) as Record<string, unknown>;
  for (const tagName of binding.tags) {
    values[tagName] = getTag(tagName)?.currentValue ?? null;
  }
  return {
    projectId: project.id,
    clientId: project.mqtt.clientId,
    ts,
    values,
  };
}

const BLOCKED_METADATA_HOSTNAMES = /^(?:metadata(?:\.google\.internal|\.goog)?|instance-data(?:\.ec2\.internal)?)$/i;

function parseIpv4Part(part: string): number | null {
  if (!/^(0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/i.test(part)) return null;
  if (/^0x/i.test(part)) return Number.parseInt(part, 16);
  if (part.startsWith('0') && part.length > 1) return Number.parseInt(part, 8);
  return Number.parseInt(part, 10);
}

/**
 * Decodes 1-, 2-, 3-, and 4-part BSD inet_aton numeric IPv4 forms
 * (e.g. 2852039166, 0xa9fea9fe, 169.16689662, 169.254.43518, 0251.0376.0251.0376).
 */
function decodeNumericIpv4(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.includes(':')) return null;
  const parts = s.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = parts.map(parseIpv4Part);
  if (nums.some((n) => n === null || !Number.isInteger(n) || n < 0)) return null;
  const vals = nums as number[];

  let addr = 0;
  if (vals.length === 1) {
    if (vals[0] > 0xffffffff) return null;
    addr = vals[0] >>> 0;
  } else if (vals.length === 2) {
    if (vals[0] > 0xff || vals[1] > 0xffffff) return null;
    addr = ((vals[0] << 24) | vals[1]) >>> 0;
  } else if (vals.length === 3) {
    if (vals[0] > 0xff || vals[1] > 0xff || vals[2] > 0xffff) return null;
    addr = ((vals[0] << 24) | (vals[1] << 16) | vals[2]) >>> 0;
  } else {
    if (vals.some((v) => v > 0xff)) return null;
    addr = ((vals[0] << 24) | (vals[1] << 16) | (vals[2] << 8) | vals[3]) >>> 0;
  }

  return [(addr >>> 24) & 255, (addr >>> 16) & 255, (addr >>> 8) & 255, addr & 255].join('.');
}

function isBlockedIpv4Literal(ipv4: string): boolean {
  return (
    /^169\.254\./.test(ipv4) || // Cloud metadata / link-local 169.254.0.0/16
    /^0\./.test(ipv4) || // Unspecified 0.0.0.0/8
    ipv4 === '100.100.100.200' // Alibaba Cloud metadata
  );
}

function expandIpv6ToHextets(raw: string): number[] | null {
  let s = raw.trim().toLowerCase();
  const zoneIdx = s.indexOf('%');
  if (zoneIdx >= 0) s = s.slice(0, zoneIdx);
  if (!s.includes(':')) return null;

  const doubleColonParts = s.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const tokens = side.split(':');
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!tok) return null;
      if (tok.includes('.')) {
        if (i !== tokens.length - 1) return null;
        const octets = tok.split('.');
        if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o))) return null;
        const nums = octets.map((o) => Number.parseInt(o, 10));
        if (nums.some((n) => n < 0 || n > 255)) return null;
        out.push((nums[0] << 8) | nums[1], (nums[2] << 8) | nums[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
        out.push(Number.parseInt(tok, 16));
      }
    }
    return out;
  };

  if (doubleColonParts.length === 1) {
    const hextets = parseSide(doubleColonParts[0]);
    return hextets && hextets.length === 8 ? hextets : null;
  }

  const left = parseSide(doubleColonParts[0]);
  const right = parseSide(doubleColonParts[1]);
  if (!left || !right) return null;
  // Trailing IPv4 in left side is invalid if right is non-empty
  if (doubleColonParts[0].includes('.') && right.length > 0) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function extractEmbeddedIpv4FromIpv6(h: number[]): string | null {
  const isIpv4Mapped = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff;
  const isIpv4Translated = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0xffff && h[5] === 0;
  const isIpv4Compat =
    h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0 && !(h[6] === 0 && h[7] <= 1);
  const isNat64WellKnown = h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0;
  const isNat64Local = h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0x0001;
  if (isIpv4Mapped || isIpv4Translated || isIpv4Compat || isNat64WellKnown || isNat64Local) {
    return [(h[6] >>> 8) & 0xff, h[6] & 0xff, (h[7] >>> 8) & 0xff, h[7] & 0xff].join('.');
  }
  // RFC 3056 6to4 (2002::/16): IPv4 is in h[1] and h[2]
  if (h[0] === 0x2002) {
    return [(h[1] >>> 8) & 0xff, h[1] & 0xff, (h[2] >>> 8) & 0xff, h[2] & 0xff].join('.');
  }
  return null;
}

function isLoopbackIp(ip: string): boolean {
  const clean = ip.trim().replace(/^\[|\]$/g, '').split('%')[0].replace(/\.+$/, '');
  if (/^127\./.test(clean)) return true;
  const hextets = expandIpv6ToHextets(clean);
  if (!hextets) return false;
  if (hextets.slice(0, 7).every((v) => v === 0) && hextets[7] === 1) return true;
  const embedded = extractEmbeddedIpv4FromIpv6(hextets);
  return Boolean(embedded && /^127\./.test(embedded));
}

export function isBlockedSsrfHost(rawHost: string, options: { blockLoopback?: boolean } = {}): boolean {
  const host = rawHost.trim().replace(/^\[|\]$/g, '').split('%')[0].replace(/\.+$/, '');
  if (!host) return true;
  if (BLOCKED_METADATA_HOSTNAMES.test(host)) return true;

  if (options.blockLoopback) {
    const lower = host.toLowerCase();
    if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  }

  const decodedIpv4 = decodeNumericIpv4(host);
  if (decodedIpv4) {
    if (isBlockedIpv4Literal(decodedIpv4)) return true;
    if (options.blockLoopback && /^127\./.test(decodedIpv4)) return true;
  }

  const hextets = expandIpv6ToHextets(host);
  if (hextets) {
    // Unspecified :: (all zeros)
    if (hextets.every((v) => v === 0)) return true;
    // Loopback ::1
    if (options.blockLoopback && hextets.slice(0, 7).every((v) => v === 0) && hextets[7] === 1) return true;
    // IPv6 link-local fe80::/10
    if ((hextets[0] & 0xffc0) === 0xfe80) return true;
    // AWS IPv6 IMDS fd00:ec2::254
    if (
      hextets[0] === 0xfd00 &&
      hextets[1] === 0x0ec2 &&
      hextets[2] === 0 &&
      hextets[3] === 0 &&
      hextets[4] === 0 &&
      hextets[5] === 0 &&
      hextets[6] === 0 &&
      hextets[7] === 0x0254
    ) {
      return true;
    }
    const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(hextets);
    if (embeddedIpv4) {
      if (isBlockedIpv4Literal(embeddedIpv4)) return true;
      if (options.blockLoopback && /^127\./.test(embeddedIpv4)) return true;
    }
  }

  return false;
}

export type DnsLookupAllFn = (
  hostname: string,
  options: { all: true; verbatim?: boolean }
) => Promise<Array<{ address: string; family: number }>>;

function connectSingleTcp(
  targetIp: string,
  port: number,
  timeoutMs: number,
  targetFamily?: number
): Promise<{ reachable: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (reachable: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, `TCP connect timed out after ${timeoutMs}ms`));
    socket.once('error', (err) => finish(false, err.message));
    socket.connect({ port, host: targetIp, ...(targetFamily ? { family: targetFamily } : {}) });
  });
}

export async function probeTcpEndpoint(
  host: string,
  port: number,
  timeoutMs = 1500,
  lookupFn?: DnsLookupAllFn
): Promise<{ reachable: boolean; latencyMs: number; error?: string }> {
  if (isBlockedSsrfHost(host)) {
    return {
      reachable: false,
      latencyMs: 0,
      error: `SSRF_BLOCK: Probing cloud metadata/link-local/unspecified host "${host}" is forbidden.`,
    };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { reachable: false, latencyMs: 0, error: `Invalid TCP port ${port}.` };
  }

  const boundedTimeout = Number.isFinite(timeoutMs) ? Math.max(50, Math.min(timeoutMs, 30_000)) : 1500;
  const cleanHost = host.trim().replace(/^\[|\]$/g, '').split('%')[0].replace(/\.+$/, '');
  const start = performance.now();
  const deadline = start + boundedTimeout;
  const targets: Array<{ ip: string; family?: number }> = [];

  if (net.isIP(cleanHost) !== 0) {
    if (net.isIP(cleanHost) === 6) {
      const hextets = expandIpv6ToHextets(cleanHost);
      const embedded = hextets ? extractEmbeddedIpv4FromIpv6(hextets) : null;
      if (embedded && /^127\./.test(embedded)) {
        return {
          reachable: false,
          latencyMs: 0,
          error: `SSRF_BLOCK: Obfuscated IPv6 loopback alias "${host}" (${embedded}) is forbidden.`,
        };
      }
    }
    targets.push({ ip: cleanHost });
  } else {
    const decoded = decodeNumericIpv4(cleanHost);
    if (decoded) {
      if (/^127\./.test(decoded) && cleanHost !== decoded) {
        return {
          reachable: false,
          latencyMs: 0,
          error: `SSRF_BLOCK: Obfuscated numeric loopback alias "${host}" (${decoded}) is forbidden.`,
        };
      }
      targets.push({ ip: decoded, family: 4 });
    } else {
      const lookup: DnsLookupAllFn = lookupFn ?? ((h, opts) => dns.promises.lookup(h, opts));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const remainingForDns = Math.max(25, Math.ceil(deadline - performance.now()));
        const records = await Promise.race([
          lookup(cleanHost, { all: true, verbatim: true }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`DNS lookup timed out after ${boundedTimeout}ms`)), remainingForDns);
          }),
        ]);
        if (!records || records.length === 0) {
          return {
            reachable: false,
            latencyMs: Number((performance.now() - start).toFixed(2)),
            error: `DNS lookup returned no addresses for "${host}".`,
          };
        }
        const isExplicitLocalhost =
          cleanHost.toLowerCase() === 'localhost' || cleanHost.toLowerCase().endsWith('.localhost');
        for (const rec of records) {
          if (isBlockedSsrfHost(rec.address)) {
            return {
              reachable: false,
              latencyMs: Number((performance.now() - start).toFixed(2)),
              error: `SSRF_BLOCK: Host "${host}" resolved to forbidden address "${rec.address}".`,
            };
          }
          if (!isExplicitLocalhost && isLoopbackIp(rec.address)) {
            return {
              reachable: false,
              latencyMs: Number((performance.now() - start).toFixed(2)),
              error: `SSRF_BLOCK: Host "${host}" resolved to loopback address "${rec.address}" (DNS rebinding blocked).`,
            };
          }
          targets.push({ ip: rec.address, family: rec.family });
        }
      } catch (err) {
        return {
          reachable: false,
          latencyMs: Number((performance.now() - start).toFixed(2)),
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  let lastError = 'TCP connect failed';
  for (const tgt of targets) {
    const remaining = Math.max(25, Math.ceil(deadline - performance.now()));
    const attempt = await connectSingleTcp(tgt.ip, port, remaining, tgt.family);
    if (attempt.reachable) {
      return {
        reachable: true,
        latencyMs: Number((performance.now() - start).toFixed(2)),
      };
    }
    lastError = attempt.error ?? lastError;
    if (performance.now() >= deadline) break;
  }

  return {
    reachable: false,
    latencyMs: Number((performance.now() - start).toFixed(2)),
    error: lastError,
  };
}

const TAG_TO_OPCUA_TYPE: Record<TagDataType, { name: string; nodeId: string }> = {
  BOOL: { name: 'Boolean', nodeId: 'i=1' },
  INT16: { name: 'Int16', nodeId: 'i=4' },
  UINT16: { name: 'UInt16', nodeId: 'i=5' },
  INT32: { name: 'Int32', nodeId: 'i=6' },
  UINT32: { name: 'UInt32', nodeId: 'i=7' },
  FLOAT32: { name: 'Float', nodeId: 'i=10' },
  FLOAT64: { name: 'Double', nodeId: 'i=11' },
  STRING: { name: 'String', nodeId: 'i=12' },
  BCD16: { name: 'UInt16', nodeId: 'i=5' },
  BCD32: { name: 'UInt32', nodeId: 'i=7' },
};

export function mapTagTypeToOpcUa(dataType: TagDataType): { name: string; nodeId: string } {
  return TAG_TO_OPCUA_TYPE[dataType] ?? { name: 'Double', nodeId: 'i=11' };
}

function escapeXml(str: string): string {
  return str
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function generateOpcUaNodeSet2Xml(project: HaiwellProject): string {
  const { opcua } = project;
  const nsIdx = Math.max(1, opcua?.namespaceIndex || 1);
  const namespaceUri = String(opcua?.namespaceUri || `urn:haiwell:scada:${project.id}`);
  const folderNodeId = `ns=${nsIdx};s=${project.id || 'haiwell_project'}.Folder`;
  const seenNodeIds = new Set<string>([folderNodeId]);

  const namespaceUrisXml: string[] = [];
  for (let i = 1; i < nsIdx; i++) {
    namespaceUrisXml.push(`    <Uri>urn:haiwell:scada:ns${i}</Uri>`);
  }
  namespaceUrisXml.push(`    <Uri>${escapeXml(namespaceUri)}</Uri>`);

  const variableXml = (opcua?.nodes ?? [])
    .filter((node) => {
      if (!node || !node.nodeId) return false;
      if (seenNodeIds.has(node.nodeId)) return false;
      seenNodeIds.add(node.nodeId);
      return true;
    })
    .map((node: OpcUaNodeMapping) => {
      const tagName = String(node.tagName ?? '');
      const tag =
        tagName && Object.prototype.hasOwnProperty.call(project.tags, tagName)
          ? project.tags[tagName]
          : undefined;
      const uaType = tag
        ? mapTagTypeToOpcUa(tag.dataType)
        : { name: String(node.dataType || 'Double'), nodeId: 'i=11' };
      const accessBits = node.accessLevel === 'CurrentReadWrite' ? 3 : node.accessLevel === 'HistoryRead' ? 5 : 1;
      const browseName = String(node.browseName || tagName || node.nodeId);
      const displayName = String(node.displayName || browseName);
      const samplingMs = Number.isFinite(node.samplingIntervalMs) ? node.samplingIntervalMs : 500;
      const parentId = folderNodeId;
      return [
        `  <UAVariable NodeId="${escapeXml(String(node.nodeId))}" BrowseName="${nsIdx}:${escapeXml(browseName)}" ParentNodeId="${escapeXml(parentId)}" DataType="${escapeXml(uaType.name)}" AccessLevel="${accessBits}" UserAccessLevel="${accessBits}" MinimumSamplingInterval="${samplingMs}">`,
        `    <DisplayName>${escapeXml(displayName)}</DisplayName>`,
        `    <References>`,
        `      <Reference ReferenceType="HasTypeDefinition">i=63</Reference>`,
        `      <Reference ReferenceType="Organizes" IsForward="false">${escapeXml(parentId)}</Reference>`,
        `    </References>`,
        `  </UAVariable>`,
      ].join('\n');
    });

  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<UANodeSet xmlns="http://opcfoundation.org/UA/2011/03/UANodeSet.xsd" xmlns:uax="http://opcfoundation.org/UA/2008/02/Types.xsd">`,
    `  <NamespaceUris>`,
    ...namespaceUrisXml,
    `  </NamespaceUris>`,
    `  <Aliases>`,
    `    <Alias Alias="Boolean">i=1</Alias>`,
    `    <Alias Alias="Int16">i=4</Alias>`,
    `    <Alias Alias="UInt16">i=5</Alias>`,
    `    <Alias Alias="Int32">i=6</Alias>`,
    `    <Alias Alias="UInt32">i=7</Alias>`,
    `    <Alias Alias="Float">i=10</Alias>`,
    `    <Alias Alias="Double">i=11</Alias>`,
    `    <Alias Alias="String">i=12</Alias>`,
    `    <Alias Alias="Organizes">i=35</Alias>`,
    `    <Alias Alias="HasTypeDefinition">i=40</Alias>`,
    `  </Aliases>`,
    `  <Models>`,
    `    <Model ModelUri="${escapeXml(namespaceUri)}" Version="${escapeXml(String(project.version || '1.0.0'))}" PublicationDate="${new Date().toISOString()}" />`,
    `  </Models>`,
    `  <UAObject NodeId="${escapeXml(folderNodeId)}" BrowseName="${nsIdx}:${escapeXml(String(project.name || project.id))}" ParentNodeId="i=85">`,
    `    <DisplayName>${escapeXml(String(project.name || project.id))}</DisplayName>`,
    `    <References>`,
    `      <Reference ReferenceType="HasTypeDefinition">i=61</Reference>`,
    `      <Reference ReferenceType="Organizes" IsForward="false">i=85</Reference>`,
    `    </References>`,
    `  </UAObject>`,
    ...variableXml,
    `</UANodeSet>`,
  ].join('\n');
}
