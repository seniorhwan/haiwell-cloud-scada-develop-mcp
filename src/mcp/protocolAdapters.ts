/**
 * Hardened Industrial Protocol Adapters for Haiwell Cloud SCADA MCP:
 * - Strict MQTT 3.1.1 / 5.0 Topic Spec Validator (+/# level integrity, $SYS publish guard)
 * - Sparkplug B / JSON payload serializer
 * - SSRF-safe TCP reachability probe (blocks cloud metadata / link-local endpoints)
 * - OPC UA Part 6 AddressSpace mapper & UANodeSet2 XML generator (full XML escaping + duplicate NodeId guard)
 */

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
  if (direction === 'PUBLISH' && (topic.includes('+') || topic.includes('#'))) {
    errors.push(`Publish topic "${topic}" cannot contain wildcards (+ or #).`);
  }
  if ((direction === 'PUBLISH' || direction === 'BIDIRECTIONAL') && topic.startsWith('$SYS/')) {
    errors.push(`Publishing to broker system namespace "$SYS/" ("${topic}") is forbidden by MQTT 3.1.1/5.0.`);
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

export function buildMqttPayload(
  project: HaiwellProject,
  binding: MqttTopicBinding
): Record<string, unknown> {
  const ts = Date.now();
  if (binding.format === 'SPARKPLUG_B') {
    return {
      timestamp: ts,
      seq: Math.floor((ts / 1000) % 256),
      metrics: binding.tags.map((tagName) => {
        const tag = project.tags[tagName];
        return {
          name: tagName,
          timestamp: ts,
          dataType: tag?.dataType ?? 'FLOAT32',
          value: tag?.currentValue ?? null,
          properties: {
            quality: tag?.quality ?? 'UNCERTAIN',
            unit: tag?.unit ?? '',
          },
        };
      }),
    };
  }

  if (binding.format === 'RAW_VALUE' && binding.tags.length === 1) {
    const tag = project.tags[binding.tags[0]];
    return { value: tag?.currentValue ?? null };
  }

  const values: Record<string, unknown> = {};
  for (const tagName of binding.tags) {
    values[tagName] = project.tags[tagName]?.currentValue ?? null;
  }
  return {
    projectId: project.id,
    clientId: project.mqtt.clientId,
    ts,
    values,
  };
}

const BLOCKED_PROBE_HOSTS = [
  /^169\.254\./,
  /^metadata\.google\.internal$/i,
  /^100\.100\.100\.200$/,
  /^fd00:ec2::254$/i,
];

export async function probeTcpEndpoint(
  host: string,
  port: number,
  timeoutMs = 1500
): Promise<{ reachable: boolean; latencyMs: number; error?: string }> {
  if (!host || BLOCKED_PROBE_HOSTS.some((re) => re.test(host.trim()))) {
    return {
      reachable: false,
      latencyMs: 0,
      error: `SSRF_BLOCK: Probing cloud metadata/link-local host "${host}" is forbidden.`,
    };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { reachable: false, latencyMs: 0, error: `Invalid TCP port ${port}.` };
  }

  const start = performance.now();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (reachable: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        reachable,
        latencyMs: Number((performance.now() - start).toFixed(2)),
        error,
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, `TCP connect timed out after ${timeoutMs}ms`));
    socket.once('error', (err) => finish(false, err.message));
    socket.connect(port, host);
  });
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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function generateOpcUaNodeSet2Xml(project: HaiwellProject): string {
  const { opcua } = project;
  const nsIdx = opcua.namespaceIndex;
  const folderNodeId = `ns=${nsIdx};s=${project.id}.Folder`;
  const seenNodeIds = new Set<string>();

  const variableXml = opcua.nodes
    .filter((node) => {
      if (seenNodeIds.has(node.nodeId)) return false;
      seenNodeIds.add(node.nodeId);
      return true;
    })
    .map((node: OpcUaNodeMapping) => {
      const tag = project.tags[node.tagName];
      const uaType = tag ? mapTagTypeToOpcUa(tag.dataType) : { name: 'Double', nodeId: 'i=11' };
      const accessBits = node.accessLevel === 'CurrentReadWrite' ? 3 : node.accessLevel === 'HistoryRead' ? 5 : 1;
      return [
        `  <UAVariable NodeId="${escapeXml(node.nodeId)}" BrowseName="${nsIdx}:${escapeXml(node.browseName)}" ParentNodeId="${escapeXml(folderNodeId)}" DataType="${uaType.name}" AccessLevel="${accessBits}" UserAccessLevel="${accessBits}" MinimumSamplingInterval="${node.samplingIntervalMs}">`,
        `    <DisplayName>${escapeXml(node.displayName)}</DisplayName>`,
        `    <References>`,
        `      <Reference ReferenceType="HasTypeDefinition">i=63</Reference>`,
        `      <Reference ReferenceType="Organizes" IsForward="false">${escapeXml(folderNodeId)}</Reference>`,
        `    </References>`,
        `  </UAVariable>`,
      ].join('\n');
    });

  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<UANodeSet xmlns="http://opcfoundation.org/UA/2011/03/UANodeSet.xsd" xmlns:uax="http://opcfoundation.org/UA/2008/02/Types.xsd">`,
    `  <NamespaceUris>`,
    `    <Uri>${escapeXml(opcua.namespaceUri)}</Uri>`,
    `  </NamespaceUris>`,
    `  <Models>`,
    `    <Model ModelUri="${escapeXml(opcua.namespaceUri)}" Version="${escapeXml(project.version)}" PublicationDate="${new Date().toISOString()}" />`,
    `  </Models>`,
    `  <UAObject NodeId="${escapeXml(folderNodeId)}" BrowseName="${nsIdx}:${escapeXml(project.name)}" ParentNodeId="i=85">`,
    `    <DisplayName>${escapeXml(project.name)}</DisplayName>`,
    `    <References>`,
    `      <Reference ReferenceType="HasTypeDefinition">i=61</Reference>`,
    `      <Reference ReferenceType="Organizes" IsForward="false">i=85</Reference>`,
    `    </References>`,
    `  </UAObject>`,
    ...variableXml,
    `</UANodeSet>`,
  ].join('\n');
}
