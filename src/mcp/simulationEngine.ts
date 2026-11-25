/**
 * Deterministic ISA-18.2 Alarm State Machine & Headless PLC/SCADA Scan-Cycle Simulator.
 * Actually executes saved IEC 61131-3 ST POUs (transpiled to Strict ES5) and validated
 * Haiwell JavaScript scripts inside a tightly constrained Node vm sandbox with persistent
 * Standard FB timer/counter state across scan steps, linear ADC scaling, configurable
 * E-Stop fail-safe enforcement (pre- and post-logic), declarative event triggers, and
 * ISA-18.2 alarm state transitions.
 */

import vm from 'node:vm';
import { applyLinearScaling } from './plcAddressing';
import { transpileStToHaiwellJs } from './iec61131';
import { validateHaiwellScript } from './scriptAnalyzer';
import type { ActiveAlarmEvent, AlarmDefinition, HaiwellProject, TagDefinition } from './types';

function toNumeric(val: number | boolean | string): number {
  if (typeof val === 'boolean') return val ? 1 : 0;
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

function isAlarmTripped(
  alm: AlarmDefinition,
  currentVal: number,
  prevVal: number,
  alreadyActive: boolean,
  scanIntervalMs = 1000
): boolean {
  const db = Math.max(0, alm.deadband);
  switch (alm.condition) {
    case 'HIHI':
    case 'HI':
      return alreadyActive
        ? db > 0
          ? currentVal > alm.threshold - db
          : currentVal >= alm.threshold
        : currentVal >= alm.threshold;
    case 'LO':
    case 'LOLO':
      return alreadyActive
        ? db > 0
          ? currentVal < alm.threshold + db
          : currentVal <= alm.threshold
        : currentVal <= alm.threshold;
    case 'DIGITAL_HIGH':
      return currentVal === 1;
    case 'DIGITAL_LOW':
      return currentVal === 0;
    case 'ROC': {
      const dtSec = Math.max(0.001, scanIntervalMs / 1000);
      return Math.abs(currentVal - prevVal) / dtSec >= alm.threshold;
    }
    case 'DEV': {
      const ref = alm.referenceValue ?? 0;
      const delta = Math.abs(currentVal - ref);
      const clearThresh = Math.max(0, alm.threshold - db);
      return alreadyActive
        ? db > 0
          ? delta > clearThresh
          : delta >= alm.threshold
        : delta >= alm.threshold;
    }
  }
}

export interface AlarmEvalSummary {
  evaluatedRules: number;
  newlyTriggered: ActiveAlarmEvent[];
  cleared: ActiveAlarmEvent[];
  activeCount: number;
}

const standaloneAlarmDelayMap = new WeakMap<HaiwellProject, Map<string, { onMs: number; offMs: number }>>();

function formatAlarmMessage(alm: AlarmDefinition, tag: TagDefinition): string {
  return alm.messageTemplate.replace(/\{(tag|tagName|value|threshold|unit|priority)\}/g, (_m, key: string) => {
    switch (key) {
      case 'tag':
      case 'tagName':
        return tag.name;
      case 'value':
        return String(tag.currentValue);
      case 'threshold':
        return String(alm.threshold);
      case 'unit':
        return tag.unit ?? '';
      case 'priority':
        return String(alm.priority);
      default:
        return '';
    }
  });
}

/**
 * Deduplicating ISA-18.2 state machine:
 * NORMAL -> ACTIVE_UNACK -> ACTIVE_ACK -> NORMAL (when cleared)
 * ACTIVE_UNACK -> CLEARED_UNACK (when cleared before ack) -> NORMAL (when acked)
 */
export function evaluateProjectAlarms(
  project: HaiwellProject,
  simOptions?: {
    simTimeMs?: number;
    scanIntervalMs?: number;
    delayState?: Map<string, { onMs: number; offMs: number }>;
    enforceDelays?: boolean;
  }
): AlarmEvalSummary {
  const nowMs = simOptions?.simTimeMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const scanIntervalMs = Math.max(1, simOptions?.scanIntervalMs ?? 1000);
  const enforceDelays = simOptions?.enforceDelays !== false;
  let delayState = simOptions?.delayState;
  if (!delayState) {
    delayState = standaloneAlarmDelayMap.get(project);
    if (!delayState) {
      delayState = new Map();
      standaloneAlarmDelayMap.set(project, delayState);
    }
  }
  const newlyTriggered: ActiveAlarmEvent[] = [];
  const cleared: ActiveAlarmEvent[] = [];

  const hasOwnTag = (name: string) => Object.prototype.hasOwnProperty.call(project.tags, name);

  for (const alm of project.alarms) {
    if (!alm.enabled) {
      delayState.delete(alm.id);
      continue;
    }

    const isShelved = Boolean(alm.shelvedUntil && Date.parse(alm.shelvedUntil) > nowMs);
    if (isShelved) {
      delayState.delete(alm.id);
    }

    const tag = hasOwnTag(alm.tagName) ? project.tags[alm.tagName] : undefined;
    if (!tag) continue;

    const cur = toNumeric(tag.currentValue);
    const prev = tag.previousValue !== undefined ? toNumeric(tag.previousValue) : cur;

    const existingActive = project.alarmHistory.find(
      (e) => e.alarmId === alm.id && (e.state === 'ACTIVE_UNACK' || e.state === 'ACTIVE_ACK')
    );

    const tripped = isAlarmTripped(alm, cur, prev, Boolean(existingActive), scanIntervalMs);

    // Shelving suppresses new nuisance triggers without freezing already-active alarms from clearing
    if (isShelved) {
      if (!tripped && existingActive) {
        existingActive.clearedAt = now;
        existingActive.state = existingActive.state === 'ACTIVE_ACK' ? 'NORMAL' : 'CLEARED_UNACK';
        cleared.push(existingActive);
      }
      continue;
    }

    const timer = delayState.get(alm.id) ?? { onMs: 0, offMs: 0 };

    if (tripped && !existingActive) {
      timer.offMs = 0;
      const delayOn = enforceDelays ? Math.max(0, alm.delayOnMs ?? 0) : 0;
      if (delayOn > 0) {
        timer.onMs += scanIntervalMs;
        if (timer.onMs < delayOn) {
          delayState.set(alm.id, timer);
          continue;
        }
      }
      timer.onMs = 0;
      delayState.set(alm.id, timer);

      const ev: ActiveAlarmEvent = {
        eventId: `ev_${alm.id}_${nowMs}_${Math.random().toString(36).slice(2, 6)}`,
        alarmId: alm.id,
        tagName: alm.tagName,
        value: tag.currentValue,
        priority: alm.priority,
        message: formatAlarmMessage(alm, tag),
        state: 'ACTIVE_UNACK',
        triggeredAt: now,
      };
      project.alarmHistory.push(ev);
      while (project.alarmHistory.length > 500) {
        // Evict fully acknowledged NORMAL records before CLEARED_UNACK, before active alarms
        const normalIdx = project.alarmHistory.findIndex((e) => e.state === 'NORMAL');
        if (normalIdx >= 0) {
          project.alarmHistory.splice(normalIdx, 1);
          continue;
        }
        const clearedUnackIdx = project.alarmHistory.findIndex((e) => e.state === 'CLEARED_UNACK');
        if (clearedUnackIdx >= 0) {
          project.alarmHistory.splice(clearedUnackIdx, 1);
        } else {
          project.alarmHistory.shift();
        }
      }
      newlyTriggered.push(ev);
    } else if (!tripped && existingActive) {
      timer.onMs = 0;
      const delayOff = enforceDelays ? Math.max(0, alm.delayOffMs ?? 0) : 0;
      if (delayOff > 0) {
        timer.offMs += scanIntervalMs;
        if (timer.offMs < delayOff) {
          delayState.set(alm.id, timer);
          continue;
        }
      }
      timer.offMs = 0;
      delayState.set(alm.id, timer);

      existingActive.clearedAt = now;
      existingActive.state = existingActive.state === 'ACTIVE_ACK' ? 'NORMAL' : 'CLEARED_UNACK';
      cleared.push(existingActive);
    } else {
      if (!tripped) timer.onMs = 0;
      if (tripped) timer.offMs = 0;
      delayState.set(alm.id, timer);
    }
  }

  return {
    evaluatedRules: project.alarms.length,
    newlyTriggered,
    cleared,
    activeCount: project.alarmHistory.filter((e) => e.state === 'ACTIVE_UNACK' || e.state === 'ACTIVE_ACK').length,
  };
}

export interface SimulationStepInput {
  injectTagValues?: Record<string, number | boolean | string>;
  injectRawAdcValues?: Record<string, number>;
  steps?: number;
  scanIntervalMs?: number;
  eStopTagName?: string;
  enforceEStopSafeState?: boolean;
  persistState?: boolean;
}

function resolveTagByFullName(project: HaiwellProject, rawName: string): TagDefinition | undefined {
  if (Object.prototype.hasOwnProperty.call(project.tags, rawName)) {
    return project.tags[rawName];
  }
  const dotIdx = rawName.indexOf('.');
  if (dotIdx > 0) {
    const bare = rawName.slice(dotIdx + 1);
    if (Object.prototype.hasOwnProperty.call(project.tags, bare)) {
      return project.tags[bare];
    }
  }
  return undefined;
}

function resolveEStopTag(project: HaiwellProject, explicitName?: string): TagDefinition | undefined {
  const hasOwn = (name: string) => Object.prototype.hasOwnProperty.call(project.tags, name);
  if (explicitName && hasOwn(explicitName)) {
    return project.tags[explicitName];
  }
  if (hasOwn('EStop_OK')) {
    return project.tags['EStop_OK'];
  }
  return Object.values(project.tags).find(
    (t) =>
      t.safetyClass === 'SIL3' &&
      t.dataType === 'BOOL' &&
      t.access === 'RO' &&
      /estop|e_stop|emergency|safety/i.test(t.name)
  );
}

function coerceTagWriteValue(tag: TagDefinition, raw: unknown): number | boolean | string {
  if (tag.dataType === 'BOOL') return Boolean(raw);
  if (tag.dataType === 'STRING') return String(raw ?? '');
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  switch (tag.dataType) {
    case 'INT16':
      return Math.max(-32768, Math.min(32767, Math.trunc(n)));
    case 'UINT16':
      return Math.max(0, Math.min(65535, Math.trunc(n)));
    case 'INT32':
      return Math.max(-2147483648, Math.min(2147483647, Math.trunc(n)));
    case 'UINT32':
      return Math.max(0, Math.min(4294967295, Math.trunc(n)));
    case 'BCD16':
      return Math.max(0, Math.min(9999, Math.trunc(n)));
    case 'BCD32':
      return Math.max(0, Math.min(99999999, Math.trunc(n)));
    case 'FLOAT32': {
      const f = Math.fround(n);
      return Number.isFinite(f) ? f : 0;
    }
    default:
      return n;
  }
}

/**
 * VM-realm bootstrap executed once inside the isolated vm.Context.
 * Every exposed global function, object, array, getter, setter, and FB store is
 * allocated strictly inside the VM realm (never exposing host-realm objects or
 * host-realm Function constructors). Host read/write callbacks remain sealed
 * inside a strict-mode closure and exchange only JSON/primitive values.
 */
const VM_MEMBRANE_BOOTSTRAP = `'use strict';
(function(globalObj) {
  return function initMembrane(hostRead, hostWrite, configJson) {
    var cfg = JSON.parse(configJson);
    var fbStore = Object.create(null);
    var initFb = cfg.initialFbState || {};
    var fbKeys = Object.keys(initFb);
    for (var i = 0; i < fbKeys.length; i++) {
      var k = fbKeys[i];
      var src = initFb[k];
      var copy = Object.create(null);
      if (src && typeof src === 'object') {
        var props = Object.keys(src);
        for (var j = 0; j < props.length; j++) {
          copy[props[j]] = src[props[j]];
        }
      }
      fbStore[k] = copy;
    }

    function coercePrimitive(val) {
      var t = typeof val;
      if (t === 'number' || t === 'boolean' || t === 'string') return val;
      if (val === null || val === undefined) return '';
      return String(val);
    }

    function vmRead(name) {
      return hostRead(String(name));
    }

    function vmWrite(name, value) {
      return hostWrite(String(name), coercePrimitive(value));
    }

    function defineImmutable(target, key, val) {
      Object.defineProperty(target, key, {
        value: val,
        enumerable: true,
        writable: false,
        configurable: false
      });
    }

    var variableApi = Object.create(null);
    defineImmutable(variableApi, 'GetByFullName', vmRead);
    defineImmutable(variableApi, 'SetByFullName', vmWrite);
    defineImmutable(variableApi, 'BatchSetByFullNames', function BatchSetByFullNames(map) {
      if (!map || typeof map !== 'object') return false;
      var keys = Object.keys(map);
      for (var m = 0; m < keys.length; m++) {
        vmWrite(keys[m], map[keys[m]]);
      }
      return true;
    });
    Object.freeze(variableApi);

    var tagApi = Object.create(null);
    defineImmutable(tagApi, 'Read', vmRead);
    defineImmutable(tagApi, 'Write', vmWrite);
    Object.freeze(tagApi);

    var noop = function() {};
    var loggerApi = Object.create(null);
    defineImmutable(loggerApi, 'log', noop);
    defineImmutable(loggerApi, 'debug', noop);
    defineImmutable(loggerApi, 'info', noop);
    defineImmutable(loggerApi, 'trace', noop);
    defineImmutable(loggerApi, 'warn', noop);
    defineImmutable(loggerApi, 'note', noop);
    defineImmutable(loggerApi, 'error', noop);
    Object.freeze(loggerApi);

    var dbApi = Object.create(null);
    defineImmutable(dbApi, 'query', function query(_sql, cb) {
      var rows = [];
      if (typeof cb === 'function') cb(null, rows);
      return rows;
    });
    defineImmutable(dbApi, 'exec', function exec(_sql, cb) {
      if (typeof cb === 'function') cb(null);
    });
    defineImmutable(dbApi, 'execTransaction', function execTransaction(_sqls, cb) {
      if (typeof cb === 'function') cb(null);
    });
    Object.freeze(dbApi);

    var commonApi = Object.create(null);
    defineImmutable(commonApi, 'logger', loggerApi);
    defineImmutable(commonApi, 'SetTimeout', function SetTimeout() { return 0; });
    defineImmutable(commonApi, 'SetInterval', function SetInterval() { return 0; });
    defineImmutable(commonApi, 'database', dbApi);
    defineImmutable(commonApi, 'Ajax', function Ajax(_opts, cb) {
      if (typeof cb === 'function') {
        cb(null, { statusCode: 200, body: '{}' });
      }
    });
    Object.freeze(commonApi);

    defineImmutable(globalObj, 'Variable', variableApi);
    defineImmutable(globalObj, 'Tag', tagApi);
    defineImmutable(globalObj, 'Common', commonApi);
    defineImmutable(globalObj, '__fbState', fbStore);
    defineImmutable(globalObj, '__haiwellFbStore', fbStore);
    defineImmutable(globalObj, '__SCAN_MS', Number(cfg.scanIntervalMs) || 1000);
    defineImmutable(globalObj, '__haiwellCyclicMs', Number(cfg.scanIntervalMs) || 1000);

    var tagNames = cfg.tagNames || [];
    for (var ti = 0; ti < tagNames.length; ti++) {
      (function(tagName) {
        Object.defineProperty(globalObj, '$' + tagName, {
          enumerable: true,
          configurable: true,
          get: function() { return vmRead(tagName); },
          set: function(v) { vmWrite(tagName, v); }
        });
      })(tagNames[ti]);
    }

    var devEntries = cfg.devices || [];
    for (var di = 0; di < devEntries.length; di++) {
      var devName = devEntries[di].name;
      var devTags = devEntries[di].tags || [];
      var devProxy = Object.create(null);
      for (var dti = 0; dti < devTags.length; dti++) {
        (function(tagName) {
          Object.defineProperty(devProxy, tagName, {
            enumerable: true,
            get: function() { return vmRead(tagName); },
            set: function(v) { vmWrite(tagName, v); }
          });
        })(devTags[dti]);
      }
      Object.freeze(devProxy);
      if (!Object.prototype.hasOwnProperty.call(globalObj, '$' + devName)) {
        defineImmutable(globalObj, '$' + devName, devProxy);
      }
    }

    return function exportFbStateJson() {
      var out = {};
      var keys = Object.keys(fbStore);
      for (var fi = 0; fi < keys.length; fi++) {
        var fk = keys[fi];
        var fobj = fbStore[fk];
        if (fobj && typeof fobj === 'object') {
          var clean = {};
          var subKeys = Object.keys(fobj);
          for (var si = 0; si < subKeys.length; si++) {
            var sv = fobj[subKeys[si]];
            if (typeof sv === 'number' || typeof sv === 'boolean' || typeof sv === 'string') {
              clean[subKeys[si]] = sv;
            }
          }
          out[fk] = clean;
        }
      }
      return JSON.stringify(out);
    };
  };
})(this);`;

function createSandboxedContext(
  project: HaiwellProject,
  fbState: Record<string, Record<string, unknown>>,
  scanIntervalMs: number,
  onTagWrite?: (tagName: string) => void
): { context: vm.Context; syncFbStateToHost: () => void } {
  const hostRead = (name: string): number | boolean | string | undefined => {
    try {
      const tag = resolveTagByFullName(project, String(name));
      return tag ? tag.currentValue : undefined;
    } catch {
      return undefined;
    }
  };
  const hostWrite = (name: string, value: number | boolean | string): boolean => {
    try {
      const tag = resolveTagByFullName(project, String(name));
      if (!tag || tag.access === 'RO') return false;
      const coerced = coerceTagWriteValue(tag, value);
      if (tag.currentValue !== coerced) {
        tag.currentValue = coerced;
        onTagWrite?.(tag.name);
      } else {
        tag.currentValue = coerced;
      }
      tag.quality = 'SIMULATED';
      tag.updatedAt = new Date().toISOString();
      return true;
    } catch {
      return false;
    }
  };

  // Deduplicate devices by name so duplicate dev.name never throws TypeError on defineProperty
  const deviceTagMap = new Map<string, Set<string>>();
  for (const dev of project.devices) {
    let set = deviceTagMap.get(dev.name);
    if (!set) {
      set = new Set<string>();
      deviceTagMap.set(dev.name, set);
    }
    for (const tag of Object.values(project.tags)) {
      if (tag.deviceId === dev.id) {
        set.add(tag.name);
      }
    }
  }

  const sandbox: Record<string, unknown> = Object.create(null);
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  const initMembrane = vm.runInContext(VM_MEMBRANE_BOOTSTRAP, context, {
    filename: 'haiwell_vm_membrane.js',
    timeout: 250,
  }) as (
    readFn: (name: string) => number | boolean | string | undefined,
    writeFn: (name: string, value: number | boolean | string) => boolean,
    cfgJson: string
  ) => () => string;

  const configJson = JSON.stringify({
    scanIntervalMs,
    initialFbState: fbState,
    tagNames: Object.values(project.tags).map((t) => t.name),
    devices: [...deviceTagMap.entries()].map(([name, tags]) => ({ name, tags: [...tags] })),
  });

  const exportFbStateJson = initMembrane(hostRead, hostWrite, configJson);

  const syncFbStateToHost = () => {
    try {
      const serialized = exportFbStateJson();
      const parsed = JSON.parse(serialized) as Record<string, Record<string, unknown>>;
      for (const k of Object.keys(fbState)) delete fbState[k];
      for (const [k, v] of Object.entries(parsed)) {
        if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') {
          fbState[k] = v;
        }
      }
    } catch {
      // Ignore malformed FB state export
    }
  };

  return { context, syncFbStateToHost };
}

