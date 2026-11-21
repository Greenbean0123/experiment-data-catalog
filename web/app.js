"use strict";

const I18n = typeof module !== "undefined" ? require("./i18n.js") : CatalogI18n;

// Lab-specific conventions come from the catalog's data/local-catalog.json (see README), never from source:
// precursor display names with aliases (display-level only; stored values stay exactly as recorded),
// suggested phase tags per project, and sample-ID prefixes whose notebook "1" is the same book as "I".
const precursorKey = value => String(value ?? "").toLowerCase().replace(/\s+/g, "");
const PRECURSOR_ALIASES = new Map(), PRECURSOR_ORDER = new Map(), PHASE_PRESETS = new Map(), notebookPrefixes = new Set();
const textList = value => Array.isArray(value) ? value.filter(item => typeof item === "string" && item.trim()).map(item => item.trim()) : [];

function configureCatalog(conventions = {}) {
  for (const table of [PRECURSOR_ALIASES, PRECURSOR_ORDER, PHASE_PRESETS]) table.clear();
  notebookPrefixes.clear();
  const settings = conventions && typeof conventions === "object" ? conventions : {};
  for (const entry of Array.isArray(settings.precursor_aliases) ? settings.precursor_aliases : []) {
    const label = typeof entry?.label === "string" ? entry.label.trim() : "";
    if (!label || PRECURSOR_ORDER.has(label)) continue;
    PRECURSOR_ORDER.set(label, PRECURSOR_ORDER.size);
    for (const alias of [label, ...textList(entry.aliases)]) PRECURSOR_ALIASES.set(precursorKey(alias), label);
  }
  const phases = settings.phase_presets && typeof settings.phase_presets === "object" ? settings.phase_presets : {};
  for (const [project, list] of Object.entries(phases)) PHASE_PRESETS.set(project, textList(list).slice(0, 20));
  for (const prefix of textList(settings.notebook_prefixes)) if (/^[A-Za-z]{1,20}$/.test(prefix)) notebookPrefixes.add(prefix.toUpperCase());
}
const CORE_CONDITIONS = ["precursor", "temperature", "duration", "solvent"];

// Per-project field settings from the server (GET /api/experiments → project_settings). Built-in condition fields can be
// switched off or renamed per project; template fields can be promoted to key fields that behave like conditions.
const PROJECT_SETTINGS = new Map();
const BUILTIN_OF = {precursor: "precursor", precursors: "precursor", temperature: "temperature", duration: "duration",
  solvent: "materials", solvents: "materials", ligand: "materials", materials: "materials"};
const BUILTIN_DEFAULT_LABELS = {precursor: "前驱体", temperature: "温度", duration: "反应 / 取样时间", materials: "溶剂 / 配体"};
function configureProjects(map = {}) {
  PROJECT_SETTINGS.clear();
  for (const [id, entry] of Object.entries(map && typeof map === "object" ? map : {})) {
    if (entry && typeof entry === "object" && entry.settings && typeof entry.settings === "object") PROJECT_SETTINGS.set(id, entry);
  }
}
const projectEntry = projectId => PROJECT_SETTINGS.get(projectId || "default");
// With no project selected a built-in stays visible while any project uses it.
function builtinEnabled(projectId, field) {
  const key = BUILTIN_OF[field] || field;
  if (!projectId) return !PROJECT_SETTINGS.size || [...PROJECT_SETTINGS.values()].some(entry => entry.settings.builtin?.[key]?.enabled !== false);
  return projectEntry(projectId)?.settings?.builtin?.[key]?.enabled !== false;
}
// The custom label for the current language, falling back to the other language; "" means the default label.
function builtinCustomLabel(projectId, field, language = "zh") {
  if (!projectId) return "";
  const label = projectEntry(projectId)?.settings?.builtin?.[BUILTIN_OF[field] || field]?.label || {};
  const pick = value => typeof value === "string" ? value.trim() : "";
  return pick(language === "en" ? label.en : label.zh);
}
function builtinLabel(projectId, field, language = "zh") {
  const key = BUILTIN_OF[field] || field;
  return builtinCustomLabel(projectId, key, language) || I18n.translate(BUILTIN_DEFAULT_LABELS[key] || key, language);
}
// Caption with unit, e.g. "温度 / °C"; the default wording is kept exactly when no custom label is set.
const BUILTIN_CAPTIONS = {precursor: "前驱体", temperature: "温度 / °C", duration: "反应 / 取样时间 · min", materials: "溶剂 / 配体"};
function builtinCaption(projectId, field, language = "zh") {
  const key = BUILTIN_OF[field] || field, custom = builtinCustomLabel(projectId, key, language);
  if (!custom) return I18n.translate(BUILTIN_CAPTIONS[key] || key, language);
  return key === "temperature" ? `${custom} / °C` : key === "duration" ? `${custom} · min` : custom;
}
const keyFieldId = info => typeof info.id === "string" && info.id ? info.id : `key:${info.section}:${String(info.label).toLowerCase()}`;
function keyFieldsOf(projectId) {
  const fields = projectEntry(projectId)?.fields;
  return Array.isArray(fields) ? fields.filter(field => field && field.available !== false && typeof field.label === "string") : [];
}
function findKeyField(projectId, id) {
  return keyFieldsOf(projectId).find(info => keyFieldId(info) === id) || null;
}
// A key field resolves in the record's own template version: same section, same label (case-insensitive), same type.
function keyFieldValue(record, info) {
  const label = String(info.label).toLowerCase();
  const field = record.template?.fields?.find(item => item.section === info.section && item.type === info.type && String(item.label).toLowerCase() === label);
  const values = record.lab_data?.values || {};
  if (!field || !Object.hasOwn(values, field.key)) return {present: false, field: field || null};
  const unit = field.unit || "";
  return {present: true, field, value: values[field.key], unit, unitDiffers: info.type === "number" && unit !== (info.unit || "")};
}
function keyFieldText(result) {
  if (!result.present) return "";
  const value = Array.isArray(result.value) ? result.value.join(" / ") : String(result.value);
  return result.unit ? `${value} ${result.unit}` : value;
}
function keyFieldMembers(record, id) {
  const info = findKeyField(record.project_id, id);
  if (!info) return [];
  const result = keyFieldValue(record, info);
  if (!result.present) return [];
  if (Array.isArray(result.value)) return result.value.map(String);
  if (info.type === "number" && result.unitDiffers) return [result.unit ? `${result.value} ${result.unit}` : `${result.value} (—)`];
  return [String(result.value)];
}
const ROMAN = {I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10};

function canonicalPrecursor(value) {
  const raw = String(value ?? "").trim();
  return PRECURSOR_ALIASES.get(precursorKey(raw)) || raw;
}

function conditionValue(record, field) {
  return field === "precursor" ? recordPrecursors(record).map(canonicalPrecursor).join(" + ") : field === "solvent" ? recordSolvents(record).join(" + ") : record[field] ?? "";
}

function recordPrecursors(record) {
  return record.precursors ?? (record.precursor ? [record.precursor] : []);
}

function conditionMembers(record, field) {
  if (String(field).startsWith("key:")) return keyFieldMembers(record, field);
  if (field === "precursor") return recordPrecursors(record).map(canonicalPrecursor);
  if (field === "solvent") return recordSolvents(record);
  return [String(conditionValue(record, field))];
}

function recordSolvents(record) {
  const values = Array.isArray(record.solvents) ? record.solvents : record.solvent ? [record.solvent] : [];
  return [...new Set([...values, ...(record.ligand ? [record.ligand] : [])])];
}

function materialSummary(record) {
  const amounts = new Map((record.material_amounts || []).map(item => [item.name, item]));
  return recordSolvents(record).map(name => {
    const item = amounts.get(name);
    return name + (item ? ` (${item.amount} ${item.unit})` : "");
  }).join(" + ");
}

function resultSummary(record) {
  return {phases: [], morphologies: [], confirmation: "", conclusion: "", evidence_ids: [], ...record.result_summary};
}

function resultConfirmation(record, language = "zh") {
  return I18n.translate(({pending: "待确认", confirmed: "已确认"})[resultSummary(record).confirmation] || "尚未记录结果", language);
}

function recordMatchesPayload(record, payload) {
  const expected = Object.fromEntries(Object.entries(payload).filter(([key]) => !["revision", "copy_from", "shared_token"].includes(key)).map(([key, value]) => [key, typeof value === "string" ? value.trim() : value]));
  expected.experiment_no ||= inferredExperimentNo(expected.sample_id);
  if (expected.solvents) {
    expected.solvents = [...new Set(expected.solvents.map(value => value.trim()))];
    expected.solvent = expected.solvents.join(" + ");
  }
  if (expected.precursors) {
    expected.precursors = [...new Set(expected.precursors.map(value => value.trim()))];
    expected.precursor = expected.precursors.join(" + ");
  }
  if (expected.result_summary) {
    const result = resultSummary({result_summary: expected.result_summary});
    for (const field of ["phases", "morphologies", "evidence_ids"]) result[field] = [...new Set(result[field].map(value => value.trim()))];
    result.conclusion = result.conclusion.trim();
    result.confirmation ||= result.phases.length || result.morphologies.length || result.conclusion || result.evidence_ids.length ? "pending" : "";
    expected.result_summary = result;
  }
  if (expected.lab_data) expected.lab_data = compactLabData(expected.lab_data);
  return Object.keys(expected).every(key => {
    const actual = key === "lab_data" ? compactLabData(record[key] || {}) : key === "precursors" ? recordPrecursors(record) : record[key];
    return JSON.stringify(actual) === JSON.stringify(expected[key]);
  });
}

function compareConditionValues(a, b, locale = "zh-CN") {
  // Configured precursor names keep their configured order; everything else follows in natural order.
  const rank = value => PRECURSOR_ORDER.get(value) ?? Infinity;
  const left = rank(a), right = rank(b);
  if (left !== right) return left < right ? -1 : 1;
  return String(a).localeCompare(String(b), locale, {numeric: true});
}

function canonicalExperimentNo(value) {
  // With a configured prefix, notebook "1" and "I" are the same book: XY-1-279 is shown as XY-I-279.
  const label = String(value ?? "");
  const match = label.match(/^([A-Za-z]+)-1-(?=[0-9])/);
  return match && notebookPrefixes.has(match[1].toUpperCase()) ? match[1] + "-I-" + label.slice(match[0].length) : label;
}

