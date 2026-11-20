/**
 * Complete domain model for Haiwell Cloud SCADA Develop projects.
 * Covers all 15 functional domains including faceplates, declarative event triggers,
 * outbound webhooks, multi-vendor PLC protocols, revisions, and snapshots.
 */

export type HaiwellTargetHardware =
  | 'PC_SCADA'
  | 'CLOUD_HMI_C7'
  | 'CLOUD_HMI_C10'
  | 'CLOUD_HMI_B7'
  | 'CLOUD_HMI_B10'
  | 'CLOUD_HMI_A8'
  | 'CLOUD_BOX_CBOX'
  | 'IPC_SCADA';

export type PlcDriverProtocol =
  | 'HAIWELL_PLC_TCP'
  | 'HAIWELL_PLC_RTU'
  | 'MODBUS_TCP'
  | 'MODBUS_RTU'
  | 'SIEMENS_S7_1200'
  | 'SIEMENS_S7_1500'
  | 'MITSUBISHI_MC_3E'
  | 'OMRON_FINS_TCP'
  | 'ALLEN_BRADLEY_EIP'
  | 'DELTA_DVP_MODBUS'
  | 'SCHNEIDER_MODBUS'
  | 'BACNET_IP'
  | 'OPC_UA_CLIENT'
  | 'MQTT_CLIENT';

export type TagDataType =
  | 'BOOL'
  | 'INT16'
  | 'UINT16'
  | 'INT32'
  | 'UINT32'
  | 'FLOAT32'
  | 'FLOAT64'
  | 'STRING'
  | 'BCD16'
  | 'BCD32';

export type TagScope = 'PLC' | 'INTERNAL' | 'SYSTEM' | 'CLOUD_SHARED';

export type SafetyClass = 'SIL0' | 'SIL1' | 'SIL2' | 'SIL3';

export type ToolSafetyTier = 'read' | 'design' | 'control_guarded' | 'protocol_io';

export type HaiwellDomain =
  | 'project'
  | 'devices'
  | 'tags'
  | 'iec61131'
  | 'hmi'
  | 'scripts'
  | 'alarms'
  | 'mqtt'
  | 'opcua'
  | 'recipes'
  | 'trends'
  | 'datalink'
  | 'operations'
  | 'security'
  | 'simulation';

export interface DeviceConfig {
  id: string;
  name: string;
  protocol: PlcDriverProtocol;
  transport: 'TCP' | 'RTU' | 'CLOUD_TUNNEL';
  host?: string;
  port?: number;
  serialPort?: string;
  baudRate?: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: 'NONE' | 'EVEN' | 'ODD';
  stationId: number;
  pollIntervalMs: number;
  timeoutMs: number;
  retryCount: number;
  byteOrder: 'ABCD' | 'CDAB' | 'BADC' | 'DCBA';
  enabled: boolean;
}

export interface CloudTransparentTunnel {
  enabled: boolean;
  cboxSerialNumber: string;
  targetDeviceId: string;
  abKeyRequired: boolean;
  allowedOperations: ('UPLOAD' | 'DOWNLOAD' | 'ONLINE_DEBUG' | 'FIRMWARE_UPDATE')[];
  sessionTimeoutSec: number;
  sslBits: 128 | 256;
}

export interface TagScaling {
  rawMin: number;
  rawMax: number;
  engMin: number;
  engMax: number;
  clamp?: boolean;
}

export interface TagDefinition {
  name: string;
  scope: TagScope;
  deviceId?: string;
  address?: string;
  modbusOffset0Based?: number;
  modbusAddress1Based?: number;
  wordSpan?: number;
  dataType: TagDataType;
  access: 'RO' | 'RW' | 'WO';
  unit?: string;
  description?: string;
  scaling?: TagScaling;
  deadband?: number;
  safeMin?: number;
  safeMax?: number;
  safetyClass: SafetyClass;
  requiresInterlock: boolean;
  currentValue: number | boolean | string;
  previousValue?: number | boolean | string;
  quality: 'GOOD' | 'BAD' | 'UNCERTAIN' | 'SIMULATED';
  updatedAt: string;
}

export interface Iec61131Diagnostic {
  code: string;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  line: number;
  column: number;
  message: string;
  rule: string;
  fixHint: string;
}

export interface Iec61131Pou {
  id: string;
  name: string;
  language: 'ST' | 'LD' | 'FBD';
  pouType: 'PROGRAM' | 'FUNCTION_BLOCK' | 'FUNCTION';
  returnType?: string;
  source: string;
  boundTags: string[];
  validatedAt: string;
  diagnostics: Iec61131Diagnostic[];
}

export type HmiWidgetType =
  | 'NUMERIC_DISPLAY'
  | 'NUMERIC_INPUT'
  | 'BIT_BUTTON'
  | 'BIT_LAMP'
  | 'MULTI_STATE_INDICATOR'
  | 'BAR_GRAPH'
  | 'GAUGE'
  | 'TANK'
  | 'PUMP'
  | 'VALVE'
  | 'PIPELINE'
  | 'TREND_CHART'
  | 'ALARM_BANNER'
  | 'RECIPE_SELECTOR'
  | 'CAMERA_VIEW'
  | 'DATA_TABLE'
  | 'NAV_BAR'
  | 'LABEL'
  | 'FACEPLATE_INSTANCE';

