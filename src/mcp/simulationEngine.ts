/**
 * Deterministic ISA-18.2 Alarm State Machine & Headless PLC/SCADA Scan-Cycle Simulator.
 * Allows AI agents to inject sensor faults or E-Stop trips and verify alarm transitions,
 * event triggers, linear scaling, and safety interlock behavior headlessly.
 */

import { applyLinearScaling } from './plcAddressing';
import type { ActiveAlarmEvent, AlarmDefinition, HaiwellProject } from './types';

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
  enforceEStopSafeState?: boolean;
}

export function runSimulationSteps(project: HaiwellProject, input: SimulationStepInput) {
  const steps = Math.max(1, Math.min(input.steps ?? 1, 50));
  const hasOwnTag = (name: string) => Object.prototype.hasOwnProperty.call(project.tags, name);
  const trace: {
    step: number;
    triggeredEvents: string[];
    newlyTriggeredAlarms: string[];
    clearedAlarms: string[];
    eStopTripped: boolean;
    outputsForcedSafe: string[];
  }[] = [];

  for (let s = 1; s <= steps; s++) {
    // 1. Apply raw ADC injections with linear scaling
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

    // 3. Evaluate E-Stop hardware fail-safe de-energization if enabled
    const outputsForcedSafe: string[] = [];
    const eStopTag = hasOwnTag('EStop_OK') ? project.tags['EStop_OK'] : undefined;
    const eStopTripped = Boolean(eStopTag && eStopTag.currentValue === false);
    if (eStopTripped && input.enforceEStopSafeState !== false) {
      for (const tag of Object.values(project.tags)) {
        if (tag.requiresInterlock && tag.access !== 'RO') {
          const safeVal = tag.dataType === 'BOOL' ? false : tag.safeMin ?? 0;
          if (tag.currentValue !== safeVal) {
            tag.previousValue = tag.currentValue;
            tag.currentValue = safeVal;
            tag.updatedAt = new Date().toISOString();
            outputsForcedSafe.push(tag.name);
          }
        }
      }
    }

    // 4. Evaluate declarative Haiwell Event Triggers
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
            targetTag.previousValue = targetTag.currentValue;
            targetTag.currentValue = rule.actionValue;
            targetTag.updatedAt = new Date().toISOString();
          }
        }
      }
    }

    // 5. Evaluate ISA-18.2 alarms
    const almSummary = evaluateProjectAlarms(project);

    trace.push({
      step: s,
      triggeredEvents,
      newlyTriggeredAlarms: almSummary.newlyTriggered.map((e) => e.alarmId),
      clearedAlarms: almSummary.cleared.map((e) => e.alarmId),
      eStopTripped,
      outputsForcedSafe,
    });

    // 6. Real PLC end-of-scan latch: previousValue := currentValue so edges/ROC do not phantom-refire on steps 2..N
    for (const tag of Object.values(project.tags)) {
      tag.previousValue = tag.currentValue;
    }
  }

  return {
    projectId: project.id,
    stepsExecuted: steps,
    trace,
    tagSnapshot: Object.fromEntries(
      Object.values(project.tags).map((t) => [t.name, { value: t.currentValue, quality: t.quality }])
    ),
    activeAlarms: project.alarmHistory.filter((e) => e.state === 'ACTIVE_UNACK' || e.state === 'ACTIVE_ACK'),
  };
}