function inferredExperimentNo(sampleId) {
  return /^([A-Za-z]+-(?:[IVX]+|\d+)-\d+)(?=$|[-_\s(])/i.exec(sampleId)?.[1].toUpperCase() || sampleId;
}

function compareExperimentNo(a, b) {
  const key = value => {
    const match = /^([A-Za-z]+)-([IVX]+)-(\d+)(.*)$/i.exec(value);
    return match ? [0, match[1].toUpperCase(), ROMAN[match[2].toUpperCase()] ?? 99, Number(match[3]), match[4]] : [1, "", 0, 0, value];
  };
  const left = key(a), right = key(b);
  for (let index = 0; index < left.length; index++) {
    const x = left[index], y = right[index];
    if (x === y) continue;
    return typeof x === "number" ? x - y : x.localeCompare(y, "en", {numeric: true});
  }
  return 0;
}

function missingConditions(records) {
  return [...new Set(records.flatMap(record => {
    const waived = ["not_measured", "measurement_failed", "no_target"].includes(record.lab_data?.outcome);
    const keys = keyFieldsOf(record.project_id).filter(info => info.check_missing && !(info.section === "result" && waived)
      && !keyFieldValue(record, info).present).map(info => info.label);
    if (record.template) return [...record.template.fields.filter(field => field.section === "condition" && field.required &&
      !Object.hasOwn(record.lab_data?.values || {}, field.key)).map(field => field.label), ...keys];
    return [...CORE_CONDITIONS.filter(field => builtinEnabled(record.project_id, field)).filter(field => {
      const value = conditionValue(record, field);
      return value === null || value === undefined || String(value).trim() === "";
    }), ...keys];
  }))];
}

const OUTCOME_LABELS = {not_measured: "未测量", measurement_failed: "测量失败", no_target: "未获得目标结果", measured: "已测量"};
const fieldCaption = field => field.label + (field.unit ? " (" + field.unit + ")" : "");
const fieldIdentity = (record, field) => JSON.stringify([record.project_id, record.template.revision, field.key]);
const comparisonCaption = (record, field, language) => fieldCaption(field) + " · " + I18n.recordLabel(record, "project_name", language) + " v" + record.template.revision;
const storedFields = (record, section) => (record.template?.fields || []).filter(field => field.section === section)
  .map(field => ({...field, value: record.lab_data?.values?.[field.key]}));
const shownValue = value => Array.isArray(value) ? value.join(" / ") : (value ?? "");
const asciiFold = text => text.replace(/[A-Z]/g, char => char.toLowerCase());
const compactLabData = details => Object.fromEntries(Object.entries(details).filter(([key, value]) =>
  key === "values" ? Object.keys(value).length : Boolean(value)));

// Round tick values (1/2/2.5/5 × 10^n) inside [min, max].
function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return Number.isFinite(min) ? [min] : [];
  const raw = (max - min) / count, power = 10 ** Math.floor(Math.log10(raw));
  if (!Number.isFinite(power) || power <= 0) return [min, max];
  const step = [1, 2, 2.5, 5, 10].map(factor => factor * power).reduce((best, value) => Math.abs(Math.log(value / raw)) < Math.abs(Math.log(best / raw)) ? value : best);
  if (min + step === min) return [min, max];
  const ticks = [];
  for (let value = Math.ceil(min / step - 1e-9) * step; value <= max + step * 1e-9; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}

// SNIP background (Morhac): LLS transform, then iterative peak clipping with a decreasing window.
function snipBackground(ys, halfWidth) {
  const n = ys.length, m = Math.max(1, Math.min(Math.round(halfWidth), Math.floor((n - 1) / 2)));
  if (n < 3) return ys.slice();
  // Pad both ends with the edge value so points near the ends are clipped too (otherwise they keep raw values).
  const lls = y => Math.log(Math.log(Math.sqrt(Math.max(y, 0) + 1) + 1) + 1);
  const total = n + 2 * m;
  let v = new Float64Array(total), next = new Float64Array(total);
  for (let i = 0; i < total; i++) v[i] = lls(ys[Math.min(n - 1, Math.max(0, i - m))]);
  for (let p = m; p >= 1; p--) {
    for (let i = 0; i < total; i++) next[i] = i >= p && i < total - p ? Math.min(v[i], (v[i - p] + v[i + p]) / 2) : v[i];
    [v, next] = [next, v];
  }
  return Array.from(v.subarray(m, m + n), w => { const a = Math.exp(Math.exp(w) - 1) - 1; return a * a - 1; });
}

// Preview-only processing; returns new points, the source array is never changed.
// window (x units) is the widest feature kept as signal; broader features (e.g. amorphous humps) go into the background.
// backgroundValues: a background already stored in the file (e.g. the bkg column of a refinement export); used as-is when present.
function processSeries(points, {background = false, normalize = false, window = 1, backgroundValues = null} = {}) {
  if (!background && !normalize) return points;
  let ys = points.map(point => point[1]);
  if (background && backgroundValues && backgroundValues.length === points.length) {
    ys = ys.map((y, i) => y - backgroundValues[i]);
  } else if (background && points.length > 2) {
    const steps = [];
    for (let i = 1; i < points.length; i += Math.max(1, Math.floor(points.length / 200))) steps.push(Math.abs(points[i][0] - points[i - 1][0]));
    steps.sort((a, b) => a - b);
    const step = steps[steps.length >> 1] || 0;
    const base = snipBackground(ys, step > 0 ? window / step : 50);
    ys = ys.map((y, i) => y - base[i]);
  }
  if (normalize) {
    let low = Infinity, high = -Infinity;
    for (const y of ys) { if (y < low) low = y; if (y > high) high = y; }
    const floor = background ? 0 : low, span = (high - floor) || 1;
    ys = ys.map(y => (y - floor) / span);
  }
  return points.map((point, i) => [point[0], ys[i]]);
}

// Overlay/stack preparation for plotting; never changes the source arrays.
function prepareSeries(series, {stack = false, normalize = false} = {}) {
  const lines = series.map(item => {
    let low = Infinity, high = -Infinity;
    for (const [, y] of item.points) { if (y < low) low = y; if (y > high) high = y; }
    const span = high - low || 1;
    const points = normalize ? item.points.map(([x, y]) => [x, (y - low) / span]) : item.points;
    return {...item, raw: item.raw || item.points, points, low: normalize ? 0 : low, high: normalize ? 1 : high};
  });
  let gap = 0;
  for (const line of lines) gap = Math.max(gap, line.high - line.low);
  gap = (gap || 1) * 1.08;
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  lines.forEach((line, index) => {
    line.offset = stack ? index * gap - line.low : 0;
    for (const [x] of line.points) { if (x < xmin) xmin = x; if (x > xmax) xmax = x; }
    ymin = Math.min(ymin, line.low + line.offset);
    ymax = Math.max(ymax, line.high + line.offset);
  });
  return {lines, xmin, xmax, ymin, ymax};
}

function isDatasetRecord(record) {
  return record.sample_id.startsWith("资料集-") &&
    (record.notes.startsWith("批量导入：local-") || record.series === "导入报告 / Import report");
}

function filterRecords(records, filters) {
  const query = (filters.query || "").trim().toLocaleLowerCase();
  const inRange = (value, low, high) => {
    if (low === "" && high === "") return true;
    if (value === null || value === undefined) return false;
    return (low === "" || value >= Number(low)) && (high === "" || value <= Number(high));
  };
  return records.filter(record => {
    if (Boolean(record.archived) !== Boolean(filters.archived)) return false;
    if (filters.project && (record.project_id || "default") !== filters.project) return false;
    if (filters.condition) {
      if (isDatasetRecord(record)) return false;
      if (filters.condition.field === "missing") {
        const missing = missingConditions([record]);
        if (filters.condition.value ? !missing.includes(filters.condition.value) : !missing.length) return false;
      } else {
        if (BUILTIN_OF[filters.condition.field] && !builtinEnabled(record.project_id, filters.condition.field)) return false;
        const members = conditionMembers(record, filters.condition.field);
        if (!(members.length ? members : [""]).includes(filters.condition.value)) return false;
      }
    }
    // A built-in switched off for the selected project no longer filters (its hidden control may keep an old value).
    // With several projects shown, an active filter only matches records whose own project uses that field.
    const shown = field => !filters.project || builtinEnabled(filters.project, field);
    const applies = (field, active) => {
      if (!active || !shown(field)) return null;
      return builtinEnabled(record.project_id, field);
    };
    for (const field of ["precursor", "solvent", "ligand", "status"]) {
      if (!filters[field]) continue;
      if (field === "status") { if (!conditionMembers(record, field).includes(filters[field])) return false; continue; }
      const own = applies(field, true);
      if (own === false || (own && !conditionMembers(record, field).includes(filters[field]))) return false;
    }
    for (const [field, low, high] of [["temperature", filters.tempMin ?? "", filters.tempMax ?? ""], ["duration", filters.timeMin ?? "", filters.timeMax ?? ""]]) {
      const own = applies(field, low !== "" || high !== "");
      if (own === false || (own && !inRange(record[field], low, high))) return false;
    }
    for (const filter of Array.isArray(filters.keyFilters) ? filters.keyFilters : []) {
      if (isDatasetRecord(record)) return false;
      const result = keyFieldValue(record, filter.info);
      if (filter.info.type === "number") {
        if (filter.min === "" && filter.max === "") continue;
        if (!result.present || result.unitDiffers || !inRange(Number(result.value), filter.min, filter.max)) return false;
      } else if (filter.info.type === "text") {
        if (!filter.text) continue;
        if (!result.present || !String(result.value).toLocaleLowerCase().includes(filter.text.toLocaleLowerCase())) return false;
      } else if (filter.value) {
        if (!result.present || !(Array.isArray(result.value) ? result.value : [result.value]).includes(filter.value)) return false;
      }
    }
    if (filters.kind === "none" && record.files.length) return false;
    if (filters.kind && filters.kind !== "none" && !record.files.some(file => file.kind === filters.kind)) return false;
    const result = resultSummary(record);
    if ((filters.phase || filters.morphology || filters.resultConfirmation || filters.outcome) && isDatasetRecord(record)) return false;
    if (filters.phase && !result.phases.includes(filters.phase)) return false;
    if (filters.morphology && !result.morphologies.includes(filters.morphology)) return false;
    if (filters.resultConfirmation === "unrecorded" && (result.confirmation || record.lab_data?.outcome ||
        storedFields(record, "result").some(field => field.value !== undefined))) return false;
    if (filters.resultConfirmation && filters.resultConfirmation !== "unrecorded" && result.confirmation !== filters.resultConfirmation) return false;
    if (filters.outcome && (record.lab_data?.outcome || "") !== filters.outcome) return false;
    const uses = field => builtinEnabled(record.project_id, field);
    const text = [record.sample_id, record.experiment_no, canonicalExperimentNo(record.experiment_no, record.project_id), ...(uses("precursor") ? conditionMembers(record, "precursor") : []), record.series, record.project_name, I18n.recordLabel(record, "project_name", filters.language), I18n.recordLabel(record, "sample_id", filters.language),
      I18n.recordLabel(record, "series", filters.language), record.experiment_date, uses("precursor") ? record.precursor : "",
      uses("materials") ? materialSummary(record) : "", record.notes, I18n.recordLabel(record, "notes", filters.language), record.status, I18n.translate(record.status, filters.language),
      ...result.phases, ...result.morphologies, result.conclusion, resultConfirmation(record, filters.language),
      ...record.extra_conditions.flatMap(condition => [condition.name, condition.value, condition.unit]),
      record.lab_data?.treatment, OUTCOME_LABELS[record.lab_data?.outcome] ? I18n.translate(OUTCOME_LABELS[record.lab_data.outcome], filters.language) : "",
      ...[...storedFields(record, "condition"), ...storedFields(record, "result")].flatMap(field => [field.label, shownValue(field.value), field.unit]),
      ...record.files.flatMap(file => [file.name, file.kind, I18n.dataKind(file.kind, filters.language)])].join(" ").toLocaleLowerCase();
    return !query || text.includes(query);
  });
}

function groupRecords(records) {
  const groups = new Map();
  for (const record of records) {
    const dataset = isDatasetRecord(record);
    const number = canonicalExperimentNo(record.experiment_no || record.sample_id, record.project_id);
    const projectId = record.project_id || "default";
    const key = dataset ? "dataset:" + record.id : `experiment:${projectId}:${number.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, {key, number, projectId, dataset, records: []});
    groups.get(key).records.push(record);
  }
  for (const group of groups.values()) group.records.sort((a, b) => a.sample_id.localeCompare(b.sample_id, "en", {numeric: true}));
  return [...groups.values()].sort((a, b) => Number(a.dataset) - Number(b.dataset) || compareExperimentNo(a.number, b.number));
}

function comparisonRows(records, language = "zh") {
  const t = key => I18n.translate(key, language);
  // Built-ins appear while any compared sample's project uses them; a shared project's custom label is used.
  const projects = [...new Set(records.map(record => record.project_id || "default"))];
  const shared = projects.length === 1 ? projects[0] : "";
  const fields = [["实验系列", "series"], ["实验编号", "experiment_no"], ["实验日期", "experiment_date"], ["前驱体", "precursor"],
    ["温度 / °C", "temperature"], ["反应 / 取样时间 · min", "duration"], ["溶剂 / 配体", "solvent"], ["记录状态", "status"], ["实验项目", "project_name"]]
    .filter(([, key]) => !BUILTIN_OF[key] || projects.some(project => builtinEnabled(project, key)));
  const rows = fields.map(([label, key]) => ({label: BUILTIN_OF[key] ? builtinCaption(shared, key, language) : t(label), values: records.map(record =>
    BUILTIN_OF[key] && !builtinEnabled(record.project_id, key) ? "" : key === "status" ? t(record[key]) : ["series", "project_name"].includes(key) ? I18n.recordLabel(record, key, language) : (key === "solvent" ? materialSummary(record) : record[key]))}));
  const keyInfos = new Map(projects.flatMap(project => keyFieldsOf(project).map(info => [keyFieldId(info), info])));
  for (const [id, info] of keyInfos) {
    rows.push({label: info.label + (info.unit ? ` (${info.unit})` : ""), key: id, values: records.map(record => {
      const own = findKeyField(record.project_id, id);
      return own ? keyFieldText(keyFieldValue(record, own)) : "";
    })});
  }
  const names = [...new Set(records.flatMap(record => record.extra_conditions.map(item => item.name)))];
  for (const name of names) {
    rows.push({label: name, values: records.map(record => {
      const field = record.extra_conditions.find(item => item.name === name);
      return field && field.value !== "" ? `${field.value}${field.unit ? " " + field.unit : ""}` : "";
    })});
  }
  for (const section of ["condition", "result"]) {
    const fieldsBySample = records.map(record => new Map(storedFields(record, section).map(field =>
      [fieldIdentity(record, field), {...field, caption: comparisonCaption(record, field, language)}])));
    const fields = new Map(fieldsBySample.flatMap(fields => [...fields]));
    for (const [id, field] of fields) {
      rows.push({label: field.caption, values: fieldsBySample.map(fields => shownValue(fields.get(id)?.value))});
    }
  }
  if (records.some(record => record.lab_data?.outcome)) rows.push({label: t("表征结果状态"), values: records.map(record => t(OUTCOME_LABELS[record.lab_data?.outcome] || "尚未记录"))});
  rows.push({label: t("数据附件"), values: records.map(record => record.files.map(file => `${I18n.dataKind(file.kind, language)} · ${file.name}`).join("\n"))});
  rows.push({label: t("备注"), values: records.map(record => I18n.recordLabel(record, "notes", language))});
  for (const [label, field] of [["物相", "phases"], ["形貌", "morphologies"], ["结果结论", "conclusion"]]) {
    rows.push({label: t(label), values: records.map(record => Array.isArray(resultSummary(record)[field]) ? resultSummary(record)[field].join(" / ") : resultSummary(record)[field])});
  }
  rows.push({label: t("结果确认"), values: records.map(record => resultConfirmation(record, language))});
  rows.push({label: t("关联表征证据"), values: records.map(record => record.files.filter(file => resultSummary(record).evidence_ids.includes(file.id)).map(file => `${I18n.dataKind(file.kind, language)} · ${file.name}`).join("\n"))});
  return rows.map(row => ({...row, different: new Set(row.values.map(value => value ?? "")).size > 1}));
}

if (typeof module !== "undefined") module.exports = {resultSummary, resultConfirmation, materialSummary, recordMatchesPayload, filterRecords, groupRecords, comparisonRows, niceTicks, prepareSeries, snipBackground, processSeries, canonicalPrecursor, canonicalExperimentNo, configureCatalog, configureProjects, builtinEnabled, builtinLabel, builtinCaption, keyFieldsOf, keyFieldValue, keyFieldId, compareExperimentNo, compareConditionValues, missingConditions};
if (typeof document !== "undefined") initialize();

function initialize() {
  const $ = id => document.getElementById(id);
  let language = "zh";
  try { language = localStorage.getItem("catalog-language") === "en" ? "en" : "zh"; } catch {}
  const t = (key, values = {}) => I18n.translate(key, language, values);
  const recordLabel = (record, field) => I18n.recordLabel(record, field, language);
  let theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  try {
    const saved = localStorage.getItem("catalog-theme");
    if (["light", "dark"].includes(saved)) theme = saved;
  } catch {}
  const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[char]));
  const display = value => value === "" || value === null || value === undefined ? '<span class="muted">—</span>' : escape(value);
  const text = key => `<span data-i18n="${escape(key)}">${escape(t(key))}</span>`;
  const sizeText = size => size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(2)} GB` : size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${(size / 1024).toFixed(1)} KB`;
  const statusTag = value => `<span class="status ${value === "待补全" ? "pending" : value === "待表征" ? "waiting" : ""}" data-i18n="${escape(value)}">${escape(t(value))}</span>`;
  const kindText = kind => `<span data-kind-label="${escape(kind)}">${escape(I18n.dataKind(kind, language))}</span>`;
  const fileTags = files => [...new Set(files.map(file => file.kind))].map(kind => `<span class="data-tag ${kind === "NMR" ? "nmr" : ""}">${kindText(kind)}</span>`).join("");
  let records = [], visible = [], selected = new Set(), archived = false, detailId = null;
  let projects = [], kinds = [], projectId = "default", catalogType = "projects", catalogTarget = "project-select", catalogSaving = false;
  let templates = {}, editorTemplate = null, editorDataset = false, editorLabProject = "", editorCopyFrom = "";
  let templateProject = "", templateRevision = 0, templateDirty = false, templateSaving = false;
  let importProject = "", folderFiles = new Map(), folderPlan = null, importBatch = "", importing = false;
  const folderOverrides = new Map(), folderSkipped = new Set();
  let comparisonRecords = [], comparisonPlotVersion = 0, comparisonScatterVersion = 0;
  const conditionLabels = {precursor: "前驱体", temperature: "温度", duration: "时间", solvent: "溶剂 / 配体"};
  let routeApplied = false, routeReplace = false;
  let conditionOptions = {}, chartCondition = null, statusSaving = false;
  let workspaceView = false, workspaceKey = "", workspaceSample = "", workspaceKind = "", workspaceFile = "", workspaceGroups = [];
  let previewVersion = 0, previewCache = new Map(), previewMode = "plot", previewModeFile = "", previewFile = null, deletingCategory = "";
  const OVERLAY_MAX = 8;
  let workspaceCsvFiles = [], overlaySlots = new Map(), overlayScope = "", overlayLayout = "stack", activePlot = null;
  // null = automatic: background subtraction + normalization on for XRD, off for other data.
  const plotPrefs = {method: null, normalize: null, window: 4};
  const processedCache = new Map();
  let dashboardTab = "overview";
  let backupStatus = null, backupTimer = null, backupStarting = false;
  let trashCount = 0, trashItems = [], trashTotal = 0, trashBusy = false, trashSelected = new Set(), trashRenaming = "";
  let fileTarget = null, fileSaving = false, historyFileEvents = [], sessionExpired = false, categoryCounts = null, demoProjectId;
  let trashLoadVersion = 0, trashScope = null, trashDrafts = new Map();
  let keyFilterSignature = "", keyFilterState = new Map(), bulkActive = [], bulkKeyInfos = new Map();
  let listScrolledTo = "";
  try { $("experiment-order").value = localStorage.getItem("catalog-experiment-order") === "desc" ? "desc" : "asc"; } catch {}
  try { projectId = localStorage.getItem("catalog-project") ?? "default"; } catch {}
  const projectLabel = id => recordLabel({project_id: id, project_name: projects.find(project => project.id === id)?.name || ""}, "project_name");
  const expanded = new Set();
  let editId = null, editRevision = null, editorTitle = "新建实验", dirty = false, saving = false, uploading = false, toastTimer;
  let editorShared = null;
  const individualConditions = new Set();
  let loaded = false, loadError = null, loadVersion = 0, presetSaving = false;
  const form = $("record-form");
  let resultDraft = {phases: [], morphologies: []};
  let resultAutoPending = false, previewPhaseSaving = false;
  let previewPhaseError = null;
  let bulkTargets = [], bulkPlan = null, bulkPreview = null, bulkBusy = false, bulkDirty = false;
  let historyBatches = [], historyDetail = null, historyRecord = "", historyOffset = 0, historyMore = false, undoPreview = null;
  let reviewItems = [], reviewItem = null, reviewPlan = null, reviewAddRecord = "", workflowBusy = false, workflowDirty = false;
  const historyActions = {create: "新建样品", edit: "编辑样品", bulk: "批量编辑", shared: "更新共用条件", status: "更新实验状态", archive: "归档或恢复", import: "照片条件回填", undo: "撤销修改", review: "核对并回填"};
  const workflowFields = {sample_id: "样品编号", experiment_no: "实验编号", series: "实验系列", experiment_date: "实验日期", precursor: "前驱体", temperature: "温度 / °C", duration: "反应 / 取样时间 · min", materials: "溶剂 / 配体", solvents: "溶剂 / 配体", extra_conditions: "自定义条件", material_amounts: "添加量", notes: "备注", status: "记录状态", result_summary: "结果摘要", archived: "已归档", project_id: "实验项目", lab_data: "样品扩展数据"};
  const bulkFields = [
    {field: "precursors", label: "前驱体", type: "list"},
    {field: "temperature", label: "温度 / °C", type: "number"},
    {field: "duration", label: "反应 / 取样时间 · min", type: "number"},
    {field: "solvents", label: "溶剂 / 配体", type: "list"},
    {field: "status", label: "记录状态", type: "status"},
    {field: "phases", label: "物相", type: "list"},
    {field: "morphologies", label: "形貌", type: "list"},
    {field: "confirmation", label: "结果确认", type: "confirmation"},
    {field: "conclusion", label: "结果结论", type: "textarea"}
  ];

  function toast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").hidden = false;
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 5000);
  }

  async function api(path, options = {}) {
    const headers = {"X-Catalog-Local": "1", ...options.headers};
    if (options.body && typeof options.body === "string") headers["Content-Type"] = "application/json";
    const controller = new AbortController();
    const timer = options.signal || (options.body && typeof options.body !== "string") ? null : setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, {...options, cache: "no-store", headers, signal: options.signal || controller.signal});
      const payload = await response.json();
      if (!response.ok) {
        if (response.status === 401) showSessionExpired();
        const error = new Error(payload.error || "操作失败，请重试。");
        error.status = response.status || 400;
        error.payload = payload;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error.status) throw error;
      if (controller.signal.aborted) throw new Error("请求超时，结果尚未确认；当前编辑内容仍保留。");
      throw new Error("无法连接本地服务。请重新启动实验数据目录后重试；编辑内容仍保留在当前页面。");
    } finally { clearTimeout(timer); }
  }

  // Static labels that name a built-in field; a project's custom label replaces them (format keys are translated).
  const FIELD_TEXT_KEYS = {
    "前驱体": ["precursor", "{label}"], "全部前驱体": ["precursor", "全部{label}"], "前驱体（可多选）": ["precursor", "{label}（可多选）"],
    "新增前驱体": ["precursor", "新增{label}"], "前驱体名称": ["precursor", "{label}名称"],
    "温度 / °C": ["temperature", "{label} / °C"], "温度": ["temperature", "{label}"],
    "反应 / 取样时间 · min": ["duration", "{label} · min"], "时间": ["duration", "{label}"],
    "溶剂 / 配体": ["materials", "{label}"], "全部溶剂 / 配体": ["materials", "全部{label}"], "溶剂 / 配体（可多选）": ["materials", "{label}（可多选）"],
    "新增溶剂 / 配体": ["materials", "新增{label}"], "溶剂 / 配体名称": ["materials", "{label}名称"]
  };
  function applyFieldSettings() {
    const project = projectId || "";
    for (const element of document.querySelectorAll("[data-i18n]")) {
      const mapping = FIELD_TEXT_KEYS[element.dataset.i18n];
      if (!mapping || element.closest("#editor, #bulk-editor")) continue;
      const custom = builtinCustomLabel(project, mapping[0], language);
      element.textContent = custom ? t(mapping[1], {label: custom}) : t(element.dataset.i18n);
    }
    const visible = field => builtinEnabled(project, field);
    for (const [id, field] of [["filter-precursor", "precursor"], ["filter-solvent", "materials"]]) $(id).closest("label").hidden = !visible(field);
    for (const [id, field] of [["temp-min", "temperature"], ["time-min", "duration"]]) $(id).closest("fieldset").hidden = !visible(field);
    const table = document.querySelector(".records-table");
    for (const field of ["precursor", "temperature", "duration", "materials"]) table?.classList.toggle(`hide-${field}`, !visible(field));
    for (const option of $("dashboard-condition-field").options) if (BUILTIN_OF[option.value]) option.hidden = option.disabled = !visible(option.value);
    const select = $("dashboard-condition-field"), chosen = select.value;
    for (const option of [...select.querySelectorAll("option[data-key-field]")]) option.remove();
    for (const info of project ? keyFieldsOf(project) : []) {
      const option = document.createElement("option");
      option.value = keyFieldId(info); option.dataset.keyField = "1";
      option.textContent = info.label + (info.unit ? ` (${info.unit})` : "");
      select.append(option);
    }
    if ([...select.options].some(option => option.value === chosen && !option.disabled)) select.value = chosen;
    else select.value = [...select.options].find(option => !option.disabled)?.value ?? "";
    if (chartCondition && chartCondition.field !== "missing" && ![...select.options].some(option => option.value === chartCondition.field && !option.disabled)) chartCondition = null;
    renderKeyFilters(project);
  }
  function renderKeyFilters(project) {
    const infos = project ? keyFieldsOf(project) : [];
    const box = $("key-filters");
    box.hidden = !infos.length;
    const signature = JSON.stringify([project, language, infos.map(info => [keyFieldId(info), info.type, info.unit, info.options])]);
    if (signature === keyFilterSignature) return;
    keyFilterSignature = signature;
    for (const [id, state] of [...keyFilterState]) {
      const info = infos.find(item => keyFieldId(item) === id);
      if (!info) keyFilterState.delete(id);
      else if (state.value && !(info.options || []).includes(state.value)) delete state.value;
    }
    box.innerHTML = infos.map(info => {
      const id = escape(keyFieldId(info)), state = keyFilterState.get(keyFieldId(info)) || {};
      const caption = escape(info.label + (info.unit ? ` (${info.unit})` : ""));
      if (info.type === "number") return `<fieldset><legend>${caption}</legend><div class="range"><input type="number" step="any" data-key-filter="${id}" data-key-part="min" value="${escape(state.min ?? "")}" placeholder="${escape(t("最低"))}" aria-label="${escape(t("{field} 最低", {field: info.label}))}"><span>—</span><input type="number" step="any" data-key-filter="${id}" data-key-part="max" value="${escape(state.max ?? "")}" placeholder="${escape(t("最高"))}" aria-label="${escape(t("{field} 最高", {field: info.label}))}"></div></fieldset>`;
      if (info.type === "text") return `<label><span>${caption}</span><input type="search" data-key-filter="${id}" data-key-part="text" value="${escape(state.text ?? "")}" placeholder="${escape(t("包含…"))}"></label>`;
      return `<label><span>${caption}</span><select data-key-filter="${id}" data-key-part="value"><option value="">${escape(t("全部"))}</option>${(info.options || []).map(option => `<option value="${escape(option)}" ${state.value === option ? "selected" : ""}>${escape(option)}</option>`).join("")}</select></label>`;
    }).join("");
  }

  const visibleFilterValue = (id, field) => builtinEnabled(projectId, field) ? $(id).value : "";
  function filters() {
    return {archived, language, project: projectId, condition: chartCondition, query: $("search").value, status: $("filter-status").value, kind: $("filter-kind").value,
      precursor: visibleFilterValue("filter-precursor", "precursor"), solvent: visibleFilterValue("filter-solvent", "materials"),
      phase: $("filter-phase").value, morphology: $("filter-morphology").value, resultConfirmation: $("filter-result-confirmation").value, outcome: $("filter-outcome").value,
      tempMin: visibleFilterValue("temp-min", "temperature"), tempMax: visibleFilterValue("temp-max", "temperature"),
      timeMin: visibleFilterValue("time-min", "duration"), timeMax: visibleFilterValue("time-max", "duration"),
      keyFilters: projectId ? keyFieldsOf(projectId).map(info => ({info, min: "", max: "", value: "", text: "", ...keyFilterState.get(keyFieldId(info))}))
        .filter(filter => filter.min !== "" || filter.max !== "" || filter.value || filter.text) : []};
  }

  function setShareLink(id, rows) {
    const link = $(id);
    link.hidden = !rows.length;
    if (!rows.length || rows.length > 500) {
      link.removeAttribute("href");
      link.textContent = t("一次最多导出 500 条样品");
      return;
    }
    const query = new URLSearchParams({ids: rows.map(row => row.id).join(","),
      revisions: rows.map(row => row.revision).join(","), lang: language});
    link.href = "api/experiments/share.zip?" + query;
    link.textContent = t("导出实验包（{count} 条样品）", {count: rows.length});
    link.title = t("导出所选实验的全部同状态样品与附件");
  }

  function render({keepWorkspaceControls = false} = {}) {
    applyFieldSettings();
    const scoped = records.filter(record => !projectId || (record.project_id || "default") === projectId);
    const active = scoped.filter(record => !record.archived);
    const experiments = groupRecords(active).filter(group => !group.dataset);
    $("stat-total").textContent = experiments.length;
    $("stat-samples").textContent = experiments.reduce((count, group) => count + group.records.length, 0);
    $("stat-files").textContent = active.reduce((count, record) => count + record.files.length, 0);
    $("stat-pending").textContent = experiments.filter(group => missingConditions(group.records).length).length;
    $("nav-count").textContent = experiments.length;
    $("archive-count").textContent = scoped.length - active.length;
    $("breadcrumb-project").textContent = projectId ? projectLabel(projectId) : t("全部项目");
    const kind = $("filter-kind").value;
    $("overview-view").hidden = workspaceView;
    $("experiment-workspace").hidden = !workspaceView;
    const pageTitle = workspaceView ? t("实验工作台") : archived ? t("已归档实验") : kind && kind !== "none" ? t("{kind} 数据", {kind: I18n.dataKind(kind, language)}) : t("实验管理");
    $("page-title").textContent = pageTitle;
    $("breadcrumb-current").textContent = pageTitle;
    document.title = `${t("实验数据目录")} · ${pageTitle}`;
    for (const [id, activeView] of [["active-view", !workspaceView && !archived && (!kind || kind === "none")], ["archived-view", !workspaceView && archived], ["experiment-view", workspaceView]]) {
      $(id).classList.toggle("active", activeView);
      $(id).setAttribute("aria-pressed", String(activeView));
    }
    const fileCounts = new Map();
    for (const record of active) for (const file of record.files) fileCounts.set(file.kind, (fileCounts.get(file.kind) || 0) + 1);
    $("category-nav").innerHTML = kinds.map(value => {
      const label = I18n.dataKind(value, language), current = !workspaceView && !archived && kind === value;
      return `<button class="nav-item ${current ? "active" : ""}" ${["XRD", "NMR"].includes(value) ? `id="${value.toLowerCase()}-view"` : ""} data-kind-view="${escape(value)}" aria-pressed="${current}" title="${escape(label)}" aria-label="${escape(label)}"><svg class="icon" aria-hidden="true"><use href="${({XRD: "#i-peaks", NMR: "#i-wave", TEM: "#i-scope", SEM: "#i-scope", DFT: "#i-cube", "其他": "#i-folder"})[value] || "#i-chart"}"/></svg><span>${escape(label)}</span><b>${fileCounts.get(value) || 0}</b></button>`;
    }).join("");
    const f = filters();
    $("chart-filter").hidden = !chartCondition;
    if (chartCondition) $("chart-filter-label").textContent = chartCondition.field === "missing"
      ? (chartCondition.value ? t("缺少条件 · {field}", {field: t(conditionLabels[chartCondition.value] || chartCondition.value)}) :
        t(scoped.some(record => record.template) ? "缺少条件" : "缺少核心条件"))
      : `${[...$("dashboard-condition-field").options].find(option => option.value === chartCondition.field)?.textContent || chartCondition.field} · ${chartCondition.value === "" ? t("尚未记录") : chartCondition.value}`;
    // Only ranges whose controls are visible are validated.
    const invalid = (builtinEnabled(projectId, "temperature") && f.tempMin !== "" && f.tempMax !== "" && Number(f.tempMin) > Number(f.tempMax)) ||
      (builtinEnabled(projectId, "duration") && f.timeMin !== "" && f.timeMax !== "" && Number(f.timeMin) > Number(f.timeMax));
    $("filter-error").hidden = !invalid && !loadError;
    $("filter-error").textContent = loadError ? I18n.translateError(loadError, language) : invalid ? t("筛选范围的下限不能大于上限。") : "";
    visible = invalid ? [] : filterRecords(records, f);
    const ids = new Set(visible.map(record => record.id));
    selected = new Set([...selected].filter(id => ids.has(id)));
    const groups = groupRecords(visible), datasets = groups.filter(group => group.dataset).length;
    const totals = new Map(groupRecords(scoped.filter(record => Boolean(record.archived) === archived)).map(group => [group.key, group.records.length]));
    $("result-count").textContent = !loaded ? t(loadError ? "读取失败" : "正在读取实验记录…") : t("{count} 个实验 · {samples} 条样品 · {datasets} 个资料集", {count: groups.length - datasets, samples: visible.length - datasets, datasets});
    $("selection-count").textContent = selected.size ? t("已选择 {count} 条", {count: selected.size}) : "";
    $("clear-selection").hidden = selected.size === 0;
    $("compare").disabled = selected.size < 2 || selected.size > 6;
    $("compare").title = t("对比最多 6 条样品；批量编辑最多 500 条。");
    $("bulk-edit").disabled = archived || !selected.size || records.some(record => selected.has(record.id) && isDatasetRecord(record));
    $("select-visible").disabled = archived || !visible.some(record => !isDatasetRecord(record));
    $("export-csv").disabled = !visible.length;
    const shareRecords = selected.size ? groupRecords(scoped.filter(record => Boolean(record.archived) === archived))
        .filter(group => !group.dataset && group.records.some(record => selected.has(record.id)))
        .flatMap(group => group.records) : [];
    setShareLink("share-selected", shareRecords);
    $("records").innerHTML = groups.map(group => {
      if (group.dataset) return sampleRow(group.records[0], true);
      const open = expanded.has(group.key), files = group.records.flatMap(record => record.files);
      const count = group.records.length, total = totals.get(group.key);
      const countText = count === total ? t("{count} 条样品", {count}) : t("匹配 {count} / {total} 条样品", {count, total});
      const summary = field => {
        const values = [...new Set(group.records.map(record => field === "solvent" ? materialSummary(record) : conditionValue(record, field)))];
        return values.length === 1 ? display(values[0]) : `<span class="muted" title="${escape(values.map(value => value === "" ? t("尚未记录") : value).join(" / "))}">${t(values.includes("") ? "不同取值，含未记录" : "不同取值")}</span>`;
      };
      const panelId = `samples-${group.records[0].id}`;
      const addButton = `<button class="quiet" data-add-sample="${escape(group.number)}" data-project="${escape(group.projectId)}" ${archived ? "disabled" : ""} aria-label="${escape(t("为 {sample} 添加样品", {sample: group.number}))}"><svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg>${t("添加样品")}</button>`;
      const statuses = [...new Set(group.records.map(record => record.status))].map(statusTag).join("");
      return `<tr class="experiment-group ${open ? "is-expanded" : ""}" data-experiment="${escape(group.number)}" data-project="${escape(group.projectId)}">
        <td class="check-cell"><button class="group-toggle" data-expand="${escape(group.key)}" aria-expanded="${open}" ${open ? `aria-controls="${panelId}"` : ""} aria-label="${escape(t(open ? "收起 {sample}" : "展开 {sample}", {sample: group.number}))}"><svg class="icon" aria-hidden="true"><use href="#i-chevron"/></svg></button></td>
        <td><button class="sample-link" data-expand="${escape(group.key)}" aria-expanded="${open}" ${open ? `aria-controls="${panelId}"` : ""}>${escape(group.number)}</button><span class="subline">${escape(countText)}${!projectId ? " · " + escape(projectLabel(group.projectId)) : ""}</span></td>
        <td class="group-value col-precursor">${groupCell(group, "precursor", summary)}</td><td class="numeric col-temperature">${groupCell(group, "temperature", summary)}</td><td class="numeric col-duration">${groupCell(group, "duration", summary)}</td>
        <td class="group-value col-materials">${groupCell(group, "solvent", summary)}</td>
        <td class="file-types">${files.length ? fileTags(files) : `<span class="muted">${t("未关联")}</span>`}<span class="subline">${escape(t("{count} 个附件", {count: files.length}))}</span></td><td class="status-cell">${statuses}</td>
        <td>${open ? "" : addButton}</td></tr>` +
        (open ? `<tr class="expansion-row"><td colspan="9"><section class="sample-panel" id="${panelId}" aria-label="${escape(group.number + " · " + t("样品与数据"))}">
          <div class="sample-panel-header"><div><h3>${t("样品与数据")}</h3><span>${escape(countText)}<span class="panel-separator">/</span>${escape(t("{count} 个附件", {count: files.length}))}</span></div>${addButton}</div>
          <table class="sample-table"><thead><tr><th class="check-cell"><span class="sr-only">${t("选择实验")}</span></th><th>${t("样品 / 系列")}</th><th>${t("条件摘要")}</th><th>${t("数据附件")}</th><th>${t("记录状态")}</th><th><span class="sr-only">${t("打开详情")}</span></th></tr></thead><tbody>${group.records.map(record => sampleRow(record)).join("")}</tbody></table>
          </section></td></tr>` : "");
    }).join("");
    $("empty-state").hidden = visible.length > 0 || !loaded;
    const noRecords = scoped.filter(record => Boolean(record.archived) === archived).length === 0;
    $("empty-title").textContent = t(noRecords ? (archived ? "没有归档记录" : "还没有实验记录") : "没有符合条件的实验");
    $("empty-message").textContent = t(noRecords ? (archived ? "已归档记录会保留条件和附件，随时可以恢复。" : "从一条实验开始，逐步补全条件和表征数据。") : "试试调整筛选条件；未记录的数值不会匹配数值范围。");
    $("empty-new").hidden = archived || !noRecords;
    $("sync-state").textContent = loaded ? "● " + t("数据已从本机读取") : t(loadError ? "本地服务连接失败" : "读取中");
    renderDashboard(active, experiments);
    if (workspaceView) renderWorkspace(active, keepWorkspaceControls);
    syncRoute();
  }

  function renderDashboard(active, experiments) {
    const show = !loadError && !archived && !$("filter-kind").value && dashboardTab === "overview";
    $("dashboard-panels").hidden = !show;
    $("dashboard-aside").hidden = !show;
    $("records-panel").hidden = show;
    $("dashboard-layout").classList.toggle("show-records", !show);
    for (const [id, pressed] of [["dashboard-overview-tab", show], ["dashboard-records-tab", !show]]) {
      $(id).setAttribute("aria-pressed", String(pressed));
      $(id).classList.toggle("active", pressed);
    }
    if (!show || workspaceView) return;
    const samples = experiments.flatMap(group => group.records), field = $("dashboard-condition-field").value;
    const conditions = new Map();
    for (const group of field ? experiments : []) for (const record of group.records) {
      if (BUILTIN_OF[field] && !builtinEnabled(record.project_id, field)) continue;
      const members = conditionMembers(record, field);
      for (const value of members.length ? members : [""]) {
        if (!conditions.has(value)) conditions.set(value, new Map());
        conditions.get(value).set(group.key, group);
      }
    }
    $("dashboard-condition-column").textContent = $("dashboard-condition-field").selectedOptions[0]?.textContent || t("条件");
    const keyInfo = field.startsWith("key:") ? findKeyField(projectId, field) : null;
    const numeric = field === "temperature" || field === "duration" || keyInfo?.type === "number";
    const expandedConditions = new Set([...$("dashboard-condition-rows").querySelectorAll("details[open]")].map(details => details.dataset.conditionMore));
    $("dashboard-condition-rows").innerHTML = [...conditions].sort(([a], [b]) => Number(a === "") - Number(b === "") || (numeric ? Number(a) - Number(b) : compareConditionValues(a, b, language === "en" ? "en" : "zh-CN"))).map(([value, groups]) => {
      const unit = field === "temperature" ? " °C" : field === "duration" ? " min" : keyInfo?.type === "number" && keyInfo.unit && !Number.isNaN(Number(value)) ? " " + keyInfo.unit : "";
      const label = value === "" ? t("尚未记录") : value + unit;
      const links = [...groups.values()].map(group => `<button class="condition-experiment" data-condition-experiment="${escape(group.key)}" aria-label="${escape(t("打开实验 {sample}", {sample: group.number}) + (!projectId ? " · " + projectLabel(group.projectId) : ""))}">${escape(group.number)}${!projectId ? `<small>${escape(projectLabel(group.projectId))}</small>` : ""}</button>`);
      const moreKey = JSON.stringify([projectId, field, value]);
      return `<tr><th scope="row"><button class="condition-filter ${value === "" ? "muted" : ""}" data-condition-value="${escape(value)}" aria-label="${escape(t("查看此条件下的实验") + " · " + label)}">${escape(label)}</button></th><td class="condition-count">${groups.size}</td><td><div class="condition-experiments">${links.slice(0, 8).join("")}</div>${links.length > 8 ? `<details class="condition-more" data-condition-more="${escape(moreKey)}" ${expandedConditions.has(moreKey) ? "open" : ""}><summary>${t("更多实验")}</summary><div class="condition-experiments">${links.slice(8).join("")}</div></details>` : ""}</td></tr>`;
    }).join("") || `<tr><td colspan="3" class="condition-empty">${t(loaded ? "还没有实验记录" : "正在读取实验记录…")}</td></tr>`;
    const statuses = ["待补全", "已记录", "待表征", "已完成"].map(label => ({label, count: samples.filter(record => record.status === label).length}));
    let offset = 0;
    const segments = statuses.map(({count}, index) => {
      const length = samples.length ? count / samples.length * 100 : 0;
      const circle = `<circle cx="75" cy="75" r="54" pathLength="100" fill="none" stroke-width="18" stroke-dasharray="${length} ${100 - length}" stroke-dashoffset="${-offset}" transform="rotate(-90 75 75)" class="chart-stroke-${index}"/>`;
      offset += length;
      return count ? circle : "";
    }).join("");
    $("dashboard-status").innerHTML = `<svg viewBox="0 0 150 150" role="img" aria-label="${escape(t("样品状态"))}"><circle cx="75" cy="75" r="54" fill="none" stroke="var(--border)" stroke-width="18"/>${segments}<text x="75" y="74" text-anchor="middle" class="donut-number">${samples.length}</text><text x="75" y="94" text-anchor="middle" class="donut-label">${t("样品记录")}</text></svg><div class="chart-legend">${statuses.map(({label, count}, i) => `<div><span class="legend-dot chart-bg-${i}"></span><span>${t(label)}</span><b>${count}</b></div>`).join("")}</div>`;
    $("dashboard-recent").innerHTML = [...active].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 6).map(record => `<button class="recent-record" data-dashboard-open="${record.id}"><span class="recent-icon"><svg class="icon" aria-hidden="true"><use href="#i-flask"/></svg></span><span><strong>${escape(canonicalExperimentNo(recordLabel(record, "sample_id"), record.project_id))}</strong><small>${escape(new Date(record.updated_at).toLocaleDateString(language === "en" ? "en-US" : "zh-CN"))} · ${t("{count} 个附件", {count: record.files.length})}</small></span></button>`).join("") || `<p class="field-help">${t("还没有实验记录")}</p>`;
    const incomplete = experiments.filter(group => missingConditions(group.records).length);
    $("dashboard-pending").textContent = t(samples.some(record => record.template) ?
      "{count} / {total} 个实验缺少条件。" : "{count} / {total} 个实验缺少核心条件（前驱体、温度、时间、溶剂 / 配体）。",
      {count: incomplete.length, total: experiments.length});
    $("dashboard-missing").innerHTML = missingConditions(samples).map(field => ({field, count: incomplete.filter(group => missingConditions(group.records).includes(field)).length}))
      .filter(({count}) => count).sort((a, b) => b.count - a.count)
      .map(({field, count}) => `<button class="quiet" data-missing-field="${escape(field)}">${escape(t("缺{field}", {field: t(conditionLabels[field] || field)}))}<b>${count}</b></button>`).join("");
    $("dashboard-show-pending").disabled = incomplete.length === 0;
  }

  function currentWorkspaceGroup() {
    return workspaceGroups.find(group => group.key === workspaceKey);
  }

  function workspaceRecords() {
    return (currentWorkspaceGroup()?.records || []).filter(record => !workspaceSample || record.id === workspaceSample);
  }

  function renderWorkspace(active, keepWorkspaceControls) {
    const query = $("experiment-search").value.trim().toLocaleLowerCase();
    workspaceGroups = groupRecords(active).filter(group => !group.dataset &&
      (!$("workspace-status-filter").value || group.records.some(record => record.status === $("workspace-status-filter").value)) &&
      (!query || [group.number, ...group.records.map(record => record.sample_id)].some(value => value.toLocaleLowerCase().includes(query))));
    if ($("experiment-order").value === "desc") workspaceGroups.reverse();
    if (!currentWorkspaceGroup()) {
      routeReplace = true;
      workspaceKey = workspaceGroups[0]?.key || "";
      workspaceSample = "";
      workspaceFile = "";
    }
    $("workspace-count").textContent = t("{count} 个实验", {count: workspaceGroups.length});
    const scrollTop = $("experiment-list").scrollTop;
    // Compact one-line index: number + sample count; details move to the tooltip, notebook headers aid scanning.
    let lastBook = null;
    $("experiment-list").innerHTML = workspaceGroups.map(group => {
      const book = /^([A-Za-z]+-[IVX]+)-\d/i.exec(group.number)?.[1].toUpperCase() || t("其他编号");
      const header = book !== lastBook ? `<p class="index-group" aria-hidden="true">${escape(book)}</p>` : "";
      lastBook = book;
      const files = group.records.reduce((sum, record) => sum + record.files.length, 0);
      const statuses = [...new Set(group.records.map(record => record.status))];
      const details = `${t("{count} 条样品", {count: group.records.length})} · ${files} ${t("文件")} · ${statuses.map(value => t(value)).join(" / ")}${!projectId ? " · " + projectLabel(group.projectId) : ""}`;
      const flags = statuses.filter(value => value !== "待补全").map(statusTag).join("");
      return header + `<button class="experiment-index-item ${group.key === workspaceKey ? "active" : ""}" data-workspace-key="${escape(group.key)}" aria-current="${group.key === workspaceKey ? "true" : "false"}" title="${escape(group.number + " · " + details)}" aria-label="${escape(group.number + " · " + details)}"><strong>${escape(group.number)}</strong>${flags ? `<span class="index-statuses">${flags}</span>` : ""}${!projectId ? `<small>${escape(projectLabel(group.projectId))}</small>` : ""}<span class="index-count">${group.records.length}</span></button>`;
    }).join("");
    const activeItem = $("experiment-list").querySelector(".experiment-index-item.active");
    if (activeItem && listScrolledTo !== workspaceKey) {
      listScrolledTo = workspaceKey;
      const list = $("experiment-list");
      if (activeItem.offsetTop < scrollTop || activeItem.offsetTop + activeItem.offsetHeight > scrollTop + list.clientHeight) list.scrollTop = Math.max(0, activeItem.offsetTop - list.clientHeight / 3);
      else list.scrollTop = scrollTop;
    } else $("experiment-list").scrollTop = scrollTop;
    const group = currentWorkspaceGroup();
    $("workspace-empty").hidden = Boolean(group);
    $("workspace-detail").hidden = !group;
    $("workspace-empty-title").textContent = t(!loaded ? (loadError ? "读取失败" : "正在读取实验记录…") : "没有符合条件的实验");
    $("workspace-empty-message").textContent = loadError ? I18n.translateError(loadError, language) : t("选择其他项目、调整搜索或新建实验。资料集仍在实验管理中。");
    if (!group) { previewVersion++; return; }
    if (!group.records.some(record => record.id === workspaceSample)) workspaceSample = "";
    $("workspace-experiment-title").textContent = group.number;
    setShareLink("share-workspace", group.records);
    const missing = missingConditions(group.records);
    $("workspace-experiment-meta").textContent = `${projectLabel(group.projectId)} · ${t("{count} 条样品", {count: group.records.length})} · ${[...new Set(group.records.map(record => record.status))].map(value => t(value)).join(" / ")}` +
      (missing.length ? ` · ${t("缺：{fields}", {fields: missing.map(field => t(conditionLabels[field] || field)).join(language === "en" ? ", " : "、")})}` : "");
    $("workspace-sample").innerHTML = `<option value="">${t("全部样品")}</option>` + group.records.map(record => `<option value="${record.id}">${escape(recordLabel(record, "sample_id"))}</option>`).join("");
    $("workspace-sample").value = workspaceSample;
    $("workspace-open-record").disabled = !workspaceSample && group.records.length > 1;
    $("workspace-edit-record").disabled = $("workspace-open-record").disabled;
    $("workspace-edit-results").disabled = $("workspace-open-record").disabled;
    $("workspace-edit-help").hidden = !$("workspace-edit-record").disabled;
    const chosen = workspaceRecords();
    const statusScope = chosen.map(record => `${record.id}:${record.revision}`).join("|");
    if ($("workspace-status").dataset.scope !== statusScope) {
      if (!keepWorkspaceControls) $("workspace-status").value = chosen.every(record => record.status === chosen[0].status) ? chosen[0].status : "";
      $("workspace-status").dataset.scope = statusScope;
      $("workspace-status-error").hidden = true;
    }
    syncWorkspaceStatus();
    const workspaceProject = chosen[0]?.project_id || projectId;
    const fields = [["前驱体", "precursor"], ["温度 / °C", "temperature"], ["反应 / 取样时间 · min", "duration"], ["溶剂 / 配体", "solvent"], ["实验日期", "experiment_date"]]
      .filter(([, key]) => !BUILTIN_OF[key] || builtinEnabled(workspaceProject, key));
    const keyRows = keyFieldsOf(workspaceProject).map(info => {
      const values = [...new Set(chosen.map(record => keyFieldText(keyFieldValue(record, info))))];
      return `<div class="key-field-row"><dt>${escape(info.label)}</dt><dd>${values.map(value => value === "" ? `<span class="muted">${t("尚未记录")}</span>` : escape(value)).join(' <span class="muted"> / </span> ')}</dd></div>`;
    }).join("");
    $("workspace-conditions").innerHTML = keyRows + fields.map(([label, key]) => {
      const values = [...new Set(chosen.map(record => key === "solvent" ? materialSummary(record) : conditionValue(record, key)))];
      const raw = key === "precursor" ? [...new Set(chosen.map(record => record.precursor).filter(Boolean))].filter(value => !values.includes(value)) : [];
      return `<div><dt>${escape(BUILTIN_OF[key] ? builtinCaption(workspaceProject, key, language) : t(label))}</dt><dd ${raw.length ? `title="${escape(t("原始记录：") + raw.join(" / "))}"` : ""}>${values.map(value => value === "" ? `<span class="muted">${t("尚未记录")}</span>` : escape(value)).join(' <span class="muted"> / </span> ')}</dd></div>`;
    }).join("") + (chosen.length === 1 ? chosen[0].extra_conditions.map(item => `<div><dt>${escape(item.name)}</dt><dd>${display(item.value)} ${escape(item.unit)}</dd></div>`).join("") + templateValuesHtml(chosen[0], "condition") : "");
    $("workspace-lineage").innerHTML = chosen.length === 1 ? lineageHtml(chosen[0]) : "";
    renderWorkspaceData(keepWorkspaceControls);
  }

  function renderWorkspaceData(keepPlot = false) {
    const chosen = workspaceRecords();
    const opened = new Set([...$("workspace-result-content").querySelectorAll("details[open]")].map(item => item.dataset.resultSample));
    $("workspace-result-content").innerHTML = chosen.map(record => `<details class="sample-result-card" data-result-sample="${record.id}" ${chosen.length === 1 || opened.has(record.id) ? "open" : ""}><summary><strong>${escape(recordLabel(record, "sample_id"))}</strong><span>${escape(resultSummary(record).phases.join(" / "))}</span><span class="muted">${escape(resultConfirmation(record, language))}</span></summary><div class="result-card-body">${resultHtml(record)}${chosen.length > 1 ? `<button class="quiet" data-edit-result="${record.id}">${t("编辑结果")}</button>` : ""}</div></details>`).join("");
    const files = chosen.flatMap(record => record.files.map(file => ({...file, sample: recordLabel(record, "sample_id")})));
    if (workspaceKind && !kinds.includes(workspaceKind)) workspaceKind = "";
    const presentKinds = kinds.filter(kind => files.some(file => file.kind === kind) || kind === workspaceKind);
    $("workspace-kinds").innerHTML = ["", ...presentKinds].map(kind => `<button data-workspace-kind="${escape(kind)}" aria-pressed="${workspaceKind === kind}" class="${workspaceKind === kind ? "active" : ""}">${kind ? kindText(kind) : t("总览")}<span>${files.filter(file => !kind || file.kind === kind).length}</span></button>`).join("");
    const filtered = files.filter(file => !workspaceKind || file.kind === workspaceKind);
    $("workspace-file-count").textContent = t("{count} 个附件", {count: filtered.length});
    if (!filtered.some(file => file.id === workspaceFile)) workspaceFile = (filtered.find(file => /\.(csv|png|jpe?g|gif|webp)$/i.test(file.name)) || filtered[0])?.id || "";
    $("workspace-file").innerHTML = filtered.map(file => `<option value="${file.id}">${escape(file.name)} · ${escape(file.sample)}</option>`).join("") || `<option value="">${t("尚未关联数据文件。")}</option>`;
    $("workspace-file").value = workspaceFile;
    $("workspace-file").disabled = !filtered.length;
    const file = filtered.find(file => file.id === workspaceFile);
    $("workspace-download").hidden = !file;
    if (file) $("workspace-download").href = `api/files/${file.id}`; else $("workspace-download").removeAttribute("href");
    $("workspace-file-meta").textContent = file ? `${file.sample} · ${sizeText(file.size)}${file.source ? " · " + t("来源副本：") + file.source : ""}` : "";
    $("workspace-notes").innerHTML = chosen.map(record => {
      const translated = recordLabel(record, "notes");
      return `<details class="workspace-note" ${chosen.length === 1 ? "open" : ""}><summary>${escape(recordLabel(record, "sample_id"))} ${statusTag(record.status)}</summary><div class="notes">${escape(translated || t("尚未填写备注。"))}</div>${translated !== record.notes ? `<details class="notes-original"><summary>${t("查看原文")}</summary><div class="notes">${escape(record.notes)}</div></details>` : ""}</details>`;
    }).join("");
    workspaceCsvFiles = filtered.filter(item => /\.csv$/i.test(item.name));
    renderPreviewPhases();
    if (!keepPlot || file?.id !== previewFile?.id) renderPreview(file);
  }

  async function previewData(id) {
    if (previewCache.has(id)) return previewCache.get(id);
    const data = await api(`api/files/${id}/preview`);
    previewCache.set(id, data);
    if (previewCache.size > 16) previewCache.delete(previewCache.keys().next().value);
    return data;
  }

  // Overlay selection: color slot follows the file, so unchecking one never repaints the others.
  function syncOverlaySelection(file) {
    const scope = `${workspaceKey}|${workspaceSample}|${workspaceKind}`;
    const ids = new Set(workspaceCsvFiles.map(item => item.id));
    if (overlayScope !== scope) {
      overlayScope = scope;
      overlaySlots = new Map();
      const sameKind = workspaceCsvFiles.filter(item => item.kind === file.kind);
      const ordered = [file, ...sameKind.filter(item => item.id !== file.id)].slice(0, OVERLAY_MAX);
      ordered.sort((a, b) => workspaceCsvFiles.indexOf(a) - workspaceCsvFiles.indexOf(b));
      ordered.forEach((item, index) => overlaySlots.set(item.id, index));
    }
    for (const id of [...overlaySlots.keys()]) if (!ids.has(id)) overlaySlots.delete(id);
  }

  function toggleOverlayFile(id, checked) {
    if (!checked) { overlaySlots.delete(id); return; }
    if (overlaySlots.size >= OVERLAY_MAX || overlaySlots.has(id)) return;
    const used = new Set(overlaySlots.values());
    let slot = 0;
    while (used.has(slot)) slot++;
    overlaySlots.set(id, slot);
  }

  function axisName(label, axis) {
    const value = String(label || "").trim();
    if (axis === "x" && /^(2[-_ ]?theta|two[-_ ]?theta|2θ)$/i.test(value)) return "2θ (°)";
    if (axis === "y" && /^(yobs|y_obs|intensity|counts?|int)$/i.test(value)) return t("强度 (a.u.)");
    return value || t(axis === "x" ? "第一列" : "第二列");
  }

  function plotSvg(series, {stack = false, normalize = false, background = false, xLabel = "", yLabel = "", container = $("workspace-preview"), scatter = false} = {}) {
    // Size the coordinate system to the real container so 11px text stays 11px on narrow screens.
    const VW = Math.max(320, Math.min(1100, Math.round((container.clientWidth || 806) - 26)));
    const prepared = prepareSeries(series, {stack});
    const {xmin, xmax, ymin, ymax} = prepared;
    const width = xmax - xmin || 1, height = ymax - ymin || 1;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return {html: `<p>${t("数值范围过大，请下载查看。")}</p>`, state: null};
    const L = 64, R = VW - 30, T = 26, B = 266;
    const sx = value => L + (xmin === xmax ? 0.5 : (value - xmin) / width) * (R - L);
    const sy = value => B - (ymin === ymax ? 0.5 : (value - ymin) / height) * (B - T);
    const format = value => Number(value.toPrecision(6)).toString();
    const yTicks = stack ? [] : niceTicks(ymin, ymax, 4);
    const grid = yTicks.map(value => `<line x1="${L}" x2="${R}" y1="${sy(value).toFixed(1)}" y2="${sy(value).toFixed(1)}"/><text x="${L - 8}" y="${(sy(value) + 4).toFixed(1)}" text-anchor="end">${format(value)}</text>`).join("") +
      niceTicks(xmin, xmax, Math.max(3, Math.round((R - L) / 70))).map(value => `<text x="${sx(value).toFixed(1)}" y="${B + 20}" text-anchor="middle">${format(value)}</text>`).join("");
    const lines = scatter ? series.flatMap(line => line.points.map(([x, y]) => `<circle class="series-fill-0" cx="${sx(x).toFixed(1)}" cy="${sy(y).toFixed(1)}" r="5" aria-label="${escape(line.label)}"><title>${escape(line.label)} · ${format(x)}, ${format(y)}</title></circle>`)).join("") :
      prepared.lines.map(line => `<polyline ${series.length > 1 ? `class="series-${line.slot}"` : ""} points="${line.points.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y + line.offset).toFixed(1)}`).join(" ")}"/>`).join("");
    const labels = stack && series.length > 1 ? prepared.lines.map(line => `<text class="series-label" x="${R - 4}" y="${(sy(line.low + line.offset) - 6).toFixed(1)}" text-anchor="end">${escape(line.label)}</text>`).join("") : "";
    const notes = [background && t("扣背底"), normalize && t("已归一化"), stack && t("堆叠偏移")].filter(Boolean);
    const yTitle = notes.length ? yLabel + (language === "en" ? ` (${notes.join(", ")})` : `（${notes.join("，")}）`) : yLabel;
    const html = `<svg class="csv-plot" viewBox="0 0 ${VW} 316" style="max-width:${VW}px" role="img" aria-label="${escape(t("CSV 曲线预览"))}"><title>${escape(t("CSV 曲线预览"))}</title><g class="plot-axis">${grid}<line class="plot-baseline" x1="${L}" x2="${R}" y1="${B}" y2="${B}"/><text x="${L}" y="16">${escape(yTitle)}</text><text x="${(L + R) / 2}" y="310" text-anchor="middle">${escape(xLabel)}</text></g>${lines}${labels}<g class="plot-hover" hidden><line class="plot-cursor" y1="${T}" y2="${B}"/>${prepared.lines.map(line => `<circle class="plot-dot ${series.length > 1 ? `series-fill-${line.slot}` : ""}" r="4"/>`).join("")}</g></svg><div class="plot-tooltip" hidden></div>`;
    return {html, state: {prepared, sx, sy, L, R, VW, xmin, width, xLabel, multiple: series.length > 1, processed: background || normalize}};
  }

  function nearestIndex(points, x) {
    let best = 0, distance = Infinity;
    const ascending = points.length > 1 && points[points.length - 1][0] >= points[0][0];
    if (ascending) {
      let low = 0, high = points.length - 1;
      while (high - low > 1) { const mid = (low + high) >> 1; if (points[mid][0] < x) low = mid; else high = mid; }
      return Math.abs(points[low][0] - x) <= Math.abs(points[high][0] - x) ? low : high;
    }
    points.forEach(([value], index) => { const d = Math.abs(value - x); if (d < distance) { distance = d; best = index; } });
    return best;
  }

  function showPlotHover(event) {
    const svg = event.target.closest?.(".csv-plot");
    const panel = svg?.closest(".preview-panel");
    if (!svg || !activePlot || !panel) return;
    const rect = svg.getBoundingClientRect(), state = activePlot;
    const vx = (event.clientX - rect.left) / rect.width * state.VW;
    const hover = svg.querySelector(".plot-hover"), tip = panel.querySelector(".plot-tooltip");
    if (vx < state.L || vx > state.R || !rect.width) { hover.setAttribute("hidden", ""); tip.hidden = true; return; }
    const x = state.xmin + (vx - state.L) / (state.R - state.L) * state.width;
    const rows = state.prepared.lines.map((line, index) => {
      const at = nearestIndex(line.points, x), [px, py] = line.points[at];
      const dot = hover.querySelectorAll(".plot-dot")[index];
      dot.setAttribute("cx", state.sx(px).toFixed(1)); dot.setAttribute("cy", state.sy(py + line.offset).toFixed(1));
      return {line, x: px, value: py, y: line.raw[at]?.[1] ?? py};
    });
    const cursor = hover.querySelector(".plot-cursor"), cx = state.sx(rows[0].x).toFixed(1);
    cursor.setAttribute("x1", cx); cursor.setAttribute("x2", cx);
    hover.removeAttribute("hidden");
    const number = value => Number(value.toPrecision(5)).toString();
    tip.innerHTML = `<strong>${escape(state.xLabel)} ${number(rows[0].x)}</strong>` + rows.slice().reverse().map(({line, y, value}) => `<span>${state.multiple ? `<i class="series-swatch series-bg-${line.slot}"></i>` : ""}${state.multiple ? escape(line.label) + " " : ""}<b>${number(state.processed ? value : y)}</b>${state.processed ? `<small>${t("原始")} ${number(y)}</small>` : ""}</span>`).join("");
    tip.hidden = false;
    const panelRect = panel.getBoundingClientRect(), left = event.clientX - panelRect.left, top = event.clientY - panelRect.top;
    tip.style.left = `${Math.min(left + 14, panelRect.width - tip.offsetWidth - 4)}px`;
    tip.style.top = `${Math.max(4, top - tip.offsetHeight - 10)}px`;
  }

  async function renderPreview(file) {
    const version = ++previewVersion, area = $("workspace-preview");
    if (previewModeFile !== (file?.id || "")) { if (previewMode === "table") previewMode = "plot"; previewModeFile = file?.id || ""; }
    activePlot = null; previewFile = file;
    area.innerHTML = "";
    if (!file) { area.textContent = t("尚未关联数据文件。"); return; }
    const url = `api/files/${file.id}/preview`;
    if (/\.(png|jpe?g|gif|webp)$/i.test(file.name)) {
      const img = document.createElement("img");
      img.alt = file.name; img.src = url;
      img.addEventListener("error", () => { if (version === previewVersion) area.textContent = t("图片无法预览，请下载查看。"); });
      area.append(img);
      return;
    }
    if (!/\.csv$/i.test(file.name)) {
      area.innerHTML = `<svg class="empty-icon" aria-hidden="true"><use href="#i-chart"/></svg><strong>${escape(file.name)}</strong><p>${t("此格式暂不支持预览，请下载后用相应软件打开。")}</p>`;
      return;
    }
    area.textContent = t("正在读取预览…");
    try {
      const data = await previewData(file.id);
      if (version !== previewVersion || !workspaceView) return;
      const table = `<div class="preview-table-scroll"><table class="preview-table"><caption>${t("CSV 数据预览")}</caption><tbody>${data.rows.map(row => `<tr>${row.map(cell => `<td>${escape(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${data.truncated ? `<p class="field-help">${t("表格最多显示 51 行、20 列；完整内容请下载。")}</p>` : ""}`;
      if (!data.points.length) { area.innerHTML = `<p>${t("未找到可绘图的前两列数值，显示表格预览。")}</p>${table}`; return; }
      const canOverlay = workspaceCsvFiles.length >= 2;
      if (previewMode === "overlay" && !canOverlay) previewMode = "plot";
      const xLabel = axisName(data.labels[0], "x"), yLabel = axisName(data.labels[1], "y");
      const isXrd = file.kind === "XRD" || xLabel === "2θ (°)";
      const unit = isXrd ? "°" : "";
      const aligned = item => Boolean(item?.background?.length && item.background.length === item.points.length);
      // Background method: "none" | "file" (bkg column stored in the CSV) | "snip" (automatic estimate).
      // Default for XRD is the file's bkg column when available; "file" falls back to SNIP for curves without one.
      const resolve = hasFile => {
        let method = plotPrefs.method ?? (isXrd ? "file" : "none");
        if (method === "file" && !hasFile) method = "snip";
        return {method, background: method !== "none", normalize: plotPrefs.normalize ?? (isXrd || previewMode === "overlay"), window: plotPrefs.window};
      };
      const processed = (options, id, item) => {
        const fromFile = options.method === "file" && aligned(item);
        const key = `${id}|${options.method}|${options.normalize}|${fromFile ? "file" : options.window}`;
        if (!processedCache.has(key)) {
          processedCache.set(key, processSeries(item.points, {...options, backgroundValues: fromFile ? item.background : null}));
          if (processedCache.size > 24) processedCache.delete(processedCache.keys().next().value);
        }
        return processedCache.get(key);
      };
      const controls = (options, hasFile, needsWindow) => `<div class="preview-switch plot-method" role="group" aria-label="${t("去背景方法")}"><span class="switch-label">${t("背底")}</span>${[["none", "不扣除"], ["file", "文件 bkg 列"], ["snip", "SNIP 自动估计"]].map(([value, label]) => `<button data-plot-method="${value}" aria-pressed="${options.method === value}" ${value === "file" && !hasFile ? `disabled title="${escape(t("没有可用的 bkg 列"))}"` : ""}>${t(label)}</button>`).join("")}</div><label class="plot-window" ${options.background && needsWindow ? "" : "hidden"}><span>${t("窗口")}</span><select data-plot-window>${[0.5, 1, 2, 4].map(value => `<option value="${value}" ${value === options.window ? "selected" : ""}>±${value}${unit}</option>`).join("")}</select></label><label class="overlay-normalize"><input type="checkbox" data-plot-normalize ${options.normalize ? "checked" : ""}>${t("归一化")}</label>`;
      const helpFor = (options, fileCount, total) => {
        const tail = options.normalize ? t("再按最大值归一化到 1。") : "";
        const keep = t("仅用于预览，原始文件不变；悬停可看原始强度。");
        if (options.method === "file" && fileCount === total) return t("已直接减去文件中的 bkg 列（精修拟合背底）。") + tail + keep;
        if (options.method === "file" && fileCount > 0) return t("{file} 条曲线减去文件中的 bkg 列；{auto} 条没有 bkg 列，用 SNIP 自动估计（窗口 ±{window}{unit}）。", {file: fileCount, auto: total - fileCount, window: options.window, unit}) + tail + keep;
        if (options.background) return t(options.normalize ? "背底由 SNIP 算法自动估计（窗口 ±{window}{unit}）并扣除，再按最大值归一化到 1。比窗口更宽的起伏（如非晶包）会被当作背底，窗口应略大于最宽的衍射峰。仅用于预览，原始文件不变；悬停可看原始强度。" : "背底由 SNIP 算法自动估计（窗口 ±{window}{unit}）并扣除。比窗口更宽的起伏（如非晶包）会被当作背底，窗口应略大于最宽的衍射峰。仅用于预览，原始文件不变；悬停可看原始强度。", {window: options.window, unit});
        return options.normalize ? t("每条曲线按自身最小值–最大值缩放到 0–1；悬停可看原始值。") : t("原始数值，未平滑、未归一化。");
      };
      let plot = "";
      if (previewMode === "overlay") {
        syncOverlaySelection(file);
        const chosen = workspaceCsvFiles.filter(item => overlaySlots.has(item.id));
        const loaded = await Promise.all(chosen.map(item => previewData(item.id).catch(() => null)));
        if (version !== previewVersion || !workspaceView) return;
        const hasFile = loaded.some(aligned);
        const options = resolve(hasFile);
        const samples = chosen.map(item => item.sample);
        const series = chosen.map((item, index) => ({id: item.id, slot: overlaySlots.get(item.id), raw: loaded[index]?.points || [], fromFile: options.method === "file" && aligned(loaded[index]), points: loaded[index]?.points?.length ? processed(options, item.id, loaded[index]) : [],
          label: samples.filter(sample => sample === item.sample).length > 1 ? `${item.sample} · ${item.name}` : item.sample})).filter(item => item.points.length);
        const skipped = chosen.length - series.length;
        const rendered = series.length ? plotSvg(series, {stack: overlayLayout === "stack", ...options, xLabel, yLabel}) : {html: `<p>${t("请至少勾选一条曲线。")}</p>`, state: null};
        activePlot = rendered.state;
        const full = overlaySlots.size >= OVERLAY_MAX;
        const legend = workspaceCsvFiles.map(item => {
          const on = overlaySlots.has(item.id);
          return `<label class="overlay-item ${on ? "on" : ""}" title="${escape(item.name)}"><input type="checkbox" data-overlay-file="${item.id}" ${on ? "checked" : ""} ${!on && full ? "disabled" : ""}>${on ? `<i class="series-swatch series-bg-${overlaySlots.get(item.id)}"></i>` : `<i class="series-swatch empty"></i>`}<span>${escape(item.sample)}</span><small>${escape(item.name)}</small></label>`;
        }).join("");
        plot = `<div class="overlay-controls"><div class="preview-switch" role="group" aria-label="${t("排列方式")}"><button data-overlay-layout="stack" aria-pressed="${overlayLayout === "stack"}">${t("堆叠")}</button><button data-overlay-layout="overlay" aria-pressed="${overlayLayout === "overlay"}">${t("重叠")}</button></div>${controls(options, hasFile, series.some(item => !item.fromFile))}</div>${rendered.html}<fieldset class="overlay-legend"><legend>${t("曲线（{count} / 最多 {max} 条）", {count: overlaySlots.size, max: OVERLAY_MAX})}</legend>${legend}</fieldset><p class="field-help">${helpFor(options, series.filter(item => item.fromFile).length, series.length)}${skipped ? " " + t("{count} 个文件无法绘图，已跳过。", {count: skipped}) : ""}</p>`;
      } else if (previewMode === "plot") {
        const hasFile = aligned(data), options = resolve(hasFile);
        const fromFile = options.method === "file";
        const rendered = plotSvg([{id: file.id, slot: 0, label: file.sample, raw: data.points, points: processed(options, file.id, data)}], {...options, xLabel, yLabel});
        activePlot = rendered.state;
        plot = `<div class="overlay-controls">${controls(options, hasFile, !fromFile)}</div>${rendered.html}<p class="field-help">${options.background || options.normalize ? helpFor(options, fromFile ? 1 : 0, 1) : t("前两列原始数值预览；未平滑、未归一化。")}</p>`;
      }
      const modes = [["plot", "曲线图"], ...(canOverlay ? [["overlay", "叠加对比"]] : []), ["table", "数值表"]];
      area.innerHTML = `<div class="preview-switch" role="group" aria-label="${t("数据预览")}">${modes.map(([mode, label]) => `<button data-preview-mode="${mode}" aria-controls="preview-${mode === "table" ? "table" : "plot"}" aria-pressed="${previewMode === mode}">${t(label)}</button>`).join("")}</div><div id="preview-plot" class="preview-panel" ${previewMode === "table" ? "hidden" : ""}>${plot}</div><div id="preview-table" class="preview-panel" ${previewMode !== "table" ? "hidden" : ""}>${table}</div>`;
    } catch (error) { if (version === previewVersion) area.textContent = I18n.translateError(error.message, language); }
  }

  function groupCell(group, field, summary) {
    return builtinEnabled(group.projectId, field) ? summary(field) : `<span class="muted">—</span>`;
  }

  function sampleRow(record, dataset = false) {
    // Chips follow the project's fields: switched-off built-ins are left out, custom labels used, key fields appended.
    const pid = record.project_id, shortLabels = {precursor: "前驱体", temperature: "温度", duration: "时间", materials: "溶剂 / 配体"};
    const conditions = [["precursor", record.precursor], ["temperature", record.temperature === null ? "" : `${record.temperature} °C`],
      ["duration", record.duration === null ? "" : `${record.duration} min`], ["materials", materialSummary(record)]]
      .filter(([field]) => builtinEnabled(pid, field)).map(([field, value]) => [builtinCustomLabel(pid, field, language) || t(shortLabels[field]), value]);
    for (const info of keyFieldsOf(pid)) conditions.push([info.label, keyFieldText(keyFieldValue(record, info))]);
    const files = record.files.slice(0, 2).map(file => `<a class="inline-file" href="api/files/${file.id}" download title="${escape(file.name)}"><span class="data-tag">${kindText(file.kind)}</span><span>${escape(file.name)}</span><svg class="icon" aria-hidden="true"><use href="#i-download"/></svg></a>`).join("");
    return `<tr class="${dataset ? "dataset-row" : "sample-row"} ${selected.has(record.id) ? "selected" : ""}">
      <td class="check-cell"><input type="checkbox" data-select="${record.id}" aria-label="${escape(t("选择 {sample}", {sample: recordLabel(record, "sample_id")}))}" ${selected.has(record.id) ? "checked" : ""}></td>
      <td><button class="sample-link" data-open="${record.id}" title="${escape(record.sample_id)}">${escape(recordLabel(record, "sample_id"))}</button><span class="subline">${dataset ? t("资料集") + " · " : ""}${escape(recordLabel(record, "series") || t("未分类"))}${record.experiment_date ? " · " + escape(record.experiment_date) : ""}</span></td>
      ${dataset ? `<td class="col-precursor">${display(record.precursor)}</td><td class="numeric col-temperature">${display(record.temperature)}</td><td class="numeric col-duration">${display(record.duration)}</td>
      <td class="col-materials">${display(materialSummary(record))}</td>
      <td class="file-types">${record.files.length ? fileTags(record.files) : `<span class="muted">${t("未关联")}</span>`}</td>` :
      `<td class="sample-conditions">${conditions.filter(([, value]) => value !== "" && value != null).map(([label, value]) => `<span><small>${escape(label)}</small>${escape(value)}</span>`).join("") || `<span class="muted">${t("尚未记录")}</span>`}${resultSummary(record).confirmation ? `<div class="sample-result-line" title="${escape(resultSummary(record).conclusion)}">${escape([...resultSummary(record).phases, ...resultSummary(record).morphologies].join(" / ") || t("结果摘要"))} · ${escape(resultConfirmation(record, language))}</div>` : ""}</td>
      <td class="sample-files">${files || `<span class="muted">${t("未关联")}</span>`}${record.files.length > 2 ? `<button class="more-files" data-open="${record.id}">${t("查看全部 {count} 个文件", {count: record.files.length})}</button>` : ""}</td>`}
      <td>${statusTag(record.status)}</td><td><button class="open-record" data-open="${record.id}" aria-label="${escape(t("查看 {sample}", {sample: recordLabel(record, "sample_id")}))}"><svg class="icon" aria-hidden="true"><use href="#i-chevron"/></svg></button></td></tr>`;
  }

  async function load() {
    const version = ++loadVersion;
    const result = await api("api/experiments");
    if (version !== loadVersion) return;
    records = result.experiments;
    projects = result.projects;
    kinds = result.kinds;
    templates = result.templates || {};
    conditionOptions = result.condition_options || {};
    I18n.extend(result.translations || {});
    configureCatalog(result.conventions);
    configureProjects(result.project_settings);
    if (result.backup && !backupTimer) { backupStatus = result.backup; renderBackupBadge(); }
    if (Number.isInteger(result.trash_count)) { trashCount = result.trash_count; renderTrashCount(); }
    categoryCounts = result.category_counts && typeof result.category_counts === "object" ? result.category_counts : null;
    const onboarding = result.onboarding;
    // undefined = an older server without the field; then the demo is recognised by its fixed id.
    demoProjectId = Object.hasOwn(result, "demo_project_id") ? result.demo_project_id : undefined;
    if (projectId && !projects.some(project => project.id === projectId)) projectId = "default";
    loaded = true;
    loadError = null;
    renderCatalogOptions();
    renderConditionOptions();
    if (!routeApplied) { applyRoute(); routeApplied = true; routeReplace = true; }
    render();
    if (onboarding && onboarding.empty && !onboarding.done && !onboardingShown && !document.querySelector("dialog[open]")) openOnboarding();
  }

  function renderConditionOptions() {
    const series = editorSeriesValue();
    const scoped = records.filter(record => !projectId || (record.project_id || "default") === projectId);
    for (const [field, label] of [["series", ""], ["precursor", "全部前驱体"], ["solvent", "全部溶剂 / 配体"]]) {
      const values = [...new Set(scoped.flatMap(record => field === "series" ? [record.series] : builtinEnabled(record.project_id, field) ? conditionMembers(record, field) : []).filter(Boolean))].sort((a, b) => compareConditionValues(a, b, language === "en" ? "en" : "zh-CN"));
      const options = values.map(value => `<option value="${escape(value)}">${escape(field === "series" ? recordLabel({series: value}, "series") : value)}</option>`).join("");
      if (field === "series") $("series-options").innerHTML = values.map(value => `<option value="${escape(recordLabel({series: value}, "series"))}" data-value="${escape(value)}"></option>`).join("");
      else if (field === "solvent") renderSolventChoices();
      else renderPrecursorChoices();
      const select = $(`filter-${field}`);
      if (select) {
        const current = select.value;
        select.innerHTML = `<option value="" data-i18n="${label}">${t(label)}</option>` + options;
        select.value = values.includes(current) ? current : "";
      }
    }
    setEditorSeries(series);
    renderNumericChoices();
    renderResultOptions(scoped);
  }

  function renderResultOptions(scoped) {
    for (const [field, id, label] of [["phases", "phase", "全部物相"], ["morphologies", "morphology", "全部形貌"]]) {
      const values = [...new Set(scoped.flatMap(record => resultSummary(record)[field]))].sort((a, b) => a.localeCompare(b, language === "en" ? "en" : "zh-CN", {numeric: true}));
      const select = $(`filter-${id}`), current = select.value;
      select.innerHTML = `<option value="">${t(label)}</option>` + values.map(value => `<option value="${escape(value)}">${escape(value)}</option>`).join("");
      select.value = values.includes(current) ? current : "";
      $(`result-${id}-options`).innerHTML = [...new Set([...records.flatMap(record => resultSummary(record)[field]), ...resultDraft[field]])].map(value => `<option value="${escape(value)}"></option>`).join("");
    }
    renderResultTags();
  }

  function renderResultTags() {
    renderPhaseChoices("result-phases", $("editor-project").value, resultDraft.phases);
    $("result-morphologies").innerHTML = resultDraft.morphologies.map(value => `<span class="result-chip"><span>${escape(value)}</span><button type="button" data-remove-result data-result-value="${escape(value)}" aria-label="${escape(t("移除结果标签 {name}", {name: value}))}">×</button></span>`).join("");
  }

  function renderPhaseChoices(id, project, selected, busy = false) {
    const container = $(id);
    const focused = container.contains(document.activeElement) ? document.activeElement.dataset.phaseChoice : undefined;
    const configured = projectEntry(project)?.settings?.phase_presets;
    const presets = Array.isArray(configured) && configured.length ? configured : PHASE_PRESETS.get(project) || [];
    const recorded = records.filter(record => record.project_id === project && !record.archived && !isDatasetRecord(record))
      .flatMap(record => resultSummary(record).phases);
    const suggestions = [...new Set([...presets, ...[...new Set(recorded)].filter(value => !presets.includes(value)).slice(0, 8)])];
    const phases = [...new Set([...suggestions, ...selected])];
    container.innerHTML = phases.map(phase => `<button type="button" class="phase-choice" data-phase-choice="${escape(phase)}" aria-pressed="${selected.includes(phase)}"${busy ? ' aria-disabled="true"' : ""}>${escape(phase)}</button>`).join("");
    if (focused !== undefined) {
      const next = [...container.children].find(button => button.dataset.phaseChoice === focused);
      (next || $(id === "preview-phases" ? "preview-edit-result" : "result-phase-input")).focus({preventScroll: true});
    }
  }

  function previewPhaseSample() {
    if (workspaceView && !$("workspace-detail").hidden && workspaceFile) {
      return workspaceRecords().find(record => record.files.some(file => file.id === workspaceFile));
    }
  }

  function renderPreviewPhases() {
    const record = previewPhaseSample(), picker = $("preview-phase-picker");
    picker.hidden = !record;
    if (!record) return;
    picker.setAttribute("aria-busy", String(previewPhaseSaving));
    $("preview-phase-label").textContent = t("物相 · {sample}", {sample: recordLabel(record, "sample_id")});
    renderPhaseChoices("preview-phases", record.project_id, resultSummary(record).phases, previewPhaseSaving);
    $("preview-phase-help").hidden = !$("preview-phases").children.length;
    $("preview-edit-result").disabled = previewPhaseSaving;
    const message = previewPhaseError?.id === record.id ? previewPhaseError.message : "";
    $("preview-phase-error").hidden = !message;
    $("preview-phase-error").textContent = I18n.translateError(message, language);
  }

  $("preview-edit-result").addEventListener("click", () => {
    const record = previewPhaseSample();
    if (record && !previewPhaseSaving) editResult(record.id);
  });

  $("preview-phases").addEventListener("click", async event => {
    const button = event.target.closest("[data-phase-choice]"), record = previewPhaseSample();
    if (!button || !record || previewPhaseSaving) return;
    const phase = button.dataset.phaseChoice, result = resultSummary(record);
    const phases = result.phases.includes(phase) ? result.phases.filter(value => value !== phase) : [...result.phases, phase];
    if (phases.length > 20) {
      previewPhaseError = {id: record.id, message: "最多选择 20 个物相。"};
      renderPreviewPhases();
      return;
    }
    const changes = {phases: phases.length ? {mode: "set", value: phases} : {mode: "clear"}};
    if (!phases.length && !result.morphologies.length && !result.conclusion) {
      changes.confirmation = {mode: "set", value: result.evidence_ids.length ? "pending" : ""};
    }
    previewPhaseSaving = true;
    previewPhaseError = null;
    renderPreviewPhases();
    try {
      let saved;
      try {
        const payload = {records: [{id: record.id, revision: record.revision}], changes, preview: false};
        const response = await api("api/experiments/bulk", {method: "POST", body: JSON.stringify(payload)});
        saved = response.records?.find(item => item.id === record.id);
        if (!saved) throw new Error("暂未确认物相是否保存，请核对当前物相。");
      } catch (error) {
        if (error.status && error.status < 500) throw error;
        // Check for a committed write when its response was lost.
        const latest = await api("api/experiments").catch(() => null);
        const candidate = latest?.experiments?.find(item => item.id === record.id);
        if (candidate?.revision !== record.revision + 1 ||
            JSON.stringify(resultSummary(candidate).phases) !== JSON.stringify(phases)) {
          throw new Error("暂未确认物相是否保存，请核对当前物相。");
        }
        saved = candidate;
      }
      const current = records.find(item => item.id === saved.id);
      if (current && saved.revision >= current.revision) {
        loadVersion++;
        records = [saved, ...records.filter(item => item.id !== saved.id)];
        renderResultOptions(records.filter(item => !projectId || item.project_id === projectId));
        render({keepWorkspaceControls: true});
      }
      toast(t("已保存 {sample} 的物相。", {sample: recordLabel(saved, "sample_id")}));
    } catch (error) {
      const message = error.status === 409 ? "样品已更新，请核对当前物相后重试。" : error.message;
      previewPhaseError = {id: record.id, message};
      if (error.status === 409) await load().catch(() => {});
      if (previewPhaseSample()?.id !== record.id) toast(I18n.translateError(message, language));
    } finally {
      previewPhaseSaving = false;
      renderPreviewPhases();
    }
  });

  function syncResultConfirmation() {
    const confirmation = $("result-confirmation");
    const hasResult = resultDraft.phases.length || resultDraft.morphologies.length || $("result-conclusion").value.trim() || $("result-evidence-options").querySelector(":checked");
    if (hasResult && !confirmation.value) {
      confirmation.value = "pending";
      resultAutoPending = true;
    } else if (!hasResult && resultAutoPending) {
      if (confirmation.value === "pending") confirmation.value = "";
      resultAutoPending = false;
    }
  }

  function addResultTag(field, choice) {
    const input = $(field === "phases" ? "result-phase-input" : "result-morphology-input"), value = choice ?? input.value.trim();
    if (!value) { input.focus(); return false; }
    if (value.length > 80 || /[\x00-\x1f]/.test(value) || (!resultDraft[field].includes(value) && resultDraft[field].length >= 20)) {
      showError("result-error", "物相和形貌各最多 20 项，每项最多 80 个字符；证据附件最多 100 个。");
      return false;
    }
    if (!resultDraft[field].includes(value)) resultDraft[field].push(value);
    if (choice === undefined) input.value = "";
    $("result-error").hidden = true;
    renderResultTags();
    syncResultConfirmation();
    dirty = true;
    if (choice === undefined) input.focus();
    return true;
  }

  function setResultEditor(record) {
    const result = resultSummary(record || {});
    resultDraft = {phases: result.phases.slice(), morphologies: result.morphologies.slice()};
    resultAutoPending = false;
    $("result-confirmation").value = result.confirmation;
    $("result-conclusion").value = result.conclusion;
    $("result-phase-input").value = "";
    $("result-morphology-input").value = "";
    $("result-error").hidden = true;
    $("result-evidence-options").innerHTML = (record?.files || []).map(file => `<label class="result-evidence-option"><input type="checkbox" data-result-evidence="${file.id}" ${result.evidence_ids.includes(file.id) ? "checked" : ""}><span class="data-tag">${kindText(file.kind)}</span><span>${escape(file.name)}</span></label>`).join("") || `<p class="field-help" data-i18n="本样品尚无附件，请保存后上传。">${t("本样品尚无附件，请保存后上传。")}</p>`;
    renderResultOptions(records.filter(item => !projectId || item.project_id === projectId));
  }

  function resultHtml(record) {
    const result = resultSummary(record);
    const outcome = OUTCOME_LABELS[record.lab_data?.outcome];
    const rows = (outcome ? `<div><dt>${text("表征结果状态")}</dt><dd>${text(outcome)}</dd></div>` : "") + templateValuesHtml(record, "result");
    const metrics = rows ? `<dl class="result-grid">${rows}</dl>` : "";
    if (!result.confirmation) return metrics || `<p class="field-help">${text("尚未记录结果。")}</p>`;
    const tags = values => values.length ? values.map(value => `<span class="result-chip">${escape(value)}</span>`).join("") : display("");
    const evidence = record.files.filter(file => result.evidence_ids.includes(file.id));
    return metrics + `<dl class="result-grid"><div><dt>${text("物相")}</dt><dd>${tags(result.phases)}</dd></div><div><dt>${text("形貌")}</dt><dd>${tags(result.morphologies)}</dd></div><div><dt>${text("结果确认")}</dt><dd><span class="status ${result.confirmation === "confirmed" ? "result-confirmed" : "pending"}">${escape(resultConfirmation(record, language))}</span></dd></div></dl>${result.conclusion ? `<p class="notes result-conclusion">${escape(result.conclusion)}</p>` : ""}<div class="result-evidence-links"><span class="field-help">${text("关联表征证据")}</span>${evidence.map(file => record.archived ? `<a class="button" href="api/files/${file.id}" download>${escape(file.name)}</a>` : `<button type="button" class="result-evidence-link" data-result-file="${file.id}" data-result-record="${record.id}"><span class="data-tag">${kindText(file.kind)}</span><span>${escape(file.name)}</span></button>`).join("") || `<span class="muted">${text("未关联证据")}</span>`}</div>`;
  }

  function templateValuesHtml(record, section) {
    return storedFields(record, section).filter(field => field.value !== undefined).map(field =>
      `<div><dt>${escape(fieldCaption(field))}</dt><dd>${display(shownValue(field.value))}</dd></div>`).join("");
  }

  function lineageHtml(record) {
    const chain = [];
    for (let row = record; row && !chain.includes(row); row = records.find(item => item.id === row.lab_data?.parent_id)) chain.push(row);
    const children = records.filter(item => item.lab_data?.parent_id === record.id);
    if (chain.length === 1 && !record.lab_data?.treatment && !children.length) return "";
    const link = row => `<button type="button" class="quiet" data-lineage-record="${escape(row.id)}">${escape(row.sample_id)}${row.archived ? " · " + t("已归档") : ""}</button>`;
    return `<section class="lab-lineage"><h3>${text("样品来源与处理")}</h3>
      <ol>${chain.reverse().map(row => `<li>${row.id === record.id ? `<strong>${escape(row.sample_id)}</strong>` : link(row)}${row.lab_data?.treatment ? " · " + escape(row.lab_data.treatment) : ""}</li>`).join("")}</ol>
      ${children.length ? `<div class="lab-actions">${text("派生样品")}${children.map(link).join("")}</div>` : ""}</section>`;
  }

  document.addEventListener("click", event => {
    const link = event.target.closest("[data-lineage-record]");
    if (link && !uploading) openDetail(link.dataset.lineageRecord);
  });

  form.addEventListener("click", event => {
    if (saving) return;
    const add = event.target.closest("[data-add-result]");
    if (add) return void addResultTag(add.dataset.addResult);
    const choice = event.target.closest("[data-phase-choice]");
    if (choice && !resultDraft.phases.includes(choice.dataset.phaseChoice)) return void addResultTag("phases", choice.dataset.phaseChoice);
    const remove = choice || event.target.closest("[data-remove-result]");
    if (!remove) return;
    const field = choice ? "phases" : "morphologies";
    const value = choice ? choice.dataset.phaseChoice : remove.dataset.resultValue;
    resultDraft[field] = resultDraft[field].filter(tag => tag !== value);
    $("result-error").hidden = true;
    renderResultTags();
    syncResultConfirmation();
    dirty = true;
    if (!choice) $("result-morphology-input").focus();
  });
  for (const [id, field] of [["result-phase-input", "phases"], ["result-morphology-input", "morphologies"]]) {
    $(id).addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); if (!saving) addResultTag(field); }
    });
  }
  $("result-conclusion").addEventListener("input", syncResultConfirmation);
  $("result-evidence-options").addEventListener("change", syncResultConfirmation);
  $("result-confirmation").addEventListener("change", () => { resultAutoPending = false; syncResultConfirmation(); });

  function editorSeriesValue() {
    const input = form.elements.namedItem("series");
    // Keep the stored name separate from its translated, editable display.
    if (input.value === input.dataset.label) return input.dataset.value;
    const option = [...$("series-options").options].find(option => option.value === input.value);
    return option?.dataset.value ?? input.value;
  }

  function setEditorSeries(value) {
    const input = form.elements.namedItem("series");
    input.dataset.value = value;
    input.dataset.label = recordLabel({series: value}, "series");
    input.value = input.dataset.label;
  }

  function conditionValues(field) {
    const numeric = field === "temperature" || field === "duration";
    const normalize = value => numeric ? String(Number(value)) : field === "precursor" ? canonicalPrecursor(value) : value;
    return [...new Set([...(conditionOptions[field] || []), ...(field === "solvent" ? conditionOptions.ligand || [] : []), ...(field === "precursor" ? records.flatMap(recordPrecursors) : [])].filter(value => value !== "" && value !== null && value !== undefined).map(normalize))].sort((a, b) => numeric ? Number(a) - Number(b) : compareConditionValues(a, b, language === "en" ? "en" : "zh-CN"));
  }

  function renderNumericChoices() {
    for (const [field, label, unit] of [["temperature", "常用温度", "°C"], ["duration", "常用时间", "min"]]) {
      const input = $(`editor-${field}`), select = $(`${field}-presets`);
      select.innerHTML = `<option value="">${t(label)}</option>` + conditionValues(field).map(value => `<option value="${value}">${value} ${unit}</option>`).join("");
      select.value = input.value === "" ? "" : String(Number(input.value));
      $(`delete-${field}-option`).disabled = saving || materialSaving || presetSaving || !select.value;
    }
  }

  function syncConditionActions() {
    const busy = saving || materialSaving || presetSaving;
    for (const control of form.querySelectorAll("[data-delete-solvent], #save-temperature-option, #save-duration-option, #add-solvent, #save-solvent, #add-precursor, #save-precursor, #editor-share-conditions")) control.disabled = busy;
    $("save-record").disabled = busy;
    renderNumericChoices();
  }

  async function deleteConditionOption(field, name) {
    if (!name || saving || materialSaving || presetSaving) return;
    const errorId = field === "solvent" ? "solvent-error" : `${field}-error`;
    presetSaving = true;
    $(errorId).hidden = true;
    syncConditionActions();
    try {
      await api("api/condition-options", {method: "DELETE", body: JSON.stringify({field, name})});
      loadVersion++;
      for (const key of field === "solvent" ? ["solvent", "ligand"] : [field]) conditionOptions[key] = (conditionOptions[key] || []).filter(value => (key === "temperature" || key === "duration" ? String(Number(value)) : value) !== name);
      if (field === "solvent") renderSolventChoices();
      toast(t("已从常用选项删除，已有实验记录保持不变。"));
    } catch (error) { showError(errorId, error.message); }
    finally { presetSaving = false; syncConditionActions(); }
  }

  for (const field of ["temperature", "duration"]) {
    $(`delete-${field}-option`).addEventListener("click", () => deleteConditionOption(field, $(`${field}-presets`).value));
    $(`${field}-presets`).addEventListener("change", event => {
      $(`delete-${field}-option`).disabled = !event.target.value;
      if (event.target.value === "") return;
      $(`editor-${field}`).value = event.target.value;
      $(`editor-${field}`).dispatchEvent(new Event("input", {bubbles: true}));
    });
    $(`editor-${field}`).addEventListener("input", renderNumericChoices);
    $(`save-${field}-option`).addEventListener("click", async () => {
      if (presetSaving || saving || materialSaving) return;
      const input = $(`editor-${field}`), name = input.value;
      if (name === "" || !input.checkValidity()) return showError(`${field}-error`, "请先填写有效的温度或时间，再添加为常用。");
      presetSaving = true;
      $(`${field}-error`).hidden = true;
      syncConditionActions();
      try {
        if (!conditionValues(field).includes(String(Number(name)))) {
          try { await api("api/condition-options", {method: "POST", body: JSON.stringify({field, name})}); }
          catch (error) { if (error.message !== "该名称已存在，请直接选择或使用其他名称。") throw error; }
          (conditionOptions[field] ||= []).push(String(Number(name)));
          loadVersion++;
        }
        renderNumericChoices();
        toast(t("常用条件已保存，下次可直接选择。"));
      } catch (error) { showError(`${field}-error`, error.message); }
      finally {
        presetSaving = false;
        syncConditionActions();
      }
    });
  }

  function selectedSolvents() {
    return [...$("editor-solvents").querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value);
  }

  function selectedPrecursors() {
    return [...$("editor-precursors").querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value);
  }

  function renderPrecursorChoices(chosen = selectedPrecursors()) {
    const aliases = new Set(chosen.map(canonicalPrecursor));
    const options = [...chosen, ...conditionValues("precursor").filter(value => !aliases.has(value))];
    $("editor-precursors").innerHTML = options.map(value =>
      `<div class="material-option"><label><input type="checkbox" value="${escape(value)}" ${chosen.includes(value) ? "checked" : ""}><span>${escape(canonicalPrecursor(value))}</span></label></div>`
    ).join("") || `<span class="muted">${t("尚未记录")}</span>`;
    $("editor-precursor").value = chosen.join(" + ");
  }
  $("editor-precursors").addEventListener("change", () => { $("editor-precursor").value = selectedPrecursors().join(" + "); });

  function materialAmountDraft() {
    return [...$("editor-solvents").querySelectorAll(".material-option")].map(row => ({name: row.querySelector('input[type="checkbox"]').value, amount: row.querySelector('input[type="number"]').value, unit: row.querySelector("select").value}));
  }

  function renderSolventChoices(chosen = selectedSolvents(), amounts = materialAmountDraft()) {
    const common = conditionValues("solvent");
    $("editor-solvents").innerHTML = [...new Set([...common, ...chosen])].map(value => {
      const selected = chosen.includes(value), item = amounts.find(item => item.name === value);
      const unitOptions = ["mL", "mmol", "g"].map(unit => `<option value="${unit}" ${item?.unit === unit ? "selected" : ""}>${unit}</option>`).join("");
      return `<div class="material-option"><label><input type="checkbox" value="${escape(value)}" ${selected ? "checked" : ""}><span>${escape(value)}</span></label><div class="material-amount" ${selected ? "" : "hidden"}><input type="number" min="0" step="any" value="${escape(item?.amount ?? "")}" placeholder="${t("添加量")}" aria-label="${escape(t("{name} 添加量", {name: value}))}" ${selected ? "" : "disabled"}><select aria-label="${escape(t("{name} 单位", {name: value}))}" ${selected ? "" : "disabled"}>${unitOptions}</select></div>${common.includes(value) ? `<button type="button" class="remove-preset" data-delete-solvent="${escape(value)}" title="${escape(t("从常用删除 {name}", {name: value}))}" aria-label="${escape(t("从常用删除 {name}", {name: value}))}" ${saving || materialSaving || presetSaving ? "disabled" : ""}>×</button>` : ""}</div>`;
    }).join("") || `<span class="muted">${t("尚未记录")}</span>`;
    $("editor-solvent").value = chosen.join(" + ");
  }
  $("editor-solvents").addEventListener("change", event => {
    if (event.target.type === "checkbox") {
      const area = event.target.closest(".material-option").querySelector(".material-amount");
      area.hidden = !event.target.checked;
      for (const input of area.querySelectorAll("input,select")) input.disabled = !event.target.checked;
    }
    $("editor-solvent").value = selectedSolvents().join(" + ");
  });
  $("editor-solvents").addEventListener("click", event => {
    const button = event.target.closest("[data-delete-solvent]");
    if (button) deleteConditionOption("solvent", button.dataset.deleteSolvent);
  });
  let materialSaving = false;
  for (const field of ["precursor", "solvent"]) {
    const precursor = field === "precursor";
    const selected = precursor ? selectedPrecursors : selectedSolvents;
    const renderChoices = precursor ? renderPrecursorChoices : renderSolventChoices;
    const add = $(`add-${field}`), save = $(`save-${field}`), cancel = $(`cancel-${field}`);
    const input = $(`new-${field}-name`), panel = $(`new-${field}-panel`), errorId = `${field}-error`;
    const closePanel = () => {
      panel.hidden = true;
      add.setAttribute("aria-expanded", "false");
      add.focus();
    };
    add.addEventListener("click", () => {
      panel.hidden = false;
      add.setAttribute("aria-expanded", "true");
      $(errorId).hidden = true;
      input.focus();
    });
    cancel.addEventListener("click", closePanel);
    input.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); save.click(); }
    });
    save.addEventListener("click", async () => {
      if (materialSaving || presetSaving || saving) return;
      const name = input.value.trim();
      if (!name || name.length > 250 || /[\u0000-\u001f]/.test(name)) return showError(errorId, "条件选项不能为空，最多 250 个字符，不能包含控制字符。");
      const key = precursor ? canonicalPrecursor(name) : name;
      const existing = selected().find(value => (precursor ? canonicalPrecursor(value) : value) === key) ?? conditionValues(field).find(value => value === key);
      const choice = existing ?? name;
      if (selected().length >= 20 && !selected().includes(choice)) return showError(errorId, precursor
        ? "请选择最多 20 项前驱体，每个名称最多 250 个字符。"
        : "请选择最多 20 项溶剂 / 配体，每个名称最多 250 个字符。");
      materialSaving = true;
      syncConditionActions();
      $(errorId).hidden = true;
      panel.setAttribute("aria-busy", "true");
      input.disabled = cancel.disabled = true;
      save.textContent = t("正在保存…");
      try {
        if (!existing) {
          try {
            await api("api/condition-options", {method: "POST", body: JSON.stringify({field, name})});
          } catch (error) {
            if (error.message !== "该名称已存在，请直接选择或使用其他名称。") {
              if (error.status && error.status < 500) throw error;
              const controller = new AbortController();
              const check = setTimeout(() => controller.abort(), 3000);
              const latest = await api("api/condition-options", {signal: controller.signal}).catch(() => null);
              clearTimeout(check);
              if (!latest?.condition_options?.[field]?.includes(name)) throw error;
            }
          }
          conditionOptions[field] = [...new Set([...(conditionOptions[field] || []), name])];
          loadVersion++;
        }
        renderChoices([...new Set([...selected(), choice])]);
        individualConditions.add(precursor ? "precursors" : "materials");
        dirty = true;
        input.value = "";
        closePanel();
      } catch (error) {
        showError(errorId, error.message);
      } finally {
        materialSaving = false;
        panel.setAttribute("aria-busy", "false");
        input.disabled = cancel.disabled = false;
        save.textContent = t("添加并选择");
        syncConditionActions();
        (panel.hidden ? add : input).focus();
      }
    });
  }

  function renderCatalogOptions() {
    const projectOptions = projects.map(project => `<option value="${escape(project.id)}">${escape(projectLabel(project.id))}</option>`).join("");
    const editorProject = $("editor-project").value;
    $("project-select").innerHTML = `<option value="">${t("全部项目")}</option>` + projectOptions;
    $("project-select").value = projectId;
    $("editor-project").innerHTML = projectOptions;
    $("editor-project").value = editorProject || projectId || "default";
    const kindOptions = kinds.map(kind => `<option value="${escape(kind)}">${escape(I18n.dataKind(kind, language))}</option>`).join("");
    for (const id of ["filter-kind", "upload-kind"]) {
      const select = $(id);
      if (!select) continue;
      const value = select.value;
      select.innerHTML = (id === "filter-kind" ? `<option value="">${t("全部类型")}</option>` : "") + kindOptions +
        (id === "filter-kind" ? `<option value="none">${t("未关联文件")}</option>` : "");
      select.value = kinds.includes(value) || (id === "filter-kind" && value === "none") ? value : id === "filter-kind" ? "" : kinds[0];
    }
    if ($("catalog-dialog").open) renderCatalogDialog();
  }

  function selectProject(value) {
    if (projectId !== value) { workspaceKey = ""; workspaceSample = ""; workspaceFile = ""; chartCondition = null; keyFilterState.clear(); keyFilterSignature = ""; }
    projectId = value;
    $("project-select").value = value;
    try { localStorage.setItem("catalog-project", value); } catch {}
    selected.clear();
    renderConditionOptions();
    render();
  }

  function renderCatalogDialog() {
    const isProject = catalogType === "projects";
    const isCategory = catalogType === "categories";
    $("catalog-title").textContent = t(isProject ? "新建项目" : "数据类别");
    $("catalog-help").textContent = t(isProject ? "每个项目分别管理实验编号、样品和数据。" : "类别用于标记附件，所有项目均可选择。");
    $("catalog-name-label").textContent = t(isProject ? "项目名称" : "类别名称");
    $("catalog-name").maxLength = 80;
    $("catalog-name").placeholder = t(isProject ? "例如 电催化 / 纳米材料" : "例如 Raman / UV-Vis");
    $("catalog-items").classList.toggle("category-manager", isCategory);
    $("catalog-items").innerHTML = isProject ? projects.map(project => `<button type="button" data-catalog-value="${escape(project.id)}">${escape(projectLabel(project.id))}</button>`).join("") :
      kinds.map(kind => `<div class="category-row"><button type="button" data-catalog-value="${escape(kind)}">${kindText(kind)}</button><small>${t("{count} 个附件", {count: categoryCount(kind)})}</small><button type="button" class="quiet danger" data-delete-category="${escape(kind)}" aria-label="${escape(t("删除 {kind}", {kind: I18n.dataKind(kind, language)}))}" ${kinds.length === 1 ? "disabled" : ""}>${t("删除")}</button></div>`).join("");
    $("category-delete-panel").hidden = !deletingCategory || !isCategory;
    if (deletingCategory && isCategory) {
      const count = categoryCount(deletingCategory), value = $("category-replacement").value;
      $("category-delete-title").textContent = t("删除 {kind}", {kind: I18n.dataKind(deletingCategory, language)});
      const trashed = categoryTrashed(deletingCategory);
      $("category-delete-help").textContent = (count ? t("该类别在所有项目（含归档）中共有 {count} 个附件。选择接收类别后删除，文件保留。", {count}) : t("该类别没有附件，删除后将从筛选和上传选项中移除。"))
        + (trashed ? " " + t("其中 {count} 个在回收站，也会改为接收类别。", {count: trashed}) : "");
      $("category-replacement-label").hidden = !count;
      $("category-replacement").innerHTML = `<option value="">${t("请选择接收类别")}</option>` + kinds.filter(kind => kind !== deletingCategory).map(kind => `<option value="${escape(kind)}">${escape(I18n.dataKind(kind, language))}</option>`).join("");
      $("category-replacement").value = value !== deletingCategory && kinds.includes(value) ? value : "";
    }
    if (catalogSaving) for (const control of $("catalog-form").querySelectorAll("button,input,select")) control.disabled = true;
  }

  // Server counts cover every project, archived records and the trash; the local fallback only sees active files.
  function categoryTrashed(kind) {
    return Number(categoryCounts?.[kind]?.trashed) || 0;
  }
  function categoryCount(kind) {
    const counted = categoryCounts?.[kind];
    if (counted) return (Number(counted.active) || 0) + (Number(counted.trashed) || 0);
    return records.reduce((sum, record) => sum + record.files.filter(file => file.kind === kind).length, 0);
  }

  function openCatalog(type, target) {
    catalogType = type;
    catalogTarget = target;
    deletingCategory = "";
    $("catalog-name").value = "";
    $("catalog-error").hidden = true;
    renderCatalogDialog();
    $("catalog-dialog").showModal();
    $("catalog-name").focus();
  }

  function chooseCatalogItem(value) {
    $(catalogTarget).value = value;
    if (catalogTarget === "project-select") selectProject(value);
    if (catalogTarget === "editor-project") changeEditorProject();
    if (catalogTarget.startsWith("editor-")) dirty = true;
    if (catalogTarget === "filter-kind") {
      if (workspaceView) workspaceKind = value;
      else dashboardTab = "records";
      render();
    }
    $("catalog-dialog").close();
    $(catalogTarget).focus();
  }

  $("catalog-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (catalogSaving) return;
    catalogSaving = true;
    $("save-catalog").disabled = true;
    $("catalog-error").hidden = true;
    renderCatalogDialog();
    try {
      const payload = {name: $("catalog-name").value};
      const result = await api(`api/${catalogType}`, {method: "POST", body: JSON.stringify(payload)});
      if (result.project) projects.push(result.project); else kinds.push(result.kind);
      renderCatalogOptions();
      chooseCatalogItem(result.project?.id || result.kind);
      toast(t(result.project ? "项目已添加。" : "数据类别已添加。"));
    } catch (error) { showError("catalog-error", error.message); }
    finally {
      catalogSaving = false;
      for (const control of $("catalog-form").querySelectorAll("button,input,select")) control.disabled = false;
      renderCatalogDialog();
    }
  });
  $("catalog-items").addEventListener("click", event => {
    if (catalogSaving) return;
    const remove = event.target.closest("[data-delete-category]");
    if (remove) {
      deletingCategory = remove.dataset.deleteCategory;
      $("category-replacement").value = "";
      $("catalog-error").hidden = true;
      renderCatalogDialog();
      (categoryCount(deletingCategory) ? $("category-replacement") : $("confirm-delete-category")).focus();
      const chosen = deletingCategory;
      load().then(() => { if (deletingCategory === chosen && $("catalog-dialog").open) renderCatalogDialog(); }).catch(() => {});
      return;
    }
    const button = event.target.closest("[data-catalog-value]");
    if (button && !catalogSaving) chooseCatalogItem(button.dataset.catalogValue);
  });
  $("cancel-delete-category").addEventListener("click", () => { deletingCategory = ""; renderCatalogDialog(); });
  $("confirm-delete-category").addEventListener("click", async () => {
    if (catalogSaving || !deletingCategory) return;
    const replacement = $("category-replacement").value;
    if (categoryCount(deletingCategory) && !replacement) return showError("catalog-error", "请选择其他类别接收附件。");
    catalogSaving = true;
    $("catalog-error").hidden = true;
    renderCatalogDialog();
    try {
      await api("api/categories", {method: "DELETE", body: JSON.stringify({name: deletingCategory, replacement})});
      deletingCategory = "";
      await load();
      if ($("detail").open) $("detail-content").querySelector(".files-list").innerHTML = (record => fileListHtml(record.files, !record.archived))(records.find(record => record.id === detailId));
      toast(t("类别已删除，附件文件完整保留。"));
    } catch (error) { showError("catalog-error", error.message); }
    finally {
      catalogSaving = false;
      for (const control of $("catalog-form").querySelectorAll("button,input,select")) control.disabled = false;
      renderCatalogDialog();
      if (!deletingCategory) $("catalog-name").focus();
    }
  });
  for (const id of ["close-catalog", "cancel-catalog"]) $(id).addEventListener("click", () => { if (!catalogSaving) $("catalog-dialog").close(); });
  $("catalog-dialog").addEventListener("cancel", event => { if (catalogSaving) event.preventDefault(); });
  $("project-select").addEventListener("change", event => selectProject(event.target.value));
  $("add-project").addEventListener("click", () => openCatalog("projects", "project-select"));
  $("editor-add-project").addEventListener("click", () => openCatalog("projects", "editor-project"));
  $("manage-categories").addEventListener("click", () => openCatalog("categories", "filter-kind"));

  function showError(id, message) {
    const target = $(id);
    target.dataset.error = message;
    target.textContent = I18n.translateError(message, language);
    target.hidden = false;
    target.scrollIntoView({block: "nearest"});
  }

  function addCondition(condition = {name: "", value: "", unit: ""}) {
    const row = document.createElement("div");
    row.className = "extra-row";
    row.innerHTML = `<input data-key="name" required maxlength="250" data-i18n-aria-label="自定义条件名称" data-i18n-placeholder="条件名称" value="${escape(condition.name)}"><input data-key="value" maxlength="250" data-i18n-aria-label="自定义条件值" data-i18n-placeholder="数值或内容" value="${escape(condition.value)}"><input data-key="unit" maxlength="250" data-i18n-aria-label="自定义条件单位" data-i18n-placeholder="单位" value="${escape(condition.unit)}"><button type="button" data-i18n-aria-label="移除此条件">×</button>`;
    I18n.apply(row, language);
    row.querySelector("button").addEventListener("click", () => { row.remove(); dirty = true; });
    $("extra-conditions").append(row);
  }

  function editorTemplateFields(values = {}) {
    const createField = field => {
      const value = values[field.key];
      const key = `data-template-value="${escape(field.key)}"`;
      const label = escape(fieldCaption(field)) + (field.required ? " *" : "");
      const input = field.type === "multi" || field.type === "single" ?
        `<select ${key} ${field.type === "multi" ? 'multiple size="4"' : ""}>${field.type === "single" ? `<option value="" data-i18n="尚未记录">${t("尚未记录")}</option>` : ""}${field.options.map(option => `<option ${(Array.isArray(value) ? value.includes(option) : value === option) ? "selected" : ""}>${escape(option)}</option>`).join("")}</select>` :
        `<input ${key} ${field.type === "number" ? 'type="number" step="any"' : 'maxlength="250"'} value="${escape(value)}">`;
      return `<label><span>${label}</span>${input}</label>`;
    };
    $("editor-template-info").textContent = editorTemplate ? `${editorTemplate.name} · v${editorTemplate.revision}` : "";
    for (const [section, id] of [["condition", "editor-template-conditions"], ["result", "editor-template-results"]]) {
      $(id).innerHTML = (editorTemplate?.fields || []).filter(field => field.section === section).map(createField).join("");
      I18n.apply($(id), language);
    }
    $("editor-template-section").hidden = !$("editor-template-conditions").children.length;
  }

  function editorParents(parentId = "") {
    const options = records.filter(row => row.project_id === editorLabProject && row.id !== editId && !isDatasetRecord(row))
      .sort((a, b) => compareExperimentNo(a.sample_id, b.sample_id));
    $("editor-parent").innerHTML = `<option value="" data-i18n="无来源样品">${t("无来源样品")}</option>` + options.map(row =>
      `<option value="${escape(row.id)}">${escape(row.sample_id)}${row.archived ? " · " + t("已归档") : ""}</option>`).join("");
    $("editor-parent").value = parentId;
  }

  function resetLabEditor(record, duplicate) {
    editorDataset = Boolean(record && !duplicate && isDatasetRecord(record));
    editorCopyFrom = duplicate && record?.template ? record.id : "";
    editorLabProject = $("editor-project").value;
    editorTemplate = editorDataset ? null : (record?.template || (!editId ? templates[editorLabProject] || null : null));
    $("editor-use-template-row").hidden = editorDataset || !editId || Boolean(record?.template) || !templates[editorLabProject];
    $("editor-use-template").checked = false;
    const details = record?.lab_data || {};
    const values = {...details.values};
    if (duplicate) for (const field of editorTemplate?.fields || []) if (field.section === "result") delete values[field.key];
    $("editor-lineage").hidden = editorDataset;
    editorTemplateFields(values);
    editorParents(duplicate ? "" : details.parent_id || "");
    $("editor-treatment").value = duplicate ? "" : details.treatment || "";
    $("editor-outcome").value = duplicate ? "" : details.outcome || "";
  }

  function applyEditorFields() {
    const project = $("editor-project").value || projectId || "default";
    for (const element of $("editor").querySelectorAll("[data-i18n]")) {
      const mapping = FIELD_TEXT_KEYS[element.dataset.i18n];
      if (!mapping) continue;
      const custom = builtinCustomLabel(project, mapping[0], language);
      element.textContent = custom ? t(mapping[1], {label: custom}) : t(element.dataset.i18n);
    }
    const wrappers = {precursor: $("editor-precursors")?.closest("fieldset"), temperature: document.querySelector('label[for="editor-temperature"]')?.parentElement,
      duration: document.querySelector('label[for="editor-duration"]')?.parentElement, materials: $("editor").querySelector(".solvent-field")};
    for (const [field, element] of Object.entries(wrappers)) if (element) element.hidden = !builtinEnabled(project, field);
  }

  function changeEditorProject() {
    if ($("editor-project").value === editorLabProject) return;
    const current = records.find(item => item.id === editId);
    if (current?.lab_data?.template_revision) {
      $("editor-project").value = editorLabProject;
      showError("form-error", "使用项目模板的样品不能移到其他项目。");
      return;
    }
    if (($("editor-parent").value || [...form.querySelectorAll("[data-template-value]")].some(input => input.value)) &&
        !confirm(t("切换项目会清空当前模板值和来源样品。继续吗？"))) {
      $("editor-project").value = editorLabProject;
      return;
    }
    editorLabProject = $("editor-project").value;
    applyEditorFields();
    editorCopyFrom = "";
    editorTemplate = editorDataset || editId ? null : templates[editorLabProject] || null;
    $("editor-use-template").checked = false;
    $("editor-use-template-row").hidden = editorDataset || !editId || !templates[editorLabProject];
    editorTemplateFields();
    editorParents();
    renderResultTags();
    updateSharedDraft();
  }
  $("editor-project").addEventListener("change", changeEditorProject);
  $("editor-use-template").addEventListener("change", () => {
    if (!$("editor-use-template").checked && [...form.querySelectorAll("[data-template-value]")].some(input => input.value) &&
        !confirm(t("切换模板会清空当前模板值。继续吗？"))) {
      $("editor-use-template").checked = true;
      return;
    }
    editorTemplate = $("editor-use-template").checked ? templates[editorLabProject] : null;
    editorTemplateFields();
  });

  function readLabEditor() {
    const values = {};
    for (const input of form.querySelectorAll("[data-template-value]")) {
      const value = input.multiple ? [...input.selectedOptions].map(option => option.value) : input.value.trim();
      if (value.length) values[input.dataset.templateValue] = input.type === "number" ? Number(value) : value;
    }
    return compactLabData({template_revision: editorTemplate?.revision || 0, values,
      parent_id: $("editor-parent").value, treatment: $("editor-treatment").value.trim(), outcome: $("editor-outcome").value});
  }

  function sharedConditionsUrl(project, number) {
    return "api/experiment-defaults?" + new URLSearchParams({project_id: project, experiment_no: number});
  }

  function editorSharedUrl() {
    const project = $("editor-project").value, sample = form.elements.namedItem("sample_id").value.trim();
    const number = form.elements.namedItem("experiment_no").value.trim() || inferredExperimentNo(sample);
    return project && number && !editorDataset && !records.find(row => row.id === editId)?.archived
      ? sharedConditionsUrl(project, canonicalExperimentNo(number, project).toLowerCase()) : "";
  }

  function prefillSharedConditions(defaults = {}) {
    if (!individualConditions.has("precursors")) renderPrecursorChoices(defaults.precursors || []);
    if (!individualConditions.has("temperature")) $("editor-temperature").value = defaults.temperature ?? "";
    if (!individualConditions.has("materials")) renderSolventChoices(defaults.materials?.solvents || [], defaults.materials?.material_amounts || []);
    renderNumericChoices();
    return (!individualConditions.has("precursors") && Boolean(defaults.precursors?.length)) ||
      (!individualConditions.has("temperature") && defaults.temperature != null) ||
      (!individualConditions.has("materials") && Boolean(defaults.materials?.solvents.length));
  }

  function renderSharedDraft() {
    const hint = $("editor-inherited-conditions");
    hint.hidden = !editorShared?.hint;
    hint.textContent = editorShared?.hint ? t(editorShared.hint) : "";
    $("editor-shared-conditions").hidden = !editorShared?.info?.token;
    if (!saving) $("save-record").textContent = t($("editor-share-conditions").checked ? "保存并更新共用条件" : "保存实验");
  }

  function updateSharedDraft() {
    const url = editorSharedUrl();
    if (editorShared?.url !== url) {
      if (editorShared?.info && !editId) prefillSharedConditions();
      editorShared = {url};
      $("editor-share-conditions").checked = false;
      renderSharedDraft();
    }
    if (!url) return null;
    const state = editorShared;
    if (!state.request) {
      state.request = api(url).then(result => {
        if (!form.isConnected || state !== editorShared || url !== editorSharedUrl() || !$("editor").open) {
          state.request = null;
          return null;
        }
        if (!result.conditions) return null;
        state.info = result;
        state.hint = !editId && prefillSharedConditions(result.conditions) ? "已预填本实验的共用条件，可以单独修改。" : "";
        renderSharedDraft();
        return result;
      }, () => {
        state.request = null;
        if (form.isConnected && state === editorShared && url === editorSharedUrl() && $("editor").open) {
          state.hint = "暂时无法读取本实验的共用条件。";
          renderSharedDraft();
        }
        return null;
      });
    }
    return state.request;
  }

  $("editor-share-conditions").addEventListener("change", renderSharedDraft);

  function edit(record = null, duplicate = false, experimentNo = "", targetProject = projectId || "default") {
    if ($("detail").open) $("detail").close();
    form.reset();
    for (const field of ["precursor", "solvent"]) {
      $(`new-${field}-panel`).hidden = true;
      $(`new-${field}-name`).value = "";
      $(`${field}-error`).hidden = true;
      $(`add-${field}`).setAttribute("aria-expanded", "false");
    }
    $("editor-project").value = record?.project_id || targetProject;
    editId = record && !duplicate ? record.id : null;
    editRevision = record && !duplicate ? record.revision : null;
    editorShared = null;
    individualConditions.clear();
    if (duplicate) for (const field of ["precursors", "temperature", "materials"]) individualConditions.add(field);
    editorTitle = duplicate ? "复制条件，新建实验" : editId ? "编辑实验" : experimentNo ? "添加样品" : "新建实验";
    $("editor-title").textContent = t(editorTitle);
    $("extra-conditions").innerHTML = "";
    $("form-error").hidden = true;
    for (const field of ["temperature", "duration"]) $(`${field}-error`).hidden = true;
    if (record) {
      for (const key of ["sample_id", "experiment_no", "series", "experiment_date", "status", "temperature", "duration", "solvent", "notes"]) {
        const input = form.elements.namedItem(key), value = record[key] ?? "";
        // Stored spellings (aliases of a configured name) must stay selectable, or saving would silently clear them.
        if (input.tagName === "SELECT" && value !== "" && ![...input.options].some(option => option.value === value)) input.add(new Option(value, value));
        input.value = value;
      }
      record.extra_conditions.forEach(addCondition);
      if (duplicate) {
        for (const key of ["sample_id", "experiment_no", "experiment_date", "notes"]) form.elements.namedItem(key).value = "";
        form.elements.namedItem("status").value = "待补全";
      }
    }
    setEditorSeries(record?.series || "");
    renderPrecursorChoices(record ? recordPrecursors(record) : []);
    renderSolventChoices(record ? recordSolvents(record) : [], record?.material_amounts || []);
    renderNumericChoices();
    setResultEditor(record && !duplicate ? record : null);
    resetLabEditor(record, duplicate);
    if (experimentNo) form.elements.namedItem("experiment_no").value = experimentNo;
    syncEditorNotes(true);
    dirty = false;
    applyEditorFields();
    $("editor").showModal();
    updateSharedDraft();
    form.elements.namedItem("sample_id").focus();
  }

  function closeEditor() {
    if (saving || materialSaving || presetSaving) return;
    if (!dirty || confirm(t("这条实验还有未保存的修改，确定放弃修改吗？"))) {
      dirty = false;
      $("editor").close();
    }
  }

  function syncEditorNotes(reset = false) {
    const original = form.elements.namedItem("notes").value;
    const translated = I18n.notesText(original, language);
    const preview = translated !== original;
    $("editor-notes-preview").textContent = translated;
    $("editor-notes-preview").hidden = !preview;
    $("editor-notes-help").hidden = !preview;
    $("editor-notes-original").querySelector("summary").hidden = !preview;
    if (!preview || reset) $("editor-notes-original").open = !preview;
  }

  function trackConditionDraft(event) {
    const input = event.target;
    if (input.matches("#editor-temperature")) individualConditions.add("temperature");
    else if (input.closest("#editor-precursors")) individualConditions.add("precursors");
    else if (input.closest("#editor-solvents") && input.matches("input,select")) individualConditions.add("materials");
  }
  form.addEventListener("input", event => {
    dirty = true;
    trackConditionDraft(event);
    if (event.target === form.elements.namedItem("notes")) syncEditorNotes();
  });
  form.addEventListener("change", event => {
    dirty = true;
    trackConditionDraft(event);
    if (event.target.matches("[name=sample_id],[name=experiment_no]")) updateSharedDraft();
  });

  async function persistRecord(payload) {
    try {
      const result = await api(editId ? `api/experiments/${editId}` : "api/experiments", {method: editId ? "PUT" : "POST", body: JSON.stringify(payload)});
      if (result.record) {
        if (result.condition_options) conditionOptions = result.condition_options;
        return result;
      }
      throw new Error("保存已提交，但未取得确认记录。请保留当前内容。");
    } catch (error) {
      // A response can be lost after commit; confirm identical content without retrying the write.
      if (payload.shared_token && error.status && error.status < 500) throw error;
      try {
        const latest = await api("api/experiments");
        if (latest.templates) templates = latest.templates;
        const record = latest.experiments.find(row => editId ? row.id === editId : row.project_id === payload.project_id && row.sample_id.toLowerCase() === payload.sample_id.trim().toLowerCase());
        if (record && recordMatchesPayload(record, payload)) {
          if (payload.shared_token) {
            const group = await api(sharedConditionsUrl(record.project_id, record.experiment_no));
            if (group.last_save !== `${payload.shared_token}:${record.id}`) throw error;
          }
          if (latest.condition_options) conditionOptions = latest.condition_options;
          return {record, records: payload.shared_token ? latest.experiments : [record]};
        }
      } catch {}
      throw error;
    }
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (saving || materialSaving || presetSaving) return;
    if (editorShared?.url !== editorSharedUrl()) updateSharedDraft();
    const payload = Object.fromEntries(new FormData(form));
    const date = document.createElement("input");
    date.type = "date";
    date.value = payload.experiment_date;
    if (date.value !== payload.experiment_date || (payload.experiment_date && !/^\d{4}-\d{2}-\d{2}$/.test(payload.experiment_date))) return showError("form-error", "实验日期格式应为 YYYY-MM-DD。");
    payload.series = editorSeriesValue();
    payload.precursors = selectedPrecursors();
    if (payload.precursors.length > 20) return showError("precursor-error", "请选择最多 20 项前驱体，每个名称最多 250 个字符。");
    payload.solvents = selectedSolvents();
    payload.material_amounts = materialAmountDraft().filter(item => payload.solvents.includes(item.name) && item.amount !== "").map(item => ({...item, amount: Number(item.amount)}));
    payload.ligand = "";
    for (const key of ["temperature", "duration"]) payload[key] = payload[key] === "" ? null : Number(payload[key]);
    payload.extra_conditions = [...$("extra-conditions").children].map(row => Object.fromEntries([...row.querySelectorAll("input")].map(input => [input.dataset.key, input.value])));
    for (const [field, id] of [["phases", "result-phase-input"], ["morphologies", "result-morphology-input"]]) {
      if ($(id).value.trim() && !addResultTag(field)) return;
    }
    syncResultConfirmation();
    payload.result_summary = {phases: resultDraft.phases.slice(), morphologies: resultDraft.morphologies.slice(), confirmation: $("result-confirmation").value,
      conclusion: $("result-conclusion").value, evidence_ids: [...$("result-evidence-options").querySelectorAll(":checked")].map(input => input.dataset.resultEvidence)};
    payload.lab_data = readLabEditor();
    if (!editId && !editorDataset && !payload.lab_data.template_revision) payload.lab_data.template_revision = 0;
    if (editorCopyFrom) payload.copy_from = editorCopyFrom;
    if (editId) payload.revision = editRevision;
    const currentGroup = editorShared?.url === editorSharedUrl() ? editorShared.info : null;
    if ($("editor-share-conditions").checked) {
      if (!currentGroup?.token) {
        updateSharedDraft();
        return showError("form-error", "请先读取本实验的共用条件。");
      }
      payload.shared_token = currentGroup.token;
    } else if (!editId && !currentGroup && !editorDataset) {
      // Save can be pressed before the default lookup returns. The server inherits omitted fields.
      if (!individualConditions.has("precursors") && !payload.precursors.length) {
        delete payload.precursor;
        delete payload.precursors;
      }
      if (!individualConditions.has("temperature") && payload.temperature === null) delete payload.temperature;
      if (!individualConditions.has("materials") && !payload.solvents.length) {
        for (const field of ["solvent", "solvents", "ligand", "material_amounts"]) delete payload[field];
      }
    }
    saving = true;
    $("language-switch").disabled = true;
    syncConditionActions();
    $("save-record").textContent = t("正在保存…");
    $("form-error").hidden = true;
    try {
      const result = await persistRecord(payload), saved = result.record;
      editId = saved.id;
      editRevision = saved.revision;
      loadVersion++;
      const updated = new Map((result.records || [saved]).map(record => [record.id, record]));
      records = [...updated.values(), ...records.filter(record => !updated.has(record.id))];
      dirty = false;
      renderConditionOptions();
      selectProject(payload.project_id);
      if (workspaceView) {
        workspaceKey = groupRecords(records).find(group => group.records.some(record => record.id === saved.id))?.key || "";
        workspaceSample = saved.id;
        render();
      }
      $("editor").close();
      openDetail(saved.id);
      toast(t(payload.shared_token ? "本实验的共用条件已保存。" : "实验已保存到本机。"));
    } catch (error) {
      showError("form-error", error.message);
      if (payload.shared_token && error.status === 409) {
        editorShared.request = null;
        editorShared.info = null;
        renderSharedDraft();
        updateSharedDraft();
      }
    } finally {
      saving = false;
      $("language-switch").disabled = false;
      syncConditionActions();
      renderSharedDraft();
    }
  });

  function syncBulkControls() {
    for (const control of $("bulk-form").querySelectorAll("button,input,select,textarea")) control.disabled = bulkBusy;
    for (const {field} of bulkActive) {
      const mode = $(`bulk-${field}-mode`).value, active = mode === "set" || mode === "append";
      $(`bulk-${field}-control`).hidden = !active;
      $(`bulk-${field}`).disabled = bulkBusy || !active;
    }
    $("preview-bulk").disabled = bulkBusy || !bulkActive.some(({field}) => $(`bulk-${field}-mode`).value);
    $("confirm-bulk").disabled = bulkBusy || !bulkPlan || !bulkPreview?.updated;
  }

  function bulkValue(field, value, unit) {
    if (typeof unit === "string" && typeof value === "number") return unit ? `${value} ${unit}` : `${value} (${t("无单位")})`;
    if (field === "confirmation") return t(({pending: "待确认", confirmed: "已确认"})[value] || "尚未记录结果");
    if (field === "status") return t(value);
    return Array.isArray(value) ? value.join(" / ") || "—" : value === null || value === "" ? "—" : String(value);
  }

  function bulkChangeLabel(field) {
    const keyed = bulkActive.find(entry => entry.key && keyFieldId(entry.key) === String(field).toLowerCase());
    if (keyed) return keyed.caption;
    if (String(field).startsWith("key:")) return String(field).split(":").slice(2).join(":");
    const item = bulkActive.find(entry => entry.field === field) || bulkFields.find(entry => entry.field === field);
    return item ? item.caption || t(item.label) : field;
  }

  // Review items name a built-in (translated) or a key field ("key:{section}:{label}", shown by its label).
  function workflowFieldLabel(field) {
    if (String(field).startsWith("key:")) return findKeyField(reviewItem?.project_id || projectId, String(field).toLowerCase())?.label || String(field).split(":").slice(2).join(":");
    return t(workflowFields[field] || field);
  }

  function renderBulkReview() {
    $("bulk-subtitle").textContent = t("已选择 {count} 条样品；保存前将逐条预览。", {count: bulkTargets.length});
    if (!bulkPreview) return;
    $("bulk-review-summary").textContent = t("将修改 {changed} / {total} 条样品；相同值不重复保存。", {changed: bulkPreview.updated, total: bulkTargets.length});
    $("bulk-review").innerHTML = bulkPreview.rows.map(row => `<section class="bulk-sample"><h3>${escape(row.sample_id)}<small>${escape(projectLabel(row.project_id))} · ${escape(row.experiment_no)}</small></h3>${row.changes.length ? `<table class="bulk-change-table"><thead><tr><th>${t("字段")}</th><th>${t("修改前")}</th><th>${t("修改后")}</th></tr></thead><tbody>${row.changes.map(change => `<tr><th scope="row">${escape(bulkChangeLabel(change.field))}</th><td>${escape(bulkValue(change.field, change.before, change.unit))}</td><td>${escape(bulkValue(change.field, change.after, change.unit))}</td></tr>`).join("")}</tbody></table>` : `<p class="field-help">${t("无变更")}</p>`}</section>`).join("");
  }

  function openBulkEditor() {
    const chosen = records.filter(record => selected.has(record.id));
    if (archived || !chosen.length || chosen.length > 500 || chosen.some(record => record.archived || isDatasetRecord(record))) return;
    bulkTargets = chosen.map(({id, revision}) => ({id, revision}));
    const chosenProjects = [...new Set(chosen.map(record => record.project_id))];
    const single = chosenProjects.length === 1 ? chosenProjects[0] : "";
    bulkActive = [...bulkFields.filter(item => !BUILTIN_OF[item.field] || chosenProjects.every(project => builtinEnabled(project, item.field)))
      .map(item => BUILTIN_OF[item.field] && single && builtinCustomLabel(single, item.field, language) ? {...item, caption: builtinCaption(single, item.field, language)} : item),
      ...(single ? keyFieldsOf(single).map((info, index) => ({field: `key${index}`, key: info, caption: info.label + (info.unit ? ` (${info.unit})` : ""),
        label: info.label, type: info.type === "multi" ? "list" : info.type === "single" ? "choice" : info.type, options: info.options || []})) : [])];
    bulkPlan = null; bulkPreview = null; bulkDirty = false;
    $("bulk-error").hidden = true;
    $("bulk-fields").innerHTML = bulkActive.map(({field, label, type, caption, key, options}) => {
      const choices = type === "status" ? ["待补全", "已记录", "待表征", "已完成"] : type === "confirmation" ? ["pending", "confirmed"] : type === "choice" ? options : [];
      const heading = caption ? `<label for="bulk-${field}">${escape(caption)}</label>` : `<label for="bulk-${field}" data-i18n="${escape(label)}">${escape(t(label))}</label>`;
      const clearable = !["status", "confirmation"].includes(type);
      const value = type === "choice" ? `<select id="bulk-${field}">${choices.map(value => `<option value="${escape(value)}">${escape(value)}</option>`).join("")}</select>`
        : choices.length ? `<select id="bulk-${field}">${choices.map(value => `<option value="${value}" data-i18n="${field === "confirmation" ? value === "pending" ? "待确认" : "已确认" : value}">${escape(bulkValue(field, value))}</option>`).join("")}</select>` : type === "list" || type === "textarea" ? `<textarea id="bulk-${field}" rows="${type === "list" ? 2 : 3}" ${type === "textarea" ? 'maxlength="2000"' : ""}></textarea>` : `<input id="bulk-${field}" type="${type}" ${type === "number" ? key ? 'step="any"' : `step="any" min="${field === "temperature" ? -273.15 : 0}" max="${field === "temperature" ? 2500 : 100000}"` : 'maxlength="250"'} list="bulk-${field}-options">`;
      const suggestions = key ? options : field === "precursors" ? conditionValues("precursor") : field === "solvents" ? conditionValues("solvent") : ["phases", "morphologies"].includes(field) ? [...new Set(records.flatMap(record => resultSummary(record)[field]))] : [];
      const datalist = ["temperature", "duration"].includes(field) ? `<datalist id="bulk-${field}-options">${conditionValues(field).map(value => `<option value="${escape(value)}"></option>`).join("")}</datalist>` : "";
      return `<section class="bulk-field"><div class="bulk-field-heading">${heading}<select id="bulk-${field}-mode" data-bulk-mode="${field}" aria-label="${escape(t("{field} 操作", {field: caption || t(label)}))}"><option value="" data-i18n="不修改">${t("不修改")}</option><option value="set" data-i18n="${type === "list" ? "替换" : "设为"}">${t(type === "list" ? "替换" : "设为")}</option>${type === "list" ? `<option value="append" data-i18n="追加">${t("追加")}</option>` : ""}${clearable ? `<option value="clear" data-i18n="清空">${t("清空")}</option>` : ""}</select></div><div id="bulk-${field}-control" hidden>${value}${datalist}${type === "list" ? `<p class="field-help" data-i18n="每行一个值，或点击已有值添加。">${t("每行一个值，或点击已有值添加。")}</p><div class="bulk-suggestions">${suggestions.map(value => `<button type="button" class="quiet" data-bulk-suggest="${field}" data-value="${escape(value)}">${escape(value)}</button>`).join("")}</div>` : ""}</div></section>`;
    }).join("");
    showBulkStep(false);
    renderBulkReview();
    $("bulk-editor").showModal();
  }

  function showBulkStep(review) {
    $("bulk-edit-step").hidden = review;
    $("bulk-review-step").hidden = !review;
    $("back-bulk").hidden = !review;
    $("preview-bulk").hidden = review;
    $("confirm-bulk").hidden = !review;
    syncBulkControls();
    $("bulk-editor").querySelector(".dialog-body").scrollTop = 0;
  }

  function closeBulkEditor() {
    if (bulkBusy || (bulkDirty && !confirm(t("批量编辑尚未保存，确定放弃吗？")))) return;
    bulkDirty = false;
    $("bulk-editor").close();
    $("bulk-edit").focus();
  }
  $("bulk-edit").addEventListener("click", openBulkEditor);
  for (const id of ["close-bulk", "cancel-bulk"]) $(id).addEventListener("click", closeBulkEditor);
  $("bulk-editor").addEventListener("cancel", event => { event.preventDefault(); closeBulkEditor(); });
  $("bulk-fields").addEventListener("input", () => { bulkDirty = true; bulkPlan = null; syncBulkControls(); });
  $("bulk-fields").addEventListener("change", () => { bulkDirty = true; bulkPlan = null; syncBulkControls(); });
  $("bulk-fields").addEventListener("click", event => {
    const button = event.target.closest("[data-bulk-suggest]");
    if (!button || bulkBusy) return;
    const input = $(`bulk-${button.dataset.bulkSuggest}`);
    input.value = [...new Set([...input.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean), button.dataset.value])].join("\n");
    bulkDirty = true; bulkPlan = null;
  });
  $("back-bulk").addEventListener("click", () => { if (!bulkBusy) { bulkPlan = null; $("bulk-error").hidden = true; showBulkStep(false); } });
  $("bulk-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (bulkBusy || !$("bulk-review-step").hidden) return;
    $("bulk-error").hidden = true;
    try {
      const changes = {}, keyChanges = [];
      for (const {field, type, key} of bulkActive) {
        const mode = $(`bulk-${field}-mode`).value;
        if (!mode) continue;
        let value = $(`bulk-${field}`).value.trim();
        if (mode !== "clear" && !value) throw new Error("请填写所选字段的新值；需要清空时请选择“清空”。");
        if (type === "number" && mode !== "clear") {
          value = Number(value);
          if (!Number.isFinite(value)) throw new Error(key ? "请填写有效的数值。" : "请填写有效的温度或时间。");
        }
        if (type === "list") value = [...new Set(value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
        if (key) {
          // Multi-choice key fields replace or append; the others set or clear.
          const keyMode = type === "list" && mode === "set" ? "replace" : mode;
          const change = mode === "clear" ? {section: key.section, label: key.label, mode} : {section: key.section, label: key.label, mode: keyMode, value};
          if (type === "number" && mode !== "clear") change.unit = key.unit || "";
          keyChanges.push(change);
          continue;
        }
        changes[field] = mode === "clear" ? {mode} : {mode, value};
      }
      if (keyChanges.length) changes.key_fields = keyChanges;
      if (!Object.keys(changes).length) throw new Error("请至少选择一个可批量修改的字段。");
      bulkBusy = true; syncBulkControls();
      const plan = {records: bulkTargets, changes, preview: true};
      bulkKeyInfos = new Map(bulkActive.filter(item => item.key).map(item => [keyFieldId(item.key), item.key]));
      const preview = await api("api/experiments/bulk", {method: "POST", body: JSON.stringify(plan)});
      bulkPlan = plan; bulkPreview = preview;
      renderBulkReview(); showBulkStep(true);
    } catch (error) { showError("bulk-error", error.message); }
    finally { bulkBusy = false; syncBulkControls(); }
  });
  $("confirm-bulk").addEventListener("click", async () => {
    if (bulkBusy || !bulkPlan || !bulkPreview?.updated) return;
    bulkBusy = true; syncBulkControls(); $("bulk-error").hidden = true;
    try {
      let response;
      try {
        response = await api("api/experiments/bulk", {method: "POST", body: JSON.stringify({...bulkPlan, preview: false})});
      } catch (error) {
        if (error.status && error.status < 500) throw error;
        // A lost response can follow a commit; read back without repeating the batch write.
        try {
          const latest = await api("api/experiments");
          const confirmed = bulkPreview.rows.every(row => {
            const record = latest.experiments.find(record => record.id === row.id);
            return record && record.revision === row.revision + (row.changes.length ? 1 : 0) && row.changes.every(change => {
              const keyInfo = String(change.field).startsWith("key:") ? bulkKeyInfos.get(String(change.field).toLowerCase()) || findKeyField(record.project_id, String(change.field).toLowerCase()) : null;
              const keyResult = keyInfo ? keyFieldValue(record, keyInfo) : null;
              const value = keyInfo ? (keyResult.present ? keyResult.value : null) : change.field === "solvents" ? materialSummary(record) : Object.hasOwn(resultSummary(record), change.field) ? resultSummary(record)[change.field] : record[change.field];
              return JSON.stringify(value) === JSON.stringify(change.after);
            });
          });
          if (confirmed) response = {records: latest.experiments.filter(record => bulkTargets.some(item => item.id === record.id)), condition_options: latest.condition_options};
        } catch {}
        if (!response) throw new Error("未能确认批量保存结果。请保留当前内容，关闭后刷新核对，勿重复提交。");
      }
      const replacements = new Map(response.records.map(record => [record.id, record]));
      loadVersion++;
      records = records.map(record => replacements.get(record.id) || record);
      if (response.condition_options) conditionOptions = response.condition_options;
      const count = bulkPreview.updated;
      bulkDirty = false;
      $("bulk-editor").close();
      renderConditionOptions(); render();
      toast(t("已批量更新 {count} 条样品。", {count}));
    } catch (error) {
      if (error.status === 409 || !error.status) bulkPlan = null;
      showError("bulk-error", error.message);
    } finally { bulkBusy = false; syncBulkControls(); }
  });

  function updateFileLabel() {
    if ($("upload-files")) $("file-selection").textContent = $("upload-files").files.length ? t("已选择 {count} 个文件", {count: $("upload-files").files.length}) : t("未选择文件");
  }

  function workflowValue(field, value) {
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return t("尚未记录");
    if (field === "project_id") return projectLabel(value);
    if (field === "status") return t(value);
    if (field === "archived") return t(value ? "已归档" : "未归档");
    if (field === "extra_conditions") return value.map(item => `${item.name}: ${item.value}${item.unit ? " " + item.unit : ""}`).join("\n");
    if (field === "result_summary") return [value.phases?.join(", "), value.morphologies?.join(", "), value.conclusion, value.confirmation ? t(value.confirmation === "confirmed" ? "已确认" : "待确认") : ""].filter(Boolean).join("\n") || t("尚未记录");
    if (Array.isArray(value)) return value.map(item => typeof item === "object" ? JSON.stringify(item) : item).join("\n");
    return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  }

  function changeTable(changes) {
    const valueCell = (field, value) => {
      const text = workflowValue(field, value), content = `<pre class="workflow-value">${escape(text)}</pre>`;
      return text.length > 500 ? `<details><summary>${escape(text.slice(0, 120))}… · ${t("查看全文")}</summary>${content}</details>` : content;
    };
    return changes.length ? `<table class="workflow-table workflow-changes"><thead><tr><th>${t("字段")}</th><th>${t("修改前")}</th><th>${t("修改后")}</th></tr></thead><tbody>${changes.map(change => `<tr><th scope="row">${escape(t(workflowFields[change.field] || change.field))}</th><td>${valueCell(change.field, change.before)}</td><td>${valueCell(change.field, change.after)}</td></tr>`).join("")}</tbody></table>` : `<p class="field-help">${t("无变更")}</p>`;
  }

  function workflowRows(rows) {
    return rows.map(row => `<section class="workflow-row"><h3>${escape(row.sample_id)}<small>${escape(projectLabel(row.project_id))}${row.reverted_by ? " · " + t("已撤销") : ""}</small></h3>${changeTable(row.changes)}</section>`).join("");
  }

  function workflowControls(busy) {
    workflowBusy = busy;
    for (const dialog of [$("history-dialog"), $("review-dialog")]) for (const control of dialog.querySelectorAll("button,input,textarea,select")) control.disabled = busy;
    if (reviewItem) $("review-value").disabled = busy || $("review-value-label").hidden;
  }

  function renderHistory() {
    $("history-more").hidden = Boolean(historyDetail) || !historyMore;
    $("preview-undo").hidden = !historyDetail || Boolean(undoPreview) || ["create", "undo"].includes(historyDetail?.action) || isImportBatch(historyDetail) || !historyDetail.rows.some(row => !row.reverted_by && (!historyRecord || row.id === historyRecord));
    $("confirm-undo").hidden = !undoPreview;
    $("undo-scope-label").hidden = !historyDetail || !historyRecord || Boolean(undoPreview) || $("preview-undo").hidden;
    $("history-back").textContent = t(historyDetail ? undoPreview ? "返回修改" : "返回历史" : "关闭");
    if (historyDetail) {
      $("history-subtitle").textContent = `${t(historyDetail.action === "import" && historyDetail.source === "import" ? "导入台账" : historyActions[historyDetail.action] || historyDetail.action)} · ${new Date(historyDetail.created_at).toLocaleString(language === "en" ? "en-US" : "zh-CN")}`;
      const rows = undoPreview ? undoPreview.rows : historyDetail.rows.filter(row => !historyRecord || $("undo-scope").value === "batch" || row.id === historyRecord);
      const note = historyDetail.action === "shared" ? `<p class="field-help">${t("撤销只恢复样品字段。要调整共用值，请在样品编辑器中重新设置。")}</p>` : "";
      $("history-content").innerHTML = note + (undoPreview ? `<p class="form-hint">${t("确认后恢复下列字段。后续修改有冲突时整批撤销取消。")}</p>` : "") + workflowRows(rows);
    } else {
      $("history-subtitle").textContent = historyRecord ? records.find(record => record.id === historyRecord)?.sample_id || "" : projectId ? projectLabel(projectId) : t("全部项目");
      $("history-content").innerHTML = historyBatches.length ? `<table class="workflow-table"><thead><tr><th>${t("时间")}</th><th>${t("操作")}</th><th>${t("样品数")}</th><th>${t("操作")}</th></tr></thead><tbody>${historyBatches.map(batch => `<tr><td>${escape(new Date(batch.created_at).toLocaleString(language === "en" ? "en-US" : "zh-CN"))}</td><td>${escape(t(batch.action === "import" && batch.source === "import" ? "导入台账" : historyActions[batch.action] || batch.action))}${!batch.remaining ? " · " + t("已撤销") : ""}</td><td>${batch.count}</td><td><button data-history-batch="${batch.id}">${t("查看变更")}</button>${isImportBatch(batch) ? ` <button data-archive-import="${escape(batch.id)}">${t("撤回这次导入（归档）")}</button>` : ""}</td></tr>`).join("")}</tbody></table>` : `<p class="empty">${t("尚无修改历史。")}</p>`;
      $("history-content").insertAdjacentHTML("beforeend", fileEventsHtml(historyFileEvents));
    }
  }

  const archiveSummary = result => t("已归档 {archived} 条导入的样品，保留 {kept} 条已修改的样品。", {archived: result.archived, kept: result.kept})
    + (result.already_archived ? " " + t("另有 {count} 条此前已归档。", {count: result.already_archived}) : "");
  const isImportBatch = batch => batch?.action === "import" && batch?.source === "import";
  async function archiveImportBatch(id) {
    if (!confirm(t("把这次导入的样品全部归档？导入后被修改过的样品会保留。归档的样品可以恢复。"))) return;
    workflowControls(true); $("history-error").hidden = true;
    try {
      const result = await api(`api/import/batches/${encodeURIComponent(id)}/archive`, {method: "POST", body: "{}"});
      await load();
      await loadHistory();
      toast(archiveSummary(result));
    } catch (error) { showError("history-error", error.message); }
    finally { workflowControls(false); }
  }

  const fileEventActions = {upload: "添加附件", rename: "重命名附件", recategorize: "更改附件类别", move: "移动附件",
    delete: "移到回收站", restore: "从回收站恢复", purge: "永久删除附件"};
  function fileEventDetail(event) {
    const before = event.before || {}, after = event.after || {};
    const sample = id => recordLabel(records.find(record => record.id === id) || {sample_id: id}, "sample_id");
    if (event.action === "rename") return `${before.name} → ${after.name}`;
    if (event.action === "recategorize") return `${after.name || before.name} · ${I18n.dataKind(before.kind, language)} → ${I18n.dataKind(after.kind, language)}`;
    if (event.action === "move") return `${after.name || before.name} · ${sample(before.record_id)} → ${sample(after.record_id)}`;
    return (after.name || before.name || "") + ((after.kind || before.kind) ? ` · ${I18n.dataKind(after.kind || before.kind, language)}` : "");
  }
  function fileEventsHtml(events) {
    if (!events.length) return "";
    const locale = language === "en" ? "en-US" : "zh-CN";
    return `<h3 class="history-files-heading">${t("附件操作")}</h3><p class="field-help">${t("附件操作只作记录，不在撤销范围内；移到回收站的附件可在回收站中恢复。")}</p>
      <table class="workflow-table"><thead><tr><th>${t("时间")}</th><th>${t("样品")}</th><th>${t("操作")}</th><th>${t("内容")}</th></tr></thead><tbody>${events.map(event => `<tr><td>${escape(new Date(event.created_at).toLocaleString(locale))}</td><td>${escape(event.sample_id || "")}</td><td>${escape(t(fileEventActions[event.action] || event.action))}</td><td>${escape(fileEventDetail(event))}</td></tr>`).join("")}</tbody></table>`;
  }

  async function loadHistory(more = false) {
    const offset = more ? historyOffset : 0;
    const result = await api(`api/history?record_id=${encodeURIComponent(historyRecord)}&project_id=${encodeURIComponent(historyRecord ? "" : projectId)}&offset=${offset}`);
    historyBatches = more ? [...historyBatches, ...result.batches] : result.batches;
    if (!more) historyFileEvents = Array.isArray(result.file_events) ? result.file_events : [];
    historyOffset = historyBatches.length; historyMore = result.has_more;
    renderHistory();
  }

  async function openHistory(recordId = "") {
    if (workflowBusy) return;
    if ($("detail").open) $("detail").close();
    historyRecord = recordId; historyDetail = null; undoPreview = null;
    $("history-error").hidden = true;
    $("history-content").textContent = t("正在读取…");
    $("history-dialog").showModal();
    workflowControls(true);
    try { await loadHistory(); } catch (error) { showError("history-error", error.message); }
    finally { workflowControls(false); }
  }

  $("history-view").addEventListener("click", () => openHistory());
  $("record-history").addEventListener("click", () => openHistory(detailId));
  $("history-content").addEventListener("click", async event => {
    const archiveImport = event.target.closest("[data-archive-import]");
    if (archiveImport && !workflowBusy) return archiveImportBatch(archiveImport.dataset.archiveImport);
    const button = event.target.closest("[data-history-batch]");
    if (!button || workflowBusy) return;
    workflowControls(true); $("history-error").hidden = true;
    try {
      historyDetail = await api(`api/history/${button.dataset.historyBatch}`);
      undoPreview = null; $("undo-scope").value = historyRecord ? "record" : "batch";
      renderHistory();
    } catch (error) { showError("history-error", error.message); }
    finally { workflowControls(false); }
  });
  $("undo-scope").addEventListener("change", () => { undoPreview = null; renderHistory(); });
  $("history-more").addEventListener("click", async () => {
    if (workflowBusy) return;
    workflowControls(true);
    try { await loadHistory(true); } catch (error) { showError("history-error", error.message); }
    finally { workflowControls(false); }
  });
  $("history-back").addEventListener("click", () => {
    if (workflowBusy) return;
    if (undoPreview) undoPreview = null;
    else if (historyDetail) historyDetail = null;
    else return $("history-dialog").close();
    $("history-error").hidden = true; renderHistory();
  });
  $("preview-undo").addEventListener("click", async () => {
    if (workflowBusy || !historyDetail) return;
    workflowControls(true); $("history-error").hidden = true;
    try {
      const payload = {preview: true};
      if (historyRecord && $("undo-scope").value === "record") payload.record_ids = [historyRecord];
      undoPreview = await api(`api/history/${historyDetail.id}/undo`, {method: "POST", body: JSON.stringify(payload)});
      undoPreview.recordIds = payload.record_ids;
      renderHistory();
    } catch (error) { showError("history-error", error.message); }
    finally { workflowControls(false); }
  });
  $("confirm-undo").addEventListener("click", async () => {
    if (workflowBusy || !undoPreview) return;
    const payload = {preview: false, revisions: undoPreview.revisions};
    if (undoPreview.recordIds) payload.record_ids = undoPreview.recordIds;
    workflowControls(true); $("history-error").hidden = true;
    try {
      await api(`api/history/${historyDetail.id}/undo`, {method: "POST", body: JSON.stringify(payload)});
      await load(); historyDetail = null; undoPreview = null; await loadHistory();
      toast(t("修改已撤销。"));
    } catch (error) {
      undoPreview = null; renderHistory();
      showError("history-error", error.status ? error.message : "撤销结果未确认，请重新打开历史核对。勿重复提交。");
    } finally { workflowControls(false); }
  });

  const reviewKinds = {conflict: "来源冲突", missing_conditions: "缺少实验条件", missing_data: "数据附件待补充", manual: "人工标记", folder_import: "文件导入待核对"};
  let reviewReturn = "";
  function syncReviewActions(record = records.find(record => record.id === reviewItem?.record_id)) {
    const outcome = $("review-outcome").value;
    const canApply = Boolean(reviewItem && record && !record.archived && ["precursor", "temperature", "duration", "solvents"].includes(reviewItem.field));
    const allowApply = canApply && outcome === "resolved";
    const applying = allowApply && $("review-apply").checked;
    $("review-apply").closest("label").hidden = !allowApply;
    $("review-value-label").hidden = !applying;
    $("review-value-title").textContent = t(["precursor", "solvents"].includes(reviewItem?.field) ? "确认值（每行一项）" : "确认值");
    $("review-value").disabled = workflowBusy || !applying;
    $("review-note-label").textContent = t(outcome === "dismissed" ? "处理说明（必填）" : "处理说明（可选）");
    $("preview-review").hidden = !applying || Boolean(reviewPlan);
    $("confirm-review").hidden = !reviewItem || (applying && !reviewPlan);
    const actions = {resolved: "确认已核对", dismissed: "确认暂不采用", pending: "重新打开"};
    $("confirm-review").textContent = t(applying ? "确认回填" : actions[outcome]);
    $("review-change-preview").hidden = !reviewPlan;
    return canApply;
  }

  function renderReviews() {
    const adding = Boolean(reviewAddRecord), detail = Boolean(reviewItem);
    const record = detail ? records.find(record => record.id === reviewItem.record_id) : null;
    const canApply = syncReviewActions(record);
    $("review-filters").hidden = detail || adding;
    $("review-add-form").hidden = !adding;
    $("review-decision").hidden = !detail || adding;
    $("review-edit-record").hidden = !detail || adding;
    $("review-back").textContent = t(detail || adding ? "返回清单" : "关闭");
    if (adding) { $("review-content").textContent = records.find(record => record.id === reviewAddRecord)?.sample_id || ""; return; }
    if (!detail) {
      const query = $("review-search").value.toLocaleLowerCase();
      const items = reviewItems.filter(item => (!projectId || item.project_id === projectId) && (!$("review-kind").value || item.kind === $("review-kind").value) && item.status === $("review-status").value &&
        [item.sample_id, item.experiment_no, t(item.title), item.kind === "folder_import" ? item.sources[0]?.value : ""].join(" ").toLocaleLowerCase().includes(query));
      $("review-subtitle").textContent = t("{count} 项待核对内容", {count: items.length});
      $("review-content").innerHTML = items.length ? `<table class="workflow-table"><thead><tr><th>${t("样品编号")}</th><th>${t("核对内容")}</th><th>${t("核对类型")}</th><th>${t("操作")}</th></tr></thead><tbody>${items.map(item => `<tr><td>${escape(item.sample_id)}<small class="field-help">${escape(projectLabel(item.project_id))}</small></td><td>${escape(t(item.title))}${item.missing?.length ? `<div class="field-help">${item.missing.map(field => escape(t(workflowFields[field] || field))).join(" · ")}</div>` : ""}</td><td>${t(reviewKinds[item.kind])}</td><td><button data-review-item="${item.id}">${t("核对")}</button></td></tr>`).join("")}</tbody></table>` : `<p class="empty">${t("当前筛选没有待核对项。")}</p>`;
      return;
    }
    if (reviewItem.kind === "folder_import" && !record) $("review-edit-record").hidden = true;
    $("review-subtitle").textContent = `${reviewItem.sample_id} · ${t(reviewItem.title)}`;
    const current = record && reviewItem.field ? `<section class="workflow-row"><h3>${t("当前记录")} · ${escape(workflowFieldLabel(reviewItem.field))}</h3><pre class="workflow-value">${escape(reviewItem.field === "solvents" ? materialSummary(record) : workflowValue(reviewItem.field, record[reviewItem.field]))}</pre></section>` : "";
    $("review-content").innerHTML = current + `<div class="review-source-grid">${reviewItem.sources.map((source, index) => `<figure class="review-source"><figcaption>${escape(t(source.label))}</figcaption>${source.source_id ? `<a href="api/review-sources/${source.source_id}" target="_blank" rel="noopener"><img src="api/review-sources/${source.source_id}" alt="${escape(source.label)}" loading="lazy"></a>` : ""}<p>${escape(workflowValue(reviewItem.field, source.value))}</p>${source.candidate && canApply ? `<button data-review-candidate="${index}">${t("采用此值")}</button>` : ""}</figure>`).join("")}</div>` + (record?.files.length ? `<details><summary>${t("当前附件")}</summary><ul class="files-list">${fileListHtml(record.files)}</ul></details>` : "") + (reviewItem.resolution ? `<p class="form-hint">${escape(reviewItem.resolution)}</p>` : "");
    $("review-edit-record").textContent = t(record ? "编辑样品" : "新建实验");
    if (reviewPlan) $("review-change-preview").innerHTML = changeTable(reviewPlan.preview.changes);
  }

  async function openReviews() {
    if (workflowBusy) return;
    if ($("detail").open) $("detail").close();
    reviewItem = null; reviewPlan = null; reviewAddRecord = ""; workflowDirty = false;
    reviewItems = [];
    $("review-error").hidden = true;
    renderReviews();
    $("review-content").textContent = t("正在读取…");
    if (!$("review-dialog").open) $("review-dialog").showModal();
    workflowControls(true);
    try { reviewItems = (await api("api/reviews")).items; renderReviews(); }
    catch (error) { showError("review-error", error.message); }
    finally { workflowControls(false); }
  }

  function showReview(id) {
    reviewItem = reviewItems.find(item => item.id === id);
    if (!reviewItem) return;
    reviewPlan = null; workflowDirty = false;
    $("review-apply").checked = false; $("review-value").value = ""; $("review-note").value = "";
    $("review-outcome").value = reviewItem.status === "pending" ? "resolved" : "pending";
    $("review-error").hidden = true; renderReviews();
  }

  $("review-view").addEventListener("click", openReviews);
  $("record-review").addEventListener("click", () => {
    if (workflowBusy) return;
    $("detail").close(); reviewItem = null; reviewPlan = null; reviewAddRecord = detailId; workflowDirty = false;
    const reviewProject = records.find(record => record.id === detailId)?.project_id;
    for (const option of $("review-add-field").options) if (BUILTIN_OF[option.value]) option.hidden = option.disabled = !builtinEnabled(reviewProject, option.value);
    if ($("review-add-field").selectedOptions[0]?.disabled) $("review-add-field").value = [...$("review-add-field").options].find(option => !option.disabled)?.value ?? "";
    $("review-add-form").reset(); $("review-error").hidden = true;
    $("review-dialog").showModal(); renderReviews(); $("review-add-title").focus();
  });
  for (const id of ["review-kind", "review-status", "review-search"]) $(id).addEventListener("input", renderReviews);
  $("review-content").addEventListener("click", event => {
    if (workflowBusy) return;
    const button = event.target.closest("[data-review-item]");
    if (button) return showReview(button.dataset.reviewItem);
    const candidate = event.target.closest("[data-review-candidate]");
    if (candidate) {
      const value = reviewItem.sources[Number(candidate.dataset.reviewCandidate)].value;
      $("review-value").value = Array.isArray(value) ? value.join("\n") : value ?? "";
      $("review-outcome").value = "resolved"; $("review-apply").checked = true;
      reviewPlan = null; workflowDirty = true; syncReviewActions();
      $("preview-review").focus();
    }
  });
  for (const id of ["review-decision", "review-add-form"]) $(id).addEventListener("input", () => {
    workflowDirty = true; reviewPlan = null;
    syncReviewActions();
  });
  $("review-back").addEventListener("click", () => {
    if (workflowBusy || (workflowDirty && !confirm(t("核对内容尚未保存，确定放弃吗？")))) return;
    if (reviewItem || reviewAddRecord) openReviews(); else $("review-dialog").close();
  });
  $("review-add-form").addEventListener("submit", async event => {
    event.preventDefault(); if (workflowBusy) return;
    workflowControls(true); $("review-error").hidden = true;
    try {
      await api("api/reviews", {method: "POST", body: JSON.stringify({record_id: reviewAddRecord, title: $("review-add-title").value, field: $("review-add-field").value, note: $("review-add-note").value})});
      workflowDirty = false; workflowControls(false); await openReviews(); toast(t("已添加待核对项。"));
    } catch (error) { showError("review-error", error.message); }
    finally { workflowControls(false); }
  });
  $("review-edit-record").addEventListener("click", () => {
    if (workflowBusy || !reviewItem || (workflowDirty && !confirm(t("核对内容尚未保存，确定放弃吗？")))) return;
    if (reviewItem.kind === "folder_import" && !reviewItem.record_id) return;
    reviewReturn = reviewItem.id; $("review-dialog").close();
    const record = records.find(record => record.id === reviewItem.record_id);
    edit(record || null, false, record ? "" : reviewItem.experiment_no, reviewItem.project_id);
    if (!record) form.elements.namedItem("sample_id").value = reviewItem.experiment_no;
  });
  $("editor").addEventListener("close", () => {
    if (!reviewReturn) return;
    const id = reviewReturn; reviewReturn = "";
    setTimeout(() => openReviews().then(() => showReview(id)), 0);
  });
  async function submitReview(preview) {
    if (workflowBusy || !reviewItem) return;
    const apply = !$("review-value-label").hidden;
    if (preview && (!apply || reviewPlan)) return;
    if (!preview && apply && !reviewPlan) return;
    const status = $("review-outcome").value, note = $("review-note").value;
    let value = null;
    if (status === "dismissed" && !note.trim()) {
      showError("review-error", "请填写处理说明。");
      $("review-note").focus();
      return;
    }
    if (preview) {
      value = $("review-value").value.trim();
      const numeric = ["temperature", "duration"].includes(reviewItem.field);
      if (!value || (numeric && !Number.isFinite(Number(value)))) {
        showError("review-error", "请填写确认值。");
        $("review-value").focus();
        return;
      }
      if (numeric) value = Number(value);
      if (["precursor", "solvents"].includes(reviewItem.field)) value = value.split("\n").map(value => value.trim()).filter(Boolean);
    }
    workflowControls(true); $("review-error").hidden = true;
    try {
      if (reviewItem.generated) {
        const stored = await api("api/reviews", {method: "POST", body: JSON.stringify({issue_id: reviewItem.id})});
        if (stored.revision !== 1) throw new Error("待核对项已变化，请刷新后再处理。");
        reviewItem = {...reviewItem, generated: false, revision: stored.revision};
      }
      const payload = reviewPlan?.payload || {revision: reviewItem.revision, record_revision: reviewItem.record_revision,
        record_id: reviewItem.record_id, status, note, apply_value: apply, value,
        // Automatic missing-condition items are decided for exactly the fields shown.
        ...(reviewItem.kind === "missing_conditions" ? {missing: Array.isArray(reviewItem.missing) ? reviewItem.missing : []} : {})};
      const result = await api(`api/reviews/${reviewItem.id}/decide`, {method: "POST", body: JSON.stringify({...payload, preview})});
      if (preview) {
        reviewPlan = {payload, preview: result};
        renderReviews();
        $("review-change-preview").scrollIntoView({block: "nearest"});
      } else {
        workflowDirty = false; reviewPlan = null;
        if (apply) await load().catch(() => {});
        workflowControls(false); await openReviews(); toast(t("核对处理已保存。"));
      }
    } catch (error) {
      reviewPlan = null; syncReviewActions();
      showError("review-error", preview || error.status ? error.message : "处理结果未确认，请返回清单核对。勿重复提交。");
    } finally {
      workflowControls(false);
      if (preview && reviewPlan) $("confirm-review").focus();
    }
  }
  $("preview-review").addEventListener("click", () => submitReview(true));
  $("confirm-review").addEventListener("click", () => submitReview(false));
  for (const [button, dialog] of [["close-history", "history-dialog"], ["close-review", "review-dialog"]]) {
    const close = () => { if (!workflowBusy && (dialog !== "review-dialog" || !workflowDirty || confirm(t("核对内容尚未保存，确定放弃吗？")))) { $(dialog).close(); workflowDirty = false; } };
    $(button).addEventListener("click", close);
    $(dialog).addEventListener("cancel", event => { event.preventDefault(); close(); });
  }

  function showSessionExpired() {
    sessionExpired = true;
    $("session-banner").hidden = false;
  }

  // Attachment changes answer with the authoritative records; merge them without reloading the catalog.
  // A response without them (older or partial server) falls back to a full reload.
  async function applyChangeResult(result, expected = []) {
    const changed = Array.isArray(result?.records) ? result.records.filter(record => record && typeof record.id === "string" && Array.isArray(record.files)) : [];
    if (Number.isInteger(result?.trash_count)) { trashCount = result.trash_count; renderTrashCount(); }
    // Every record whose file list changed (both sides of a move) must be present, otherwise reconcile by reloading.
    if (!changed.length || expected.some(id => !changed.some(record => record.id === id))) {
      await load();
    } else {
      const replacements = new Map(changed.map(record => [record.id, record]));
      records = records.map(record => replacements.get(record.id) || record);
      for (const [id, record] of replacements) if (!records.some(item => item.id === id)) records.push(record);
      render({keepWorkspaceControls: true});
    }
    if ($("detail").open && detailId && records.some(record => record.id === detailId)) openDetail(detailId);
  }

  function renderTrashCount() {
    $("trash-count").textContent = String(trashCount);
    $("trash-count").hidden = !trashCount;
  }

  const sampleName = record => recordLabel(record, "sample_id");
  // The dialog compares the draft with the values it showed when it was opened (or last refreshed) and submits the
  // revisions captured at that moment. A catalog refresh in the background therefore never turns an untouched field
  // into a change; if the record moved on, the server answers 409 and the dialog refreshes explicitly.
  let fileOriginal = null, fileSession = 0;
  const fileDraft = () => ({name: $("file-name").value.trim(), kind: $("file-kind").value, target: $("file-target").value});
  const fileDirty = () => Boolean($("file-dialog").open && fileOriginal && ["name", "kind", "target"].some(key => fileDraft()[key] !== fileOriginal[key]));
  function fillFileDialog(record, file, draft = null) {
    const original = {name: file.name, kind: file.kind, target: record.id, revisions: new Map()};
    const keep = key => draft && fileOriginal && draft[key] !== fileOriginal[key];
    $("file-dialog-subtitle").textContent = `${file.name} · ${sampleName(record)}`;
    $("file-name").value = keep("name") ? draft.name : file.name;
    $("file-kind").innerHTML = [...new Set([...kinds, file.kind])].map(kind => `<option value="${escape(kind)}" data-kind-label="${escape(kind)}">${escape(I18n.dataKind(kind, language))}</option>`).join("");
    $("file-kind").value = keep("kind") && kinds.includes(draft.kind) ? draft.kind : file.kind;
    const targets = records.filter(item => item.project_id === record.project_id && !item.archived)
      .sort((a, b) => compareExperimentNo(sampleName(a), sampleName(b)));
    $("file-target").innerHTML = targets.map(item => `<option value="${escape(item.id)}">${escape(sampleName(item))}${item.id === record.id ? " · " + escape(t("当前样品")) : ""}</option>`).join("");
    $("file-target").value = keep("target") && targets.some(item => item.id === draft.target) ? draft.target : record.id;
    for (const item of targets) original.revisions.set(item.id, item.revision);
    fileOriginal = original;
  }
  function openFileDialog(recordId, fileId) {
    const record = records.find(item => item.id === recordId), file = record?.files.find(item => item.id === fileId);
    if (!record || !file || record.archived) return;
    fileSession++;
    fileTarget = {recordId, fileId};
    fileOriginal = null;
    $("file-error").hidden = true;
    fillFileDialog(record, file);
    setFileBusy(false);
    $("file-dialog").showModal();
    $("file-name").focus();
  }
  function setFileBusy(busy) {
    fileSaving = busy;
    for (const id of ["file-name", "file-kind", "file-target", "save-file", "delete-file", "cancel-file", "close-file-dialog"]) $(id).disabled = busy;
  }
  function closeFileDialog({force = false} = {}) {
    if (fileSaving) return;
    if (!force && fileDirty() && !confirm(t("附件修改尚未保存，确定放弃吗？"))) return;
    fileSession++;
    fileTarget = null; fileOriginal = null;
    $("file-dialog").close();
  }
  // After a 409 the catalog is reloaded; the dialog shows the latest metadata and keeps only the user's own edits.
  // The dialog stays busy meanwhile, and a refresh that finishes after the dialog was closed or reopened is ignored.
  async function refreshFileDialogAfterConflict(error) {
    if (error.status !== 409 || !fileTarget) return;
    const draft = fileDraft(), session = fileSession;
    setFileBusy(true);
    try { await load(); } catch { if (session === fileSession) setFileBusy(false); return; }
    if (session !== fileSession) return;
    setFileBusy(false);
    const owner = records.find(record => record.files.some(file => file.id === fileTarget.fileId));
    const file = owner?.files.find(item => item.id === fileTarget.fileId);
    if (!owner || !file || owner.archived) {
      showError("file-error", "附件已被移动、删除或样品已归档，请关闭窗口后核对。");
      for (const id of ["save-file", "delete-file"]) $(id).disabled = true;
      return;
    }
    fileTarget = {recordId: owner.id, fileId: file.id};
    fillFileDialog(owner, file, draft);
    showError("file-error", "附件信息已在其他窗口更新，已显示最新内容并保留你的修改。请核对后再保存。");
  }
  $("detail-content").addEventListener("click", event => {
    const button = event.target.closest("[data-manage-file]");
    if (button && detailId) openFileDialog(detailId, button.dataset.manageFile);
  });
  $("save-file").addEventListener("click", async () => {
    if (fileSaving || !fileTarget) return;
    const record = records.find(item => item.id === fileTarget.recordId), file = record?.files.find(item => item.id === fileTarget.fileId);
    if (!record || !file) return closeFileDialog({force: true});
    const draft = fileDraft(), shown = fileOriginal;
    if (!draft.name) return showError("file-error", "请填写文件名。");
    const body = {record_revision: shown.revisions.get(shown.target)};
    if (draft.name !== shown.name) body.name = draft.name;
    if (draft.kind !== shown.kind) body.kind = draft.kind;
    if (draft.target !== shown.target) {
      if (!shown.revisions.has(draft.target)) return showError("file-error", "目标样品不存在，请刷新后重试。");
      Object.assign(body, {target_record_id: draft.target, target_revision: shown.revisions.get(draft.target)});
    }
    if (Object.keys(body).length === 1) return showError("file-error", "没有需要保存的修改。");
    $("file-error").hidden = true;
    setFileBusy(true);
    try {
      const result = await api(`api/files/${encodeURIComponent(file.id)}/update`, {method: "POST", body: JSON.stringify(body)});
      setFileBusy(false);
      closeFileDialog({force: true});
      await applyChangeResult(result, [shown.target, ...(body.target_record_id ? [body.target_record_id] : [])]);
      const moved = body.target_record_id && records.find(item => item.id === body.target_record_id);
      toast(moved ? t("附件已移到 {sample}。", {sample: sampleName(moved)}) : t("附件已更新。"));
    } catch (error) {
      setFileBusy(false);
      showError("file-error", error.message);
      await refreshFileDialogAfterConflict(error);
    }
  });
  $("delete-file").addEventListener("click", async () => {
    if (fileSaving || !fileTarget) return;
    const record = records.find(item => item.id === fileTarget.recordId), file = record?.files.find(item => item.id === fileTarget.fileId);
    if (!record || !file) return closeFileDialog({force: true});
    if (!confirm(t("把 {name} 移到回收站？附件会从样品中移除，可在“回收站”中恢复。", {name: file.name}))) return;
    setFileBusy(true);
    try {
      const shown = fileOriginal;
      const result = await api(`api/files/${encodeURIComponent(file.id)}/delete`, {method: "POST", body: JSON.stringify({record_revision: shown.revisions.get(shown.target)})});
      setFileBusy(false);
      closeFileDialog({force: true});
      await applyChangeResult(result, [shown.target]);
      toast(t("{name} 已移到回收站。", {name: file.name}));
    } catch (error) {
      setFileBusy(false);
      showError("file-error", error.message);
      await refreshFileDialogAfterConflict(error);
    }
  });
  for (const id of ["close-file-dialog", "cancel-file"]) $(id).addEventListener("click", () => closeFileDialog());
  $("file-dialog").addEventListener("cancel", event => { event.preventDefault(); closeFileDialog(); });

  const trashScopeValue = () => $("trash-all-projects").checked ? "" : projectId || "";
  function renderTrash() {
    const locale = language === "en" ? "en-US" : "zh-CN";
    const loading = trashScope === null;
    const scope = trashScope === null ? "" : trashScope ? projectLabel(trashScope) : t("全部项目");
    $("trash-subtitle").textContent = loading ? t("正在读取…") : t("{scope} · {count} 个附件 · {size}", {scope, count: trashItems.length, size: sizeText(trashTotal)});
    trashSelected = new Set([...trashSelected].filter(id => trashItems.some(item => item.id === id)));
    if (loading) {
      $("trash-content").textContent = t("正在读取…");
    } else {
      $("trash-content").innerHTML = trashItems.length ? `<table class="workflow-table trash-table"><thead><tr><th><span class="sr-only">${t("选择")}</span></th><th>${t("文件")}</th><th>${t("样品")}</th><th>${t("移入时间")}</th><th>${t("大小")}</th><th>${t("操作")}</th></tr></thead><tbody>${trashItems.map(item => {
        const id = escape(item.id), renaming = trashRenaming === item.id;
        const download = `<a class="button" href="api/files/${encodeURIComponent(item.id)}" download>${t("下载")}</a>`;
        const restore = item.record_archived ? `<span class="field-help">${t("样品已归档，请先恢复样品。")}</span>`
          : renaming ? `<div class="trash-rename"><input data-trash-name="${id}" maxlength="240" value="${escape(trashDrafts.get(item.id) ?? item.name)}" aria-label="${escape(t("恢复后的文件名"))}"><button data-trash-restore="${id}" class="primary">${t("确认恢复")}</button><button data-trash-cancel="${id}">${t("取消")}</button></div>`
          : `<button data-trash-restore="${id}">${t("恢复")}</button>${item.name_conflict ? `<small class="field-help">${t("原样品已有同名同类附件，恢复时需要改名。")}</small>` : ""}`;
        return `<tr><td><input type="checkbox" data-trash-select="${id}" ${trashSelected.has(item.id) ? "checked" : ""} aria-label="${escape(t("选择 {name}", {name: item.name}))}"></td>
          <td><span class="data-tag">${kindText(item.kind)}</span> <strong>${escape(item.name)}</strong></td><td>${escape(recordLabel(item, "sample_id"))}</td>
          <td>${escape(new Date(item.deleted_at).toLocaleString(locale))}</td><td>${sizeText(Number(item.size) || 0)}</td><td><div class="trash-actions">${restore}${download}</div></td></tr>`;
      }).join("")}</tbody></table>` : `<p class="empty">${t("回收站是空的。")}</p>`;
    }
    // Purging is only offered for rows of the scope that is actually shown.
    const ready = !trashBusy && !loading && trashScope === trashScopeValue();
    $("purge-selected").disabled = !ready || !trashSelected.size;
    $("purge-all").disabled = !ready || !trashItems.length;
    for (const control of $("trash-content").querySelectorAll("button,input")) control.disabled = trashBusy;
    $("trash-all-projects").disabled = trashBusy;
  }
  async function loadTrash() {
    const version = ++trashLoadVersion, scope = trashScopeValue();
    trashScope = null; renderTrash();
    let result;
    try { result = await api(`api/trash?project_id=${encodeURIComponent(scope)}`); }
    catch (error) { if (version === trashLoadVersion) throw error; return; }
    if (version !== trashLoadVersion) return;  // A newer scope was requested meanwhile.
    trashItems = Array.isArray(result.items) ? result.items.filter(item => typeof item?.id === "string") : [];
    trashTotal = Number(result.total_bytes) || 0;
    trashScope = scope;
    renderTrash();
  }
  async function trashAction(work) {
    if (trashBusy) return;
    trashBusy = true; $("trash-error").hidden = true; renderTrash();
    try { await work(); }
    catch (error) { showError("trash-error", error.message); if (error.status === 409) { try { await load(); } catch {} } }
    finally { trashBusy = false; try { await loadTrash(); } catch (error) { showError("trash-error", error.message); } }
  }
  async function openTrash() {
    trashSelected = new Set(); trashRenaming = ""; trashDrafts = new Map(); trashItems = []; trashTotal = 0; trashScope = null;
    $("trash-error").hidden = true;
    $("trash-dialog").showModal();
    try { await loadTrash(); } catch (error) { showError("trash-error", error.message); }
  }
  async function restoreTrashItem(id) {
    const item = trashItems.find(entry => entry.id === id);
    if (!item || trashBusy) return;
    if (item.name_conflict && trashRenaming !== id) {
      trashRenaming = id; renderTrash();
      $("trash-content").querySelector(`[data-trash-name="${id}"]`)?.focus();
      return;
    }
    const body = {};
    if (trashRenaming === id) {
      const input = $("trash-content").querySelector(`[data-trash-name="${id}"]`);
      if (input) trashDrafts.set(id, input.value);
      const name = (trashDrafts.get(id) ?? item.name).trim();
      if (!name) return showError("trash-error", "请填写文件名。");
      body.name = name;
    }
    await trashAction(async () => {
      const owner = () => records.find(record => record.id === item.record_id)?.revision;
      if (!Number.isInteger(owner())) await load();
      const result = await api(`api/trash/${encodeURIComponent(id)}/restore`, {method: "POST", body: JSON.stringify({record_revision: owner(), ...body})});
      trashRenaming = ""; trashDrafts.delete(id);
      await applyChangeResult(result);
      toast(t("{name} 已恢复到 {sample}。", {name: result.file?.name || body.name || item.name, sample: recordLabel(item, "sample_id")}));
    });
  }
  async function purge(ids) {
    const chosen = trashItems.filter(item => ids.includes(item.id));
    if (!chosen.length || trashScope === null || trashScope !== trashScopeValue()) return;
    const size = sizeText(chosen.reduce((sum, item) => sum + (Number(item.size) || 0), 0));
    if (!confirm(t("永久删除 {count} 个附件（{size}）？文件副本会从本机删除，此操作不能撤销。", {count: chosen.length, size}))) return;
    const scope = trashScope;
    await trashAction(async () => {
      const body = {file_ids: chosen.map(item => item.id), confirm: "purge", ...(scope ? {project_id: scope} : {})};
      const result = await api("api/trash/purge", {method: "POST", body: JSON.stringify(body)});
      trashSelected.clear();
      if (Number.isInteger(result.trash_count)) { trashCount = result.trash_count; renderTrashCount(); }
      const pending = Number(result.pending_bytes) || 0;
      toast(t("已永久删除 {count} 个附件，释放 {size}。", {count: result.purged, size: sizeText(Number(result.bytes) || 0)})
        + (pending ? " " + t("另有 {size} 暂时无法从磁盘删除，下次启动时会重试。", {size: sizeText(pending)}) : ""));
    });
  }
  $("trash-view").addEventListener("click", openTrash);
  $("trash-all-projects").addEventListener("change", () => {
    trashSelected.clear();
    loadTrash().catch(error => showError("trash-error", error.message));
  });
  $("trash-content").addEventListener("change", event => {
    const box = event.target.closest("[data-trash-select]");
    if (!box) return;
    if (box.checked) trashSelected.add(box.dataset.trashSelect); else trashSelected.delete(box.dataset.trashSelect);
    renderTrash();
  });
  $("trash-content").addEventListener("input", event => {
    const input = event.target.closest("[data-trash-name]");
    if (input) trashDrafts.set(input.dataset.trashName, input.value);
  });
  $("trash-content").addEventListener("click", event => {
    const restore = event.target.closest("[data-trash-restore]");
    if (restore) return restoreTrashItem(restore.dataset.trashRestore);
    const cancel = event.target.closest("[data-trash-cancel]");
    if (cancel) { trashDrafts.delete(cancel.dataset.trashCancel); trashRenaming = ""; renderTrash(); }
  });
  $("trash-content").addEventListener("keydown", event => {
    const input = event.target.closest("[data-trash-name]");
    if (input && event.key === "Enter" && !event.isComposing) { event.preventDefault(); restoreTrashItem(input.dataset.trashName); }
  });
  $("purge-selected").addEventListener("click", () => purge([...trashSelected]));
  $("purge-all").addEventListener("click", () => purge(trashItems.map(item => item.id)));
  const trashDirty = () => $("trash-dialog").open && [...trashDrafts.values()].some(Boolean);
  const closeTrash = () => {
    if (trashBusy || (trashDirty() && !confirm(t("恢复用的新文件名尚未提交，确定放弃吗？")))) return;
    trashLoadVersion++; trashDrafts.clear(); trashRenaming = "";
    $("trash-dialog").close();
  };
  for (const id of ["close-trash", "trash-close"]) $(id).addEventListener("click", closeTrash);
  $("trash-dialog").addEventListener("cancel", event => { event.preventDefault(); closeTrash(); });

  // ---- Project settings: built-in fields, key fields, phase presets (PUT api/projects/{id}/settings) ----
  const BUILTIN_ROWS = [["precursor", "前驱体"], ["temperature", "温度 / °C"], ["duration", "反应 / 取样时间 · min"], ["materials", "溶剂 / 配体"]];
  // The draft and its revision belong to settingsLoadedFor; saving is possible only after that project loaded.
  let settingsProject = "", settingsRevision = 0, settingsBusy = false, settingsDirty = false, settingsLoadedFor = "";
  function settingsTemplateFields(project) {
    const template = templates[project];
    return (template?.fields || []).filter(field => ["text", "number", "single", "multi"].includes(field.type));
  }
  function fillProjectSettings(entry) {
    const settings = entry?.settings || {}, builtin = settings.builtin || {};
    settingsRevision = Number.isInteger(entry?.revision) ? entry.revision : 0;
    $("settings-builtin").innerHTML = `<table class="workflow-table settings-table"><thead><tr><th>${t("使用")}</th><th>${t("字段")}</th><th>${t("中文名称")}</th><th>${t("英文名称")}</th></tr></thead><tbody>${BUILTIN_ROWS.map(([field, label]) => {
      const row = builtin[field] || {}, names = row.label || {};
      return `<tr><td><input type="checkbox" data-builtin-enabled="${field}" ${row.enabled === false ? "" : "checked"} aria-label="${escape(t("使用 {field}", {field: t(label)}))}"></td><td>${escape(t(label))}</td>
        <td><input data-builtin-label="${field}" data-lang="zh" maxlength="40" value="${escape(names.zh || "")}" placeholder="${escape(I18n.translate(label, "zh"))}" aria-label="${escape(t("{field} 中文名称", {field: t(label)}))}"></td>
        <td><input data-builtin-label="${field}" data-lang="en" maxlength="40" value="${escape(names.en || "")}" placeholder="${escape(I18n.translate(label, "en"))}" aria-label="${escape(t("{field} 英文名称", {field: t(label)}))}"></td></tr>`;
    }).join("")}</tbody></table>`;
    const configured = Array.isArray(settings.key_fields) ? settings.key_fields : [];
    const fields = settingsTemplateFields(settingsProject);
    const same = (a, b) => a.section === b.section && String(a.label).toLowerCase() === String(b.label).toLowerCase();
    const stale = configured.filter(entry => !fields.some(field => same(field, entry)));
    $("settings-key-fields").innerHTML = (fields.length ? `<table class="workflow-table settings-table"><thead><tr><th>${t("关键字段")}</th><th>${t("模板字段")}</th><th>${t("区域")}</th><th>${t("缺少时提示")}</th></tr></thead><tbody>${fields.map((field, index) => {
      const entry = configured.find(item => same(item, field));
      return `<tr><td><input type="checkbox" data-key-pick="${index}" ${entry ? "checked" : ""} aria-label="${escape(t("设为关键字段：{field}", {field: field.label}))}"></td><td>${escape(field.label)}${field.unit ? ` <small class="muted">${escape(field.unit)}</small>` : ""}</td>
        <td>${t(field.section === "result" ? "结果" : "条件")}</td><td><input type="checkbox" data-key-missing="${index}" ${entry?.check_missing ? "checked" : ""} ${entry ? "" : "disabled"} aria-label="${escape(t("缺少时提示：{field}", {field: field.label}))}"></td></tr>`;
    }).join("")}</tbody></table>` : `<p class="empty">${t("这个项目还没有实验模板。先在“实验模板”中添加字段，再回来选择关键字段。")}</p>`)
      + (stale.length ? `<p class="field-help">${escape(t("以下关键字段已不在当前模板中，保存时会移除：{fields}", {fields: stale.map(entry => entry.label).join("、")}))}</p>` : "");
    $("settings-phases").value = (Array.isArray(settings.phase_presets) ? settings.phase_presets : []).join("\n");
    settingsDirty = false;
    syncProjectSettingsControls();
  }
  function syncProjectSettingsControls() {
    for (const control of $("project-settings-dialog").querySelectorAll("button,input,select,textarea")) control.disabled = settingsBusy;
    $("save-project-settings").disabled = settingsBusy || !settingsProject || settingsLoadedFor !== settingsProject;
    if (settingsBusy) return;
    for (const box of $("settings-key-fields").querySelectorAll("[data-key-missing]")) {
      box.disabled = !$("settings-key-fields").querySelector(`[data-key-pick="${box.dataset.keyMissing}"]`).checked;
    }
    const picked = $("settings-key-fields").querySelectorAll("[data-key-pick]:checked").length;
    for (const box of $("settings-key-fields").querySelectorAll("[data-key-pick]")) if (!box.checked) box.disabled = picked >= 8;
  }
  function projectSettingsDraft() {
    const builtin = {};
    for (const [field] of BUILTIN_ROWS) {
      const label = {};
      for (const input of $("settings-builtin").querySelectorAll(`[data-builtin-label="${field}"]`)) label[input.dataset.lang] = input.value.trim();
      builtin[field] = {enabled: $("settings-builtin").querySelector(`[data-builtin-enabled="${field}"]`).checked, label};
    }
    const fields = settingsTemplateFields(settingsProject);
    const key_fields = [...$("settings-key-fields").querySelectorAll("[data-key-pick]:checked")].map(box => {
      const field = fields[Number(box.dataset.keyPick)];
      return {section: field.section, label: field.label, check_missing: $("settings-key-fields").querySelector(`[data-key-missing="${box.dataset.keyPick}"]`).checked};
    });
    const phase_presets = [...new Set($("settings-phases").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
    return {builtin, key_fields, phase_presets};
  }
  async function loadProjectSettings(project) {
    settingsProject = project; settingsLoadedFor = ""; settingsDirty = false;
    $("settings-project-name").value = projects.find(item => item.id === project)?.name || "";
    $("settings-builtin").textContent = t("正在读取…"); $("settings-key-fields").textContent = ""; $("settings-phases").value = "";
    $("project-settings-error").hidden = true;
    settingsBusy = true; syncProjectSettingsControls();
    try {
      const entry = await api(`api/projects/${encodeURIComponent(project)}/settings`);
      if (settingsProject !== project) return;
      fillProjectSettings(entry);
      settingsLoadedFor = project;
    } catch (error) {
      if (settingsProject === project) { $("settings-builtin").textContent = ""; $("settings-key-fields").textContent = ""; }
      throw error;
    } finally { if (settingsProject === project) { settingsBusy = false; syncProjectSettingsControls(); } }
  }
  async function openProjectSettings() {
    const project = projectId || projects[0]?.id || "default";
    $("settings-project").innerHTML = projects.map(item => `<option value="${escape(item.id)}">${escape(projectLabel(item.id))}</option>`).join("");
    $("settings-project").value = project;
    $("settings-builtin").textContent = t("正在读取…"); $("settings-key-fields").textContent = "";
    $("project-settings-dialog").showModal();
    try { await loadProjectSettings(project); } catch (error) { showError("project-settings-error", error.message); }
  }
  function closeProjectSettings() {
    if (settingsBusy || (settingsDirty && !confirm(t("项目设置尚未保存，确定放弃吗？")))) return;
    settingsDirty = false;
    $("project-settings-dialog").close();
  }
  $("project-settings-view").addEventListener("click", openProjectSettings);
  $("settings-project").addEventListener("change", async event => {
    const next = event.target.value;
    if (settingsDirty && !confirm(t("项目设置尚未保存，确定放弃吗？"))) { event.target.value = settingsProject; return; }
    try { await loadProjectSettings(next); } catch (error) { showError("project-settings-error", error.message); }
  });
  for (const type of ["input", "change"]) $("project-settings-dialog").addEventListener(type, event => {
    if (event.target.id === "settings-project" || event.target.id === "settings-project-name") return;
    settingsDirty = true;
    syncProjectSettingsControls();
  });
  $("save-project-settings").addEventListener("click", async () => {
    if (settingsBusy || settingsLoadedFor !== settingsProject) return;
    const draft = projectSettingsDraft(), project = settingsProject;
    if (draft.phase_presets.length > 20) return showError("project-settings-error", "物相预设最多 20 个。");
    if (draft.key_fields.length > 8) return showError("project-settings-error", "关键字段最多 8 个。");
    $("project-settings-error").hidden = true;
    settingsBusy = true; syncProjectSettingsControls();
    try {
      const entry = await api(`api/projects/${encodeURIComponent(project)}/settings`, {method: "PUT", body: JSON.stringify({settings: draft, revision: settingsRevision})});
      settingsBusy = false; settingsDirty = false;
      $("project-settings-dialog").close();
      try { await load(); } catch { configureProjects({...Object.fromEntries(PROJECT_SETTINGS), [project]: entry}); render(); }
      toast(t("项目设置已保存。"));
    } catch (error) {
      settingsBusy = false; syncProjectSettingsControls();
      showError("project-settings-error", error.message);
      if (error.status === 409) {
        // Another window saved first: show its settings instead of silently overwriting them.
        try { const latest = await api(`api/projects/${encodeURIComponent(project)}/settings`); if (settingsProject === project) { fillProjectSettings(latest); showError("project-settings-error", "项目设置已在其他窗口修改，已显示最新设置。请重新修改后保存。"); } } catch {}
      }
    }
  });
  for (const id of ["close-project-settings", "cancel-project-settings"]) $(id).addEventListener("click", closeProjectSettings);
  $("project-settings-dialog").addEventListener("cancel", event => { event.preventDefault(); closeProjectSettings(); });

  // ---- Catalog conventions in data/local-catalog.json (GET/PUT api/local-catalog) ----
  let conventionsRevision = "", conventionsBusy = false, conventionsDirty = false;
  // Aliases are edited as structured rows: a label and one alias per line, so names may contain "=" or commas.
  function aliasRowHtml(entry) {
    return `<div class="alias-row" data-alias-row>
      <label><span>${escape(t("显示名称"))}</span><input data-alias-label maxlength="250" value="${escape(entry.label || "")}"></label>
      <label><span>${escape(t("别名（每行一个）"))}</span><textarea data-alias-list rows="2" spellcheck="false">${escape((entry.aliases || []).join("\n"))}</textarea></label>
      <button type="button" class="quiet danger" data-remove-alias>${escape(t("删除"))}</button></div>`;
  }
  function renderAliasRows(entries) {
    $("conventions-aliases").innerHTML = (entries.length ? entries : [{label: "", aliases: []}]).map(aliasRowHtml).join("");
  }
  function readAliasRows() {
    const entries = [];
    for (const [index, row] of [...$("conventions-aliases").querySelectorAll("[data-alias-row]")].entries()) {
      const label = row.querySelector("[data-alias-label]").value.trim();
      const aliases = [...new Set(row.querySelector("[data-alias-list]").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
      if (!label && !aliases.length) continue;
      if (!label) throw new Error(t("第 {line} 组缺少显示名称。", {line: index + 1}));
      entries.push({label, aliases});
    }
    return entries;
  }
  function parseConventions() {
    const prefixes = [...new Set($("conventions-prefixes").value.split(/[\s,，、]+/).map(value => value.trim()).filter(Boolean))];
    const invalid = prefixes.find(prefix => !/^[A-Za-z]{1,20}$/.test(prefix));
    if (invalid) throw new Error(t("编号前缀只能包含 1–20 个英文字母：{prefix}", {prefix: invalid}));
    const precursor_aliases = readAliasRows();
    let translations = {};
    const source = $("conventions-translations").value.trim();
    if (source) {
      try { translations = JSON.parse(source); } catch { throw new Error(t("英文标签与备注译法不是有效的 JSON。")); }
      if (!translations || typeof translations !== "object" || Array.isArray(translations)) throw new Error(t("英文标签与备注译法应为 JSON 对象。"));
      for (const rule of Array.isArray(translations.noteRules) ? translations.noteRules : []) {
        try { new RegExp(rule?.pattern, rule?.flags || ""); } catch { throw new Error(t("备注规则不是有效的正则表达式：{pattern}", {pattern: String(rule?.pattern)})); }
      }
    }
    return {notebook_prefixes: prefixes, precursor_aliases, translations};
  }
  let conventionsBlocked = false;
  function fillConventions(result, {refresh = true} = {}) {
    const catalog = result?.catalog || {};
    // The service may have just accepted a repaired prefix set; refresh the grouping shown on the page.
    if (refresh && Array.isArray(result?.active_prefixes) && result.active_prefixes.map(String).sort().join(",") !== [...notebookPrefixes].sort().join(",")) {
      load().catch(() => {});
    }
    const unrepresentable = (Array.isArray(catalog.precursor_aliases) ? catalog.precursor_aliases : [])
      .some(entry => [entry.label, ...(entry.aliases || [])].some(value => /[\u0000-\u001f\u007f]/.test(String(value))))
      || (Array.isArray(catalog.notebook_prefixes) ? catalog.notebook_prefixes : []).some(prefix => !/^[A-Za-z]{1,20}$/.test(String(prefix)));
    conventionsBlocked = result?.error_kind === "unparsable" || (Boolean(result?.error) && result?.error_kind !== "prefix_conflict") || unrepresentable;
    if (result?.error) showError("conventions-error", result.error);
    else if (unrepresentable) showError("conventions-error", "有名称或别名包含换行等控制字符，无法在这里编辑。请先停止程序，手工修改 local-catalog.json。");
    conventionsRevision = typeof result?.revision === "string" ? result.revision : "";
    $("conventions-prefixes").value = (catalog.notebook_prefixes || []).join(", ");
    const aliasEntries = Array.isArray(catalog.precursor_aliases) ? catalog.precursor_aliases : [];
    renderAliasRows(aliasEntries);

    const translations = catalog.translations || {};
    $("conventions-translations").value = Object.keys(translations).some(key => Object.keys(translations[key] || {}).length) ? JSON.stringify(translations, null, 2) : "";
    conventionsDirty = false;
  }
  function syncConventionsControls() {
    for (const control of $("conventions-dialog").querySelectorAll("button,input,textarea")) control.disabled = conventionsBusy;
    if (!conventionsBusy && conventionsBlocked) {
      for (const control of $("conventions-dialog").querySelectorAll("input,textarea,#save-conventions,#add-alias-row,[data-remove-alias]")) control.disabled = true;
    }
  }
  async function openConventions() {
    $("conventions-error").hidden = true;
    $("conventions-dialog").showModal();
    conventionsBusy = true; syncConventionsControls();
    try { fillConventions(await api("api/local-catalog")); }
    catch (error) { showError("conventions-error", error.message); }
    finally { conventionsBusy = false; syncConventionsControls(); }
  }
  function closeConventions() {
    if (conventionsBusy || (conventionsDirty && !confirm(t("本地约定尚未保存，确定放弃吗？")))) return;
    conventionsDirty = false;
    $("conventions-dialog").close();
  }
  $("conventions-view").addEventListener("click", openConventions);
  $("add-alias-row").addEventListener("click", () => {
    if (conventionsBusy) return;
    $("conventions-aliases").insertAdjacentHTML("beforeend", aliasRowHtml({label: "", aliases: []}));
    conventionsDirty = true;
    $("conventions-aliases").lastElementChild.querySelector("[data-alias-label]").focus();
  });
  $("conventions-aliases").addEventListener("click", event => {
    const remove = event.target.closest("[data-remove-alias]");
    if (!remove || conventionsBusy) return;
    remove.closest("[data-alias-row]").remove();
    conventionsDirty = true;
  });
  for (const type of ["input", "change"]) $("conventions-dialog").addEventListener(type, () => { conventionsDirty = true; });
  $("save-conventions").addEventListener("click", async () => {
    if (conventionsBusy || conventionsBlocked) return;
    let catalog;
    try { catalog = parseConventions(); } catch (error) { return showError("conventions-error", error.message); }
    $("conventions-error").hidden = true;
    conventionsBusy = true; syncConventionsControls();
    try {
      const result = await api("api/local-catalog", {method: "PUT", body: JSON.stringify({catalog, revision: conventionsRevision})});
      fillConventions(result, {refresh: false});
      conventionsBusy = false;
      $("conventions-dialog").close();
      try { await load(); } catch {}
      toast(t(result?.publication_pending ? "本地约定已保存，local-catalog.json 将在文件可写时自动更新。" : "本地约定已保存。"));
    } catch (error) {
      conventionsBusy = false; syncConventionsControls();
      showError("conventions-error", error.message);
    }
  });
  for (const id of ["close-conventions", "cancel-conventions"]) $(id).addEventListener("click", closeConventions);
  $("conventions-dialog").addEventListener("cancel", event => { event.preventDefault(); closeConventions(); });

  // ---- Project rename (PUT api/projects/{id}) ----
  $("rename-project").addEventListener("click", async () => {
    const project = settingsProject, name = $("settings-project-name").value.trim();
    if (!project || settingsBusy) return;
    if (!name) return showError("project-settings-error", "请填写项目名称。");
    settingsBusy = true; syncProjectSettingsControls();
    try {
      await api(`api/projects/${encodeURIComponent(project)}`, {method: "PUT", body: JSON.stringify({name})});
      await load();
      $("settings-project").innerHTML = projects.map(item => `<option value="${escape(item.id)}">${escape(projectLabel(item.id))}</option>`).join("");
      $("settings-project").value = project;
      $("project-settings-error").hidden = true;
      toast(t("项目已改名为 {name}。", {name}));
    } catch (error) { showError("project-settings-error", error.message); }
    finally { settingsBusy = false; syncProjectSettingsControls(); }
  });

  // ---- Demo catalog (POST / DELETE api/demo) ----
  const currentDemo = () => demoProjectId === undefined ? (projects.some(project => project.id === "demo") ? "demo" : null) : demoProjectId;
  const demoExists = () => Boolean(currentDemo());
  async function createDemo() {
    const result = await api("api/demo", {method: "POST", body: "{}"});
    await load();
    return result;
  }
  $("demo-view").addEventListener("click", async () => {
    try {
      if (demoExists()) {
        if (!confirm(t("删除示例实验库？程序生成的示例样品和附件会永久删除；你自己添加的样品会保留。其他项目不受影响。"))) return;
        const demo = currentDemo();
        const result = await api("api/demo", {method: "DELETE", body: JSON.stringify({confirm: "delete-demo"})});
        if (projectId === demo && !result.project_kept) projectId = "default";
        await load();
        toast(result.project_kept && !result.kept_records
          ? t("已删除示例数据（{count} 条样品）。“{name}”中还有你添加的待核对事项，项目已保留，可以在项目设置里改名。", {count: result.deleted_records, name: projectLabel(demo)})
          : result.project_kept
          ? t("已删除示例数据（{count} 条样品）。你添加的 {kept} 条样品保留在“{name}”中，可以在项目设置里改名。", {count: result.deleted_records, kept: result.kept_records, name: projectLabel(demo)})
          : t("已删除示例实验库（{count} 条样品）。", {count: result.deleted_records}));
      } else {
        const result = await createDemo();
        selectProject(result.project_id || "demo");
        toast(t("已载入示例实验库：{count} 条虚构样品，可随时删除。", {count: result.records}));
      }
    } catch (error) { toast(I18n.translateError(error.message, language)); }
  });

  // ---- Onboarding wizard ----
  let onboardingStep = 0, onboardingBusy = false, onboardingShown = false;
  const ONBOARDING_STEPS = ["项目名称", "实验类型", "备份", "示例实验库"];
  function renderOnboarding() {
    for (const section of $("onboarding-dialog").querySelectorAll("[data-onboarding-step]")) section.hidden = Number(section.dataset.onboardingStep) !== onboardingStep;
    $("onboarding-step-label").textContent = t("第 {step} / {total} 步 · {name}", {step: onboardingStep + 1, total: ONBOARDING_STEPS.length, name: t(ONBOARDING_STEPS[onboardingStep])});
    $("onboarding-back").hidden = onboardingStep === 0;
    $("onboarding-next").textContent = t(onboardingStep === ONBOARDING_STEPS.length - 1 ? "完成" : "下一步");
    for (const control of $("onboarding-dialog").querySelectorAll("button,input")) control.disabled = onboardingBusy;
  }
  function openOnboarding() {
    onboardingShown = true; onboardingStep = 0;
    $("onboarding-error").hidden = true;
    $("onboarding-project-name").value = projectLabel(projects[0]?.id || "default");
    $("onboarding-demo").checked = false;
    renderOnboarding();
    $("onboarding-dialog").showModal();
    $("onboarding-project-name").focus();
  }
  async function markOnboardingDone() {
    try { await api("api/onboarding/done", {method: "POST", body: "{}"}); } catch {}
  }
  // Applies a preset to a project that has no template yet: the example template plus matching project settings.
  async function applyPreset(project, preset) {
    if (preset === "solution" || preset === "later") return false;
    const saved = PROJECT_SETTINGS.get(project);
    const settingsRevision = Number.isInteger(saved?.revision) ? saved.revision : 0;
    if (templates[project] || settingsRevision > 0) return true;  // kept as it is
    const template = exampleTemplate(preset);
    const fields = template.fields.filter(field => field.section === "condition").slice(0, 2);
    const off = preset === "film" ? ["precursor", "materials"] : [];
    const builtin = Object.fromEntries(["precursor", "temperature", "duration", "materials"].map(field => [field, {enabled: !off.includes(field), label: {zh: "", en: ""}}]));
    try {
      await api(`api/projects/${encodeURIComponent(project)}/preset`, {method: "POST", body: JSON.stringify({template,
        settings: {builtin, key_fields: fields.map(field => ({section: field.section, label: field.label, check_missing: false})), phase_presets: []},
        expected_template_revision: 0, expected_settings_revision: settingsRevision})});
    } catch (error) {
      if (error.status === 409) return true;  // configured in another window meanwhile: nothing was changed
      throw error;
    }
    return false;
  }
  async function finishOnboarding() {
    const project = projects[0]?.id || "default";
    const name = $("onboarding-project-name").value.trim();
    const preset = $("onboarding-dialog").querySelector('[name="onboarding-preset"]:checked')?.value || "solution";
    onboardingBusy = true; renderOnboarding(); $("onboarding-error").hidden = true;
    try {
      if (name && name !== projectLabel(project)) await api(`api/projects/${encodeURIComponent(project)}`, {method: "PUT", body: JSON.stringify({name})});
      const kept = await applyPreset(project, preset);
      if ($("onboarding-demo").checked && !demoExists()) await api("api/demo", {method: "POST", body: "{}"});
      await markOnboardingDone();
      onboardingBusy = false;
      $("onboarding-dialog").close();
      projectId = project;
      await load();
      toast(t(kept ? "设置完成。项目已有模板或设置，已原样保留。" : "设置完成，可以开始记录实验了。"));
      if ($("onboarding-backup").checked) openBackup();
    } catch (error) {
      onboardingBusy = false; renderOnboarding();
      showError("onboarding-error", error.message);
    }
  }
  $("onboarding-next").addEventListener("click", () => {
    if (onboardingBusy) return;
    if (onboardingStep === 0 && !$("onboarding-project-name").value.trim()) return showError("onboarding-error", "请填写项目名称。");
    $("onboarding-error").hidden = true;
    if (onboardingStep < ONBOARDING_STEPS.length - 1) { onboardingStep++; renderOnboarding(); return; }
    finishOnboarding();
  });
  $("onboarding-back").addEventListener("click", () => { if (!onboardingBusy && onboardingStep > 0) { onboardingStep--; renderOnboarding(); } });
  const skipOnboarding = async () => {
    if (onboardingBusy) return;
    $("onboarding-dialog").close();
    await markOnboardingDone();
  };
  for (const id of ["skip-onboarding", "close-onboarding"]) $(id).addEventListener("click", skipOnboarding);
  $("onboarding-dialog").addEventListener("cancel", event => { event.preventDefault(); skipOnboarding(); });

  // ---- Record import (api/import/records/*) ----
  let riUpload = null, riFile = null, riPreview = null, riBusy = false, riDirty = false, riBatch = null, riSheets = [];
  const IMPORT_GENERIC = {sample_id: ["编号", "样品", "sample", "id"], experiment_no: ["批次", "batch", "experiment"], duration: ["时间", "time"]};
  const IMPORT_GUESSES = {
    sample_id: ["样品编号", "sample id", "sampleid", "sample_id", "sample no", "sample number"],
    experiment_no: ["实验编号", "experiment no", "experiment number", "experiment_no", "batch no"],
    series: ["系列", "实验系列", "series"],
    experiment_date: ["日期", "实验日期", "date", "experiment date"],
    precursors: ["前驱体", "precursor", "precursors"],
    temperature: ["温度", "反应温度", "temperature", "temp"],
    duration: ["反应时间", "取样时间", "时长", "duration", "reaction time"],
    solvents: ["溶剂", "配体", "溶剂 / 配体", "溶剂/配体", "solvent", "solvents", "ligand", "ligands"],
    notes: ["备注", "说明", "notes", "note", "remarks", "comment"],
  };
  function importTargets(project) {
    const builtins = [["sample_id", t("样品编号（必填）")], ["experiment_no", t("实验编号")], ["series", t("实验系列")], ["experiment_date", t("实验日期")],
      ["precursors", builtinCaption(project, "precursor", language), "precursor"], ["temperature", builtinCaption(project, "temperature", language), "temperature"],
      ["duration", builtinCaption(project, "duration", language), "duration"], ["solvents", builtinCaption(project, "materials", language), "materials"], ["notes", t("备注")]]
      .filter(([, , field]) => !field || builtinEnabled(project, field)).map(([value, label]) => ({value, label}));
    const template = (templates[project]?.fields || []).map(field => ({value: `template:${field.key}`, label: t("模板：{field}", {field: field.label + (field.unit ? ` (${field.unit})` : "")}), field}));
    return [...builtins, ...template];
  }
  // Auto-mapping guesses only what is unambiguous: a header that is exactly a field name, or a field name followed by that
  // field's own unit ("温度 (°C)", "Reaction time / min"). Names ignore case; units compare exactly except the spellings
  // listed here. A column is guessed only when one field fits it and no other column fits that field; the rest is mapped
  // by hand.
  const UNIT_ALIASES = [["°C", "℃", "°c"], ["min", "Min", "mins", "minute", "minutes", "分钟"]];
  const BUILTIN_UNITS = {temperature: "°C", duration: "min"};
  const normHeader = value => String(value).replace(/（/g, "(").replace(/）/g, ")").replace(/\s+/g, " ").replace(/\s*([()\/])\s*/g, "$1").trim();
  const unitSpellings = unit => unit ? (UNIT_ALIASES.find(group => group.includes(unit)) || [unit]).map(normHeader) : [];
  function headerFits(header, names, units, withUnit) {
    const text = normHeader(header);
    // The unit suffix is removed exactly (case-sensitive) before the remaining name is compared without case.
    const bases = !withUnit ? [text] : (units.length ? units.flatMap(unit => [`(${unit})`, `/${unit}`]) : ["()"])
      .filter(suffix => text.length > suffix.length && text.endsWith(suffix)).map(suffix => text.slice(0, -suffix.length));
    return bases.some(base => names.some(name => base.toLowerCase() === normHeader(name).toLowerCase()));
  }
  function guessTargets(headers, targets) {
    // One pass: each column collects every field it fits by any rule (exact name, or name plus the field's unit). A
    // column is guessed only when it fits exactly one field and no other column fits that field.
    const options = targets.flatMap(target => {
      const names = target.field ? [target.field.label] : [...(IMPORT_GUESSES[target.value] || []), ...(IMPORT_GENERIC[target.value] || [])];
      const units = unitSpellings(target.field ? target.field.unit : BUILTIN_UNITS[target.value]);
      return names.length ? [{target: target.value, names, units}] : [];
    });
    const fits = headers.map(header => options.filter(option => headerFits(header, option.names, option.units, false) || headerFits(header, option.names, option.units, true)).map(option => option.target));
    return fits.map(list => list.length === 1 && fits.filter(other => other.includes(list[0])).length === 1 ? list[0] : "");
  }
  function renderImportMapping() {
    const box = $("ri-mapping");
    if (!riUpload) { box.innerHTML = ""; return; }
    const targets = importTargets($("ri-project").value);
    const previous = new Map([...box.querySelectorAll("[data-import-column]")].map(select => [select.dataset.importColumn, select.value]));
    const guesses = guessTargets(riUpload.columns, targets);
    box.innerHTML = `<table class="workflow-table import-mapping"><thead><tr><th>${t("表格列")}</th><th>${t("示例值")}</th><th>${t("导入到")}</th></tr></thead><tbody>${riUpload.columns.map((header, index) => {
      let value = previous.has(String(index)) ? previous.get(String(index)) : guesses[index];
      if (value && !value.startsWith("extra:") && !targets.some(item => item.value === value)) value = "";
      const samples = riUpload.rows.slice(0, 3).map(row => row[index] ?? "").filter(Boolean).join(" · ");
      const extra = `extra:${header}`;
      return `<tr><th scope="row">${escape(header)}</th><td class="muted">${escape(samples)}</td><td><select data-import-column="${index}" aria-label="${escape(t("{column} 导入到", {column: header}))}">
        <option value="">${escape(t("不导入"))}</option>${targets.map(item => `<option value="${escape(item.value)}" ${item.value === value ? "selected" : ""}>${escape(item.label)}</option>`).join("")}
        <option value="${escape(extra)}" ${value === extra ? "selected" : ""}>${escape(t("自定义条件：{name}", {name: header}))}</option></select></td></tr>`;
    }).join("")}</tbody></table>`;
  }
  function importMapping() {
    const mapping = {};
    for (const select of $("ri-mapping").querySelectorAll("[data-import-column]")) if (select.value) mapping[select.dataset.importColumn] = select.value;
    return mapping;
  }
  function checkImportMapping(mapping) {
    const values = Object.values(mapping);
    if (values.filter(value => value === "sample_id").length !== 1) return "请把一列导入到“样品编号”。";
    const single = values.filter(value => !value.startsWith("extra:"));
    if (new Set(single).size !== single.length) return "每个字段只能对应一列，请检查重复的选择。";
    return "";
  }
  function renderImportPreview() {
    const box = $("ri-preview");
    if (!riPreview) { box.innerHTML = ""; $("ri-summary").textContent = riUpload ? t("共 {count} 行。选择对应字段后点“预览”。", {count: riUpload.total_rows}) : ""; return; }
    const counts = riPreview.counts || {};
    $("ri-summary").textContent = t("预览：新建 {create} 条，跳过 {skip} 条，错误 {error} 条。", {create: counts.create || 0, skip: counts.skip || 0, error: counts.error || 0});
    const actions = {create: "新建", skip: "跳过", error: "错误"};
    const rows = [...riPreview.rows].sort((a, b) => Number(b.action === "error") - Number(a.action === "error") || a.row - b.row).slice(0, 300);
    box.innerHTML = `<table class="workflow-table import-preview"><thead><tr><th>${t("行")}</th><th>${t("样品编号")}</th><th>${t("结果")}</th><th>${t("说明")}</th></tr></thead><tbody>${rows.map(row => `<tr class="import-${escape(row.action)}"><td>${escape(row.row)}</td><td>${escape(row.sample_id || "")}</td><td>${escape(t(actions[row.action] || row.action))}</td><td>${escape((row.errors || []).map(error => I18n.translateError(error, language)).join("；"))}</td></tr>`).join("")}</tbody></table>`
      + (riPreview.rows.length > rows.length ? `<p class="field-help">${escape(t("只显示前 {count} 行，错误行排在最前。", {count: rows.length}))}</p>` : "");
  }
  function syncImportControls() {
    for (const control of $("records-import-dialog").querySelectorAll("button,input,select")) control.disabled = riBusy;
    if (riBusy) return;
    $("ri-preview-button").disabled = !riUpload || Boolean(riBatch);
    const counts = riPreview?.counts || {};
    $("ri-commit").disabled = !riPreview || Boolean(riBatch) || Boolean(counts.error) || !counts.create;
    $("ri-undo").hidden = !riBatch;
    $("ri-sheet-label").hidden = riSheets.length < 2;
  }
  function resetImport() {
    riUpload = null; riFile = null; riPreview = null; riDirty = false; riBatch = null; riSheets = [];
    $("ri-file").value = ""; $("ri-file-name").textContent = "";
    renderImportMapping(); renderImportPreview(); syncImportControls();
  }
  function openRecordsImport() {
    $("ri-project").innerHTML = projects.map(item => `<option value="${escape(item.id)}">${escape(projectLabel(item.id))}</option>`).join("");
    $("ri-project").value = projectId && projects.some(item => item.id === projectId) ? projectId : projects[0]?.id || "default";
    $("records-import-error").hidden = true;
    resetImport();
    $("records-import-dialog").showModal();
  }
  async function parseImportFile(sheet = "") {
    if (!riFile) return;
    riUpload = null; riPreview = null; riBatch = null;
    $("ri-mapping").innerHTML = ""; renderImportMapping(); renderImportPreview();
    riBusy = true; syncImportControls(); $("records-import-error").hidden = true;
    try {
      const query = new URLSearchParams({name: riFile.name, ...(sheet ? {sheet} : {})});
      riUpload = await api(`api/import/records/parse?${query}`, {method: "POST", body: riFile, headers: {"Content-Type": "application/octet-stream"}});
      riPreview = null; riDirty = true;
      riSheets = riUpload.sheets || [];
      $("ri-sheet").innerHTML = riSheets.map(name => `<option value="${escape(name)}" ${name === riUpload.sheet ? "selected" : ""}>${escape(name)}</option>`).join("");
      $("ri-mapping").innerHTML = "";
      renderImportMapping(); renderImportPreview();
    } catch (error) {
      showError("records-import-error", error.message);
      // The selected sheet failed; other sheets of the workbook may still be importable.
      riSheets = Array.isArray(error.payload?.sheets) ? error.payload.sheets : [];
      $("ri-sheet").innerHTML = riSheets.map(name => `<option value="${escape(name)}" ${name === error.payload?.sheet ? "selected" : ""}>${escape(name)}</option>`).join("");
    }
    finally { riBusy = false; syncImportControls(); }
  }
  async function runImport(commit) {
    const mapping = importMapping(), problem = checkImportMapping(mapping);
    if (problem) return showError("records-import-error", problem);
    const body = {upload_id: riUpload.upload_id, project_id: $("ri-project").value, mapping, existing: $("ri-existing").value};
    riBusy = true; syncImportControls(); $("records-import-error").hidden = true;
    try {
      if (!commit) {
        riPreview = await api("api/import/records/preview", {method: "POST", body: JSON.stringify(body)});
      } else {
        const result = await api("api/import/records/commit", {method: "POST", body: JSON.stringify({...body, token: riPreview.token})});
        riBatch = result.batch_id; riDirty = false;
        $("ri-summary").textContent = t("已导入 {created} 条样品，跳过 {skipped} 条。", {created: result.created, skipped: result.skipped});
        projectId = body.project_id;
        await load();
        toast(t("已导入 {created} 条样品。之后也可以在“修改历史”中撤回这次导入。", {created: result.created}));
      }
      if (!commit) renderImportPreview();
    } catch (error) {
      showError("records-import-error", error.message);
      if (commit && error.status === 409) riPreview = null;
      if (commit) renderImportPreview();
    } finally { riBusy = false; syncImportControls(); }
  }
  $("records-import-view").addEventListener("click", openRecordsImport);
  $("ri-choose").addEventListener("click", () => $("ri-file").click());
  $("ri-file").addEventListener("change", () => {
    riFile = $("ri-file").files[0] || null;
    $("ri-file-name").textContent = riFile ? `${riFile.name} · ${sizeText(riFile.size)}` : "";
    riUpload = null; riPreview = null; riBatch = null; riSheets = [];
    $("ri-mapping").innerHTML = ""; renderImportMapping(); renderImportPreview(); syncImportControls();
    if (riFile) parseImportFile();
  });
  $("ri-sheet").addEventListener("change", () => parseImportFile($("ri-sheet").value));
  for (const id of ["ri-project", "ri-existing"]) $(id).addEventListener("change", () => {
    riPreview = null; if (id === "ri-project") { $("ri-mapping").innerHTML = ""; renderImportMapping(); }
    renderImportPreview(); syncImportControls();
  });
  $("ri-mapping").addEventListener("change", () => { riPreview = null; riDirty = true; renderImportPreview(); syncImportControls(); });
  $("ri-preview-button").addEventListener("click", () => { if (!riBusy && riUpload) runImport(false); });
  $("ri-commit").addEventListener("click", () => { if (!riBusy && riPreview && !riBatch) runImport(true); });
  $("ri-undo").addEventListener("click", async () => {
    if (riBusy || !riBatch) return;
    if (!confirm(t("把这次导入的样品全部归档？导入后被修改过的样品会保留。归档的样品可以恢复。"))) return;
    riBusy = true; syncImportControls();
    try {
      const result = await api(`api/import/batches/${encodeURIComponent(riBatch)}/archive`, {method: "POST", body: "{}"});
      riBatch = null;
      await load();
      $("ri-summary").textContent = archiveSummary(result);
    } catch (error) { showError("records-import-error", error.message); }
    finally { riBusy = false; syncImportControls(); }
  });
  const closeRecordsImport = () => {
    if (riBusy || (riDirty && !confirm(t("导入尚未完成，确定关闭吗？")))) return;
    riDirty = false;
    $("records-import-dialog").close();
  };
  for (const id of ["close-records-import", "ri-cancel"]) $(id).addEventListener("click", closeRecordsImport);
  $("records-import-dialog").addEventListener("cancel", event => { event.preventDefault(); closeRecordsImport(); });

  const backupStale = status => {
    const time = Date.parse(status?.last?.time || "");
    return !Number.isFinite(time) || Date.now() - time > (status.stale_after_days || 7) * 864e5;
  };
  function renderBackupBadge() {
    const stale = Boolean(backupStatus) && backupStale(backupStatus);
    $("backup-badge").hidden = !stale;
    $("backup-badge").title = stale ? t(backupStatus.last ? "距上次备份已超过 {days} 天" : "尚未备份", {days: backupStatus.stale_after_days || 7}) : "";
  }
  function renderBackup() {
    const status = backupStatus || {state: "idle"}, last = status.last;
    const locale = language === "en" ? "en-US" : "zh-CN";
    $("backup-last").textContent = last
      ? t("上次备份：{time} · {kind} · {files} 个附件，{size}", {time: new Date(last.time).toLocaleString(locale),
        kind: t(last.kind === "folder" ? "文件夹" : "ZIP 下载"), files: last.files, size: sizeText(last.bytes || 0)}) + (last.path ? " · " + last.path : "")
      : t("这台电脑上还没有完成过备份。");
    const running = status.state === "running" || backupStarting;
    $("backup-progress").hidden = !running && !["done", "failed"].includes(status.state);
    $("backup-bar").max = Math.max(status.total_bytes || 0, 1);
    $("backup-bar").value = status.state === "done" ? $("backup-bar").max : status.done_bytes || 0;
    let message = "";
    if (backupStarting || status.phase === "prepare") message = t("正在检查备份文件夹和数据库…");
    else if (running && status.phase === "database") message = t("正在写入数据库快照…");
    else if (running) message = t("正在复制：{done} / {total} 个文件 · {copied} / {size}", {done: status.done_files, total: status.total_files,
      copied: sizeText(status.done_bytes || 0), size: sizeText(status.total_bytes || 0)});
    else if (status.state === "done") message = t("备份完成：新复制 {count} 个文件（{size}）。", {count: status.copied_files, size: sizeText(status.copied_bytes || 0)});
    $("backup-progress-text").textContent = message;
    if (status.state === "failed" && status.error) showError("backup-error", status.error);
    for (const id of ["backup-path", "backup-verify", "start-backup"]) $(id).disabled = running;
    $("backup-zip").classList.toggle("disabled", running);
    $("backup-zip").setAttribute("aria-disabled", String(running));
    renderBackupBadge();
  }
  async function pollBackup() {
    clearTimeout(backupTimer); backupTimer = null;
    try { backupStatus = await api("api/backup/status"); }
    catch (error) { showError("backup-error", error.message); return; }
    renderBackup();
    if (backupStatus.state === "running") backupTimer = setTimeout(pollBackup, 800);
  }
  function openBackup() {
    $("backup-error").hidden = true;
    if (!$("backup-path").value) $("backup-path").value = backupStatus?.folder || "";
    $("backup-dialog").showModal();
    renderBackup();
    pollBackup();
  }
  $("backup-view").addEventListener("click", openBackup);
  $("open-backup").addEventListener("click", openBackup);
  $("start-backup").addEventListener("click", async () => {
    if (backupStarting || backupStatus?.state === "running") return;
    const path = $("backup-path").value.trim();
    if (!path) return showError("backup-error", "请填写备份文件夹的完整路径。");
    $("backup-error").hidden = true; backupStarting = true; renderBackup();
    try {
      backupStatus = await api("api/backup/folder", {method: "POST", body: JSON.stringify({path, verify: $("backup-verify").checked})});
    } catch (error) {
      showError("backup-error", error.message);
    } finally { backupStarting = false; }
    renderBackup();
    if (backupStatus?.state === "running") backupTimer = setTimeout(pollBackup, 500);
  });
  $("backup-zip").addEventListener("click", event => {
    if (backupStarting || backupStatus?.state === "running") return event.preventDefault();
    toast(t("正在生成 ZIP，完成后浏览器会开始下载；请勿重复点击。"));
  });
  // A running backup keeps polling after the dialog closes so the close guard and badge stay accurate.
  const closeBackup = () => {
    if (backupStatus?.state !== "running") { clearTimeout(backupTimer); backupTimer = null; }
    $("backup-dialog").close();
  };
  $("close-backup").addEventListener("click", closeBackup);
  $("backup-done").addEventListener("click", closeBackup);
  $("backup-dialog").addEventListener("cancel", event => { event.preventDefault(); closeBackup(); });

  function fileListHtml(files, manage = false) {
    return files.map(file => `<li><span class="data-tag ${file.kind === "NMR" ? "nmr" : ""}">${kindText(file.kind)}</span><div class="file-meta"><strong>${escape(file.name)}</strong><small>${sizeText(file.size)} · SHA-256 ${escape(file.sha256.slice(0, 12))}…</small>${file.source ? `<small>${text("来源副本：")}${escape(file.source)}</small>` : ""}</div>${manage ? `<button type="button" class="quiet" data-manage-file="${escape(file.id)}">${text("管理")}</button>` : ""}<a class="button" href="api/files/${file.id}" download>${text("下载")}</a></li>`).join("") || `<li class="muted">${text("尚未关联数据文件。")}</li>`;
  }

  function openDetail(id) {
    detailId = id;
    const record = records.find(item => item.id === id);
    if (!record) return;
    $("detail-title").textContent = recordLabel(record, "sample_id");
    const builtinKeys = {"前驱体": "precursor", "温度 / °C": "temperature", "反应 / 取样时间 · min": "duration", "溶剂 / 配体": "materials"};
    const fields = [["实验项目", projectLabel(record.project_id)], ["实验编号", record.experiment_no || record.sample_id], ["前驱体", record.precursor], ["温度 / °C", record.temperature], ["反应 / 取样时间 · min", record.duration],
      ["溶剂 / 配体", materialSummary(record)], ["实验日期", record.experiment_date]].filter(([name]) => !builtinKeys[name] || builtinEnabled(record.project_id, builtinKeys[name]));
    const keyHtml = keyFieldsOf(record.project_id).map(info => `<div class="key-field-row"><dt>${escape(info.label)}</dt><dd>${display(keyFieldText(keyFieldValue(record, info)))}</dd></div>`).join("");
    const fieldHtml = fields.map(([name, value]) => `<div><dt>${builtinKeys[name] && builtinCustomLabel(record.project_id, builtinKeys[name], language) ? escape(builtinCaption(record.project_id, builtinKeys[name], language)) : text(name)}</dt><dd ${name === "实验项目" ? 'id="detail-project"' : ""}>${display(value)}</dd></div>`).join("") + keyHtml +
      record.extra_conditions.map(item => `<div><dt>${escape(item.name)}</dt><dd>${display(item.value === "" ? "" : item.value + (item.unit ? " " + item.unit : ""))}</dd></div>`).join("");
    $("detail-content").innerHTML = `<div class="detail-meta">${statusTag(record.status)}<span id="detail-series">${escape(recordLabel(record, "series") || t("未分类"))}</span>${record.archived ? text("已归档 · 可恢复") : ""}</div>
      <dl class="detail-grid">${fieldHtml}${templateValuesHtml(record, "condition")}</dl>${lineageHtml(record)}
      <section class="detail-section"><div class="workspace-section-heading"><h3>${text("结果摘要")}</h3><button type="button" class="quiet" data-edit-result="${record.id}">${text("编辑结果")}</button></div><div id="detail-result-content">${resultHtml(record)}</div></section>
      <section class="detail-section"><h3>${text("实验观察与备注")}</h3><div class="notes" id="detail-notes"></div><details id="detail-notes-original" class="notes-original" hidden><summary>${text("查看原文")}</summary><div class="notes">${escape(record.notes)}</div></details></section>
      <section class="detail-section"><h3>${text("数据附件")} <span class="muted">${record.files.length}</span></h3>
      <ul class="files-list">${fileListHtml(record.files, !record.archived)}</ul>
      <div class="upload-box"><div><label for="upload-kind">${text("数据类别")}</label><div class="select-with-action"><select id="upload-kind"></select><button type="button" id="add-upload-kind" class="icon-button" aria-label="${escape(t("新增类别"))}" data-i18n-aria-label="新增类别" title="${escape(t("新增类别"))}" data-i18n-title="新增类别"><svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg></button></div></div><div class="file-picker"><button type="button" id="choose-files">${text("选择文件")}</button><span id="file-selection"></span><input id="upload-files" type="file" multiple hidden></div><button id="upload-button" class="primary" data-i18n="添加文件">${t("添加文件")}</button></div>
      <p class="field-help">${text("文件将复制到本机 data 文件夹，原文件保持原样。单个文件上限 256 MB；文件夹请先压缩为 ZIP。")}</p><p id="upload-error" class="inline-error" role="alert" hidden></p></section>
      <p class="field-help">${text("最近修改：")}<time id="updated-time" datetime="${escape(record.updated_at)}">${escape(new Date(record.updated_at).toLocaleString(language === "en" ? "en-US" : "zh-CN"))}</time> · ${text("附件校验值用于核对文件内容。")}</p>`;
    $("archive-record").textContent = t(record.archived ? "恢复记录" : "归档记录");
    $("upload-button").addEventListener("click", upload);
    $("choose-files").addEventListener("click", () => $("upload-files").click());
    $("upload-files").addEventListener("change", updateFileLabel);
    $("add-upload-kind").addEventListener("click", () => openCatalog("categories", "upload-kind"));
    renderDetailNotes(record);
    renderCatalogOptions();
    updateFileLabel();
    if (!$("detail").open) $("detail").showModal();
  }

  async function upload() {
    const files = [...$("upload-files").files];
    if (!files.length) return showError("upload-error", "请先选择数据文件。");
    if (files.some(file => file.size === 0 || file.size > 256 * 1024 * 1024)) return showError("upload-error", "请选择非空文件，且每个文件不超过 256 MB。");
    const id = detailId, kind = $("upload-kind").value;
    const shownRecord = records.find(record => record.id === id);
    const identity = shownRecord ? {project_id: shownRecord.project_id, sample_id: shownRecord.sample_id} : {};
    uploading = true;
    for (const key of ["upload-button", "upload-files", "upload-kind", "add-upload-kind", "choose-files", "language-switch"]) $(key).disabled = true;
    $("upload-error").hidden = true;
    for (const button of $("detail").querySelectorAll(".detail-actions button")) button.disabled = true;
    let completed = 0;
    const errors = [];
    try {
      for (const file of files) {
        $("upload-button").textContent = `${completed + errors.length + 1} / ${files.length}…`;
        try {
          await api(`api/experiments/${id}/files?${new URLSearchParams({name: file.name, kind, ...identity})}`, {method: "POST", body: file, headers: {"Content-Type": "application/octet-stream"}});
          completed++;
        } catch (error) { errors.push(`${file.name}: ${I18n.translateError(error.message, language)}`); }
      }
      await load();
      openDetail(id);
      if (errors.length) showError("upload-error", t("已保存 {count} 个文件。", {count: completed}) + " " + errors.join("; "));
      else toast(t("已保存 {count} 个文件副本。", {count: completed}));
    } catch (error) {
      showError("upload-error", t("文件处理已结束，但列表刷新失败。") + " " + I18n.translateError(error.message, language));
    } finally {
      uploading = false;
      for (const key of ["upload-button", "upload-files", "upload-kind", "add-upload-kind", "choose-files", "language-switch"]) $(key).disabled = false;
      $("upload-button").textContent = t("添加文件");
      for (const button of $("detail").querySelectorAll(".detail-actions button")) button.disabled = false;
    }
  }

  const templateTypes = {text: "文本", number: "数值", single: "单选", multi: "多选"};
  function templateFieldRow(field = {}) {
    const row = document.createElement("div");
    row.className = "template-row";
    row.innerHTML = `<div class="form-grid">
      <label>${text("字段名称")}<input data-field="label" maxlength="80" required value="${escape(field.label)}"></label>
      <label>${text("字段用途")}<select data-field="section"><option value="condition" data-i18n="实验条件"></option><option value="result" data-i18n="实验结果"></option></select></label>
      <label>${text("字段类型")}<select data-field="type">${Object.entries(templateTypes).map(([type, label]) => `<option value="${type}" data-i18n="${label}"></option>`).join("")}</select></label>
      <label data-field-toggle="unit">${text("单位")}<input data-field="unit" maxlength="32" value="${escape(field.unit)}"></label>
      <label class="span-two" data-field-toggle="options">${text("选项（每行一个）")}<textarea data-field="options" rows="3" maxlength="2450">${escape(field.options?.join("\n"))}</textarea></label>
      </div><div class="lab-actions template-row-footer"><label class="lab-check"><input data-field="required" type="checkbox" ${field.required ? "checked" : ""}>${text("必填")}</label>
      <button type="button" class="quiet" data-template-remove data-i18n="移除字段"></button></div>`;
    row.querySelector('[data-field="type"]').value = field.type || "text";
    row.querySelector('[data-field="section"]').value = field.section || "condition";
    I18n.apply(row, language);
    $("template-fields").append(row);
    toggleTemplateInputs(row);
    return row;
  }

  function toggleTemplateInputs(row) {
    const kind = row.querySelector('[data-field="type"]').value;
    row.querySelector('[data-field-toggle="unit"]').hidden = kind !== "number";
    row.querySelector('[data-field-toggle="options"]').hidden = !["single", "multi"].includes(kind);
  }

  function editTemplateDraft(template) {
    $("template-name").value = template?.name || "";
    $("template-fields").replaceChildren();
    for (const field of template?.fields || []) templateFieldRow(field);
  }

  function readTemplateDraft() {
    const fields = [...$("template-fields").children].map(row => {
      const get = key => row.querySelector(`[data-field="${key}"]`);
      return {label: get("label").value, section: get("section").value, type: get("type").value,
        unit: get("unit").value, options: get("options").value.split("\n").map(value => value.trim()).filter(Boolean),
        required: get("required").checked};
    });
    return {name: $("template-name").value, fields};
  }

  function exampleTemplate(kind) {
    const field = (label, type, section = "condition", unit = "", options = [], required = true) =>
      ({label: t(label), type, section, unit, options: options.map(option => t(option)), required});
    return kind === "powder" ? {
      name: t("粉体合成"),
      fields: [field("前驱体名称", "text"), field("合成气氛", "single", "condition", "", ["空气", "氮气", "氩气"]),
        field("退火温度", "number", "condition", "°C"), field("粒径", "number", "result", "nm", [], false)],
    } : {
      name: t("薄膜沉积"),
      fields: [field("基底", "single", "condition", "", ["玻璃", "硅片", "金属箔"]), field("沉积功率", "number", "condition", "W"),
        field("沉积时间", "number", "condition", "min"), field("膜厚", "number", "result", "nm")],
    };
  }

  $("manage-template").addEventListener("click", () => {
    if (!projectId || !loaded) return toast(t("请先选择一个具体项目。"));
    templateProject = projectId; templateRevision = templates[projectId]?.revision || 0;
    $("template-error").hidden = true;
    $("template-project").textContent = projectLabel(projectId);
    $("template-file").value = "";
    $("export-template").disabled = !templateRevision;
    editTemplateDraft(templates[projectId]);
    templateDirty = false;
    $("template-dialog").showModal();
  });
  $("template-form").addEventListener("input", event => {
    if (event.target.id !== "template-file") templateDirty = true;
  });
  $("template-form").addEventListener("change", event => {
    if (event.target.dataset.field === "type") toggleTemplateInputs(event.target.closest(".template-row"));
  });
  $("template-form").addEventListener("click", event => {
    const remove = event.target.closest("[data-template-remove]");
    const example = event.target.closest("[data-template-example]");
    if (remove) { remove.closest(".template-row").remove(); templateDirty = true; }
    if (example && (!templateDirty || confirm(t("替换当前模板草稿吗？")))) {
      editTemplateDraft(exampleTemplate(example.dataset.templateExample)); templateDirty = true;
    }
  });
  $("add-template-field").addEventListener("click", () => {
    if ($("template-fields").children.length >= 30) return showError("template-error", "模板最多支持 30 个字段。");
    templateFieldRow().querySelector("input").focus();
    templateDirty = true;
  });
  $("read-template").addEventListener("click", () => $("template-file").click());
  $("template-file").addEventListener("change", async () => {
    const file = $("template-file").files[0];
    $("template-file").value = "";
    if (!file || (templateDirty && !confirm(t("替换当前模板草稿吗？")))) return;
    try {
      if (file.size > 512 * 1024) throw new Error();
      const data = JSON.parse(await file.text());
      if (data.schema !== "experiment-data-catalog/template-v1" || typeof data.name !== "string" ||
          !Array.isArray(data.fields) || data.fields.length > 30 || data.fields.some(field => !field ||
          typeof field.label !== "string" || !["condition", "result"].includes(field.section) ||
          !Object.hasOwn(templateTypes, field.type) || typeof field.required !== "boolean" ||
          typeof field.unit !== "string" || !Array.isArray(field.options) || field.options.some(option => typeof option !== "string"))) throw new Error();
      editTemplateDraft(data); templateDirty = true;
      $("template-error").hidden = true;
    } catch { showError("template-error", "无法读取模板文件，请选择本工具导出的 JSON 模板。"); }
  });
  $("export-template").addEventListener("click", () => {
    const {name, fields} = templates[templateProject];
    const url = URL.createObjectURL(new Blob([JSON.stringify({schema: "experiment-data-catalog/template-v1", name, fields}, null, 2)], {type: "application/json"}));
    const link = document.createElement("a");
    link.href = url; link.download = "experiment-template.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  function closeTemplate() {
    if (!templateSaving && (!templateDirty || confirm(t("放弃未保存的模板修改吗？")))) {
      templateDirty = false; $("template-dialog").close();
    }
  }
  $("close-template").addEventListener("click", closeTemplate);
  $("template-dialog").addEventListener("cancel", event => { event.preventDefault(); closeTemplate(); });
  $("template-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (templateSaving) return;
    const payload = {...readTemplateDraft(), project_id: templateProject, revision: templateRevision};
    const controls = [...$("template-form").elements].filter(control => !control.disabled);
    templateSaving = true;
    controls.forEach(control => { control.disabled = true; });
    $("template-error").hidden = true;
    try {
      templates[templateProject] = await api("api/templates", {method: "PUT", body: JSON.stringify(payload)});
      templateDirty = false;
      $("template-dialog").close();
      toast(t("实验模板已保存。"));
      await load().catch(() => {});
    } catch (error) { showError("template-error", error.message); }
    finally { templateSaving = false; controls.forEach(control => { control.disabled = false; }); }
  });

  const folderReasons = {sample: "缺少可匹配的样品编号", category: "数据类别待确认", duplicate: "同一样品下已有同名同类附件",
    size: "空文件或超过单文件大小限制", archived: "目标样品已归档或属于资料集", failed: "文件保存结果待核对"};
  function importControls() {
    const picked = (folderPlan?.rows || []).filter(row => !folderSkipped.has(row.path));
    const review = picked.filter(row => row.action === "review").length;
    if ($("import-plan-count")) $("import-plan-count").textContent = t("{ready} 个可导入 · {review} 个待核对", {ready: picked.length - review, review});
    for (const control of $("import-options").querySelectorAll("input,select")) control.disabled = importing;
    for (const control of $("import-rows").querySelectorAll("input,select")) control.disabled = importing;
    for (const id of ["choose-folder", "choose-import-files", "folder-files", "individual-files", "close-import", "preview-import", "confirm-import"]) $(id).disabled = importing ||
      (id === "preview-import" && !folderFiles.size) || (id === "confirm-import" && (!picked.length || folderPlan.stale));
  }
  function renderImportRows() {
    $("import-project").textContent = projectLabel(importProject);
    $("import-file-count").textContent = folderFiles.size ? t("已选择 {count} 个文件", {count: folderFiles.size}) : t("未选择文件");
    $("import-separator-label").hidden = $("import-rule").value !== "name";
    if (!folderPlan) $("import-rows").replaceChildren();
    else {
      $("import-rows").innerHTML = `<p id="import-plan-count" class="form-hint" role="status"></p>
        <table class="workflow-table import-table"><thead><tr><th>${t("相对路径")}</th><th>${t("样品编号")}</th><th>${t("数据类别")}</th><th>${t("预览结果")}</th></tr></thead><tbody>${folderPlan.rows.map((row, index) => {
          const draft = folderOverrides.get(row.path) || row;
          const label = field => escape(t(field) + " · " + row.path);
          const category = `<select aria-label="${label("数据类别")}" data-import-edit="kind"><option value="">—</option>${kinds.map(kind => `<option value="${escape(kind)}" ${kind === draft.kind ? "selected" : ""}>${escape(I18n.dataKind(kind, language))}</option>`).join("")}</select>`;
          return `<tr data-import-index="${index}"><td><label class="lab-check"><input type="checkbox" data-import-pick aria-label="${label("导入此文件")}" ${folderSkipped.has(row.path) ? "" : "checked"}><span>${escape(row.path)}</span></label></td><td><input aria-label="${label("样品编号")}" maxlength="120" data-import-edit="sample_id" value="${escape(draft.sample_id)}"></td><td>${category}</td>
          <td>${t(folderPlan.stale ? "请重新预览" : row.action === "review" ? folderReasons[row.reason] : row.action === "attach" ? "关联已有样品" : "新建样品并关联")}${row.action === "new" && !folderPlan.stale ? `<small class="field-help">${escape(row.experiment_no)}</small>` : ""}</td></tr>`;
        }).join("")}</tbody></table>`;
    }
    importControls();
  }
  $("folder-import").addEventListener("click", () => {
    if (!projectId || !loaded) return toast(t("请先选择一个具体项目。"));
    importProject = projectId; folderFiles = new Map(); folderPlan = null;
    folderOverrides.clear(); folderSkipped.clear();
    $("import-rule").value = "name";
    $("import-create").checked = false; $("import-experiment").value = "";
    $("import-error").hidden = true; $("import-progress").textContent = "";
    $("import-kind").innerHTML = `<option value="" data-i18n="按文件名识别类别">${t("按文件名识别类别")}</option>` +
      kinds.map(kind => `<option data-kind-label="${escape(kind)}" value="${escape(kind)}">${escape(I18n.dataKind(kind, language))}</option>`).join("");
    renderImportRows();
    $("import-dialog").showModal();
  });
  $("choose-folder").addEventListener("click", () => $("folder-files").click());
  $("choose-import-files").addEventListener("click", () => $("individual-files").click());
  for (const id of ["folder-files", "individual-files"]) $(id).addEventListener("change", event => {
    if (importing || !event.target.files.length) return;
    const files = [...event.target.files];
    folderPlan = null; folderFiles = new Map(); $("import-progress").textContent = "";
    folderOverrides.clear(); folderSkipped.clear();
    if (files.length > 300) showError("import-error", "每次请选择 1–300 个文件。");
    else {
      const byPath = new Map(files.map(file => [file.webkitRelativePath || file.name, file]));
      if (byPath.size !== files.length) showError("import-error", "所选文件的相对路径不能重复。");
      else {
        folderFiles = byPath;
        importBatch = crypto.randomUUID().replaceAll("-", "");
        $("import-error").hidden = true;
      }
    }
    if (id === "individual-files") $("import-rule").value = "name";
    event.target.value = "";
    renderImportRows();
  });
  $("import-options").addEventListener("input", () => {
    folderOverrides.clear();
    folderPlan = null; $("import-error").hidden = true; $("import-progress").textContent = ""; renderImportRows();
  });
  $("import-rows").addEventListener("input", event => {
    const {importEdit} = event.target.dataset;
    if (importing || !folderPlan || (!importEdit && !event.target.hasAttribute("data-import-pick"))) return;
    const row = folderPlan.rows[Number(event.target.closest("tr").dataset.importIndex)];
    if (!importEdit) {
      if (event.target.checked) folderSkipped.delete(row.path); else folderSkipped.add(row.path);
    } else {
      folderOverrides.set(row.path, {...(folderOverrides.get(row.path) || {sample_id: row.sample_id, kind: row.kind}),
        [importEdit]: event.target.value});
    }
    folderPlan.stale = true;
    $("import-progress").textContent = t("归属已修改，请重新预览。");
    importControls();
  });
  function closeImport() {
    if (importing) return;
    folderPlan = null; folderFiles.clear(); $("import-dialog").close();
  }
  $("close-import").addEventListener("click", closeImport);
  $("import-dialog").addEventListener("cancel", event => { event.preventDefault(); closeImport(); });
  $("preview-import").addEventListener("click", async () => {
    if (importing || !folderFiles.size) return;
    const mode = $("import-rule").value, delimiter = $("import-separator").value;
    const fallbackKind = $("import-kind").value;
    const experimentalKinds = kinds.filter(kind => /^[A-Za-z][A-Za-z0-9-]*$/.test(kind));
    const files = [...folderFiles].map(([path, file]) => {
      const parts = path.split("/");
      const stem = file.name.replace(/\.[^.]+$/, "");
      const sample = mode === "directory" ? (parts.length > 2 ? parts[1] : "") : (delimiter ? stem.split(delimiter, 1)[0] : stem);
      const tokens = " " + path.toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
      const alternatives = experimentalKinds.filter(kind => tokens.includes(" " + kind.toLowerCase().replace(/-/g, " ") + " "));
      return {path, size: file.size, sample_id: sample.trim(), kind: fallbackKind || (alternatives.length === 1 ? alternatives[0] : ""),
        ...folderOverrides.get(path)};
    });
    const payload = {project_id: importProject, create: $("import-create").checked,
      experiment_no: $("import-experiment").value, excluded: [...folderSkipped], files};
    importing = true; folderPlan = null; $("import-error").hidden = true; importControls();
    try {
      folderPlan = await api("api/folder-import/preview", {method: "POST", body: JSON.stringify(payload)});
    } catch (error) { showError("import-error", error.message); }
    finally { importing = false; renderImportRows(); }
  });
  $("confirm-import").addEventListener("click", async () => {
    if (importing || !folderPlan || folderPlan.stale) return;
    const rows = folderPlan.rows.filter(row => !folderSkipped.has(row.path)), issues = rows.filter(row => row.action === "review");
    const pending = rows.filter(row => row.action !== "review");
    const created = new Map(), uncertain = new Set();
    let saved = 0, queued = 0;
    importing = true; $("import-error").hidden = true; importControls();
    try {
      for (const row of pending) {
        const key = asciiFold(row.sample_id);
        if (uncertain.has(key)) { issues.push({...row, reason: "failed"}); continue; }
        const receipt = crypto.randomUUID().replaceAll("-", "");
        const query = new URLSearchParams({project_id: importProject, sample_id: row.sample_id, receipt,
          record_id: row.record_id || created.get(key) || "", experiment_no: row.experiment_no, path: row.path, kind: row.kind});
        $("import-progress").textContent = t("正在复制 {file}", {file: row.path});
        let result;
        try {
          result = await api("api/folder-import/file?" + query, {method: "POST", body: folderFiles.get(row.path), headers: {"Content-Type": "application/octet-stream"}});
        } catch (error) {
          if (!error.status) result = await api("api/folder-import/receipts/" + receipt).catch(() => null);
          if (!result) {
            issues.push({...row, reason: "failed"});
            if (!error.status) uncertain.add(key);
            continue;
          }
        }
        if (result.record_id) {
          created.set(key, result.record_id);
          folderFiles.delete(row.path);
          folderOverrides.delete(row.path);
          saved++;
        } else {
          issues.push({...row, reason: "failed"});
          uncertain.add(key);
        }
      }
      folderPlan = null;
      if (issues.length) {
        const result = await api("api/folder-import/issues", {method: "POST", body: JSON.stringify({project_id: importProject, batch_id: importBatch, issues})});
        queued = result.pending;
      }
    } catch (error) { showError("import-error", t("待核对条目写入未确认。请重新预览。") + " " + error.message); }
    finally {
      await load().catch(() => {});
      $("import-progress").textContent = t("已导入 {saved} 个文件 · {queued} 个条目在待核对清单", {saved, queued});
      importing = false; renderImportRows();
    }
  });

  function renderComparison() {
    const chosen = comparisonRecords;
    $("comparison-table").innerHTML = `<thead><tr><th>${t("实验条件")}</th>${chosen.map(record => `<th>${escape(recordLabel(record, "sample_id"))}</th>`).join("")}</tr></thead><tbody>${comparisonRows(chosen, language).map(row => `<tr class="${row.different ? "different" : ""}"><td>${escape(row.label)}</td>${row.values.map(value => `<td>${display(value)}</td>`).join("")}</tr>`).join("")}</tbody>`;
    const axisOptions = (section, id, core = []) => {
      const select = $(id), selected = select.value;
      const options = new Map(core);
      for (const record of chosen) for (const field of storedFields(record, section)) {
        if (field.type === "number" && Number.isFinite(field.value)) options.set(fieldIdentity(record, field), comparisonCaption(record, field, language));
      }
      select.innerHTML = [...options].map(([value, label]) => `<option value="${escape(value)}">${escape(label)}</option>`).join("");
      if (options.has(selected)) select.value = selected;
    };
    axisOptions("condition", "comparison-x", [["temperature", t("温度 / °C")], ["duration", t("反应 / 取样时间 · min")]]);
    axisOptions("result", "comparison-y");
    $("numeric-comparison").hidden = !$("comparison-y").options.length;
    renderComparisonScatter();
    const previous = new Map([...$("comparison-xrd-files").querySelectorAll("select")].map(select => [select.dataset.sample, select.value]));
    const xrd = chosen.map(record => ({record, files: record.files.filter(file => file.kind === "XRD" && /\.csv$/i.test(file.name))}))
      .filter(entry => entry.files.length);
    $("xrd-comparison").hidden = xrd.length < 2;
    $("comparison-xrd-files").innerHTML = xrd.map(({record, files}) => `<label><span>${escape(record.sample_id)}</span><select data-sample="${escape(record.id)}">
      <option value="">${t("不加入叠图")}</option>${files.map(file => `<option value="${escape(file.id)}">${escape(file.name)}</option>`).join("")}</select></label>`).join("");
    for (const select of $("comparison-xrd-files").querySelectorAll("select")) {
      const value = previous.get(select.dataset.sample);
      select.value = value !== undefined && [...select.options].some(option => option.value === value) ? value : select.options[1].value;
    }
  }
  function renderComparisonScatter() {
    const version = ++comparisonScatterVersion, area = $("comparison-scatter");
    if ($("numeric-comparison").hidden) { area.replaceChildren(); return; }
    const x = $("comparison-x"), y = $("comparison-y");
    const get = (record, section, id) => ["temperature", "duration"].includes(id) ? record[id] :
      storedFields(record, section).find(field => fieldIdentity(record, field) === id)?.value;
    const series = comparisonRecords.filter(record => !["not_measured", "measurement_failed"].includes(record.lab_data?.outcome))
      .map(record => ({label: record.sample_id, points: [[get(record, "condition", x.value), get(record, "result", y.value)]]}))
      .filter(item => item.points[0].every(Number.isFinite));
    if (series.length < 2) {
      area.textContent = t("至少需要两个样品同时记录所选条件与结果。");
      return;
    }
    requestAnimationFrame(() => {
      if (version !== comparisonScatterVersion || !$("comparison").open) return;
      const xLabel = x.selectedOptions[0].textContent, yLabel = y.selectedOptions[0].textContent;
      const plot = plotSvg(series, {scatter: true, container: area, xLabel, yLabel});
      area.innerHTML = plot.html + `<table class="workflow-table"><thead><tr><th>${t("样品编号")}</th><th>${escape(xLabel)}</th><th>${escape(yLabel)}</th></tr></thead>
        <tbody>${series.map(item => `<tr><td>${escape(item.label)}</td><td>${item.points[0][0]}</td><td>${item.points[0][1]}</td></tr>`).join("")}</tbody></table>`;
    });
  }
  for (const id of ["comparison-x", "comparison-y"]) $(id).addEventListener("change", renderComparisonScatter);
  function clearComparisonXrd() {
    comparisonPlotVersion++;
    $("comparison-xrd-plot").replaceChildren();
    $("draw-comparison-xrd").disabled = false;
  }
  for (const id of ["comparison-xrd-files", "comparison-xrd-normalize"]) $(id).addEventListener("change", clearComparisonXrd);
  $("draw-comparison-xrd").addEventListener("click", async () => {
    const version = ++comparisonPlotVersion, area = $("comparison-xrd-plot");
    const inputs = [...$("comparison-xrd-files").querySelectorAll("select")].filter(select => select.value);
    if (inputs.length < 2) { area.textContent = t("请选择来自不同样品的至少两份 XRD CSV。"); return; }
    const normalize = $("comparison-xrd-normalize").checked;
    area.textContent = t("正在读取…"); $("draw-comparison-xrd").disabled = true;
    try {
      const results = await Promise.allSettled(inputs.map(async (input, slot) => {
        const data = await previewData(input.value);
        const [angle = "", intensity = ""] = (data.labels || []).map(label => label.replaceAll("_", " "));
        if (!data.points || data.points.length < 2 || /\b(rad(?:ian)?s?|d[ _-]*spacing|angstroms?|nm|q|intensity|yobs|counts?|time)\b|[ÅÅ]/i.test(angle) ||
            /\b((?:y ?)?(?:cal(?:c)?|bkg|background)|calculated|fitted|residual|diff(?:erence)?|(?:two|2) ?theta|angle|voltage)\b|2\s*θ/i.test(intensity) ||
            data.points.some(([x]) => x < 0 || x > 180)) throw new Error("请检查 CSV 前两列是否为角度 (°) 和实测强度。");
        return {slot, label: comparisonRecords.find(record => record.id === input.dataset.sample)?.sample_id || "",
          file: input.selectedOptions[0]?.textContent, points: processSeries(data.points, {normalize})};
      }));
      if (version !== comparisonPlotVersion) return;
      const failures = results.map((result, index) => result.status === "rejected" ?
        `<li>${escape(inputs[index].selectedOptions[0]?.textContent)} · ${escape(t(result.reason.message))}</li>` : "").join("");
      const errors = failures ? `<ul class="field-help">${failures}</ul>` : "";
      const series = results.filter(result => result.status === "fulfilled").map(result => result.value);
      if (series.length < 2) {
        area.innerHTML = `<p>${t("可绘制的 XRD CSV 少于两份。请检查前两列。")}</p>` + errors;
        return;
      }
      const plot = plotSvg(series, {container: area, normalize, xLabel: "2θ (°)", yLabel: t("强度 (a.u.)")});
      area.innerHTML = plot.html + `<ul class="comparison-plot-legend">${series.map(item => `<li><i class="series-swatch series-bg-${item.slot}"></i>${escape(item.label)} · ${escape(item.file)}</li>`).join("")}</ul>` + errors;
    } finally {
      if (version === comparisonPlotVersion) $("draw-comparison-xrd").disabled = false;
    }
  });

  function renderDetailNotes(record) {
    const translated = recordLabel(record, "notes");
    $("detail-notes").textContent = translated || t("尚未填写备注。");
    $("detail-notes-original").hidden = translated === record.notes;
  }

  function applyTheme() {
    const dark = theme === "dark";
    document.documentElement.classList.toggle("dark", dark);
    $("theme-label").textContent = t(dark ? "浅色" : "深色");
    $("theme-icon").setAttribute("href", dark ? "#i-sun" : "#i-moon");
    const label = t(dark ? "切换到浅色主题" : "切换到深色主题");
    $("theme-switch").setAttribute("aria-label", label);
    $("theme-switch").title = label;
    document.querySelector('meta[name="theme-color"]').content = dark ? "#1e1e1e" : "#ffffff";
  }

  function applyLanguage() {
    document.documentElement.lang = language === "en" ? "en" : "zh-CN";
    I18n.apply(document, language);
    renderCatalogOptions();
    renderConditionOptions();
    for (const element of document.querySelectorAll("[data-kind-label]")) element.textContent = I18n.dataKind(element.dataset.kindLabel, language);
    $("language-label").textContent = language === "en" ? "中文" : "English";
    $("language-switch").setAttribute("aria-label", t(language === "en" ? "切换到中文" : "切换到英文"));
    applyTheme();
    syncExperimentList();
    $("editor-title").textContent = t(editorTitle);
    renderSharedDraft();
    syncEditorNotes(true);
    for (const error of document.querySelectorAll("[data-error]")) error.textContent = I18n.translateError(error.dataset.error, language);
    render();
    if ($("detail").open) {
      const record = records.find(item => item.id === detailId);
      $("detail-title").textContent = recordLabel(record, "sample_id");
      $("detail-series").textContent = recordLabel(record, "series") || t("未分类");
      $("detail-project").textContent = projectLabel(record.project_id);
      $("detail-result-content").innerHTML = resultHtml(record);
      renderDetailNotes(record);
      $("archive-record").textContent = t(record.archived ? "恢复记录" : "归档记录");
      $("updated-time").textContent = new Date(record.updated_at).toLocaleString(language === "en" ? "en-US" : "zh-CN");
      updateFileLabel();
    }
    if ($("comparison").open) { renderComparison(); clearComparisonXrd(); }
    if ($("template-dialog").open) $("template-project").textContent = projectLabel(templateProject);
    if ($("import-dialog").open) renderImportRows();
    if ($("history-dialog").open) renderHistory();
    if ($("review-dialog").open) renderReviews();
    renderBackupBadge();
    if ($("backup-dialog").open) renderBackup();
    if ($("trash-dialog").open) renderTrash();
    renderTrashCount();
    if ($("bulk-editor").open) {
      for (const {field, label, caption} of bulkActive) $(`bulk-${field}-mode`).setAttribute("aria-label", t("{field} 操作", {field: caption || t(label)}));
      renderBulkReview();
    }
    for (const link of document.querySelectorAll(".nav-item")) {
      const label = link.querySelector("span").textContent;
      link.title = label;
      link.setAttribute("aria-label", label);
    }
  }

  $("language-switch").addEventListener("click", () => {
    if (saving || uploading || catalogSaving) return;
    language = language === "en" ? "zh" : "en";
    try { localStorage.setItem("catalog-language", language); } catch {}
    $("toast").hidden = true;
    applyLanguage();
  });
  $("theme-switch").addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    try { localStorage.setItem("catalog-theme", theme); } catch {}
    applyTheme();
  });
  function syncSidebar() {
    $("toggle-sidebar").setAttribute("aria-expanded", String(!document.body.classList.contains("sidebar-collapsed")));
  }
  if (matchMedia("(max-width: 720px)").matches) document.body.classList.add("sidebar-collapsed");
  syncSidebar();
  $("toggle-sidebar").addEventListener("click", () => {
    document.body.classList.toggle("sidebar-collapsed");
    syncSidebar();
  });
  // URL hash keeps the current view so refresh, back/forward and bookmarks work: #/records, #/kind/XRD, #/workspace/default/XY-II-268?sample=<id>
  function currentRoute() {
    if (workspaceView) {
      const group = currentWorkspaceGroup();
      if (!group) return "#/workspace";
      return `#/workspace/${encodeURIComponent(group.projectId)}/${encodeURIComponent(group.number)}` + (workspaceSample ? `?sample=${encodeURIComponent(workspaceSample)}` : "");
    }
    if (archived) return "#/archived";
    const kind = $("filter-kind").value;
    if (kind && kind !== "none" && !chartCondition) return `#/kind/${encodeURIComponent(kind)}`;
    return dashboardTab === "records" ? "#/records" : "#/";
  }

  function syncRoute() {
    if (!routeApplied) return;
    const next = currentRoute(), now = location.hash || "#/";
    const replace = routeReplace || now.split("?")[0] === next.split("?")[0];
    routeReplace = false;
    if (now === next) return;
    try { history[replace ? "replaceState" : "pushState"](null, "", next); } catch {}
  }

  function applyRoute() {
    const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
    const parts = path.split("/").filter(Boolean).map(part => { try { return decodeURIComponent(part); } catch { return part; } });
    workspaceView = false; archived = false; chartCondition = null; dashboardTab = "overview";
    $("filter-kind").value = "";
    if (parts[0] === "workspace") {
      workspaceView = true;
      $("experiment-search").value = ""; $("workspace-status-filter").value = "";
      if (parts[1] && parts[2]) {
        if (projectId && projectId !== parts[1] && projects.some(project => project.id === parts[1])) {
          projectId = parts[1];
          $("project-select").value = projectId;
          renderConditionOptions();
        }
        const key = `experiment:${parts[1]}:${canonicalExperimentNo(parts[2], parts[1]).toLowerCase()}`;
        if (key !== workspaceKey) { workspaceKey = key; workspaceKind = ""; workspaceFile = ""; }
      }
      workspaceSample = new URLSearchParams(query).get("sample") || "";
    } else if (parts[0] === "archived") { archived = true; dashboardTab = "records"; }
    else if (parts[0] === "records") dashboardTab = "records";
    else if (parts[0] === "kind" && parts[1] && kinds.includes(parts[1])) { $("filter-kind").value = parts[1]; dashboardTab = "records"; }
    selected.clear();
  }

  window.addEventListener("popstate", () => {
    if (!loaded) return;
    previewVersion++;
    applyRoute();
    render();
  });

  function changeView(isArchived, kind = "", condition = null) {
    workspaceView = false;
    previewVersion++;
    archived = isArchived;
    chartCondition = condition;
    dashboardTab = isArchived || kind || condition ? "records" : "overview";
    $("filter-kind").value = kind;
    selected.clear();
    render();
    if (matchMedia("(max-width: 720px)").matches) {
      document.body.classList.add("sidebar-collapsed");
      syncSidebar();
    }
    window.scrollTo(0, 0);
  }

  $("experiment-view").addEventListener("click", () => {
    workspaceView = true;
    render();
    if (matchMedia("(max-width: 720px)").matches) { document.body.classList.add("sidebar-collapsed"); syncSidebar(); }
  });
  $("experiment-search").addEventListener("input", render);
  $("workspace-status-filter").addEventListener("change", render);
  $("experiment-order").addEventListener("change", () => {
    try { localStorage.setItem("catalog-experiment-order", $("experiment-order").value); } catch {}
    render();
  });
  $("dashboard-overview-tab").addEventListener("click", () => changeView(false));
  $("dashboard-records-tab").addEventListener("click", () => { dashboardTab = "records"; render(); });
  $("dashboard-condition-field").addEventListener("change", render);
  $("dashboard-condition-table").addEventListener("click", event => {
    const experiment = event.target.closest("[data-condition-experiment]");
    if (experiment) return openWorkspace(experiment.dataset.conditionExperiment);
    const button = event.target.closest("[data-condition-value]");
    if (button) { clearRecordFilters(); changeView(false, "", {field: $("dashboard-condition-field").value, value: button.dataset.conditionValue}); }
  });
  $("clear-chart-filter").addEventListener("click", () => { chartCondition = null; render(); });
  $("dashboard-recent").addEventListener("click", event => {
    const button = event.target.closest("[data-dashboard-open]");
    if (button) openDetail(button.dataset.dashboardOpen);
  });
  $("dashboard-show-pending").addEventListener("click", () => { clearRecordFilters(); changeView(false, "", {field: "missing", value: ""}); });
  function openWorkspace(key) {
    workspaceKey = key;
    workspaceSample = ""; workspaceFile = ""; workspaceKind = "";
    $("experiment-search").value = ""; $("workspace-status-filter").value = "";
    $("experiment-view").click();
    $("workspace-experiment-title").focus();
    $("workspace-experiment-title").scrollIntoView({block: "start"});
  }
  document.querySelector(".stats").addEventListener("click", event => {
    const action = event.target.closest("[data-stat-action]")?.dataset.statAction;
    if (action === "workspace") $("experiment-view").click();
    else if (action === "records") { dashboardTab = "records"; render(); }
    else if (action === "missing") { clearRecordFilters(); changeView(false, "", {field: "missing", value: ""}); }
  });

  // Global jump box (Ctrl+K or /): matches experiment numbers, sample names and precursors in the current project.
  let globalMatches = [], globalIndex = 0;
  function renderGlobalResults() {
    const query = $("global-search").value.trim().toLocaleLowerCase();
    const scoped = records.filter(record => !record.archived && (!projectId || (record.project_id || "default") === projectId));
    const precursors = record => builtinEnabled(record.project_id, "precursor") ? conditionMembers(record, "precursor") : [];
    globalMatches = query ? groupRecords(scoped).filter(group => !group.dataset && [group.number, ...group.records.flatMap(record => [record.sample_id, ...precursors(record)])]
      .some(value => String(value || "").toLocaleLowerCase().includes(query))).slice(0, 8) : [];
    globalIndex = Math.min(globalIndex, Math.max(0, globalMatches.length - 1));
    const list = $("global-results");
    list.hidden = !query;
    $("global-search").setAttribute("aria-expanded", String(!list.hidden));
    list.innerHTML = globalMatches.map((group, index) => {
      const precursor = [...new Set(group.records.flatMap(precursors).filter(Boolean))].join(" / ") || t("尚未记录");
      return `<button type="button" role="option" id="global-option-${index}" class="global-option ${index === globalIndex ? "active" : ""}" aria-selected="${index === globalIndex}" data-global-key="${escape(group.key)}"><strong>${escape(group.number)}</strong><small>${escape(t("{count} 条样品 · {precursor}", {count: group.records.length, precursor}))}${!projectId ? " · " + escape(projectLabel(group.projectId)) : ""}</small></button>`;
    }).join("") || `<p class="global-empty">${t("没有匹配的实验")}</p>`;
    if (globalMatches.length) $("global-search").setAttribute("aria-activedescendant", `global-option-${globalIndex}`); else $("global-search").removeAttribute("aria-activedescendant");
  }
  function closeGlobal() { $("global-results").hidden = true; $("global-search").setAttribute("aria-expanded", "false"); }
  function chooseGlobal(key) {
    if (!key) return;
    $("global-search").value = ""; closeGlobal();
    openWorkspace(key);
  }
  $("global-search").addEventListener("input", () => { globalIndex = 0; renderGlobalResults(); });
  $("global-search").addEventListener("focus", () => { if ($("global-search").value) renderGlobalResults(); });
  $("global-search").addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!globalMatches.length) return;
      globalIndex = (globalIndex + (event.key === "ArrowDown" ? 1 : -1) + globalMatches.length) % globalMatches.length;
      renderGlobalResults();
    } else if (event.key === "Enter") { event.preventDefault(); chooseGlobal(globalMatches[globalIndex]?.key); }
    else if (event.key === "Escape") { if (!$("global-results").hidden) { event.preventDefault(); closeGlobal(); } else $("global-search").blur(); }
  });
  $("global-results").addEventListener("mousedown", event => event.preventDefault());
  $("global-results").addEventListener("click", event => chooseGlobal(event.target.closest("[data-global-key]")?.dataset.globalKey));
  $("global-search").addEventListener("blur", closeGlobal);
  document.addEventListener("keydown", event => {
    if (document.querySelector("dialog[open]")) return;
    const typing = event.target.closest?.("input, textarea, select, [contenteditable]");
    if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") || (event.key === "/" && !typing && !document.querySelector("dialog[open]"))) {
      event.preventDefault();
      $("global-search").focus();
      $("global-search").select();
    }
  });
  $("dashboard-missing").addEventListener("click", event => {
    const button = event.target.closest("[data-missing-field]");
    if (button) { clearRecordFilters(); changeView(false, "", {field: "missing", value: button.dataset.missingField}); }
  });
  $("experiment-list").addEventListener("click", event => {
    const button = event.target.closest("[data-workspace-key]");
    if (!button) return;
    workspaceKey = button.dataset.workspaceKey;
    workspaceSample = ""; workspaceFile = "";
    render();
    [...$("experiment-list").children].find(item => item.dataset.workspaceKey === workspaceKey)?.focus();
  });
  $("workspace-sample").addEventListener("change", event => { workspaceSample = event.target.value; workspaceFile = ""; render(); });
  function syncWorkspaceStatus() {
    const chosen = workspaceRecords(), value = $("workspace-status").value;
    $("workspace-status").disabled = statusSaving;
    $("workspace-save-status").disabled = statusSaving || !value || !chosen.some(record => record.status !== value);
    $("workspace-save-status").textContent = t(statusSaving ? "正在保存…" : "更新 {count} 条样品状态", {count: chosen.length});
  }
  $("workspace-status").addEventListener("change", syncWorkspaceStatus);
  $("workspace-save-status").addEventListener("click", async () => {
    const chosen = workspaceRecords(), status = $("workspace-status").value;
    if (statusSaving || !chosen.length || !status || !chosen.some(record => record.status !== status)) return;
    statusSaving = true;
    $("workspace-status-error").hidden = true;
    syncWorkspaceStatus();
    let updated = false;
    try {
      await api("api/experiments/status", {method: "POST", body: JSON.stringify({status, records: chosen.map(record => ({id: record.id, revision: record.revision}))})});
      updated = true;
      await load();
      toast(t("样品状态已更新。"));
    } catch (error) {
      const message = updated ? "状态已更新，但列表刷新失败。请刷新页面。" : error.message;
      if ($("workspace-detail").hidden || !workspaceView) toast(I18n.translateError(message, language));
      else showError("workspace-status-error", message);
    } finally { statusSaving = false; syncWorkspaceStatus(); }
  });
  $("workspace-kinds").addEventListener("click", event => {
    const button = event.target.closest("[data-workspace-kind]");
    if (!button) return;
    workspaceKind = button.dataset.workspaceKind;
    renderWorkspaceData();
    [...$("workspace-kinds").children].find(item => item.dataset.workspaceKind === workspaceKind)?.focus();
  });
  $("workspace-file").addEventListener("change", event => { workspaceFile = event.target.value; renderWorkspaceData(); });
  const rerenderPreview = async selector => {
    const version = await renderPreview(previewFile).then(() => previewVersion);
    try { if (selector && version === previewVersion) $("workspace-preview").querySelector(selector)?.focus(); } catch {}
  };
  $("workspace-preview").addEventListener("click", event => {
    const mode = event.target.closest("[data-preview-mode]");
    if (mode) { previewMode = mode.dataset.previewMode; return rerenderPreview(`[data-preview-mode="${previewMode}"]`); }
    const method = event.target.closest("[data-plot-method]");
    if (method && !method.disabled) { plotPrefs.method = method.dataset.plotMethod; return rerenderPreview(`[data-plot-method="${plotPrefs.method}"]`); }
    const layout = event.target.closest("[data-overlay-layout]");
    if (layout) { overlayLayout = layout.dataset.overlayLayout; return rerenderPreview(`[data-overlay-layout="${overlayLayout}"]`); }
  });
  $("workspace-preview").addEventListener("change", event => {
    if (event.target.matches("[data-plot-normalize]")) { plotPrefs.normalize = event.target.checked; return rerenderPreview("[data-plot-normalize]"); }
    if (event.target.matches("[data-plot-window]")) { plotPrefs.window = Number(event.target.value); return rerenderPreview("[data-plot-window]"); }
    const id = event.target.dataset.overlayFile;
    if (id) { toggleOverlayFile(id, event.target.checked); rerenderPreview(`[data-overlay-file="${id}"]`); }
  });
  $("workspace-preview").addEventListener("pointermove", showPlotHover);
  let plotResizeTimer, plotWidth = 0;
  window.addEventListener("resize", () => {
    clearTimeout(plotResizeTimer);
    plotResizeTimer = setTimeout(() => {
      const width = $("workspace-preview").clientWidth;
      if (activePlot && previewFile && Math.abs(width - plotWidth) > 40) { plotWidth = width; renderPreview(previewFile); }
    }, 200);
  });
  $("workspace-preview").addEventListener("pointerleave", () => {
    $("workspace-preview").querySelector(".plot-hover")?.setAttribute("hidden", "");
    const tip = $("workspace-preview").querySelector(".plot-tooltip");
    if (tip) tip.hidden = true;
  });
  $("workspace-add-sample").addEventListener("click", () => { const group = currentWorkspaceGroup(); if (group) edit(null, false, group.number, group.projectId); });
  $("workspace-open-record").addEventListener("click", () => { const chosen = workspaceRecords(); if (chosen.length === 1) openDetail(chosen[0].id); });
  $("workspace-edit-record").addEventListener("click", () => { const chosen = workspaceRecords(); if (chosen.length === 1) edit(chosen[0]); });
  function editResult(id) {
    const record = records.find(item => item.id === id);
    if (!record) return;
    edit(record);
    $("result-phase-input").focus();
    $("editor-results").scrollIntoView({block: "start"});
  }
  $("workspace-edit-results").addEventListener("click", () => { const chosen = workspaceRecords(); if (chosen.length === 1) editResult(chosen[0].id); });
  for (const id of ["workspace-result-content", "detail-content"]) $(id).addEventListener("click", event => {
    const editor = event.target.closest("[data-edit-result]");
    if (editor) return editResult(editor.dataset.editResult);
    const button = event.target.closest("[data-result-file]");
    if (!button) return;
    const record = records.find(item => item.id === button.dataset.resultRecord);
    if (!record || !record.files.some(file => file.id === button.dataset.resultFile)) return;
    if ($("detail").open) $("detail").close();
    openWorkspace(groupRecords([record])[0].key);
    workspaceSample = record.id;
    workspaceFile = button.dataset.resultFile;
    render();
    $("workspace-file").focus();
    $("workspace-preview-heading").scrollIntoView({block: "start"});
  });

  function syncExperimentList() {
    const collapsed = $("workspace-layout").classList.contains("index-collapsed");
    $("toggle-experiment-list").setAttribute("aria-expanded", String(!collapsed));
    $("experiment-list-toggle-label").textContent = t(collapsed ? "展开编号列表" : "收起编号列表");
  }
  $("toggle-experiment-list").addEventListener("click", () => {
    $("workspace-layout").classList.toggle("index-collapsed");
    syncExperimentList();
  });
  function setIndexWidth(value) {
    const width = Math.round(Math.max(190, Math.min(420, value)));
    $("workspace-layout").style.setProperty("--index-width", width + "px");
    $("experiment-resizer").setAttribute("aria-valuenow", String(width));
    try { localStorage.setItem("catalog-index-width", String(width)); } catch {}
  }
  try { const saved = Number(localStorage.getItem("catalog-index-width")); if (Number.isFinite(saved) && saved > 0) setIndexWidth(saved); } catch {}
  $("experiment-resizer").addEventListener("keydown", event => {
    const width = Number($("experiment-resizer").getAttribute("aria-valuenow"));
    const value = {ArrowLeft: width - 20, ArrowRight: width + 20, Home: 190, End: 420}[event.key];
    if (value !== undefined) { event.preventDefault(); setIndexWidth(value); }
  });
  let resizeStart = null;
  $("experiment-resizer").addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    resizeStart = {x: event.clientX, width: $("experiment-index").getBoundingClientRect().width};
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    event.preventDefault();
  });
  $("experiment-resizer").addEventListener("pointermove", event => { if (resizeStart) setIndexWidth(resizeStart.width + event.clientX - resizeStart.x); });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) $("experiment-resizer").addEventListener(type, () => { resizeStart = null; });

  $("records").addEventListener("click", event => {
    const toggle = event.target.closest("[data-expand]");
    if (toggle) {
      const key = toggle.dataset.expand;
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      render();
      [...$("records").querySelectorAll("[data-expand]")].find(button => button.dataset.expand === key)?.focus();
      return;
    }
    const add = event.target.closest("[data-add-sample]");
    if (add) return edit(null, false, add.dataset.addSample, add.dataset.project);
    const button = event.target.closest("[data-open]");
    if (button) openDetail(button.dataset.open);
  });
  $("records").addEventListener("change", event => {
    const id = event.target.dataset.select;
    if (!id) return;
    if (event.target.checked) {
      if (selected.size === 500) { event.target.checked = false; return toast(t("一次最多选择 500 条样品。")); }
      selected.add(id);
    } else selected.delete(id);
    render();
    document.querySelector(`[data-select="${id}"]`)?.focus();
  });
  for (const id of ["search", "temp-min", "temp-max", "time-min", "time-max"]) $(id).addEventListener("input", render);
  for (const id of ["filter-status", "filter-kind", "filter-precursor", "filter-solvent", "filter-phase", "filter-morphology", "filter-result-confirmation", "filter-outcome"]) $(id).addEventListener("change", render);
  function clearRecordFilters() {
    chartCondition = null;
    keyFilterState.clear(); keyFilterSignature = "";
    for (const id of ["search", "temp-min", "temp-max", "time-min", "time-max", "filter-status", "filter-kind", "filter-precursor", "filter-solvent", "filter-phase", "filter-morphology", "filter-result-confirmation", "filter-outcome"]) $(id).value = "";
  }
  $("clear-filters").addEventListener("click", () => { clearRecordFilters(); render(); });
  for (const type of ["input", "change"]) $("key-filters").addEventListener(type, event => {
    const control = event.target.closest("[data-key-filter]");
    if (!control) return;
    const state = keyFilterState.get(control.dataset.keyFilter) || {};
    if (state[control.dataset.keyPart] === control.value) return;
    state[control.dataset.keyPart] = control.value;
    keyFilterState.set(control.dataset.keyFilter, state);
    render();
  });
  $("clear-selection").addEventListener("click", () => { selected.clear(); render(); });
  $("select-visible").addEventListener("click", () => {
    if (archived) return;
    const samples = visible.filter(record => !isDatasetRecord(record));
    if (samples.length > 500) return toast(t("一次最多选择 500 条样品。"));
    selected = new Set(samples.map(record => record.id));
    render();
  });
  $("active-view").addEventListener("click", () => changeView(false));
  $("archived-view").addEventListener("click", () => changeView(true));
  $("category-nav").addEventListener("click", event => {
    const button = event.target.closest("[data-kind-view]");
    if (button) { changeView(false, button.dataset.kindView); [...$("category-nav").children].find(item => item.dataset.kindView === button.dataset.kindView)?.focus(); }
  });
  $("new-record").addEventListener("click", () => edit());
  $("empty-new").addEventListener("click", () => edit());
  $("add-condition").addEventListener("click", () => { addCondition(); dirty = true; });
  $("close-editor").addEventListener("click", closeEditor);
  $("cancel-editor").addEventListener("click", closeEditor);
  $("editor").addEventListener("cancel", event => { event.preventDefault(); closeEditor(); });
  $("close-detail").addEventListener("click", () => { if (!uploading) $("detail").close(); });
  $("detail").addEventListener("cancel", event => { if (uploading) event.preventDefault(); });
  $("edit-record").addEventListener("click", () => edit(records.find(record => record.id === detailId)));
  $("duplicate-record").addEventListener("click", () => edit(records.find(record => record.id === detailId), true));
  $("archive-record").addEventListener("click", async () => {
    const record = records.find(item => item.id === detailId);
    if (!record.archived && !confirm(t("归档这条实验？条件和附件会完整保留，可在“已归档”中恢复。"))) return;
    $("archive-record").disabled = true;
    try {
      await api(`api/experiments/${record.id}/archive`, {method: "POST", body: JSON.stringify({archived: !record.archived, revision: record.revision})});
      await load();
      $("detail").close();
      toast(t(record.archived ? "实验已恢复。" : "实验已归档，可以随时恢复。"));
    } catch (error) { toast(I18n.translateError(error.message, language)); }
    finally { $("archive-record").disabled = false; }
  });
  $("export-csv").addEventListener("click", () => {
    if (visible.length) window.location.assign(`api/export.csv?lang=${language}&ids=${visible.map(record => record.id).join(",")}`);
  });
  $("compare").addEventListener("click", () => {
    if (selected.size < 2 || selected.size > 6) return;
    comparisonRecords = visible.filter(record => selected.has(record.id));
    $("comparison-xrd-files").replaceChildren();
    $("comparison-xrd-normalize").checked = false;
    clearComparisonXrd();
    $("comparison").showModal();
    renderComparison();
  });
  $("close-comparison").addEventListener("click", () => $("comparison").close());
  $("comparison").addEventListener("close", clearComparisonXrd);
  const hasUnfinishedWork = () => dirty || saving || uploading || catalogSaving || materialSaving || presetSaving ||
    statusSaving || previewPhaseSaving || bulkBusy || bulkDirty || workflowBusy || workflowDirty || templateDirty || templateSaving || importing ||
    backupStarting || backupStatus?.state === "running" || fileSaving || trashBusy || fileDirty() || trashDirty() || settingsBusy || settingsDirty || conventionsBusy || conventionsDirty || onboardingBusy || riBusy || riDirty;
  window.addEventListener("beforeunload", event => {
    if (hasUnfinishedWork()) { event.preventDefault(); event.returnValue = ""; }
  });
  if (new URLSearchParams(location.search).get("desktop") === "1") {
    document.querySelector(".brand")?.setAttribute("href", "./?desktop=1");
    window.confirmCatalogClose = () => !hasUnfinishedWork() || confirm(t("有未保存的修改或正在处理的操作。确定关闭窗口吗？"));
    document.addEventListener("click", event => {
      const link = event.target.closest('a[target="_blank"]');
      if (link?.origin === location.origin) {
        link.removeAttribute("target");
        link.setAttribute("download", "");
      }
    }, true);
  }
  window.addEventListener("focus", () => {
    if (!loaded || saving || uploading || statusSaving || previewPhaseSaving || document.querySelector("dialog[open]")) return;
    load().catch(() => toast(t("列表暂未更新，已保存的数据不受影响。请稍后重试。")));
  });
  applyLanguage();
  load().catch(error => { loadError = error.message; render(); });
}