export interface HmiWidget {
  id: string;
  type: HmiWidgetType;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  tagName?: string;
  writeEnabled?: boolean;
  targetScreenId?: string;
  faceplateId?: string;
  unit?: string;
  min?: number;
  max?: number;
  precision?: number;
  props?: Record<string, string | number | boolean>;
}

export interface HmiPipeRoute {
  id: string;
  fromWidgetId: string;
  toWidgetId: string;
  fromPort: 'left' | 'right' | 'top' | 'bottom';
  toPort: 'left' | 'right' | 'top' | 'bottom';
  fluid: 'CHILLED_WATER' | 'HOT_WATER' | 'STEAM' | 'AIR' | 'CHEMICAL' | 'PROCESS' | 'RETURN';
  label?: string;
  flowTagName?: string;
  waypoints: { x: number; y: number }[];
}

export interface HmiScreen {
  id: string;
  name: string;
  width: number;
  height: number;
  layoutStandard: 'ISA_101_HIGH_PERFORMANCE' | 'STANDARD_INDUSTRIAL' | 'MOBILE_UNIFIED';
  backgroundColor: string;
  autoScaleMobile: boolean;
  autoScaleWeb: boolean;
  isPopup?: boolean;
  widgets: HmiWidget[];
  pipes?: HmiPipeRoute[];
  createdAt: string;
}

export interface HmiFaceplateTemplate {
  id: string;
  name: string;
  description?: string;
  width: number;
  height: number;
  tagPlaceholders: string[];
  widgets: Omit<HmiWidget, 'id'>[];
}

export interface HaiwellScript {
  id: string;
  name: string;
  trigger: 'STARTUP' | 'SHUTDOWN' | 'CYCLIC' | 'TAG_CHANGE' | 'SCREEN_EVENT' | 'ALARM_EVENT';
  intervalMs?: number;
  triggerTag?: string;
  code: string;
  referencedTags: string[];
  validated: boolean;
  updatedAt: string;
}

export interface EventTriggerRule {
  id: string;
  name: string;
  sourceTag: string;
  condition: 'RISING_EDGE' | 'FALLING_EDGE' | 'ON_CHANGE' | 'GT' | 'LT' | 'EQ';
  threshold?: number;
  actionType: 'OPEN_SCREEN' | 'WRITE_TAG' | 'RUN_SCRIPT' | 'DOWNLOAD_RECIPE' | 'SEND_WEBHOOK';
  targetId: string;
  actionValue?: number | boolean | string;
  enabled: boolean;
}

export interface WebhookConnector {
  id: string;
  name: string;
  url: string;
  method: 'POST' | 'PUT';
  tlsRequired: boolean;
  timeoutMs: number;
  headers: Record<string, string>;
  payloadTemplate: string;
  enabled: boolean;
}

export interface AlarmDefinition {
  id: string;
  name: string;
  tagName: string;
  condition: 'DIGITAL_HIGH' | 'DIGITAL_LOW' | 'HIHI' | 'HI' | 'LO' | 'LOLO' | 'ROC' | 'DEV';
  threshold: number;
  referenceValue?: number;
  deadband: number;
  delayOnMs: number;
  delayOffMs: number;
  priority: 1 | 2 | 3 | 4;
  group: string;
  messageTemplate: string;
  channels: ('SCREEN_POPUP' | 'VOICE_TTS' | 'MOBILE_PUSH' | 'WECHAT' | 'SMS' | 'EMAIL')[];
  shelvedUntil?: string;
  enabled: boolean;
}

export interface ActiveAlarmEvent {
  eventId: string;
  alarmId: string;
  tagName: string;
  value: number | boolean | string;
  priority: 1 | 2 | 3 | 4;
  message: string;
  state: 'ACTIVE_UNACK' | 'ACTIVE_ACK' | 'CLEARED_UNACK' | 'NORMAL';
  triggeredAt: string;
  clearedAt?: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
}

export interface MqttTopicBinding {
  id: string;
  topic: string;
  direction: 'PUBLISH' | 'SUBSCRIBE' | 'BIDIRECTIONAL';
  qos: 0 | 1 | 2;
  retain: boolean;
  format: 'JSON' | 'SPARKPLUG_B' | 'RAW_VALUE';
  tags: string[];
  publishIntervalMs: number;
  reportByException: boolean;
  allowRemoteWrite: boolean;
}

export interface MqttConfig {
  mode: 'BUILTIN_BROKER' | 'EXTERNAL_BROKER' | 'HAIWELL_CLOUD_DATA_CENTER';
  brokerUri: string;
  clientId: string;
  keepAliveSec: number;
  cleanSession: boolean;
  tlsEnabled: boolean;
  sslBits: 128 | 256;
  username?: string;
  lwtTopic?: string;
  lwtPayload?: string;
  proxyEnabled: boolean;
  bindings: MqttTopicBinding[];
}

