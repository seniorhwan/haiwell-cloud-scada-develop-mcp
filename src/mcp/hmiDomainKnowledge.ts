/**
 * Industrial HMI Engineering Knowledge Base — S&P 500 Factory Archetypes,
 * Human Factors Authorities, and Explicit Epistemic Separation (Facts vs. Standards vs. Opinions).
 *
 * Served to AI agents via MCP resource `haiwell://knowledge/hmi-engineering-playbook`
 * and consumed by `hmiDesignSystem.ts` for context-aware, non-dogmatic HMI auditing.
 */

import type {
  HmiEvidenceBasis,
  HmiIndustryDomain,
  HmiScreen,
  HmiThemeId,
  TagDefinition,
} from './types';

export interface HmiAuthorityProfile {
  name: string;
  affiliation: string;
  contribution: string;
  evidenceType: HmiEvidenceBasis;
  verifiedTakeaway: string;
  criticalCaveat: string;
}

export interface HmiDomainProfile {
  domain: HmiIndustryDomain;
  label: string;
  sp500Examples: string[];
  applicableStandards: string[];
  recommendedThemeIds: HmiThemeId[];
  colorStrategy: string;
  hierarchyAndNavigation: string;
  informationEncoding: string;
  failureModeWhenMisapplied: string;
}

export interface HmiEngineeringPrinciple {
  id: string;
  title: string;
  evidenceBasis: HmiEvidenceBasis;
  domains: HmiIndustryDomain[];
  statement: string;
  sourceOrRationale: string;
  enforcedByAuditCode?: string;
}

export interface HmiDogmaCritique {
  myth: string;
  classification: 'PRACTITIONER_OPINION' | 'OVERGENERALIZED_STANDARD';
  whereItWorks: string;
  whereItFails: string;
  pragmaticRule: string;
}

export const HMI_AUTHORITIES: HmiAuthorityProfile[] = [
  {
    name: 'Dr. Mica R. Endsley',
    affiliation: 'SA Technologies / Human Factors & Ergonomics Society',
    contribution: 'Three-level Situation Awareness (SA) model (Level 1 Perception -> Level 2 Comprehension -> Level 3 Projection), SAGAT measurement, and Out-of-the-Loop (OOTL) performance research.',
    evidenceType: 'EMPIRICAL_FACT',
    verifiedTakeaway: 'Raw digital readouts only satisfy Level 1 (perception). Operators under stress need normal operating bands, limits, and rate-of-change trends to achieve Level 2 (comprehension) and Level 3 (projection), and must see automation mode/interlock state to avoid OOTL failures.',
    criticalCaveat: 'SA models explain cognitive bottlenecks across domains, but the concrete visual encoding still depends on whether the operator supervises slow thermal/chemical dynamics or fast discrete cycle faults.',
  },
  {
    name: 'Dr. Peter Bullemer, Dr. Dal Vernon Reising & Jamie Errington',
    affiliation: 'ASM Consortium (ExxonMobil, Chevron, Shell, BP, Honeywell) / Human Centered Solutions / NOVA Chemicals',
    contribution: 'Controlled operator-in-the-loop simulator evaluations comparing traditional P&ID-mimic DCS graphics against human-centered High Performance HMI displays; authored Effective Console Operator HMI Design.',
    evidenceType: 'EMPIRICAL_FACT',
    verifiedTakeaway: 'In the landmark NOVA Chemicals / ASM Consortium simulator study, operators detected developing abnormal situations BEFORE alarms tripped 48% of the time vs. 10% on traditional mimics, improved upset resolution success from ~70% to 96%, and completed mitigation roughly 40%-41% faster.',
    criticalCaveat: 'These simulator trials tested multi-loop continuous petrochemical consoles — they empirically prove clutter reduction and operating-context encoding in continuous process control, not universal superiority of identical layouts for high-speed discrete robotics.',
  },
  {
    name: 'Bill Hollifield',
    affiliation: 'Former Union Carbide / Dow, PAS, co-author of The High Performance HMI Handbook (with Eddie Habibi, Dana Oliver, Ian Nimmo)',
    contribution: 'Translated human-factors and ASM findings into concrete industrial graphic templates: 4-level display hierarchy (L1-L4), neutral canvas baselines, moving-pointer analog indicators, embedded mini-trends, and strict alarm-color discipline.',
    evidenceType: 'INDUSTRY_STANDARD',
    verifiedTakeaway: 'Replaced decorative "Las Vegas Strip" / 3D animated P&ID mimics with disciplined, repeatable graphic standards adopted across refining, chemical, and power plants.',
    criticalCaveat: 'Later vendor/consultant evangelism often hardened Hollifield\'s process-control templates into rigid "100% monochrome grayscale everywhere" dogma that breaks down on shop-floor discrete machines.',
  },
  {
    name: 'Ian Nimmo',
    affiliation: 'User Centered Design Services / ASM Consortium',
    contribution: 'Control room ergonomics (EEMUA 201 / ISO 11064), alarm rationalization (ISA-18.2), and operator workload engineering.',
    evidenceType: 'INDUSTRY_STANDARD',
    verifiedTakeaway: 'HMI graphics cannot compensate for broken alarm management or poor physical ergonomics; limiting alarm priorities to 3-4 rationalized levels prevents alarm flooding and habituation.',
    criticalCaveat: 'Full control-room ergonomic redesigns (lighting, console geometry, alarm rationalization) are organizational programs, not fixes achievable purely by restyling a single touch-panel screen.',
  },
  {
    name: 'Dr. Kim J. Vicente & Jens Rasmussen',
    affiliation: 'University of Toronto / Risø National Laboratory',
    contribution: 'Ecological Interface Design (EID), Abstraction Hierarchy (AH), and Skills-Rules-Knowledge (SRK) taxonomy validated in thermal-hydraulic process simulations (DURESS).',
    evidenceType: 'EMPIRICAL_FACT',
    verifiedTakeaway: 'Making invisible physical laws and functional constraints (mass/energy balances, interlock boundaries) perceptually visible helps operators diagnose novel, unanticipated faults more reliably than component-only displays.',
    criticalCaveat: 'Vicente himself documented EID\'s practical barriers: high domain-modeling cost and lack of turnkey toolkits limit full EID to high-consequence, tightly coupled processes rather than every simple packaging skid.',
  },
];