interface PersistentSimState {
  fbState: Record<string, Record<string, unknown>>;
  delayState: Map<string, { onMs: number; offMs: number }>;
  simTimeMs: number;
  cyclicAccumMs: Map<string, number>;
  startupRan: Set<string>;
  firedOnceEvents: Set<string>;
  pendingTagChanges: Set<string>;
}

const simProjectStateMap = new WeakMap<HaiwellProject, PersistentSimState>();

export function runSimulationSteps(project: HaiwellProject, input: SimulationStepInput) {
  const steps = Math.max(1, Math.min(input.steps ?? 1, 50));
  const scanIntervalMs = Math.max(50, Math.min(input.scanIntervalMs ?? 1000, 60000));
  const hasOwnTag = (name: string) => Object.prototype.hasOwnProperty.call(project.tags, name);

  if (input.eStopTagName && !hasOwnTag(input.eStopTagName)) {
    throw new Error(`Explicit eStopTagName "${input.eStopTagName}" does not exist in project tags.`);
  }

  let simState: PersistentSimState;
  if (input.persistState) {
    let existing = simProjectStateMap.get(project);
    if (!existing) {
      existing = {
        fbState: Object.create(null) as Record<string, Record<string, unknown>>,
        delayState: new Map(),
        simTimeMs: Date.now(),
        cyclicAccumMs: new Map(),
        startupRan: new Set(),
        firedOnceEvents: new Set(),
        pendingTagChanges: new Set(),
      };
      simProjectStateMap.set(project, existing);
    }
    simState = existing;
  } else {
    simState = {
      fbState: Object.create(null) as Record<string, Record<string, unknown>>,
      delayState: new Map(),
      simTimeMs: Date.now(),
      cyclicAccumMs: new Map(),
      startupRan: new Set(),
      firedOnceEvents: new Set(),
      pendingTagChanges: new Set(),
    };
  }

  // Pre-compile saved ST POUs once before running N scan cycles
  const compiledPous: { name: string; script: vm.Script }[] = [];
  const preCompileErrors: string[] = [];
  for (const pou of project.pous) {
    if (pou.language !== 'ST') continue;
    const transpiled = transpileStToHaiwellJs(pou.source, {}, {
      apiStyle: 'HAIWELL_NATIVE_350',
      cyclicIntervalMs: scanIntervalMs,
    });
    if (transpiled.success && transpiled.jsCode) {
      try {
        compiledPous.push({
          name: pou.name,
          script: new vm.Script(`(function() {\n${transpiled.jsCode}\n})();`, {
            filename: `pou_${pou.name}.js`,
          }),
        });
      } catch (err) {
        preCompileErrors.push(`POU "${pou.name}": ${(err as Error).message}`);
      }
    } else {
      const errMsgs = transpiled.validation.diagnostics
        .filter((d) => d.severity === 'ERROR')
        .map((d) => `${d.code}: ${d.message}`);
      const errMsg = errMsgs.length ? errMsgs.join('; ') : 'ST transpilation failed';
      preCompileErrors.push(`POU "${pou.name}" transpile error: ${errMsg}`);
    }
  }

  // Pre-compile validated Haiwell JS scripts (re-validated via AST security analyzer before VM execution)
  const compiledScripts: {
    id: string;
    name: string;
    trigger: string;
    triggerTag?: string;
    intervalMs?: number;
    script: vm.Script;
  }[] = [];
  const compiledScriptByKey = new Map<string, { name: string; script: vm.Script }>();
  for (const scr of project.scripts) {
    const check = validateHaiwellScript(scr.code, project.tags, {
      trigger: scr.trigger,
      intervalMs: scr.intervalMs,
      triggerTag: scr.triggerTag,
      targetHardware: project.targetHardware,
    });
    const blockingErrors = check.diagnostics.filter((d) => d.severity === 'ERROR');
    if (blockingErrors.length > 0) {
      const firstErr = blockingErrors.map((d) => `${d.code}: ${d.message}`).join('; ');
      preCompileErrors.push(`Script "${scr.name}" skipped: ${firstErr}`);
      continue;
    }
    try {
      const compiled = new vm.Script(`(function() {\n${scr.code}\n})();`, {
        filename: `script_${scr.name}.js`,
      });
      compiledScriptByKey.set(scr.name, { name: scr.name, script: compiled });
      if (scr.id) {
        compiledScriptByKey.set(scr.id, { name: scr.name, script: compiled });
      }
      if (
        scr.trigger === 'CYCLIC' ||
        scr.trigger === 'TAG_CHANGE' ||
        scr.trigger === 'STARTUP' ||
        scr.trigger === 'ALARM_EVENT'
      ) {
        compiledScripts.push({
          id: scr.id,
          name: scr.name,
          trigger: scr.trigger,
          triggerTag: scr.triggerTag,
          intervalMs: scr.intervalMs,
          script: compiled,
        });
      }
    } catch (err) {
      preCompileErrors.push(`Script "${scr.name}": ${(err as Error).message}`);
    }
  }

  let recordingPostStep5Changes = false;
  const nextPendingTagChanges = new Set<string>();
  const { context: vmContext, syncFbStateToHost } = createSandboxedContext(
    project,
    simState.fbState,
    scanIntervalMs,
    (tagName) => {
      if (recordingPostStep5Changes) nextPendingTagChanges.add(tagName);
    }
  );

  const trace: {
    step: number;
    triggeredEvents: string[];
    newlyTriggeredAlarms: string[];
    clearedAlarms: string[];
    eStopTripped: boolean;
    outputsForcedSafe: string[];
    executedPous: string[];
    executedScripts: string[];
    scriptErrors: string[];
    tagsSnapshot: Record<string, number | boolean | string>;
  }[] = [];

  const enforceEStop = (outputsForcedSafe: string[]): boolean => {
    const eStopTag = resolveEStopTag(project, input.eStopTagName);
    const tripped = Boolean(
      eStopTag &&
        (eStopTag.currentValue === false || eStopTag.currentValue === 0 || eStopTag.currentValue === '0')
    );
    if (tripped && input.enforceEStopSafeState !== false) {
      for (const tag of Object.values(project.tags)) {
        if (tag.access === 'RO' || (eStopTag && tag.name === eStopTag.name)) continue;
        const isSafetyOutput =
          tag.requiresInterlock ||
          tag.safetyClass === 'SIL1' ||
          tag.safetyClass === 'SIL2' ||
          tag.safetyClass === 'SIL3' ||
          (tag.scope === 'PLC' &&
            tag.dataType === 'BOOL' &&
            /^(?:0X|COIL:|Y\d|Q\d|%Q)/i.test((tag.address ?? '').trim()));
        if (isSafetyOutput) {
          const safeVal =
            tag.dataType === 'BOOL' ? false : tag.dataType === 'STRING' ? '' : (tag.safeMin ?? 0);
          if (tag.currentValue !== safeVal) {
            tag.currentValue = safeVal;
            tag.updatedAt = new Date(simState.simTimeMs).toISOString();
            if (!outputsForcedSafe.includes(tag.name)) {
              outputsForcedSafe.push(tag.name);
            }
          }
        }
      }
    }
    return tripped;
  };

  // Snapshot previousValue before Step 1 injections
  for (const tag of Object.values(project.tags)) {
    if (tag.previousValue === undefined) {
      tag.previousValue = tag.currentValue;
    }
  }

  for (let s = 1; s <= steps; s++) {
    simState.simTimeMs += scanIntervalMs;
    const scriptErrors: string[] = s === 1 ? [...preCompileErrors] : [];
    const executedPous: string[] = [];
    const executedScripts: string[] = [];

    // 1. Apply raw ADC injections with linear scaling on step 1
    if (s === 1 && input.injectRawAdcValues) {
      for (const [tagName, rawVal] of Object.entries(input.injectRawAdcValues)) {
        const tag = hasOwnTag(tagName) ? project.tags[tagName] : undefined;
        if (!tag) continue;
        tag.previousValue = tag.currentValue;
        tag.currentValue = tag.scaling ? applyLinearScaling(rawVal, tag.scaling) : rawVal;
        tag.quality = 'SIMULATED';
        tag.updatedAt = new Date(simState.simTimeMs).toISOString();
      }
    }

    // 2. Apply direct tag injections on step 1 with type coercion
    if (s === 1 && input.injectTagValues) {
      for (const [tagName, val] of Object.entries(input.injectTagValues)) {
        const tag = hasOwnTag(tagName) ? project.tags[tagName] : undefined;
        if (!tag) continue;
        tag.previousValue = tag.currentValue;
        tag.currentValue = coerceTagWriteValue(tag, val);
        tag.quality = 'SIMULATED';
        tag.updatedAt = new Date(simState.simTimeMs).toISOString();
      }
    }

    // 3. Pre-logic E-Stop check
    const outputsForcedSafe: string[] = [];
    let eStopTripped = enforceEStop(outputsForcedSafe);

    // 4. Execute saved IEC 61131-3 ST POUs inside constrained VM sandbox
    for (const pou of compiledPous) {
      try {
        pou.script.runInContext(vmContext, { timeout: 250 });
        executedPous.push(pou.name);
      } catch (err) {
        scriptErrors.push(`POU "${pou.name}" runtime error: ${(err as Error).message}`);
      }
    }

    // 5. Execute validated Haiwell JS scripts (STARTUP, CYCLIC with intervalMs accumulator, TAG_CHANGE)
    for (const scr of compiledScripts) {
      let shouldRun = false;
      if (scr.trigger === 'STARTUP') {
        if (s === 1 && !simState.startupRan.has(scr.name)) {
          shouldRun = true;
          simState.startupRan.add(scr.name);
        }
      } else if (scr.trigger === 'CYCLIC') {
        const targetMs = scr.intervalMs ?? scanIntervalMs;
        const accum = (simState.cyclicAccumMs.get(scr.name) ?? 0) + scanIntervalMs;
        if (accum >= targetMs) {
          shouldRun = true;
          simState.cyclicAccumMs.set(scr.name, accum % targetMs);
        } else {
          simState.cyclicAccumMs.set(scr.name, accum);
        }
      } else if (scr.trigger === 'TAG_CHANGE' && scr.triggerTag && hasOwnTag(scr.triggerTag)) {
        const t = project.tags[scr.triggerTag];
        shouldRun =
          (t.previousValue !== undefined && t.previousValue !== t.currentValue) ||
          simState.pendingTagChanges.has(scr.triggerTag);
      }
      if (!shouldRun) continue;
      try {
        scr.script.runInContext(vmContext, { timeout: 250 });
        executedScripts.push(scr.name);
      } catch (err) {
        scriptErrors.push(`Script "${scr.name}" runtime error: ${(err as Error).message}`);
      }
    }
    simState.pendingTagChanges.clear();
    nextPendingTagChanges.clear();
    recordingPostStep5Changes = true;

    // 6. Re-evaluate E-Stop before Event Triggers, then evaluate declarative Haiwell Event Triggers
    eStopTripped = enforceEStop(outputsForcedSafe);
    const triggeredEvents: string[] = [];
    for (const rule of project.eventTriggers) {
      if (!rule.enabled) continue;
      const mode = (rule as { executionMode?: string }).executionMode;
      const isRunOnce = mode === 'RUN_ONCE' || mode === 'ONCE';
      if (isRunOnce && simState.firedOnceEvents.has(rule.id)) continue;
      const src = hasOwnTag(rule.sourceTag) ? project.tags[rule.sourceTag] : undefined;
      if (!src) continue;
      const cur = toNumeric(src.currentValue);
      const prev = src.previousValue !== undefined ? toNumeric(src.previousValue) : cur;
      const fired =
        rule.condition === 'RISING_EDGE' ? prev === 0 && cur === 1 :
        rule.condition === 'FALLING_EDGE' ? prev === 1 && cur === 0 :
        rule.condition === 'ON_CHANGE' ? src.previousValue !== undefined && src.currentValue !== src.previousValue :
        rule.condition === 'GT' ? cur > (rule.threshold ?? 0) :
        rule.condition === 'LT' ? cur < (rule.threshold ?? 0) :
        cur === (rule.threshold ?? 0);

      if (fired) {
        const isEStopBlockedAction =
          eStopTripped &&
          (rule.actionType === 'WRITE_TAG' ||
            rule.actionType === 'RUN_SCRIPT' ||
            rule.actionType === 'DOWNLOAD_RECIPE');
        if (isEStopBlockedAction) {
          continue;
        }
        if (isRunOnce) simState.firedOnceEvents.add(rule.id);
        triggeredEvents.push(`${rule.id}:${rule.actionType}->${rule.targetId}`);
        if (rule.actionType === 'WRITE_TAG' && rule.actionValue !== undefined) {
          const targetTag = hasOwnTag(rule.targetId) ? project.tags[rule.targetId] : undefined;
          if (targetTag && targetTag.access !== 'RO') {
            const nextVal = coerceTagWriteValue(targetTag, rule.actionValue);
            if (targetTag.currentValue !== nextVal) nextPendingTagChanges.add(targetTag.name);
            targetTag.currentValue = nextVal;
            targetTag.updatedAt = new Date(simState.simTimeMs).toISOString();
          }
        } else if (rule.actionType === 'RUN_SCRIPT') {
          const targetScript = compiledScriptByKey.get(rule.targetId);
          if (targetScript) {
            try {
              targetScript.script.runInContext(vmContext, { timeout: 250 });
              executedScripts.push(targetScript.name);
            } catch (err) {
              scriptErrors.push(`Event script "${rule.targetId}" runtime error: ${(err as Error).message}`);
            }
          }
        } else if (rule.actionType === 'DOWNLOAD_RECIPE') {
          const [grpId, recId] = rule.targetId.split(':');
          const recipe = project.recipes.find(
            (r) => r.id === grpId || r.id === rule.targetId || r.name === rule.targetId
          );
          const rec = (recId ? recipe?.records.find((r) => r.recordId === recId) : undefined) ?? recipe?.records[0];
          if (rec) {
            for (const [k, v] of Object.entries(rec.values)) {
              const targetTag = hasOwnTag(k) ? project.tags[k] : undefined;
              if (targetTag && targetTag.access !== 'RO') {
                const nextVal = coerceTagWriteValue(targetTag, v);
                if (targetTag.currentValue !== nextVal) nextPendingTagChanges.add(targetTag.name);
                targetTag.currentValue = nextVal;
                targetTag.updatedAt = new Date(simState.simTimeMs).toISOString();
              }
            }
          }
        }
      }
    }

    // 7. Post-logic E-Stop enforcement (safety relay always overrides software logic!)
    eStopTripped = enforceEStop(outputsForcedSafe);

    // 8. Evaluate ISA-18.2 alarms (and run ALARM_EVENT scripts if newly triggered)
    const almSummary = evaluateProjectAlarms(project, {
      simTimeMs: simState.simTimeMs,
      scanIntervalMs,
      delayState: simState.delayState,
      enforceDelays: true,
    });
    if (almSummary.newlyTriggered.length > 0) {
      for (const scr of compiledScripts) {
        if (scr.trigger !== 'ALARM_EVENT') continue;
        try {
          scr.script.runInContext(vmContext, { timeout: 250 });
          executedScripts.push(scr.name);
        } catch (err) {
          scriptErrors.push(`Script "${scr.name}" runtime error: ${(err as Error).message}`);
        }
      }
      eStopTripped = enforceEStop(outputsForcedSafe);
    }
    recordingPostStep5Changes = false;
    for (const chgTag of nextPendingTagChanges) {
      simState.pendingTagChanges.add(chgTag);
    }

    const tagsSnapshot: Record<string, number | boolean | string> = Object.fromEntries(
      Object.values(project.tags).map((t) => [t.name, t.currentValue])
    );

    trace.push({
      step: s,
      triggeredEvents,
      newlyTriggeredAlarms: almSummary.newlyTriggered.map((e) => e.alarmId),
      clearedAlarms: almSummary.cleared.map((e) => e.alarmId),
      eStopTripped,
      outputsForcedSafe,
      executedPous,
      executedScripts,
      scriptErrors,
      tagsSnapshot,
    });

    // 9. Real PLC end-of-scan latch: previousValue := currentValue so edges/ROC do not phantom-refire on steps 2..N
    for (const tag of Object.values(project.tags)) {
      tag.previousValue = tag.currentValue;
    }
  }

  syncFbStateToHost();

  const finalTags: Record<string, number | boolean | string> = Object.fromEntries(
    Object.values(project.tags).map((t) => [t.name, t.currentValue])
  );
  const resolvedEStop = resolveEStopTag(project, input.eStopTagName);

  return {
    projectId: project.id,
    stepsExecuted: steps,
    scanIntervalMs,
    eStopTagName: resolvedEStop?.name ?? null,
    trace,
    tagSnapshot: Object.fromEntries(
      Object.values(project.tags).map((t) => [t.name, { value: t.currentValue, quality: t.quality }])
    ),
    finalTags,
    activeAlarms: project.alarmHistory.filter((e) => e.state === 'ACTIVE_UNACK' || e.state === 'ACTIVE_ACK'),
  };
}
