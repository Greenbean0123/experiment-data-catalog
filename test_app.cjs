const assert = require("node:assert/strict");
const {filterRecords, groupRecords, comparisonRows, configureCatalog} = require("./web/app.js");
const localCatalog = require("./test_catalog.json");
configureCatalog(localCatalog);
const I18n = require("./web/i18n.js");
const localTranslations = localCatalog.translations;
I18n.extend(localTranslations);

const record = (id, fields = {}) => ({id, sample_id: id, series: "示例系列", experiment_date: "", precursor: "PA12", temperature: null, duration: null, solvent: "ODE", ligand: "OA", notes: "", status: "待补全", archived: false, extra_conditions: [], files: [], ...fields});
const data = [
  record("unknown"),
  record("zero", {temperature: 0, duration: 0}),
  record("hot", {temperature: 250, duration: 60, files: [{kind: "XRD", name: "衍射.csv"}], extra_conditions: [{name: "OA 加入时间", value: "5", unit: "min"}]}),
  record("archived", {archived: true, temperature: 250, duration: 60})
];
const ids = filters => filterRecords(data, filters).map(item => item.id);
assert.deepEqual(ids({}), ["unknown", "zero", "hot"]);
assert.deepEqual(ids({tempMin: "0", tempMax: "0"}), ["zero"]);
assert.deepEqual(ids({condition: {field: "temperature", value: "0"}}), ["zero"]);
assert.deepEqual(ids({condition: {field: "temperature", value: ""}}), ["unknown"]);
assert.equal(filterRecords([record("资料集-test", {notes: "批量导入：local-test"})], {condition: {field: "temperature", value: ""}}).length, 0);
assert.deepEqual(ids({timeMin: "0", timeMax: "1"}), ["zero"]);
assert.deepEqual(ids({tempMin: "240", timeMax: "60", kind: "XRD"}), ["hot"]);
assert.deepEqual(ids({query: "衍射"}), ["hot"]);
assert.deepEqual(ids({query: "OA 加入时间"}), ["hot"]);
assert.deepEqual(ids({query: "pa12"}), ["unknown", "zero", "hot"]);
assert.deepEqual(ids({solvent: "octadecane"}), []);
assert.deepEqual(ids({archived: true}), ["archived"]);
assert.deepEqual(ids({kind: "none"}), ["unknown", "zero"]);
const mixture = record("mix", {precursor: "PA12 + Salt B", precursors: ["PA12", "Salt B"]});
assert.deepEqual(filterRecords([mixture], {precursor: "Salt B"}), [mixture]);
assert.deepEqual(filterRecords([mixture], {condition: {field: "precursor", value: "Compound A12 (CA12)"}}), [mixture]);
const rows = comparisonRows(data.slice(0, 3));
assert.equal(rows.find(row => row.label === "温度 / °C").different, true);
assert.equal(rows.find(row => row.label === "前驱体").different, false);
assert.deepEqual(rows.find(row => row.label === "OA 加入时间").values, ["", "", "5 min"]);
assert.equal(rows.find(row => row.label === "温度 / °C").values[1], 0);
const imported = record("dataset", {sample_id: "资料集-示例图谱", series: "资料分类", notes: "批量导入：local-2026-11-14。"});
assert.equal(I18n.recordLabel(imported, "sample_id", "en"), "Dataset-Example plots");
assert.equal(I18n.recordLabel(imported, "sample_id", "zh"), imported.sample_id);
assert.equal(I18n.recordLabel({...imported, notes: "用户自己填写"}, "sample_id", "en"), imported.sample_id);
assert.equal(I18n.recordLabel(data[0], "series", "en"), "Example series");
assert.equal(I18n.recordLabel({series: "时间系列"}, "series", "en"), "Time course");
assert.equal(I18n.recordLabel({series: "自定义系列"}, "series", "en"), "自定义系列");
assert.equal(filterRecords([imported], {query: "example plots", language: "en"}).length, 1);
assert.equal(comparisonRows([imported], "en")[0].values[0], "Reference materials");
const grouped = [record("XY-III-352-10", {experiment_no: "XY-III-352"}), record("XY-III-352-01", {experiment_no: "XY-III-352"}),
  record("XY-III-352-redo", {experiment_no: "XY-III-352"}), record("XY-II-352_01", {experiment_no: "XY-II-352"}),
  record("XY-I-279", {experiment_no: "XY-I-279"}), record("XY-1-279", {experiment_no: "XY-1-279"}),
  record("custom", {experiment_no: "My reaction"}), imported];