export const HMI_DOMAIN_PROFILES: Record<HmiIndustryDomain, HmiDomainProfile> = {
  PROCESS_CONTINUOUS: {
    domain: 'PROCESS_CONTINUOUS',
    label: 'Continuous Process (Refining, Chemicals, Utilities, Chiller/HVAC, Water)',
    sp500Examples: ['ExxonMobil', 'Chevron', 'Dow'],
    applicableStandards: ['ANSI/ISA-101.01', 'ANSI/ISA-18.2', 'EEMUA 201', 'ISO 11064', 'ASM Consortium Guidelines'],
    recommendedThemeIds: ['ISA_101_LIGHT', 'CONTROL_ROOM_DARK'],
    colorStrategy: 'Neutral muted background (light gray on bright floors, slate dark in dim 24/7 control rooms). Equipment uses luminance/shape/text for normal Running/Stopped state. Saturated red/amber/orange are reserved strictly for alarms and abnormal deviations so visual pop-out remains intact.',
    hierarchyAndNavigation: '4-level ISA-101 hierarchy: L1 Plant Overview (KPIs + trends + alarm summary) -> L2 Area/Unit Control -> L3 Equipment Detail/Faceplate -> L4 Diagnostics/Tuning. Target <= 3 clicks to any asset.',
    informationEncoding: 'Always pair continuous analog values (temperature, pressure, flow, level) with engineering units, normal operating range/limits, and embedded trends/bar-graphs/gauges to support Endsley SA Levels 2 & 3.',
    failureModeWhenMisapplied: 'Turning continuous process screens into raw tables of bare numbers or rainbow animated P&IDs destroys pre-alarm upset detection.',
  },
  HYBRID_BATCH_CPG: {
    domain: 'HYBRID_BATCH_CPG',
    label: 'Hybrid Batch & High-Speed CPG (Consumer Goods, Food & Beverage, Pharma)',
    sp500Examples: ['Procter & Gamble (P&G)'],
    applicableStandards: ['ANSI/ISA-101.01', 'ISA-TR88.00.02 (PackML)', 'ISA-88 Batch', 'Rockwell PlantPAx Style Guide'],
    recommendedThemeIds: ['ISA_101_LIGHT', 'HIGH_CONTRAST_TOUCH'],
    colorStrategy: 'Reconciles ISA-101 visual restraint with PackML 17-state machine clarity: process vessels/skids remain muted neutral while machine/batch states (Execute, Held, Suspended, Idle, Aborted) are communicated through explicit text labels + subtle badges, preserving saturated red/amber for faults and abnormal holds.',
    hierarchyAndNavigation: 'Standardized cross-plant templates (Line OEE Overview -> Machine/Batch Unit -> Recipe/Faceplate -> Micro-stoppage Diagnostics) so operators transfer between plants without retraining.',
    informationEncoding: 'Combines analog batch variables (temperature/pressure/recipe targets with units & limits) with PackML state banners, OEE/throughput KPIs, and batch/recipe selectors.',
    failureModeWhenMisapplied: 'Allowing every OEM skid to ship its own rainbow "Las Vegas Strip" HMI destroys cross-plant consistency and slows changeover/troubleshooting.',
  },
  DISCRETE_MANUFACTURING: {
    domain: 'DISCRETE_MANUFACTURING',
    label: 'Discrete & Automotive Manufacturing (Assembly, Stamping, Body Shop, Packaging Cells)',
    sp500Examples: ['Ford', 'General Motors (GM)', 'Toyota Andon-influenced assembly plants'],
    applicableStandards: ['ISA-TR88.00.02 (PackML)', 'ANSI/ISA-101.01 (utilities/paint/HVAC)', 'Toyota Andon Visual Management'],
    recommendedThemeIds: ['HIGH_CONTRAST_TOUCH', 'ISA_101_LIGHT'],
    colorStrategy: 'Pragmatic hybrid: keep canvases clean and reserve red strictly for faults/E-Stop, but allow clear multi-state operating differentiation (Auto, Manual, Starved, Blocked, Changeover) paired with explicit text labels so operators standing beside a fast machine see cell bottlenecks at a glance.',
    hierarchyAndNavigation: 'Flat 1-2 click fault localization: Line/Cell Spatial Mimic -> Station/Actuator Interlock & Recovery. Never bury jammed-sensor or robot-interlock diagnostics 3+ clicks deep.',
    informationEncoding: 'Spatial/kinematic station layout matching physical cell geometry, explicit interlock/sensor fault diagnostics, cycle time/OEE/good-reject counters, and transactional recipe/part IDs (raw counters are inherently digital — do NOT force artificial analog trends onto part counts).',
    failureModeWhenMisapplied: 'Forcing refinery-style 100% dull grayscale and deep 3-click drill-downs onto high-speed assembly cells increases click count, delays jam recovery, and causes operator rejection.',
  },
};