export interface OpcUaNodeMapping {
  nodeId: string;
  browseName: string;
  displayName: string;
  tagName: string;
  dataType: string;
  accessLevel: 'CurrentRead' | 'CurrentReadWrite' | 'HistoryRead';
  samplingIntervalMs: number;
  folderPath: string;
}

export interface OpcUaConfig {
  role: 'SERVER' | 'CLIENT' | 'DUAL';
  endpointUrl: string;
  namespaceUri: string;
  namespaceIndex: number;
  securityPolicy: 'None' | 'Basic256Sha256' | 'Aes128_Sha256_RsaOaep' | 'Aes256_Sha256_RsaPss';
  securityMode: 'None' | 'Sign' | 'SignAndEncrypt';
  authMode: 'Anonymous' | 'Username' | 'X509Certificate';
  publishingIntervalMs: number;
  nodes: OpcUaNodeMapping[];
}

export interface RecipeRecord {
  recordId: string;
  name: string;
  values: Record<string, number | boolean | string>;
  updatedAt: string;
}

export interface RecipeGroup {
  id: string;
  name: string;
  description?: string;
  tagNames: string[];
  records: RecipeRecord[];
}

export interface TrendSample {
  timestamp: string;
  values: Record<string, number>;
}

export interface TrendGroup {
  id: string;
  name: string;
  tagNames: string[];
  sampleIntervalMs: number;
  retentionDays: number;
  deadbandPercent: number;
  storageTarget: 'LOCAL_HIST' | 'CLOUD_HIST' | 'SQL_DATALINK';
  samples: TrendSample[];
}

export interface DataLinkConfig {
  id: string;
  name: string;
  engine: 'MYSQL' | 'SQL_SERVER' | 'POSTGRESQL' | 'SQLITE';
  host: string;
  port: number;
  database: string;
  tableName: string;
  syncMode: 'CYCLIC_INSERT' | 'TAG_TRIGGER' | 'UPSERT_LATEST';
  intervalMs: number;
  columnMappings: { column: string; tagName: string; sqlType: string }[];
  parameterizedOnly: boolean;
}

export interface ScheduleTask {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  actionType: 'RUN_SCRIPT' | 'WRITE_TAG' | 'DOWNLOAD_RECIPE' | 'EXPORT_REPORT';
  targetId: string;
  payload?: Record<string, unknown>;
  enabled: boolean;
}

export interface ReportTemplate {
  id: string;
  name: string;
  schedule: 'HOURLY' | 'SHIFT' | 'DAILY' | 'MONTHLY' | 'ON_DEMAND';
  format: 'CSV' | 'XLSX' | 'JSON' | 'HTML';
  columns: { header: string; tagName: string; aggregate: 'RAW' | 'MIN' | 'MAX' | 'AVG' | 'SUM' }[];
}

export interface CameraBinding {
  id: string;
  name: string;
  protocol: 'RTSP' | 'ONVIF' | 'EZVIZ' | 'HLS';
  streamUri: string;
  screenId?: string;
  ptzEnabled: boolean;
  alarmSnapshotTriggerId?: string;
}

export interface SecurityPolicy {
  sslBits: 128 | 256;
  abKeyEnabled: boolean;
  requireInterlockForOutputs: boolean;
  auditTrailEnabled: boolean;
  userGroups: {
    groupName: string;
    privilegeLevel: number;
    canWriteTags: boolean;
    canAckAlarms: boolean;
    canTransferRecipes: boolean;
    canRemoteTunnel: boolean;
  }[];
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  target: string;
  outcome: 'ALLOWED' | 'BLOCKED' | 'SIMULATED';
  detail: string;
}

export interface HaiwellProject {
  id: string;
  name: string;
  version: string;
  revision: number;
  targetHardware: HaiwellTargetHardware;
  resolution: { width: number; height: number };
  defaultLanguage: string;
  cloudEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  devices: DeviceConfig[];
  transparentTunnel: CloudTransparentTunnel | null;
  tags: Record<string, TagDefinition>;
  pous: Iec61131Pou[];
  screens: HmiScreen[];
  faceplates: HmiFaceplateTemplate[];
  scripts: HaiwellScript[];
  eventTriggers: EventTriggerRule[];
  webhooks: WebhookConnector[];
  alarms: AlarmDefinition[];
  alarmHistory: ActiveAlarmEvent[];
  mqtt: MqttConfig;
  opcua: OpcUaConfig;
  recipes: RecipeGroup[];
  trends: TrendGroup[];
  dataLinks: DataLinkConfig[];
  schedules: ScheduleTask[];
  reports: ReportTemplate[];
  cameras: CameraBinding[];
  translations: Record<string, Record<string, string>>;
  security: SecurityPolicy;
  auditLog: AuditLogEntry[];
}