const before = JSON.stringify(grouped), groups = groupRecords(grouped);
assert.equal(groups.length, 5, "XY-1-279 and XY-I-279 are the same notebook and merge");
assert.deepEqual(groups.find(group => group.number === "XY-I-279").records.map(r => r.sample_id), ["XY-1-279", "XY-I-279"]);
assert.deepEqual(groups.filter(group => !group.dataset).map(group => group.number), ["XY-I-279", "XY-II-352", "XY-III-352", "My reaction"], "Notebook order I < II < III, unparsed names last");
assert.deepEqual(filterRecords(grouped, {query: "XY-I-279"}).map(r => r.id).sort(), ["XY-1-279", "XY-I-279"]);
{
  const {canonicalPrecursor, canonicalExperimentNo, compareExperimentNo, compareConditionValues, missingConditions} = require("./web/app.js");
  for (const raw of ["PA12", "pa12", "CA12", "Compound A12 (CA12)"]) assert.equal(canonicalPrecursor(raw), "Compound A12 (CA12)");
  for (const raw of ["Compound A8", "compound a8", "compounda8"]) assert.equal(canonicalPrecursor(raw), "Compound A8 (CA8)");
  for (const raw of ["CA18", "Compound A18", "compounda18"]) assert.equal(canonicalPrecursor(raw), "Compound A18 (CA18)");
  assert.equal(canonicalPrecursor("a6"), "Compound A6 (CA6)");
  for (const raw of ["PX18", "PX8", "Salt B", ""]) assert.equal(canonicalPrecursor(raw), raw, "Unconfirmed names stay unmerged");
  assert.deepEqual(["Compound A18 (CA18)", "Salt B", "Compound A6 (CA6)", "Compound A12 (CA12)"].sort((a, b) => compareConditionValues(a, b)),
    ["Compound A6 (CA6)", "Compound A12 (CA12)", "Compound A18 (CA18)", "Salt B"], "Configured order first, others after");
  assert.equal(canonicalExperimentNo("XY-1-261(2)"), "XY-I-261(2)");
  assert.equal(canonicalExperimentNo("XY-1-261(2)", "other"), "XY-I-261(2)", "Configured prefixes apply in every project");
  assert.equal(canonicalExperimentNo("RUN-1-061"), "RUN-1-061");
  assert.equal(canonicalExperimentNo("XY-160-202"), "XY-160-202");
  assert.equal(canonicalExperimentNo("XY-II-212"), "XY-II-212");
  assert.deepEqual(["AA_1H", "XY-III-202", "XY-I-321", "XY-II-300", "XY-II-220"].sort(compareExperimentNo), ["XY-I-321", "XY-II-220", "XY-II-300", "XY-III-202", "AA_1H"]);
  assert.deepEqual(missingConditions([record("m1", {precursor: "PA12", temperature: 0, duration: 10, solvent: "OA", ligand: ""})]), [], "0 °C is recorded, and solvents / ligands form one condition");
  const pool = [record("p1", {precursor: "PA12", ligand: ""}), record("p2", {precursor: "CA18", ligand: "OA", temperature: 250, duration: 5, solvent: "ODE"})];
  assert.deepEqual(filterRecords(pool, {precursor: "Compound A12 (CA12)"}).map(r => r.id), ["p1"]);
  assert.deepEqual(filterRecords(pool, {condition: {field: "missing", value: "temperature"}}).map(r => r.id), ["p1"]);
  assert.deepEqual(filterRecords(pool, {query: "compound a18"}).map(r => r.id), ["p2"]);
  assert.equal(pool[0].precursor, "PA12", "Stored value is untouched");
}
{
  const {niceTicks, prepareSeries} = require("./web/app.js");
  assert.deepEqual(niceTicks(10, 90, 6), [10, 20, 30, 40, 50, 60, 70, 80, 90]);
  assert.deepEqual(niceTicks(2044, 17560, 4), [5000, 10000, 15000]);
  assert.deepEqual(niceTicks(0, 1, 4), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(niceTicks(5, 5), [5]);
  const a = {label: "a", points: [[1, 100], [2, 300]]}, b = {label: "b", points: [[1, 10], [2, 20]]};
  const normal = prepareSeries([a, b], {normalize: true});
  assert.deepEqual(normal.lines[0].points, [[1, 0], [2, 1]]);
  assert.deepEqual(normal.lines[0].raw, a.points, "Raw values kept for hover readouts");
  assert.deepEqual(a.points, [[1, 100], [2, 300]], "Source arrays are not mutated");
  const stacked = prepareSeries([a, b], {stack: true, normalize: true});
  assert.ok(stacked.lines[1].low + stacked.lines[1].offset > stacked.lines[0].high + stacked.lines[0].offset, "Stacked curves do not overlap");
  assert.equal(prepareSeries([a, b], {stack: false}).lines[1].offset, 0);
}
assert.deepEqual(groups.find(group => group.number === "XY-III-352").records.map(r => r.sample_id), ["XY-III-352-01", "XY-III-352-10", "XY-III-352-redo"]);
assert.equal(groups.at(-1).dataset, true);
assert.equal(groups.at(-1).records[0], imported);
assert.equal(JSON.stringify(grouped), before, "Grouping must not mutate stored records or arrays");
assert.deepEqual(filterRecords(grouped, {query: "my reaction"}).map(r => r.id), ["custom"]);
assert.equal(groupRecords([record("资料集-my own name")])[0].dataset, false, "User labels are not automatically datasets");
const twoProjects = [record("one", {sample_id: "S1", experiment_no: "E1", project_id: "default", project_name: "默认项目"}),
  record("two", {sample_id: "S1", experiment_no: "E1", project_id: "other", project_name: "Catalysis", files: [{kind: "Raman", name: "spectrum.txt"}]})];
assert.equal(groupRecords(twoProjects).length, 2, "Identical experiment numbers in different projects stay separate");
assert.deepEqual(filterRecords(twoProjects, {project: "other"}).map(r => r.id), ["two"]);
assert.deepEqual(filterRecords(twoProjects, {kind: "Raman"}).map(r => r.id), ["two"]);
assert.deepEqual(filterRecords(twoProjects, {query: "catalysis"}).map(r => r.id), ["two"]);
assert.equal(I18n.dataKind("温度", "en"), "温度", "Custom category labels remain literal");
assert.equal(I18n.dataKind("其他", "en"), "Other");
const sourceNotes = "批量导入：local-test。\n示例说明：\nZ:\\研究资料\\sample.csv\nName / 名称: sample.csv → {\"duration\": 0}\n未知条件保留为空，需后续核对。";
const englishNotes = I18n.notesText(sourceNotes, "en");
assert.equal(I18n.notesText(sourceNotes, "zh"), sourceNotes);
assert.match(englishNotes, /^Bulk import: local-test\./);
assert.match(englishNotes, /Example note:/);
assert(englishNotes.includes("Z:\\研究资料\\sample.csv"));
assert(englishNotes.includes('Name: sample.csv → {"duration": 0}'));
assert.match(englishNotes, /require verification/);
assert.equal(I18n.notesText("自写备注：溶液呈绿色，不能确定物相。", "en"), "自写备注：溶液呈绿色，不能确定物相。");
assert.equal(I18n.notesText("", "en"), "");
assert.equal(I18n.notesText("Already in English.", "en"), "Already in English.");
assert.equal(I18n.notesText("0 min 为示例时刻，据 script.py。", "en"), "0 min is an example time from script.py.", "Rules keep capture groups");
assert.equal(I18n.translate("温度待核对", "en"), "Temperature needs review", "Local labels extend the dictionary");
I18n.extend({});
assert.equal(I18n.notesText("0 min 为示例时刻，据 script.py。", "en"), "0 min 为示例时刻，据 script.py。", "Without local labels notes stay as written");
assert.equal(I18n.translate("温度待核对", "en"), "温度待核对");
assert.equal(I18n.translate("关闭", "en"), "Close", "Built-in labels survive a reset");
I18n.extend({noteRules: [{pattern: "^a$", replacement: "b"}], categories: {x: 1}});
I18n.extend({noteRules: [{pattern: "^a$", replacement: "c"}]});
assert.equal(I18n.notesText("a", "en"), "c", "A new catalog replaces earlier rules instead of stacking them");
I18n.extend(localTranslations);
assert.equal(filterRecords([record("imported", {notes: sourceNotes})], {language: "en", query: "example note"}).length, 1);
assert.equal(comparisonRows([record("imported", {notes: sourceNotes})], "en").find(row => row.label === "Notes").values[0], englishNotes);
{
  // Milestone 2: built-in switches, key-field resolution across template versions, missing checks, comparison rows.
  const {configureProjects, builtinEnabled, builtinCaption, keyFieldValue, missingConditions, comparisonRows: rowsOf, filterRecords: filterOf} = require("./web/app.js");
  const v1 = {revision: 1, fields: [{key: "0", label: "substrate", section: "condition", type: "single", options: ["Si"], unit: ""}]};
  const v2 = {revision: 2, fields: [{key: "3", label: "Substrate", section: "condition", type: "single", options: ["Si", "Glass"], unit: ""},
    {key: "4", label: "Thickness", section: "condition", type: "number", options: [], unit: "nm"}]};
  const v3 = {revision: 3, fields: [{key: "0", label: "Thickness", section: "condition", type: "number", options: [], unit: "um"}]};
  configureProjects({p: {revision: 1, settings: {builtin: {temperature: {enabled: false, label: {}}, precursor: {enabled: true, label: {zh: "电解液", en: ""}}}},
    fields: [{section: "condition", label: "Substrate", check_missing: true, available: true, type: "single", unit: "", options: ["Si", "Glass"]},
             {section: "condition", label: "Thickness", check_missing: false, available: true, type: "number", unit: "nm", options: []}]}});
  const old = record("old", {project_id: "p", template: v1, lab_data: {template_revision: 1, values: {0: "Si"}}});
  const now = record("now", {project_id: "p", template: v2, lab_data: {template_revision: 2, values: {3: "Glass", 4: 90}}});
  const other = record("other", {project_id: "p", template: v3, lab_data: {template_revision: 3, values: {0: 0.2}}});
  const bare = record("bare", {project_id: "p", temperature: null});
  const [substrate, thickness] = [{section: "condition", label: "Substrate", type: "single", unit: ""}, {section: "condition", label: "Thickness", type: "number", unit: "nm"}];
  assert.equal(keyFieldValue(old, substrate).value, "Si", "Labels match case-insensitively across template versions");
  assert.equal(keyFieldValue(now, thickness).value, 90);
  assert.equal(keyFieldValue(other, thickness).unitDiffers, true, "A different unit is flagged");
  assert.equal(builtinEnabled("p", "temperature"), false);
  assert.equal(builtinEnabled("", "temperature"), false, "With every project switching it off, the all-projects view hides it too");
  assert.equal(builtinCaption("p", "precursor", "en"), "电解液", "Falls back to the other language's custom label");
  assert.equal(builtinCaption("p", "duration", "en"), "Reaction / sampling time · min", "Defaults stay exact");
  assert.deepEqual(missingConditions([bare]).includes("temperature"), false, "Switched-off built-ins are not missing");
  assert.ok(missingConditions([bare]).includes("Substrate"), "check_missing key fields are reported");
  assert.equal(missingConditions([now]).includes("Thickness"), false, "Key fields without check_missing are not reported");
  const rows = rowsOf([old, now], "en");
  assert.ok(!rows.some(row => /^Temperature/.test(row.label)), "Comparison hides switched-off built-ins");
  assert.deepEqual(rows.find(row => row.label === "Thickness (nm)").values, ["", "90 nm"]);
  assert.deepEqual(filterOf([old, now, other], {project: "p", keyFilters: [{info: {...thickness}, min: "50", max: "", value: "", text: ""}]}).map(r => r.id), ["now"],
    "Range filters skip other units and missing values");
  assert.deepEqual(filterOf([old, now], {project: "p", tempMin: "999", keyFilters: []}).length, 2, "A switched-off built-in no longer filters");
  configureProjects({});
  console.log("Passed: project field settings, key fields across template versions, missing checks.");
}
console.log("Passed: range filters, unknown vs zero, attachment/condition search, archive separation, comparison differences.");
const mixed = record("mixed", {solvent: "ODE + OA", solvents: ["ODE", "OA"]});
assert.equal(filterRecords([mixed], {solvent: "OA"}).length, 1);
assert.equal(filterRecords([mixed], {solvent: "ODE + OA"}).length, 0, "Selections match solvent components, not a guessed split of the display label");
assert.equal(filterRecords([mixed], {condition: {field: "solvent", value: "OA"}}).length, 1);
assert.equal(filterRecords([mixed], {condition: {field: "solvent", value: ""}}).length, 0);
assert.equal(filterRecords([record("unknown", {solvent: "", solvents: [], ligand: ""})], {condition: {field: "solvent", value: ""}}).length, 1);
assert.equal(filterRecords([record("legacy", {solvent: "ODE + octadecane"})], {solvent: "ODE"}).length, 0);
assert.equal(filterRecords([record("ligand-only", {solvent: "", ligand: "OA"})], {solvent: "OA"}).length, 1);
assert.equal(comparisonRows([record("merged", {solvent: "OA", solvents: ["OA", "ODE"], ligand: "OA"})]).find(row => row.label === "溶剂 / 配体").values[0], "OA + ODE");
{
  const {materialSummary} = require("./web/app.js");
  const withAmounts = record("amounts", {solvents: ["ODE", "OA"], material_amounts: [{name: "ODE", amount: 5.5, unit: "mL"}, {name: "OA", amount: 0, unit: "mmol"}]});
  assert.equal(materialSummary(withAmounts), "ODE (5.5 mL) + OA (0 mmol)");
  assert.equal(filterRecords([withAmounts], {query: "5.5 ml"}).length, 1);
  assert.equal(filterRecords([withAmounts], {condition: {field: "solvent", value: "OA"}}).length, 1, "Condition grouping continues to use material names");
  assert.equal(comparisonRows([withAmounts, {...withAmounts, material_amounts: []}]).find(row => row.label === "溶剂 / 配体").different, true);
}
{
  const {recordMatchesPayload} = require("./web/app.js");
  const payload = {sample_id: " XY-III-352-01 ", experiment_no: "", project_id: "default", solvents: ["ODE", " OA ", "ODE"], solvent: "ignored summary", ligand: "", notes: " new note ", temperature: 0, duration: 2.5, revision: 1};
  const saved = {...payload, sample_id: "XY-III-352-01", experiment_no: "XY-III-352", solvents: ["ODE", "OA"], solvent: "ODE + OA", notes: "new note", revision: 2, files: [{id: "preserved"}]};
  assert.equal(recordMatchesPayload(saved, payload), true, "A committed write can be confirmed despite a lost response");
  assert.equal(recordMatchesPayload({...saved, notes: "Different window"}, payload), false, "Different content is a genuine conflict");
  assert.equal(recordMatchesPayload({...saved, temperature: null}, payload), false, "Unknown and zero remain distinct during recovery");
  const material_amounts = [{name: "OA", amount: 0, unit: "mmol"}];
  assert.equal(recordMatchesPayload({...saved, material_amounts}, {...payload, material_amounts}), true);
  assert.equal(recordMatchesPayload({...saved, material_amounts: [{name: "OA", amount: 0, unit: "mL"}]}, {...payload, material_amounts}), false, "A different unit cannot confirm a save");
}
{
  const {snipBackground, processSeries} = require("./web/app.js");
  // Synthetic XRD: sloped baseline + broad hump + sharp peak at 2θ = 40°.
  const pts = [];
  for (let x = 10; x <= 90.0001; x += 0.02) pts.push([Number(x.toFixed(2)), 1000 - 5 * x + 400 * Math.exp(-((x - 20) ** 2) / (2 * 6 ** 2)) + 5000 * Math.exp(-((x - 40) ** 2) / (2 * 0.15 ** 2))]);
  const copy = JSON.stringify(pts);
  const out = processSeries(pts, {background: true, normalize: true, window: 1});
  assert.equal(JSON.stringify(pts), copy, "Raw points are not modified");
  const at = x => out[Math.round((x - 10) / 0.02)][1];
  assert.ok(Math.abs(at(40) - 1) < 0.02, "Peak becomes ~1 after background removal");
  for (const x of [15, 30, 60, 80]) assert.ok(Math.abs(at(x)) < 0.03, `Baseline near 0 at ${x}° (got ${at(x)})`);
  const wide = processSeries(pts, {background: true, normalize: true, window: 4});
  assert.ok(wide[Math.round((20 - 10) / 0.02)][1] > at(20) + 0.03, "A wider window keeps more of the broad hump as signal");
  for (const x of [10.1, 89.9]) assert.ok(Math.abs(at(x)) < 0.01, `Edges are clipped too (${x}°)`);
  const bkg = snipBackground(pts.map(p => p[1]), 150);
  assert.ok(bkg.every((value, i) => value <= pts[i][1] + 1e-6), "Background never exceeds the data");
  assert.deepEqual(processSeries(pts), pts, "No options → unchanged");
  const minmax = processSeries([[1, 10], [2, 30], [3, 20]], {normalize: true});
  assert.deepEqual(minmax.map(p => p[1]), [0, 1, 0.5]);
}
console.log("Passed: SNIP background subtraction and normalization.");
{
  const {processSeries} = require("./web/app.js");
  const pts = [[10, 110], [11, 150], [12, 130]], bkg = [100, 100, 110];
  assert.deepEqual(processSeries(pts, {background: true, backgroundValues: bkg}).map(p => p[1]), [10, 50, 20], "File bkg column is subtracted directly");
  assert.deepEqual(processSeries(pts, {background: true, normalize: true, backgroundValues: bkg}).map(p => p[1]), [0.2, 1, 0.4]);
  assert.notDeepEqual(processSeries(pts, {background: true, backgroundValues: [1, 2]}).map(p => p[1]), [109, 148, 130], "Misaligned bkg falls back to the automatic estimate");
  assert.deepEqual(processSeries(pts, {normalize: true, backgroundValues: bkg}).map(p => p[1]), [0, 1, 0.5], "bkg ignored when subtraction is off");
}
console.log("Passed: file bkg column subtraction.");
{
  const {resultSummary, resultConfirmation, recordMatchesPayload} = require("./web/app.js");
  const confirmed = record("result", {solvent: "ODE", temperature: 250, result_summary: {phases: ["Phase-A2", "Phase-A"], morphologies: ["nanoparticles"], confirmation: "confirmed", conclusion: "Mixed phases", evidence_ids: ["xrd"]}, files: [{id: "xrd", name: "pattern.csv", kind: "XRD"}]});
  const pending = record("pending", {result_summary: {phases: ["Phase-A2"], confirmation: "pending"}});
  const pool = [confirmed, pending, record("unknown"), imported, {...confirmed, id: "archived-result", archived: true}];
  const ids = filters => filterRecords(pool, filters).map(row => row.id);
  assert.deepEqual(ids({phase: "Phase-A2", resultConfirmation: "confirmed", solvent: "ODE", tempMin: "250"}), ["result"]);
  assert.deepEqual(ids({phase: "Phase-A"}), ["result"], "Phase tags match exactly rather than matching Phase-A2 by substring");
  assert.deepEqual(ids({morphology: "nanoparticles"}), ["result"]);
  assert.deepEqual(ids({resultConfirmation: "pending"}), ["pending"]);
  assert.deepEqual(ids({resultConfirmation: "unrecorded"}), ["unknown"], "Imported document collections are not missing experimental outcomes");
  assert.equal(filterRecords([{...imported, result_summary: confirmed.result_summary}], {phase: "Phase-A2"}).length, 0, "Result filtering only lists samples");
  assert.deepEqual(ids({query: "mixed phases"}), ["result"]);
  assert.deepEqual(ids({query: "nanoparticles"}), ["result"]);
  assert.deepEqual(ids({query: "confirmed", language: "en"}), ["result"]);
  assert.deepEqual(ids({archived: true, phase: "Phase-A2"}), ["archived-result"]);
  assert.equal(resultConfirmation(confirmed, "en"), "Confirmed");
  assert.equal(resultSummary(record("blank")).confirmation, "");
  const rows = comparisonRows([confirmed, pending], "en");
  assert.deepEqual(rows.find(row => row.label === "Phase").values, ["Phase-A2 / Phase-A", "Phase-A2"]);
  assert.equal(rows.find(row => row.label === "Result confirmation").different, true);
  assert.deepEqual(rows.find(row => row.label === "Supporting measurements").values, ["XRD · pattern.csv", ""]);
  const payload = {sample_id: "result", experiment_no: "result", solvents: ["ODE"], solvent: "ODE", result_summary: {phases: [" Phase-A2 ", "Phase-A2"], conclusion: " Mixed phases "}};
  const saved = {...payload, result_summary: {phases: ["Phase-A2"], morphologies: [], confirmation: "pending", conclusion: "Mixed phases", evidence_ids: []}};
  assert.equal(recordMatchesPayload(saved, payload), true, "Lost-response confirmation normalizes nested result data");
  assert.equal(recordMatchesPayload({...saved, result_summary: {...saved.result_summary, evidence_ids: ["different"]}}, payload), false);
  const pinned = {template_revision: 1, values: {"0": 0}};
  assert.equal(recordMatchesPayload({...saved, lab_data: pinned}, {...payload, lab_data: pinned, copy_from: "source-id"}), true);
  assert.equal(recordMatchesPayload(saved, {...payload, lab_data: {template_revision: 0}}), true);
}
console.log("Passed: sample result filters, evidence comparison and nested save recovery.");