export const HMI_DESIGN_PRINCIPLES: HmiEngineeringPrinciple[] = [
  {
    id: 'HF-FACT-01',
    title: 'Never Encode Critical State by Color Alone (Red-Green CVD ~8% of Males)',
    evidenceBasis: 'EMPIRICAL_FACT',
    domains: ['PROCESS_CONTINUOUS', 'HYBRID_BATCH_CPG', 'DISCRETE_MANUFACTURING'],
    statement: 'Approximately 8% of males (~0.5% of females) have red-green color-vision deficiency. Every alarm, interlock, and equipment status must combine color with redundant text, shape, or luminance coding.',
    sourceOrRationale: 'Human vision biology; mandated across ANSI/ISA-101.01 and EEMUA 201.',
    enforcedByAuditCode: 'HMI-HF-COLOR-ONLY-CODING',
  },
  {
    id: 'HF-FACT-02',
    title: 'Preserve Alarm Pop-Out by Avoiding Saturated Decorative Colors',
    evidenceBasis: 'EMPIRICAL_FACT',
    domains: ['PROCESS_CONTINUOUS', 'HYBRID_BATCH_CPG', 'DISCRETE_MANUFACTURING'],
    statement: 'Human visual search time degrades sharply when non-alarm elements use saturated red, amber, or neon colors ("alarm color dilution"). Keep normal surfaces neutral so real alarms pop out pre-attentively.',
    sourceOrRationale: 'Pre-attentive visual search psychophysics; ASM Consortium Guidelines.',
    enforcedByAuditCode: 'HMI-HF-ALARM-COLOR-DILUTION',
  },
  {
    id: 'HF-FACT-03',
    title: 'Encode Operating Context for Analog Process Variables (Endsley SA L2/L3)',
    evidenceBasis: 'EMPIRICAL_FACT',
    domains: ['PROCESS_CONTINUOUS', 'HYBRID_BATCH_CPG'],
    statement: 'Continuous process variables require engineering units, safe/operating bounds, and trend/analog range context. In the NOVA Chemicals / ASM simulator study, contextual displays raised pre-alarm abnormal-situation detection from 10% to 48% and upset resolution from ~70% to 96%.',
    sourceOrRationale: 'Endsley SA Model; Errington, Bullemer & Reising (ASM Consortium / NOVA Chemicals simulator study).',
    enforcedByAuditCode: 'HMI-HF-MISSING-PROCESS-CONTEXT',
  },
  {
    id: 'HF-FACT-04',
    title: 'Enforce Luminance Contrast & Anthropometric Touch Targets',
    evidenceBasis: 'EMPIRICAL_FACT',
    domains: ['PROCESS_CONTINUOUS', 'HYBRID_BATCH_CPG', 'DISCRETE_MANUFACTURING'],
    statement: 'Text contrast below 3.0:1 is illegible (target >= 4.5:1 WCAG AA against the true painted enclosing surface), and touch-panel interactive controls below 44x44px increase fat-finger error rates, especially with gloves.',
    sourceOrRationale: 'WCAG 2.1 luminance physics; human factors anthropometry for industrial touchscreens.',
    enforcedByAuditCode: 'HMI-VIS-INVISIBLE-TEXT',
  },
  {
    id: 'HF-FACT-05',
    title: 'Control Visual Clutter & Screen Density',
    evidenceBasis: 'EMPIRICAL_FACT',
    domains: ['PROCESS_CONTINUOUS', 'HYBRID_BATCH_CPG', 'DISCRETE_MANUFACTURING'],
    statement: 'Overcrowded screens (> 65% widget canvas coverage or > 30 non-panel elements on a compact 800x480 panel) slow visual scanning and hide developing faults.',
    sourceOrRationale: 'Visual search & cognitive load ergonomics; EEMUA 201 / ASM Consortium.',
    enforcedByAuditCode: 'HMI-HF-DENSITY-OVERLOAD',
  },
  {
    id: 'HF-STD-01',
    title: 'Separate Destructive Actions from Routine Navigation/Start Controls',
    evidenceBasis: 'INDUSTRY_STANDARD',
    domains: ['PROCESS_CONTINUOUS', 'HYBRID_BATCH_CPG', 'DISCRETE_MANUFACTURING'],
    statement: 'Maintain >= 12px spatial separation (and distinct grouping/confirmation) between DANGER_ACTION write controls (Stop/Abort/Override) and routine PRIMARY_ACTION or NAV_BAR buttons to prevent accidental activation.',
    sourceOrRationale: 'Industrial control ergonomics & ISO 11064 / ISA-101 control safety.',
    enforcedByAuditCode: 'HMI-HF-DANGER-PROXIMITY',
  },
  {
    id: 'HF-STD-02',
    title: 'Rationalize Alarm Priorities (3-4 Levels) & Keep Navigation Shallow',
    evidenceBasis: 'INDUSTRY_STANDARD',
    domains: ['PROCESS_CONTINUOUS', 'HYBRID_BATCH_CPG', 'DISCRETE_MANUFACTURING'],
    statement: 'Use 3-4 rationalized alarm priority tiers (ISA-18.2) with distinct shape + color + text, and keep navigation <= 3 clicks in continuous plants (1-2 clicks to fault recovery in discrete cells).',
    sourceOrRationale: 'ANSI/ISA-18.2, ANSI/ISA-101.01, EEMUA 201.',
  },
  {
    id: 'HF-OPIN-01',
    title: 'Light Neutral vs. Dark Canvas Depends on Ambient Lighting',
    evidenceBasis: 'PRACTITIONER_OPINION',
    domains: ['PROCESS_CONTINUOUS', 'HYBRID_BATCH_CPG', 'DISCRETE_MANUFACTURING'],
    statement: 'Light neutral gray (ISA_101_LIGHT / HIGH_CONTRAST_TOUCH) reduces glare on brightly lit shop floors; dark slate (CONTROL_ROOM_DARK) reduces eye strain in dim 24/7 central control rooms. Neither is universally superior.',
    sourceOrRationale: 'Human factors lighting ergonomics; practitioner debate across ISA-101 implementations.',
  },
];

