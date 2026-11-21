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

function isAlarmTripped(alm: AlarmDefinition, currentVal: number, prevVal: number, alreadyActive: boolean): boolean {
  const db = Math.max(0, alm.deadband);
  switch (alm.condition) {
    case 'HIHI':
    case 'HI':
      return alreadyActive ? currentVal > alm.threshold - db : currentVal >= alm.threshold;
    case 'LO':
    case 'LOLO':
      return alreadyActive ? currentVal < alm.threshold + db : currentVal <= alm.threshold;
    case 'DIGITAL_HIGH':
      return currentVal === 1;
    case 'DIGITAL_LOW':
      return currentVal === 0;
    case 'ROC':
      return Math.abs(currentVal - prevVal) >= alm.threshold;
    case 'DEV': {
      const ref = alm.referenceValue ?? 0;
      const delta = Math.abs(currentVal - ref);
      return alreadyActive ? delta > alm.threshold - db : delta >= alm.threshold;
    }
  }
}

export interface AlarmEvalSummary {
  evaluatedRules: number;
  newlyTriggered: ActiveAlarmEvent[];
  cleared: ActiveAlarmEvent[];
  activeCount: number;
}

/**
 * Deduplicating ISA-18.2 state machine:
 * NORMAL -> ACTIVE_UNACK -> ACTIVE_ACK -> NORMAL (when cleared)
 * ACTIVE_UNACK -> CLEARED_UNACK (when cleared before ack) -> NORMAL (when acked)
 */