export const HMI_DOGMA_CRITIQUES: HmiDogmaCritique[] = [
  {
    myth: 'Every factory HMI must be 100% dull monochrome grayscale.',
    classification: 'PRACTITIONER_OPINION',
    whereItWorks: 'Continuous refineries, chemical units, and power consoles where operators monitor dozens of slow analog loops and alarms must pre-attentively pop out.',
    whereItFails: 'High-speed discrete assembly/stamping/packaging cells (Ford/GM/Andon lines) where operators stand next to machinery and must distinguish Running, Starved, Blocked, Manual, and Fault states within one second.',
    pragmaticRule: 'Always keep backgrounds neutral and reserve bright red/amber strictly for faults/warnings, but use explicit state labels and disciplined multi-state status badges on discrete lines.',
  },
  {
    myth: 'Never display raw numbers; put analog moving-pointer bars and trends on everything.',
    classification: 'OVERGENERALIZED_STANDARD',
    whereItWorks: 'Continuous analog process variables (temperatures, pressures, levels, flows, PID loops) where direction and proximity to limits determine Endsley SA Levels 2 & 3.',
    whereItFails: 'Discrete manufacturing KPIs and transactional values: part counters, batch/recipe IDs, barcode strings, shift targets, and numeric PLC fault codes.',
    pragmaticRule: 'Require units + limits + trend/gauge context on continuous analog loops (`PROCESS_CONTINUOUS`); allow clean digital readouts for discrete counters and transactional codes (`DISCRETE_MANUFACTURING`).',
  },
  {
    myth: 'Always enforce a strict 4-level L1 -> L2 -> L3 -> L4 drill-down hierarchy.',
    classification: 'OVERGENERALIZED_STANDARD',
    whereItWorks: 'Large multi-unit refineries and plant-wide SCADA consoles supervising hundreds of loops across multiple process areas.',
    whereItFails: 'Local OEM machine touch panels (7"-10" Haiwell C7/C10) on discrete lines where burying jammed-sensor diagnostics 3 clicks deep wastes cycle time and frustrates operators.',
    pragmaticRule: 'Match navigation depth to span of control: <= 3 clicks for multi-unit process plants, 1-2 clicks directly to station interlocks/fault recovery for machine-level discrete HMIs.',
  },
];