export function evaluateProjectAlarms(project: HaiwellProject): AlarmEvalSummary {
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const newlyTriggered: ActiveAlarmEvent[] = [];
  const cleared: ActiveAlarmEvent[] = [];

  const hasOwnTag = (name: string) => Object.prototype.hasOwnProperty.call(project.tags, name);

  for (const alm of project.alarms) {
    if (!alm.enabled) continue;
    if (alm.shelvedUntil && Date.parse(alm.shelvedUntil) > nowMs) continue;

    const tag = hasOwnTag(alm.tagName) ? project.tags[alm.tagName] : undefined;
    if (!tag) continue;

    const cur = toNumeric(tag.currentValue);
    const prev = tag.previousValue !== undefined ? toNumeric(tag.previousValue) : cur;

    const existingActive = project.alarmHistory.find(
      (e) => e.alarmId === alm.id && (e.state === 'ACTIVE_UNACK' || e.state === 'ACTIVE_ACK')
    );

    const tripped = isAlarmTripped(alm, cur, prev, Boolean(existingActive));

    if (tripped && !existingActive) {
      const ev: ActiveAlarmEvent = {
        eventId: `ev_${alm.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        alarmId: alm.id,
        tagName: alm.tagName,
        value: tag.currentValue,
        priority: alm.priority,
        message: alm.messageTemplate,
        state: 'ACTIVE_UNACK',
        triggeredAt: now,
      };
      project.alarmHistory.push(ev);
      if (project.alarmHistory.length > 500) {
        project.alarmHistory.splice(0, project.alarmHistory.length - 500);
      }
      newlyTriggered.push(ev);
    } else if (!tripped && existingActive) {
      existingActive.clearedAt = now;
      existingActive.state = existingActive.state === 'ACTIVE_ACK' ? 'NORMAL' : 'CLEARED_UNACK';
      cleared.push(existingActive);
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
  return Number.isFinite(n) ? n : 0;
}

function createSandboxedContext(
  project: HaiwellProject,
  fbState: Record<string, Record<string, unknown>>,
  scanIntervalMs: number
) {
  const readTag = (name: string): number | boolean | string | undefined => {
    const tag = resolveTagByFullName(project, String(name));
    return tag ? tag.currentValue : undefined;
  };
  const writeTag = (name: string, value: unknown): boolean => {
    const tag = resolveTagByFullName(project, String(name));
    if (!tag || tag.access === 'RO') return false;
    const coerced = coerceTagWriteValue(tag, value);
    tag.currentValue = coerced;
    tag.quality = 'SIMULATED';
    tag.updatedAt = new Date().toISOString();
    return true;
  };

  const sandbox: Record<string, unknown> = Object.create(null);
  sandbox.Variable = Object.freeze({
    GetByFullName: readTag,
    SetByFullName: writeTag,
    BatchSetByFullNames: (map: Record<string, unknown>) => {
      if (!map || typeof map !== 'object') return false;
      for (const [k, v] of Object.entries(map)) {
        writeTag(k, v);
      }
      return true;
    },
  });
  sandbox.Tag = Object.freeze({
    Read: readTag,
    Write: writeTag,
  });
  sandbox.Common = Object.freeze({
    logger: Object.freeze({
      log: () => {},
      debug: () => {},
      info: () => {},
      trace: () => {},
      warn: () => {},
      note: () => {},
      error: () => {},
    }),
    SetTimeout: () => 0,
    SetInterval: () => 0,
  });
  sandbox.__fbState = fbState;
  sandbox.__SCAN_MS = scanIntervalMs;
  sandbox.Math = Math;
  sandbox.Date = Date;
  sandbox.JSON = JSON;
  sandbox.Number = Number;
  sandbox.String = String;
  sandbox.Boolean = Boolean;
  sandbox.Array = Array;
  sandbox.Object = Object;
  sandbox.parseInt = parseInt;
  sandbox.parseFloat = parseFloat;
  sandbox.isNaN = isNaN;
  sandbox.isFinite = isFinite;

  // Bind single-level $TagName accessors on sandbox global
  for (const tag of Object.values(project.tags)) {
    Object.defineProperty(sandbox, `$${tag.name}`, {
      enumerable: true,
      configurable: true,
      get: () => tag.currentValue,
      set: (v: unknown) => {
        writeTag(tag.name, v);
      },
    });
  }

  // Bind $DeviceName objects with tag properties
  for (const dev of project.devices) {
    const devProxy: Record<string, unknown> = {};
    for (const tag of Object.values(project.tags)) {
      if (tag.deviceId === dev.id || tag.scope === 'PLC') {
        Object.defineProperty(devProxy, tag.name, {
          enumerable: true,
          get: () => tag.currentValue,
          set: (v: unknown) => {
            writeTag(tag.name, v);
          },
        });
      }
    }
    sandbox[`$${dev.name}`] = devProxy;
  }

  return vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });
}

export function runSimulationSteps(project: HaiwellProject, input: SimulationStepInput) {
  const steps = Math.max(1, Math.min(input.steps ?? 1, 50));
  const scanIntervalMs = Math.max(50, Math.min(input.scanIntervalMs ?? 1000, 60000));
  const hasOwnTag = (name: string) => Object.prototype.hasOwnProperty.call(project.tags, name);

  // Pre-compile saved ST POUs once before running N scan cycles
  const compiledPous: { name: string; script: vm.Script }[] = [];
  const preCompileErrors: string[] = [];
  for (const pou of project.pous) {
    if (pou.language !== 'ST') continue;
    const transpiled = transpileStToHaiwellJs(pou.source, {}, { apiStyle: 'HAIWELL_NATIVE_350' });
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
    }
  }

  // Pre-compile validated Haiwell JS scripts (re-validated via AST security analyzer before VM execution)
  const compiledScripts: {
    name: string;
    trigger: string;
    triggerTag?: string;
    script: vm.Script;
  }[] = [];
  for (const scr of project.scripts) {
    if (scr.trigger !== 'CYCLIC' && scr.trigger !== 'TAG_CHANGE') continue;
    const check = validateHaiwellScript(scr.code, project.tags, {
      trigger: scr.trigger,
      intervalMs: scr.intervalMs,
      triggerTag: scr.triggerTag,
      strictEs5: false,
    });
    const hasSecurityOrSyntaxError = check.diagnostics.some(
      (d) => d.severity === 'ERROR' && (d.code === 'HWJS-SEC-001' || d.code === 'HWJS-SYN-001' || d.code === 'HWJS-SAFE-001')
    );
    if (hasSecurityOrSyntaxError) {
      preCompileErrors.push(`Script "${scr.name}" skipped due to safety/syntax error.`);
      continue;
    }
    try {
      compiledScripts.push({
        name: scr.name,
        trigger: scr.trigger,
        triggerTag: scr.triggerTag,
        script: new vm.Script(`(function() {\n${scr.code}\n})();`, {
          filename: `script_${scr.name}.js`,
        }),
      });
    } catch (err) {
      preCompileErrors.push(`Script "${scr.name}": ${(err as Error).message}`);
    }
  }

  // Persistent FB state across all scan steps (TON/TOF/TP/CTU/CTD/R_TRIG/F_TRIG/SR/RS)
  const fbState: Record<string, Record<string, unknown>> = {};
  const vmContext = createSandboxedContext(project, fbState, scanIntervalMs);

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
    const tripped = Boolean(eStopTag && eStopTag.currentValue === false);
    if (tripped && input.enforceEStopSafeState !== false) {
      for (const tag of Object.values(project.tags)) {
        if (tag.requiresInterlock && tag.access !== 'RO') {
          const safeVal = tag.dataType === 'BOOL' ? false : tag.safeMin ?? 0;
          if (tag.currentValue !== safeVal) {
            tag.currentValue = safeVal;
            tag.updatedAt = new Date().toISOString();
            if (!outputsForcedSafe.includes(tag.name)) {
              outputsForcedSafe.push(tag.name);
            }
          }
        }
      }
    }
    return tripped;
  };

  for (let s = 1; s <= steps; s++) {
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
        tag.updatedAt = new Date().toISOString();
      }
    }

    // 2. Apply direct tag injections on step 1
    if (s === 1 && input.injectTagValues) {
      for (const [tagName, val] of Object.entries(input.injectTagValues)) {
        const tag = hasOwnTag(tagName) ? project.tags[tagName] : undefined;
        if (!tag) continue;
        tag.previousValue = tag.currentValue;
        tag.currentValue = val;
        tag.quality = 'SIMULATED';
        tag.updatedAt = new Date().toISOString();
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

    // 5. Execute validated Haiwell JS scripts (CYCLIC every scan, TAG_CHANGE when triggerTag changed)
    for (const scr of compiledScripts) {
      let shouldRun = scr.trigger === 'CYCLIC';
      if (scr.trigger === 'TAG_CHANGE' && scr.triggerTag && hasOwnTag(scr.triggerTag)) {
        const t = project.tags[scr.triggerTag];
        shouldRun = t.previousValue !== undefined && t.previousValue !== t.currentValue;
      }
      if (!shouldRun) continue;
      try {
        scr.script.runInContext(vmContext, { timeout: 250 });
        executedScripts.push(scr.name);
      } catch (err) {
        scriptErrors.push(`Script "${scr.name}" runtime error: ${(err as Error).message}`);
      }
    }

    // 6. Evaluate declarative Haiwell Event Triggers
    const triggeredEvents: string[] = [];
    for (const rule of project.eventTriggers) {
      if (!rule.enabled) continue;
      const src = hasOwnTag(rule.sourceTag) ? project.tags[rule.sourceTag] : undefined;
      if (!src) continue;
      const cur = toNumeric(src.currentValue);
      const prev = src.previousValue !== undefined ? toNumeric(src.previousValue) : cur;
      const fired =
        rule.condition === 'RISING_EDGE' ? prev === 0 && cur === 1 :
        rule.condition === 'FALLING_EDGE' ? prev === 1 && cur === 0 :
        rule.condition === 'ON_CHANGE' ? cur !== prev :
        rule.condition === 'GT' ? cur > (rule.threshold ?? 0) :
        rule.condition === 'LT' ? cur < (rule.threshold ?? 0) :
        cur === (rule.threshold ?? 0);

      if (fired) {
        triggeredEvents.push(`${rule.id}:${rule.actionType}->${rule.targetId}`);
        if (rule.actionType === 'WRITE_TAG' && rule.actionValue !== undefined) {
          const targetTag = hasOwnTag(rule.targetId) ? project.tags[rule.targetId] : undefined;
          if (targetTag && targetTag.access !== 'RO' && !eStopTripped) {
            targetTag.currentValue = rule.actionValue;
            targetTag.updatedAt = new Date().toISOString();
          }
        }
      }
    }

    // 7. Post-logic E-Stop enforcement (safety relay always overrides software logic!)
    eStopTripped = enforceEStop(outputsForcedSafe);

    // 8. Evaluate ISA-18.2 alarms
    const almSummary = evaluateProjectAlarms(project);

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