/**
 * Conservatively infers an HMI screen's industrial domain when the caller did not
 * explicitly specify `industryDomain`.
 */
export function inferHmiIndustryDomain(
  screen: HmiScreen,
  tags: Record<string, TagDefinition> = {}
): HmiIndustryDomain {
  if (screen.industryDomain) return screen.industryDomain;

  const discreteWidgetCount = screen.widgets.filter(
    (w) => w.type === 'STATION' || w.type === 'CONVEYOR' || w.type === 'ACTUATOR'
  ).length;
  const processWidgetCount = screen.widgets.filter(
    (w) =>
      w.type === 'PUMP' ||
      w.type === 'VALVE' ||
      w.type === 'TANK' ||
      w.type === 'PIPELINE' ||
      w.type === 'TREND_CHART'
  ).length;
  const hasRecipe = screen.widgets.some((w) => w.type === 'RECIPE_SELECTOR');

  const combinedText = [
    screen.name,
    ...screen.widgets.map((w) => `${w.label} ${w.tagName ?? ''}`),
  ]
    .join(' ')
    .toLowerCase();

  const discreteKeywordHits = (
    combinedText.match(/\b(station|conveyor|press|robot|clamp|cycle|oee|pallet|packml|starved|blocked|counter|part|reject|scrap)\b/g) ?? []
  ).length;
  const processKeywordHits = (
    combinedText.match(/\b(chiller|boiler|reactor|pump|valve|tank|temp|pressure|flow|level|ph|condenser|evaporator|setpoint|pid|steam|water)\b/g) ?? []
  ).length;

  // Check bound tag data types for analog vs. counter ratio
  let floatBound = 0;
  for (const w of screen.widgets) {
    if (!w.tagName) continue;
    const tag = tags[w.tagName];
    if (tag && (tag.dataType === 'FLOAT32' || tag.dataType === 'FLOAT64')) {
      floatBound++;
    }
  }

  if (hasRecipe && (discreteWidgetCount > 0 || processWidgetCount > 0)) {
    return 'HYBRID_BATCH_CPG';
  }
  if (discreteWidgetCount > processWidgetCount || (discreteKeywordHits >= 3 && processKeywordHits === 0 && floatBound === 0)) {
    return 'DISCRETE_MANUFACTURING';
  }
  if (discreteWidgetCount > 0 && processWidgetCount > 0) {
    return 'HYBRID_BATCH_CPG';
  }
  return 'PROCESS_CONTINUOUS';
}

/**
 * Renders the complete S&P 500 Factory HMI Engineering Playbook as concise,
 * evidence-tiered markdown for AI agents via `haiwell://knowledge/hmi-engineering-playbook`.
 */
export function renderHmiEngineeringPlaybookMarkdown(): string {
  const facts = HMI_DESIGN_PRINCIPLES.filter((p) => p.evidenceBasis === 'EMPIRICAL_FACT');
  const standards = HMI_DESIGN_PRINCIPLES.filter((p) => p.evidenceBasis === 'INDUSTRY_STANDARD');
  const opinions = HMI_DESIGN_PRINCIPLES.filter((p) => p.evidenceBasis === 'PRACTITIONER_OPINION');

  return `# S&P 500 Factory HMI Engineering Playbook (Evidence-Tiered)

> **Epistemic Discipline**: Every rule in this playbook is explicitly tagged as **EMPIRICAL_FACT** (human biology, contrast physics, or controlled operator-in-the-loop simulator results), **INDUSTRY_STANDARD** (ANSI/ISA, EEMUA, ISO, PackML consensus), or **PRACTITIONER_OPINION** (context-dependent preference or overgeneralized dogma). Do NOT apply continuous-refinery dogma blindly to discrete factory machinery.

## 1. Choose the Right Factory Archetype First (\`industryDomain\`)
${Object.values(HMI_DOMAIN_PROFILES)
  .map(
    (p) => `### \`${p.domain}\` — ${p.label}
- **S&P 500 Reference Patterns**: ${p.sp500Examples.join(', ')}
- **Standards**: ${p.applicableStandards.join(', ')}
- **Recommended Haiwell Themes**: ${p.recommendedThemeIds.map((t) => `\`${t}\``).join(', ')}
- **Color Strategy**: ${p.colorStrategy}
- **Navigation & Hierarchy**: ${p.hierarchyAndNavigation}
- **Information Encoding**: ${p.informationEncoding}
- **Failure Mode if Misapplied**: ${p.failureModeWhenMisapplied}`
  )
  .join('\n\n')}

## 2. Empirical Facts (Hard Human-Factors Constraints — Always Enforce)
${facts
  .map(
    (p) => `- **[${p.id} | EMPIRICAL_FACT]** **${p.title}**: ${p.statement} _(${p.sourceOrRationale}${p.enforcedByAuditCode ? `; audited by \`${p.enforcedByAuditCode}\`` : ''})_`
  )
  .join('\n')}

## 3. Industry Consensus Standards (Strong Defaults — Adapt to Span of Control)
${standards
  .map(
    (p) => `- **[${p.id} | INDUSTRY_STANDARD]** **${p.title}**: ${p.statement} _(${p.sourceOrRationale}${p.enforcedByAuditCode ? `; audited by \`${p.enforcedByAuditCode}\`` : ''})_`
  )
  .join('\n')}

## 4. Practitioner Opinions & Where Dogma Fails (Critical Counter-Checks)
${opinions
  .map(
    (p) => `- **[${p.id} | PRACTITIONER_OPINION]** **${p.title}**: ${p.statement}`
  )
  .join('\n')}

${HMI_DOGMA_CRITIQUES.map(
  (c) => `### Myth: "${c.myth}" (\`${c.classification}\`)
- **Where it works**: ${c.whereItWorks}
- **Where it fails**: ${c.whereItFails}
- **Pragmatic Haiwell Rule**: ${c.pragmaticRule}`
).join('\n\n')}

## 5. Field Authorities & Primary Research to Learn From
${HMI_AUTHORITIES.map(
  (a) => `- **${a.name}** (${a.affiliation}) [${a.evidenceType}]: ${a.verifiedTakeaway} _Caveat: ${a.criticalCaveat}_`
).join('\n')}

## 6. Executable Agent Workflow in This MCP Server
1. Pick \`industryDomain\` (\`PROCESS_CONTINUOUS\` | \`DISCRETE_MANUFACTURING\` | \`HYBRID_BATCH_CPG\`) and lighting-matched \`themeId\` (\`ISA_101_LIGHT\` for bright plant floors, \`CONTROL_ROOM_DARK\` for dim 24/7 rooms, \`HIGH_CONTRAST_TOUCH\` for gloved local touch panels).
2. Build screens via \`haiwell_hmi_template_instantiate\`, \`haiwell_hmi_pid_compile\`, or \`haiwell_hmi_screen_generate\`.
3. Run \`haiwell_hmi_design_audit\` with \`industryDomain\` and \`autoFix: true\` — inspect both blocking \`ERROR\` visual defects and evidence-tagged \`HMI-HF-*\` human-factors warnings.
4. Run \`haiwell_hmi_spatial_verify\` (0 collisions/OOB) and inspect \`haiwell_hmi_screen_render_svg\` before \`.hwExport\` / \`.hwdev\` deployment.
`;
}
