// DOM integration checks only. No browser or real experimental data is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {JSDOM, VirtualConsole} = require("./.test-tools/node_modules/jsdom");
const I18n = require("./web/i18n.js");
const localCatalog = require("./test_catalog.json");
const translations = localCatalog.translations;
I18n.extend(translations);
const html = fs.readFileSync(path.join(__dirname, "web/index.html"), "utf8");
const scripts = ["i18n.js", "app.js"].map(name => fs.readFileSync(path.join(__dirname, "web", name), "utf8")).join("\n");
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const sample = (id, fields = {}) => ({id, sample_id: id, experiment_no: id, project_id: "default", project_name: "默认项目", series: "示例系列", experiment_date: "", precursor: "PA12", temperature: 250, duration: 60, solvent: "ODE", ligand: "OA", material_amounts: [], notes: "中文原始记录，不应被翻译", status: "待补全", archived: false, extra_conditions: [], files: [], revision: 1, updated_at: "2026-11-14T12:00:00Z", ...fields});

async function boot({savedLanguage, savedTheme, savedProject, savedOrder, systemDark = false, mobile = false, unavailableStorage = false, offline = false, desktop = false, extraRows = [], extraProjects = [], extraKinds = [], previewHandler, conditionHandler, readHandler, recordHandler, sharedHandler, bulkHandler, workflowHandler, backupHandler, attachmentHandler, settingsHandler, m3Handler, deleteError, statusError, savedConditions = {}} = {}) {
  const console = new VirtualConsole();
  const errors = [];
  console.on("jsdomError", error => errors.push(error));
  const dom = new JSDOM(html, {url: "http://127.0.0.1:8765/" + (desktop ? "?desktop=1" : ""), runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: console});
  const w = dom.window, rows = [sample("A", {files: [{id: "f1", name: "pattern.csv", kind: "XRD", size: 10, sha256: "1234567890abcdef", source: "local source"}]}), sample("ZERO", {temperature: 0, duration: 0, files: [{id: "f2", name: "spectrum.csv", kind: "NMR", size: 10, sha256: "1234567890abcdef", source: ""}]}), sample("ARCHIVED", {archived: true})];
  const writes = [], confirmations = [], scrollCalls = [];
  const projects = [{id: "default", name: "默认项目"}, ...extraProjects], kinds = ["XRD", "NMR", "TEM", "SEM", "XPS", "DFT", "其他", ...extraKinds];
  rows.push(...extraRows);
  const condition_options = Object.fromEntries(["precursor", "solvent", "ligand", "temperature", "duration"].map(field => [field, [...new Set([...(savedConditions[field] || []), ...rows.flatMap(row => field === "solvent" ? row.solvents || [row.solvent] : [row[field]])].filter(value => value !== "" && value !== null && value !== undefined).map(String))]]));
  const hiddenOptions = new Set();
  const seedOptions = row => {
    for (const field of Object.keys(condition_options)) for (const value of field === "solvent" ? row.solvents : [row[field]]) {
      if (value !== "" && value !== null && value !== undefined && !hiddenOptions.has(field + ":" + value) && !condition_options[field].includes(String(value))) condition_options[field].push(String(value));
    }
  };
  w.matchMedia = query => ({matches: query.includes("prefers-color-scheme") ? systemDark : mobile});
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.scrollTo = (...args) => scrollCalls.push(args);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.confirm = message => { confirmations.push(message); return true; };
  if (savedLanguage) w.localStorage.setItem("catalog-language", savedLanguage);
  if (savedTheme) w.localStorage.setItem("catalog-theme", savedTheme);
  if (savedOrder) w.localStorage.setItem("catalog-experiment-order", savedOrder);
  if (savedProject !== undefined) w.localStorage.setItem("catalog-project", savedProject);
  if (unavailableStorage) Object.defineProperty(w, "localStorage", {get() {throw new Error("Unavailable");}});
  w.fetch = async (url, options = {}) => {
    if (typeof url === "string" && url.startsWith("api/")) url = "/" + url;  // The page uses relative URLs under /s/{instance}/.
    if (offline) throw new Error("Offline");
    if (workflowHandler && (url.startsWith("/api/history") || url.startsWith("/api/reviews"))) return workflowHandler(url, options, rows);
    if (m3Handler && (url.startsWith("/api/demo") || url.startsWith("/api/onboarding") || url.startsWith("/api/import/") || url === "/api/templates" || /^\/api\/projects\/[^/]+(\/preset)?$/.test(url))) {
      return m3Handler(url, options, rows);
    }
    if (url.startsWith("/api/projects/") || url.startsWith("/api/local-catalog")) {
      assert(settingsHandler, "Unexpected settings request: " + url);
      return settingsHandler(url, options);
    }
    if (url.startsWith("/api/trash") || /^\/api\/files\/[^/?]+\/(update|delete)$/.test(url)) {
      assert(attachmentHandler, "Unexpected attachment request: " + url);
      return attachmentHandler(url, options, rows);
    }
    if (url.startsWith("/api/backup/")) { assert(backupHandler, "Unexpected backup request: " + url); return backupHandler(url, options); }
    if (url.startsWith("/api/experiment-defaults?")) return {ok: true, json: async () => sharedHandler ? sharedHandler(new URL(url, w.location.origin).searchParams, rows) : {}};
    if (url.endsWith("/preview")) return previewHandler ? previewHandler(url) : {ok: true, json: async () => ({rows: [["angle", "intensity"], ["1", "2"], ["3", "4"]], points: [[1, 2], [3, 4]], labels: ["angle", "intensity"], truncated: false})};
    if (!options.method || options.method === "GET") {
      const catalog = structuredClone({experiments: rows, projects, kinds, condition_options, translations, conventions: localCatalog});
      return readHandler ? readHandler(catalog, options) : {ok: true, json: async () => catalog};
    }
    if (options.method === "POST" && url.includes("/files?")) {
      const kind = new URL(url, w.location.origin).searchParams.get("kind");
      writes.push({url, kind, file: options.body});
      return {ok: true, json: async () => ({id: "uploaded"})};
    }
    const payload = JSON.parse(options.body);
    writes.push({url, payload, method: options.method});
    if (url === "/api/experiments/bulk" && options.method === "POST") {
      assert(bulkHandler, "Unexpected bulk request");
      return bulkHandler(payload, rows, options);
    }
    if (["POST", "DELETE"].includes(options.method) && url === "/api/condition-options") {
      if (conditionHandler) return conditionHandler(payload, options);
      const name = payload.name.trim();
      if (options.method === "DELETE") {
        for (const field of ["solvent", "ligand"].includes(payload.field) ? ["solvent", "ligand"] : [payload.field]) {
          hiddenOptions.add(field + ":" + name);
          condition_options[field] = condition_options[field].filter(value => value !== name);
        }
        return {ok: true, json: async () => ({field: payload.field, name})};
      }
      if (condition_options[payload.field].includes(name)) return {ok: false, json: async () => ({error: "该名称已存在，请直接选择或使用其他名称。"})};
      hiddenOptions.delete(payload.field + ":" + name);
      condition_options[payload.field].push(name);
      return {ok: true, json: async () => ({field: payload.field, name})};
    }
    if (options.method === "POST" && url === "/api/experiments/status") {
      if (statusError) return {ok: false, json: async () => ({error: statusError})};
      for (const item of payload.records) {
        const row = rows.find(row => row.id === item.id);
        assert.equal(row.revision, item.revision);
        row.status = payload.status; row.revision++;
      }
      return {ok: true, json: async () => ({ok: true, updated: payload.records.length})};
    }
    if (options.method === "DELETE" && url === "/api/categories") {
      if (deleteError) return {ok: false, json: async () => ({error: deleteError})};
      const moved = rows.flatMap(row => row.files).filter(file => file.kind === payload.name).length;
      kinds.splice(kinds.indexOf(payload.name), 1);
      for (const row of rows) {
        if (row.files.some(file => file.kind === payload.name)) row.revision++;
        for (const file of row.files) if (file.kind === payload.name) file.kind = payload.replacement;
      }
      return {ok: true, json: async () => ({ok: true, moved})};
    }
    if (options.method === "POST" && url === "/api/experiments" && !recordHandler) return {ok: false, json: async () => ({error: "该项目内样品编号已存在（含已归档记录）。请使用不同编号。"})};
    if (options.method === "POST" && ["/api/projects", "/api/categories"].includes(url)) {
      const name = payload.name.trim();
      if ((url === "/api/projects" ? projects.map(p => p.name) : kinds).some(value => value.toLowerCase() === name.toLowerCase()))
        return {ok: false, json: async () => ({error: "该名称已存在，请直接选择或使用其他名称。"})};
      if (url === "/api/projects") {
        const project = {id: "p" + projects.length, name}; projects.push(project);
        return {ok: true, json: async () => ({project})};
      }
      kinds.push(name);
      return {ok: true, json: async () => ({kind: name})};
    }
    if (options.method === "PUT") {
      const row = rows.find(item => item.id === url.split("/").at(-1));
      if (recordHandler) return recordHandler(row, payload, options);
      if (row.revision !== payload.revision) return {ok: false, status: 409, json: async () => ({error: "这条记录已在其他窗口更新。请保留当前内容，关闭编辑窗口后刷新再编辑。"})};
      Object.assign(row, payload, {solvent: payload.solvents.join(" + "), revision: row.revision + 1});
      seedOptions(row);
      return {ok: true, json: async () => ({id: row.id, record: structuredClone(row), condition_options: structuredClone(condition_options)})};
    }
    if (options.method === "POST" && url === "/api/experiments") {
      const row = sample("created", {...payload, solvent: (payload.solvents || []).join(" + "), ligand: payload.ligand || ""});
      rows.push(row);
      return recordHandler ? recordHandler(row, payload, options) : {ok: true, json: async () => ({id: row.id, record: structuredClone(row)})};
    }
    throw new Error("Unexpected test request: " + url);
  };
  w.eval(scripts);
  await flush();
  assert.deepEqual(errors, []);
  return {dom, w, rows, writes, confirmations, scrollCalls, projects, kinds, $: id => w.document.getElementById(id)};
}

(async () => {
  const desktop = await boot({desktop: true, savedLanguage: "en"});
  try {
    const {$, w} = desktop;
    assert.equal(w.confirmCatalogClose(), true);
    $("new-record").click();
    $("record-form").elements.sample_id.value = "Unsaved trial";
    $("record-form").elements.sample_id.dispatchEvent(new w.Event("input", {bubbles: true}));
    w.confirm = message => { assert.match(message, /unsaved changes/); return false; };
    assert.equal(w.confirmCatalogClose(), false);
    const source = w.document.querySelector('a[href="notices.txt"]');
    source.addEventListener("click", event => event.preventDefault());
    source.click();
    assert.equal(source.target, "");
    assert.equal(source.hasAttribute("download"), true);
  } finally { desktop.dom.window.close(); }

  {
    const shared = {precursors: ["Ni source", "Se source"], temperature: 250,
      materials: {solvents: ["ODE"], material_amounts: [{name: "ODE", amount: 0.5, unit: "g"}]}};
    const token = "a".repeat(64);
    let lastSave = "";
    const env = await boot({
      savedLanguage: "en", extraProjects: [{id: "other-lab", name: "Other lab"}],
      extraRows: [sample("first-aliquot", {experiment_no: "XY-I-780", duration: 5}), sample("second-aliquot", {experiment_no: "XY-I-780", duration: 10})],
      sharedHandler: (query) => ({token, last_save: lastSave, conditions: query.get("project_id") === "default" && query.get("experiment_no") === "xy-i-780" ?
        shared : {precursors: [], temperature: null, materials: {solvents: [], material_amounts: []}}}),
      recordHandler: (row, payload) => {
        Object.assign(row, payload, {solvent: (payload.solvents || []).join(" + "), revision: row.revision + 1});
        if (!payload.shared_token) return {ok: true, json: async () => ({record: structuredClone(row)})};
        const second = env.rows.find(item => item.id === "second-aliquot");
        second.temperature = payload.temperature;
        second.revision++;
        lastSave = payload.shared_token + ":" + row.id;
        return {ok: true, json: async () => { throw Error("Lost shared save response"); }};
      }
    });
    try {
      const {$, w, writes, rows} = env;
      const form = $("record-form");
      const input = (control, value, event = "change") => {
        control.value = value;
        control.dispatchEvent(new w.Event(event, {bubbles: true}));
      };
      const submit = () => form.dispatchEvent(new w.Event("submit", {cancelable: true}));
      $("experiment-view").click();
      w.document.querySelector('[data-workspace-key="experiment:default:xy-i-780"]').click();
      $("workspace-add-sample").click();
      await flush();
      assert.equal(form.elements.experiment_no.value, "XY-I-780");
      assert.equal($("editor-temperature").value, "250");
      assert.equal($("editor-duration").value, "");
      assert.deepEqual([...$("editor-precursors").querySelectorAll("input:checked")].map(item => item.value), ["Ni source", "Se source"]);
      assert.equal($("editor-solvents").querySelector('input[type="checkbox"]:checked').closest(".material-option").querySelector("select").value, "g");
      assert.match($("editor-inherited-conditions").textContent, /prefilled/);
      input(form.elements.sample_id, "XY-I-780_12");
      input($("editor-temperature"), "220", "input");
      input($("editor-duration"), "12.5", "input");
      input($("editor-project"), "other-lab");
      await flush();
      assert.equal($("editor-temperature").value, "220");
      assert.equal($("editor-solvents").querySelector("input:checked"), null);
      input($("editor-project"), "default");
      await flush();
      $("language-switch").click();
      $("language-switch").click();
      assert.equal($("editor-duration").value, "12.5");
      submit();
      await flush();
      assert.equal(writes.at(-1).payload.shared_token, undefined);
      assert.deepEqual(writes.at(-1).payload.material_amounts, shared.materials.material_amounts);
      assert.equal(writes.at(-1).payload.temperature, 220);
      assert.equal(rows.find(item => item.id === "second-aliquot").temperature, 250);
      $("close-detail").click();

      $("workspace-sample").value = "first-aliquot";
      $("workspace-sample").dispatchEvent(new w.Event("change"));
      $("workspace-edit-record").click();
      await flush();
      assert.equal($("editor-shared-conditions").hidden, false);
      $("editor-share-conditions").click();
      assert.match($("save-record").textContent, /update shared conditions/);
      input($("editor-temperature"), "270", "input");
      submit();
      await flush();
      await flush();
      assert.equal(writes.at(-1).payload.shared_token, token);
      assert.equal($("editor").open, false, "Verify a lost reply against the committed shared save");
      assert.equal(writes.length, 2);
      $("close-detail").click();
      $("workspace-sample").value = "second-aliquot";
      $("workspace-sample").dispatchEvent(new w.Event("change"));
      assert.match($("workspace-conditions").textContent, /270/);
      assert.match($("workspace-conditions").textContent, /10/);
    } finally { env.dom.window.close(); }
  }

  {
    let commitCount = 0, finishCommit, undone = false, commitBody;
    const batchId = "a".repeat(32);
    const env = await boot({savedLanguage: "en", workflowHandler: async (url, options, rows) => {
      const respond = data => ({ok: true, json: async () => structuredClone(data)});
      if (url.startsWith("/api/history?")) return respond({batches: [{id: batchId, action: "bulk", source: "app", created_at: "2026-11-17T12:00:00Z", count: 2, remaining: undone ? 0 : 2}], has_more: false});
      const changes = ["A", "ZERO"].map((id, index) => ({id, sample_id: id, project_id: "default", revision: rows.find(row => row.id === id).revision, reverted_by: undone ? "undo-id" : null, changes: [{field: "temperature", before: index ? 200 : 100, after: index ? 0 : 250}]}));
      if (url === "/api/history/" + batchId) return respond({id: batchId, action: "bulk", created_at: "2026-11-17T12:00:00Z", rows: changes});
      const payload = JSON.parse(options.body);
      if (payload.preview) return respond({preview: true, updated: 2, rows: changes.map(row => ({...row, changes: row.changes.map(change => ({...change, before: change.after, after: change.before}))})), revisions: changes.map(({id, revision}) => ({id, revision}))});
      commitCount++; commitBody = payload;
      await new Promise(resolve => { finishCommit = resolve; });
      for (const [index, id] of ["A", "ZERO"].entries()) { const row = rows.find(row => row.id === id); row.temperature = index ? 200 : 100; row.revision++; }
      undone = true;
      return respond({records: rows.slice(0, 2)});
    }});
    try {
      env.$("history-view").click(); await flush(); await flush();
      assert.equal(env.$("history-dialog").open, true);
      env.w.document.querySelector("[data-history-batch]").click(); await flush(); await flush();
      assert.match(env.$("history-content").textContent, /250/);
      env.$("preview-undo").click(); await flush(); await flush();
      assert.equal(commitCount, 0);
      assert.equal(env.$("confirm-undo").hidden, false);
      env.$("confirm-undo").click(); env.$("confirm-undo").click(); await flush();
      assert.equal(commitCount, 1);
      assert.equal(Object.hasOwn(commitBody, "record_ids"), false, "A whole-batch undo names no records, so batches over 500 samples can be undone");
      finishCommit(); await flush(); await flush();
      assert.match(env.$("history-content").textContent, /Undone/);
      assert.equal(env.rows[0].temperature, 100);
      env.$("close-history").click();
    } finally { env.dom.window.close(); }
  }
  {
    let commits = 0, conflict = true;
    const item = {id: "b".repeat(32), record_id: "A", project_id: "default", experiment_no: "A", sample_id: "A", title: "温度待核对", field: "temperature", kind: "conflict", status: "pending", revision: 1, record_revision: 1, generated: false,
      sources: [{label: "Notebook", value: 200, candidate: true, source_id: "c".repeat(32)}]};
    const env = await boot({savedLanguage: "en", workflowHandler: async (url, options, rows) => {
      const respond = data => ({ok: true, json: async () => structuredClone(data)});
      if (!options.method) return respond({items: [item]});
      const payload = JSON.parse(options.body);
      if (payload.preview) return respond({preview: true, changes: [{field: "temperature", before: 250, after: payload.value}]});
      commits++;
      if (conflict) return {ok: false, status: 409, json: async () => ({error: "样品已有后续修改，请刷新后再核对。"})};
      rows[0].temperature = payload.value; rows[0].revision++;
      item.status = "resolved"; item.revision++;
      return respond({});
    }});
    try {
      env.$("review-view").click(); await flush(); await flush();
      env.w.document.querySelector("[data-review-item]").click();
      assert.match(env.$("review-content").innerHTML, /api\/review-sources/);
      assert.equal(env.$("confirm-review").textContent, "Mark as reviewed");
      assert.equal(env.$("confirm-review").hidden, false);
      env.w.document.querySelector("[data-review-candidate]").click();
      assert.equal(env.$("confirm-review").hidden, true, "Selecting a proposed value requires a preview");
      assert.equal(env.$("review-value").value, "200");
      env.$("review-note").value = "Notebook page checked";
      env.$("review-note").dispatchEvent(new env.w.Event("input", {bubbles: true}));
      const originalConfirm = env.w.confirm;
      env.w.confirm = () => false;
      env.$("review-edit-record").click();
      assert.equal(env.$("editor").open, false, "Entering the editor must not silently discard a review draft");
      assert.equal(env.$("review-note").value, "Notebook page checked");
      env.w.confirm = originalConfirm;
      env.$("language-switch").click();
      assert.equal(env.$("review-value").value, "200");
      assert.equal(env.$("review-note").value, "Notebook page checked");
      env.$("preview-review").click(); await flush(); await flush();
      assert.equal(commits, 0);
      assert.equal(env.$("confirm-review").textContent, "确认回填");
      assert.equal(env.$("review-change-preview").hidden, false);
      env.$("confirm-review").click(); await flush(); await flush();
      assert.equal(commits, 1);
      assert.equal(env.rows[0].temperature, 250);
      assert.equal(env.$("review-value").value, "200");
      assert.equal(env.$("review-note").value, "Notebook page checked");
      assert.equal(env.$("confirm-review").hidden, true);
      assert.match(env.$("review-error").textContent, /后续修改/);
      conflict = false;
      env.$("preview-review").click(); await flush(); await flush();
      env.$("confirm-review").click(); env.$("confirm-review").click(); await flush(); await flush();
      assert.equal(commits, 2);
      assert.equal(env.rows[0].temperature, 200);
      assert.equal(env.$("review-content").querySelector("[data-review-item]"), null);
    } finally { env.dom.window.close(); }
  }
  {
    const item = {id: "d".repeat(32), record_id: "A", project_id: "default", sample_id: "A", experiment_no: "A",
      title: "缺少实验条件", kind: "missing_conditions", field: "", status: "pending", revision: 0, record_revision: 1,
      generated: true, sources: [], missing: ["temperature"]};
    const requests = [];
    const env = await boot({savedLanguage: "zh", workflowHandler: async (url, options) => {
      const respond = data => ({ok: true, json: async () => structuredClone(data)});
      if (!options.method) return respond({items: [item]});
      const payload = JSON.parse(options.body);
      requests.push(payload);
      if (url === "/api/reviews") { item.generated = false; item.revision = 1; return respond({revision: 1}); }
      item.status = payload.status;
      item.revision++;
      return respond({changes: []});
    }});
    try {
      const {$, w} = env;
      $("review-view").click(); await flush();
      w.document.querySelector("[data-review-item]").click();
      assert.equal($("confirm-review").textContent, "确认已核对");
      assert.equal($("preview-review").hidden, true);
      $("confirm-review").click(); $("confirm-review").click();
      await flush(); await flush();
      assert.deepEqual(requests[0], {issue_id: item.id});
      assert.equal(requests.length, 2);
      assert.equal(requests[1].preview, false);
      assert.equal(requests[1].apply_value, false);
      assert.equal(requests[1].note, "");
      assert.equal(w.document.querySelector("[data-review-item]"), null);
      $("review-status").value = "resolved";
      $("review-status").dispatchEvent(new w.Event("input"));
      w.document.querySelector("[data-review-item]").click();
      assert.equal($("confirm-review").textContent, "重新打开");
      $("review-outcome").value = "dismissed";
      $("review-outcome").dispatchEvent(new w.Event("input", {bubbles: true}));
      assert.equal($("confirm-review").textContent, "确认暂不采用");
      $("confirm-review").click();
      assert.equal(requests.length, 2, "Missing dismissal notes do not submit a decision");
      assert.match($("review-error").textContent, /请填写处理说明/);
      $("review-outcome").value = "pending";
      $("review-outcome").dispatchEvent(new w.Event("input", {bubbles: true}));
      $("confirm-review").click(); await flush(); await flush();
      assert.equal(requests.length, 3);
      assert.equal(requests[2].status, "pending");
      assert.equal(requests[2].preview, false);
      assert.equal(item.status, "pending");
    } finally { env.dom.window.close(); }
  }
  const env = await boot();
  const {dom, w, $, writes, confirmations} = env;
  try {
    assert.equal($("stat-total").textContent, "2");
    assert.match(w.document.title, /实验数据目录/);
    assert.equal($("page-title").textContent, "实验管理");
    assert.equal(w.document.documentElement.classList.contains("dark"), false);
    $("theme-switch").click();
    assert.equal(w.document.documentElement.classList.contains("dark"), true);
    assert.equal(w.localStorage.getItem("catalog-theme"), "dark");
    assert.equal($("theme-label").textContent, "浅色");
    const attrs = ["data-i18n", "data-i18n-placeholder", "data-i18n-aria-label", "data-i18n-title"];
    for (const attr of attrs) for (const element of w.document.querySelectorAll(`[${attr}]`)) {
      const key = element.getAttribute(attr);
      assert(!/[\u3400-\u9fff]/u.test(key) || Object.hasOwn(I18n.en, key), `Missing English: ${key}`);
    }
    $("language-switch").click();
    assert.equal(w.document.documentElement.lang, "en");
    assert.equal(w.localStorage.getItem("catalog-language"), "en");
    assert.equal($("page-title").textContent, "Experiments");
    assert.equal($("language-label").textContent, "中文");
    assert.equal($("theme-label").textContent, "Light");
    assert.equal($("theme-switch").getAttribute("aria-label"), "Switch to light theme");
    assert.match(w.document.title, /Experiment Data Catalog/);
    $("dashboard-records-tab").click();
    for (const id of ["a", "zero"]) w.document.querySelector(`[data-expand="experiment:default:${id}"]`).click();
    assert.match($("records").textContent, /Incomplete/);
    assert.match($("records").textContent, /Example series/);
    $("temp-min").value = "0"; $("temp-max").value = "0";
    $("temp-min").dispatchEvent(new w.Event("input", {bubbles: true}));
    assert.equal($("records").querySelectorAll(".experiment-group").length, 1);
    assert.match($("records").textContent, /ZERO/);
    $("language-switch").click();
    assert.equal($("temp-min").value, "0");
    assert.equal($("records").querySelectorAll(".experiment-group").length, 1);
    $("language-switch").click();
    $("clear-filters").click();
    for (const id of ["A", "ZERO"]) {
      const input = w.document.querySelector(`[data-select="${id}"]`);
      input.checked = true; input.dispatchEvent(new w.Event("change", {bubbles: true}));
    }
    $("compare").click();
    assert.equal($("comparison").open, true);
    assert.match($("comparison-table").textContent, /Temperature \/ °C/);
    assert.match($("comparison-table").textContent, /Incomplete/);
    assert.match($("comparison-table").textContent, /中文原始记录/);
    $("close-comparison").click();
    $("clear-selection").click();
    w.document.querySelector('[data-open="A"]').click();
    assert.equal($("detail").open, true);
    assert.match($("detail-content").textContent, /Observations and notes/);
    assert.match($("detail-content").textContent, /中文原始记录，不应被翻译/);
    $("upload-button").click();
    assert.equal($("upload-error").textContent, "Choose data files first.");
    $("edit-record").click();
    const form = $("record-form");
    assert.equal(form.elements.series.value, "Example series");
    assert.equal(form.elements.experiment_date.type, "text");
    assert.equal(form.elements.experiment_date.placeholder, "YYYY-MM-DD");
    assert.equal(form.elements.precursor.value, "PA12", "Editing keeps the stored precursor spelling instead of clearing it");
    assert.match($("editor-precursors").textContent, /Compound A12 \(CA12\)/);
    assert.equal($("editor-precursors").querySelector("input:checked").value, "PA12", "Display aliases preserve the recorded spelling");
    form.elements.sample_id.value = "UNSAVED";
    form.elements.experiment_no.value = "Manual grouping";
    form.elements.temperature.value = "0";
    form.elements.status.value = "已完成";
    form.elements.experiment_date.value = "2024-02-29";
    form.elements.sample_id.dispatchEvent(new w.Event("input", {bubbles: true}));
    $("add-condition").click();
    const custom = $("extra-conditions").querySelectorAll("input");
    custom[0].value = "气氛"; custom[1].value = "氮气"; custom[2].value = "";
    $("language-switch").click();
    assert.equal(form.elements.series.value, "示例系列");
    assert.equal(form.elements.experiment_date.placeholder, "年-月-日");
    $("language-switch").click();
    $("theme-switch").click();
    $("theme-switch").click();
    assert.equal(form.elements.sample_id.value, "UNSAVED");
    assert.equal(form.elements.experiment_no.value, "Manual grouping");
    assert.equal(form.elements.temperature.value, "0");
    assert.equal(form.elements.status.value, "已完成");
    assert.equal(form.elements.series.value, "Example series");
    assert.equal(form.elements.experiment_date.value, "2024-02-29");
    assert.equal(custom[1].value, "氮气");
    assert.equal($("editor-title").textContent, "Edit experiment");
    assert.equal(writes.length, 0, "Changing language must not write experiment data");
    form.dispatchEvent(new w.Event("submit", {bubbles: true, cancelable: true}));
    await flush(); await flush();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].payload.status, "已完成");
    assert.equal(writes[0].payload.temperature, 0);
    assert.equal(writes[0].payload.experiment_no, "Manual grouping");
    assert.equal(writes[0].payload.series, "示例系列");
    assert.equal(writes[0].payload.experiment_date, "2024-02-29");
    assert.equal(writes[0].payload.notes, "中文原始记录，不应被翻译");
    assert.equal(writes[0].payload.extra_conditions[0].value, "氮气");
    assert.equal($("detail").open, true);
    $("close-detail").click();
    $("new-record").click();
    assert.equal(form.elements.series.value, "", "A new form must not inherit the previous stored series");
    form.elements.sample_id.value = "DATE-CHECK";
    for (const date of ["2026-02-30", "2026-02-29", "0000-01-01", "2026-2-3", "10000-01-01"]) {
      form.elements.experiment_date.value = date;
      form.dispatchEvent(new w.Event("submit", {bubbles: true, cancelable: true}));
      assert.equal(writes.length, 1, "Invalid dates must be rejected before saving");
      assert.equal($("form-error").textContent, "Use a valid date in YYYY-MM-DD format.");
      assert.equal(form.elements.experiment_date.value, date, "Validation preserves the draft");
    }
    form.elements.experiment_date.value = "";
    form.elements.sample_id.value = "A";
    form.dispatchEvent(new w.Event("submit", {bubbles: true, cancelable: true}));
    await flush();
    assert.equal($("editor").open, true);
    assert.match($("form-error").textContent, /This sample ID already exists/);
    assert.equal(form.elements.sample_id.value, "A");
    form.elements.sample_id.dispatchEvent(new w.Event("input", {bubbles: true}));
    $("cancel-editor").click();
    assert.match(confirmations.at(-1), /unsaved changes/);
    $("archived-view").click();
    assert.equal($("page-title").textContent, "Archived experiments");
    w.document.querySelector('[data-expand="experiment:default:archived"]').click();
    w.document.querySelector('[data-open="ARCHIVED"]').click();
    assert.equal($("archive-record").textContent, "Restore record");
    $("close-detail").click();
    $("toggle-sidebar").click();
    assert.equal($("toggle-sidebar").getAttribute("aria-expanded"), "false");
    assert(w.document.body.classList.contains("sidebar-collapsed"));
    $("xrd-view").click();
    assert.equal($("filter-kind").value, "XRD");
    assert.equal($("records").querySelectorAll(".experiment-group").length, 1);
    assert.equal($("page-title").textContent, "XRD data");
  } finally { dom.window.close(); }

  for (const options of [{savedLanguage: "en"}, {savedLanguage: "en", mobile: true}, {unavailableStorage: true}, {savedLanguage: "en", offline: true},
    {savedTheme: "dark"}, {savedTheme: "light", systemDark: true}, {systemDark: true}, {savedTheme: "invalid", systemDark: true}, {unavailableStorage: true, systemDark: true}]) {
    const env = await boot(options);
    try {
      assert.equal(env.w.document.documentElement.lang, options.savedLanguage ? "en" : "zh-CN");
      const expectedDark = options.savedTheme === "dark" || (options.savedTheme !== "light" && Boolean(options.systemDark));
      assert.equal(env.w.document.documentElement.classList.contains("dark"), expectedDark);
      env.$("theme-switch").click();
      assert.equal(env.w.document.documentElement.classList.contains("dark"), !expectedDark);
      if (options.mobile) {
        assert(env.w.document.body.classList.contains("sidebar-collapsed"));
        env.$("toggle-sidebar").click();
        env.$("nmr-view").click();
        assert(env.w.document.body.classList.contains("sidebar-collapsed"));
        assert.equal(env.$("filter-kind").value, "NMR");
      }
      if (options.offline) {
        assert.match(env.$("filter-error").textContent, /Cannot connect to the local service/);
        assert.equal(env.$("records-panel").hidden, false, "Connection errors must remain visible");
        assert.equal(env.$("dashboard-panels").hidden, true);
      }
    } finally { env.dom.window.close(); }
  }
  const dataset = sample("DATASET", {sample_id: "资料集-示例图谱", series: "资料分类", notes: "批量导入：local-2026-11-14。原始备注保留。"});
  const imported = await boot({savedLanguage: "en", extraRows: [dataset]});
  try {
    const {$, w, writes} = imported;
    $("search").value = "reference materials";
    $("search").dispatchEvent(new w.Event("input", {bubbles: true}));
    assert.equal($("records").children.length, 1);
    assert.match($("records").textContent, /Dataset-Example plots/);
    assert.match($("records").textContent, /Reference materials/);
    assert.doesNotMatch($("records").textContent, /资料集|资料分类/);
    w.document.querySelector('[data-open="DATASET"]').click();
    assert.equal($("detail-title").textContent, "Dataset-Example plots");
    assert.equal($("detail-series").textContent, "Reference materials");
    assert.match($("detail-content").textContent, /原始备注保留/);
    $("language-switch").click();
    assert.equal($("detail-title").textContent, dataset.sample_id);
    assert.equal($("detail-series").textContent, dataset.series);
    $("language-switch").click();
    $("edit-record").click();
    assert.equal($("record-form").elements.sample_id.value, dataset.sample_id);
    assert.equal($("record-form").elements.series.value, "Reference materials");
    assert.equal(writes.length, 0);
    const option = [...$("series-options").options].find(option => option.dataset.value === dataset.series);
    assert.equal(option.value, "Reference materials");
  } finally { imported.dom.window.close(); }
  const seriesEditor = await boot({savedLanguage: "en", extraRows: [sample("ENGLISH", {series: "Example series"}), sample("TIME", {series: "时间系列"})]});
  try {
    const {$, w, writes} = seriesEditor, form = $("record-form");
    assert([...$("series-options").options].every(option => !/[\u3400-\u9fff]/u.test(option.value)));
    $("dashboard-records-tab").click();
    w.document.querySelector('[data-expand="experiment:default:english"]').click();
    w.document.querySelector('[data-open="ENGLISH"]').click();
    $("edit-record").click();
    $("language-switch").click();
    assert.equal(form.elements.series.value, "Example series", "Originally English names keep their stored spelling");
    $("language-switch").click();
    form.dispatchEvent(new w.Event("submit", {bubbles: true, cancelable: true}));
    await flush(); await flush();
    assert.equal(writes[0].payload.series, "Example series");
    $("close-detail").click();
    $("new-record").click();
    form.elements.sample_id.value = "NEW-TIME";
    form.elements.series.value = [...$("series-options").options].find(option => option.dataset.value === "时间系列").value;
    $("language-switch").click();
    assert.equal(form.elements.series.value, "时间系列", "Selecting an English suggestion retains its original identity");
    $("language-switch").click();
    assert.equal(form.elements.series.value, "Time course");
    form.dispatchEvent(new w.Event("submit", {bubbles: true, cancelable: true}));
    await flush(); await flush();
    assert.equal(writes[1].payload.series, "时间系列");
    $("close-detail").click();
    $("new-record").click();
    form.elements.series.value = "我的自定义系列";
    form.elements.experiment_date.value = "2026-0";
    $("language-switch").click();
    $("language-switch").click();
    assert.equal(form.elements.series.value, "我的自定义系列");
    assert.equal(form.elements.experiment_date.value, "2026-0", "Incomplete date drafts survive language changes");
    assert.equal(writes.length, 2, "Language changes do not write records");
  } finally { seriesEditor.dom.window.close(); }
  const grouped = await boot({savedLanguage: "en", extraRows: [
    sample("first", {sample_id: "XY-III-352-01", experiment_no: "XY-III-352", temperature: 250}),
    sample("second", {sample_id: "XY-III-352-10", experiment_no: "XY-III-352", temperature: 260}),
    sample("third", {sample_id: "XY-III-352-redo", experiment_no: "XY-III-352", archived: true})
  ]});
  try {
    const {$, w, writes} = grouped;
    const group = () => w.document.querySelector('[data-experiment="XY-III-352"]');
    assert.equal($("stat-total").textContent, "3");
    assert.match($("result-count").textContent, /Experiments: 3 · Samples: 4 · Datasets: 0/);
    assert.match(group().textContent, /Multiple values/);
    assert.equal(group().querySelector("[data-expand]").getAttribute("aria-expanded"), "false");
    group().querySelector("[data-expand]").click();
    assert.equal($("records").querySelectorAll(".sample-row").length, 2);
    assert.equal($("records").querySelectorAll(":scope > .sample-row").length, 0, "Samples must be inside a separate nested panel");
    assert.equal($("records").querySelector(".expansion-row > td").colSpan, 9);
    assert.equal($("records").querySelectorAll(".sample-panel .sample-table tbody .sample-row").length, 2);
    assert.match(group().querySelector(".status-cell").textContent, /Incomplete/);
    assert.equal(group().querySelector("[data-expand]").getAttribute("aria-expanded"), "true");
    $("search").value = "XY-III-352";
    $("search").dispatchEvent(new w.Event("input", {bubbles: true}));
    assert.equal($("records").querySelectorAll(".experiment-group").length, 1);
    $("temp-max").value = "255";
    $("temp-max").dispatchEvent(new w.Event("input", {bubbles: true}));
    assert.equal($("records").querySelectorAll(".sample-row").length, 1);
    assert.match(group().textContent, /1 \/ 2 samples match/);
    $("language-switch").click(); $("theme-switch").click();
    assert.equal(group().querySelector("[data-expand]").getAttribute("aria-expanded"), "true");
    w.document.querySelector('[data-add-sample="XY-III-352"]').click();
    assert.equal($("record-form").elements.experiment_no.value, "XY-III-352");
    assert.equal($("record-form").elements.sample_id.value, "");
    $("cancel-editor").click();
    $("clear-filters").click();
    for (const id of ["first", "second"]) {
      const input = w.document.querySelector(`[data-select="${id}"]`);
      input.checked = true; input.dispatchEvent(new w.Event("change", {bubbles: true}));
    }
    group().querySelector("[data-expand]").click();
    assert.equal($("records").querySelectorAll(".sample-row").length, 0);
    $("compare").click();
    assert.match($("comparison-table").textContent, /XY-III-352-01/);
    assert.match($("comparison-table").textContent, /XY-III-352-10/);
    assert.equal(writes.length, 0, "Grouping, filtering, and preferences must not modify records");
  } finally { grouped.dom.window.close(); }
  const catalog = await boot({savedLanguage: "en", extraProjects: [{id: "catalysis", name: "Catalysis"}],
    extraKinds: ["Raman", "温度"], extraRows: [sample("second-project", {sample_id: "A", experiment_no: "A", project_id: "catalysis", project_name: "Catalysis", files: [{id: "raman-file", kind: "Raman", name: "Raman.csv", size: 10, sha256: "1234567890abcdef"}]})]});
  try {
    const {$, w, writes, projects} = catalog;
    const change = id => $(id).dispatchEvent(new w.Event("change", {bubbles: true}));
    const submitCatalog = async name => {
      $("catalog-name").value = name;
      $("catalog-form").dispatchEvent(new w.Event("submit", {bubbles: true, cancelable: true}));
      await flush(); await flush();
    };
    assert.equal($("project-select").value, "default");
    assert.equal($("stat-total").textContent, "2");
    assert.equal($("stat-samples").textContent, "2");
    assert.equal($("stat-files").textContent, "2");
    $("project-select").value = "catalysis"; change("project-select");
    assert.equal($("stat-total").textContent, "1");
    assert.equal($("stat-files").textContent, "1");
    assert.equal(w.localStorage.getItem("catalog-project"), "catalysis");
    assert.equal($("records").querySelectorAll(".experiment-group").length, 1);
    $("project-select").value = ""; change("project-select");
    assert.equal($("records").querySelectorAll('[data-experiment="A"]').length, 2);
    w.document.querySelector('[data-expand="experiment:catalysis:a"]').click();
    assert.equal(w.document.querySelector('.sample-panel .inline-file').getAttribute("href"), "api/files/raman-file");
    w.document.querySelector('[data-add-sample="A"][data-project="catalysis"]').click();
    assert.equal($("editor-project").value, "catalysis");
    $("record-form").elements.sample_id.value = "UNSAVED-SAMPLE";
    $("record-form").elements.notes.value = "Keep my draft";
    $("editor-add-project").click();
    await submitCatalog('New <project> "name"');
    const addedProject = projects.at(-1);
    assert.equal($("editor-project").value, addedProject.id);
    assert.equal($("record-form").elements.sample_id.value, "UNSAVED-SAMPLE");
    assert.equal($("record-form").elements.experiment_no.value, "A");
    assert.equal($("record-form").elements.notes.value, "Keep my draft");
    assert.equal($("editor-project").querySelector("project"), null);
    $("language-switch").click(); $("theme-switch").click(); $("language-switch").click();
    assert.equal($("editor-project").value, addedProject.id);
    assert.equal($("record-form").elements.notes.value, "Keep my draft");
    $("cancel-editor").click();
    $("add-project").click(); await submitCatalog("Empty project");
    assert.equal($("project-select").value, projects.at(-1).id);
    assert.equal($("stat-total").textContent, "0");
    assert.equal($("empty-state").hidden, false);
    $("new-record").click();
    assert.equal($("editor-project").value, projects.at(-1).id);
    $("cancel-editor").click();
    $("project-select").value = "catalysis"; change("project-select");
    w.document.querySelector('[data-expand="experiment:catalysis:a"]').click(); // collapse
    w.document.querySelector('[data-expand="experiment:catalysis:a"]').click();
    w.document.querySelector('[data-open="second-project"]').click();
    assert.equal($("detail-project").textContent, "Catalysis");
    const fileInput = $("upload-files"), file = new w.File(["data"], "spectrum.txt");
    Object.defineProperty(fileInput, "files", {value: [file]});
    fileInput.dispatchEvent(new w.Event("change", {bubbles: true}));
    $("add-upload-kind").click(); await submitCatalog("Raman");
    assert.equal($("catalog-dialog").open, true);
    assert.match($("catalog-error").textContent, /already exists/);
    await submitCatalog('UV-Vis <custom>');
    assert.equal($("catalog-dialog").open, false);
    assert.equal($("upload-kind").value, 'UV-Vis <custom>');
    assert.equal($("upload-files"), fileInput, "Adding a category must preserve the chosen files");
    $("language-switch").click(); $("language-switch").click();
    assert.equal($("upload-kind").value, 'UV-Vis <custom>');
    assert.equal($("upload-files").files[0], file);
    assert.equal($("file-selection").textContent, "1 files selected");
    assert([...$("filter-kind").options].some(option => option.value === 'UV-Vis <custom>'));
    assert.equal($("upload-kind").querySelector("custom"), null);
    assert.equal([...$("upload-kind").options].find(option => option.value === "温度").textContent, "温度");
    $("upload-button").click(); await flush(); await flush();
    assert.equal(writes.at(-1).kind, 'UV-Vis <custom>');
    assert.equal(writes.at(-1).file, file);
    $("close-detail").click();
    $("manage-categories").click();
    w.document.querySelector('[data-catalog-value="Raman"]').click();
    assert.equal($("filter-kind").value, "Raman");
    assert.equal($("page-title").textContent, "Raman data");
    assert.equal($("records").querySelectorAll(".experiment-group").length, 1);
    assert.equal(w.document.querySelector('[data-kind-view="Raman"]').getAttribute("aria-pressed"), "true");
    assert(writes.every(write => !/\/api\/experiments$/.test(write.url)), "Adding metadata does not create sample records");
  } finally { catalog.dom.window.close(); }
  for (const savedProject of ["missing", "default", ""]) {
    const restored = await boot({savedProject});
    try { assert.equal(restored.$("project-select").value, savedProject === "missing" ? "default" : savedProject); }
    finally { restored.dom.window.close(); }
  }
  const rawNotes = "批量导入：local-test。\n示例说明：\nZ:\\研究资料\\sample.csv\n未知条件保留为空，需后续核对。";
  const translated = await boot({savedLanguage: "en", extraRows: [sample("IMPORTED-NOTES", {notes: rawNotes})]});
  try {
    const {$, w, writes} = translated;
    w.document.querySelector('[data-expand="experiment:default:imported-notes"]').click();
    w.document.querySelector('[data-open="IMPORTED-NOTES"]').click();
    assert.match($("detail-notes").textContent, /^Bulk import/);
    assert.doesNotMatch($("detail-notes").textContent, /示例说明|未知条件/);
    assert($("detail-notes").textContent.includes("Z:\\研究资料\\sample.csv"));
    assert.equal($("detail-notes-original").hidden, false);
    assert.equal($("detail-notes-original").querySelector(".notes").textContent, rawNotes);
    $("language-switch").click();
    assert.equal($("detail-notes").textContent, rawNotes);
    assert.equal($("detail-notes-original").hidden, true);
    $("language-switch").click();
    $("edit-record").click();
    const form = $("record-form");
    assert.equal($("editor-notes-preview").hidden, false);
    assert.match($("editor-notes-preview").textContent, /Bulk import/);
    assert.equal($("editor-notes-original").open, false);
    assert.equal(form.elements.notes.value, rawNotes);
    $("language-switch").click();
    assert.equal($("editor-notes-original").open, true);
    assert.equal($("editor-notes-preview").hidden, true);
    $("language-switch").click(); $("theme-switch").click();
    assert.equal(form.elements.notes.value, rawNotes);
    form.elements.temperature.value = "123";
    form.dispatchEvent(new w.Event("submit", {bubbles: true, cancelable: true}));
    await flush(); await flush();
    assert.equal(writes.at(-1).payload.notes, rawNotes, "Saving unrelated fields must never save the translation over the source");
    assert.match($("detail-notes").textContent, /Bulk import/);
    $("edit-record").click();
    $("editor-notes-original").open = true;
    form.elements.notes.value = "导入来源：example.py。\n新写备注 <img src=x>";
    form.elements.notes.dispatchEvent(new w.Event("input", {bubbles: true}));
    assert.equal($("editor-notes-original").open, true, "Live preview must not close the active editor");
    assert.match($("editor-notes-preview").textContent, /^Import source: example.py\./);
    assert.equal($("editor-notes-preview").querySelector("img"), null);
    $("language-switch").click(); $("language-switch").click();
    assert.equal(form.elements.notes.value, "导入来源：example.py。\n新写备注 <img src=x>");
    assert.equal(writes.length, 1);
  } finally { translated.dom.window.close(); }
  const reusable = await boot({savedLanguage: "en", savedConditions: {precursor: ["Saved precursor"]}, extraProjects: [{id: "other", name: "Other"}], extraRows: [sample("cross-project", {project_id: "other", precursor: "Salt B"})]});
  try {
    const {$, w, writes} = reusable;
    $("new-record").click();
    const form = $("record-form");
    const options = () => [...$("editor-precursors").querySelectorAll("input")];
    const chosen = () => options().filter(option => option.checked).map(option => option.value);
    assert(options().some(option => option.value === "Salt B"));
    assert(options().some(option => option.value === "Saved precursor"));
    assert.equal(form.elements.precursor.value, "");
    form.elements.sample_id.value = "DRAFT"; form.elements.notes.value = "Keep draft notes";
    options().find(option => option.value === "Salt B").click();
    $("add-precursor").click();
    assert.equal($("new-precursor-name").maxLength, 250);
    assert.equal($("catalog-dialog").open, false, "Adding a precursor stays inside the editor");
    $("new-precursor-name").value = "PA12";
    $("save-precursor").click(); await flush();
    assert.deepEqual(chosen().sort(), ["Compound A12 (CA12)", "Salt B"]);
    assert.equal(writes.length, 0, "A known alias reuses the saved choice");
    const name = 'Ni <reagent> "new"';
    $("add-precursor").click(); $("new-precursor-name").value = name;
    $("save-precursor").click(); await flush(); await flush();
    assert.deepEqual(chosen().sort(), ["Compound A12 (CA12)", name, "Salt B"]);
    assert.equal($("new-precursor-panel").hidden, true);
    assert.equal($("editor-precursors").querySelector("reagent"), null);
    assert.equal(form.elements.sample_id.value, "DRAFT");
    assert.equal(form.elements.notes.value, "Keep draft notes");
    $("language-switch").click(); $("theme-switch").click(); $("language-switch").click();
    assert.equal(chosen().length, 3);
    $("add-solvent").click();
    assert.equal($("catalog-dialog").open, false, "Adding a solvent stays inside the editor without a stacked dialog");
    $("new-solvent-name").value = "ODE"; $("save-solvent").click(); await flush();
    assert.equal(form.elements.solvent.value, "ODE");
    $("editor-solvents").querySelector('input[value="OA"]').click();
    assert.equal(form.elements.solvent.value, "OA + ODE");
    assert.equal($("add-ligand"), null, "Ligands share the multi-select material field");
    assert(writes.every(write => write.url === "/api/condition-options"), "Saving a choice must not save the draft experiment");
    $("cancel-editor").click(); $("new-record").click();
    assert.equal(form.elements.precursor.value, "", "A new experiment starts with unknown conditions");
    assert(options().some(option => option.value === name));
  } finally { reusable.dom.window.close(); }
  const multiSolvent = await boot({savedLanguage: "en", savedConditions: {solvent: ["OA", "NMP"]}, extraRows: [sample("MIX", {solvent: "ODE + OA", solvents: ["ODE", "OA"]})]});
  try {
    const {$, w, rows, writes} = multiSolvent;
    $("dashboard-records-tab").click(); w.document.querySelector('[data-expand="experiment:default:mix"]').click();
    w.document.querySelector('[data-open="MIX"]').click(); $("edit-record").click();
    const chosen = () => [...$("editor-solvents").querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value);
    const form = $("record-form");
    assert.deepEqual(chosen().sort(), ["OA", "ODE"]);
    form.elements.notes.value = "Keep this draft";
    $("add-precursor").click(); $("new-precursor-name").value = "Salt C"; $("save-precursor").click(); await flush();
    $("add-solvent").click();
    assert.equal($("catalog-dialog").open, false);
    $("new-solvent-name").value = "DMSO"; $("save-solvent").click(); await flush();
    assert(chosen().includes("DMSO") && chosen().includes("ODE") && chosen().includes("OA"));
    assert.equal($("save-record").disabled, false);
    assert.equal(form.elements.notes.value, "Keep this draft");
    $("language-switch").click(); $("theme-switch").click();
    assert.equal(chosen().length, 3);
    const checkbox = [...$("editor-solvents").querySelectorAll('input[type="checkbox"]')].find(input => input.value === "OA");
    checkbox.click();
    assert.equal(chosen().length, 2);
    $("add-solvent").click(); $("new-solvent-name").value = ""; $("save-solvent").click();
    assert.equal($("solvent-error").hidden, false);
    $("cancel-solvent").click();
    form.dispatchEvent(new w.Event("submit", {cancelable: true})); await flush(); await flush();
    assert.deepEqual(writes.at(-1).payload.solvents.sort(), ["DMSO", "ODE"]);
    assert.deepEqual(writes.at(-1).payload.precursors, ["PA12", "Salt C"]);
    assert.equal(writes.at(-1).payload.notes, "Keep this draft");
    $("edit-record").click(); assert.deepEqual(chosen().sort(), ["DMSO", "ODE"]);
    assert.deepEqual([...$("editor-precursors").querySelectorAll("input:checked")].map(input => input.value), ["PA12", "Salt C"]);
    $("cancel-editor").click(); $("close-detail").click();
    $("dashboard-condition-field").value = "solvent"; $("dashboard-condition-field").dispatchEvent(new w.Event("change")); $("dashboard-overview-tab").click();
    const dmso = w.document.querySelector('[data-condition-value="DMSO"]'); assert(dmso);
    dmso.click();
    assert.equal($("records").querySelectorAll(".experiment-group").length, 1);
    assert.match($("records").textContent, /MIX/);
  } finally { multiSolvent.dom.window.close(); }
  const stalledSolvent = await boot({conditionHandler: (payload, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("Aborted"))))});
  try {
    const {$, w, writes} = stalledSolvent;
    $("new-record").click();
    let expire;
    const originalTimeout = w.setTimeout;
    w.setTimeout = (callback, ms) => ms === 15000 ? (expire = callback, 0) : originalTimeout(callback, ms);
    $("add-solvent").click(); $("new-solvent-name").value = "DMSO"; $("save-solvent").click();
    assert.equal($("save-solvent").disabled, true);
    $("save-solvent").click(); assert.equal(writes.length, 1);
    $("new-solvent-name").dispatchEvent(new w.KeyboardEvent("keydown", {key: "k", ctrlKey: true, bubbles: true}));
    assert.notEqual(w.document.activeElement, $("global-search"), "Search shortcut must not steal modal focus");
    expire(); await flush();
    assert.match($("solvent-error").textContent, /超时/);
    assert.equal($("save-record").disabled, false);
    assert.equal($("cancel-solvent").disabled, false);
    assert.equal($("new-solvent-name").value, "DMSO");
    $("cancel-solvent").click(); assert.equal($("new-solvent-panel").hidden, true);
    $("add-precursor").click();
    $("new-precursor-name").dispatchEvent(new w.KeyboardEvent("keydown", {key: "k", ctrlKey: true, bubbles: true}));
    assert.equal(w.document.activeElement, $("new-precursor-name"));
  } finally { stalledSolvent.dom.window.close(); }
  let committedChoice = "";
  const lostPrecursorReply = await boot({
    conditionHandler: (payload, options) => {
      committedChoice = payload.name;
      return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("Aborted"))));
    },
    readHandler: catalog => {
      if (committedChoice) catalog.condition_options.precursor.push(committedChoice);
      return {ok: true, json: async () => catalog};
    }
  });
  try {
    const {$, w, writes} = lostPrecursorReply;
    $("new-record").click();
    $("editor-precursors").querySelector("input").click();
    $("record-form").elements.notes.value = "Keep draft during read-back";
    let expire;
    const originalTimeout = w.setTimeout;
    w.setTimeout = (callback, ms) => ms === 15000 ? (expire = callback, 0) : originalTimeout(callback, ms);
    $("add-precursor").click();
    $("new-precursor-name").value = "Recovered precursor";
    $("save-precursor").click();
    assert.equal($("save-precursor").disabled, true);
    expire(); await flush(); await flush();
    assert.equal($("new-precursor-panel").hidden, true);
    assert.equal($("editor-precursors").querySelectorAll("input:checked").length, 2);
    assert.equal($("record-form").elements.notes.value, "Keep draft during read-back");
    assert.equal(writes.length, 1, "Confirm a lost reply with a read instead of a second write");
  } finally { lostPrecursorReply.dom.window.close(); }
  const duplicateSolvent = await boot({conditionHandler: () => ({ok: false, json: async () => ({error: "该名称已存在，请直接选择或使用其他名称。"})})});
  try {
    const {$, w} = duplicateSolvent;
    $("new-record").click(); $("add-solvent").click(); $("new-solvent-name").value = "Saved in another window"; $("save-solvent").click(); await flush();
    assert.equal($("new-solvent-panel").hidden, true);
    assert.equal($("editor-solvent").value, "Saved in another window");
    assert.equal($("save-record").disabled, false);
  } finally { duplicateSolvent.dom.window.close(); }
  const progress = await boot({savedLanguage: "en", extraRows: [sample("progress-1", {experiment_no: "EXP", status: "待补全"}), sample("progress-2", {experiment_no: "EXP", status: "已记录"})]});
  try {
    const {$, w, rows, writes} = progress;
    const change = id => $(id).dispatchEvent(new w.Event("change"));
    $("experiment-view").click();
    w.document.querySelector('[data-workspace-key="experiment:default:exp"]').click();
    assert.equal($("workspace-status").value, "");
    assert.equal($("workspace-save-status").disabled, true);
    $("workspace-status").value = "已完成"; change("workspace-status");
    assert.match($("workspace-save-status").textContent, /2 samples/);
    $("language-switch").click(); $("language-switch").click();
    assert.equal($("workspace-status").value, "已完成", "Language switching preserves the pending choice");
    $("workspace-save-status").click(); await flush(); await flush();
    assert.equal(writes.at(-1).payload.records.length, 2);
    assert(rows.filter(row => row.experiment_no === "EXP").every(row => row.status === "已完成"));
    assert.equal(rows.find(row => row.id === "A").status, "待补全");
    assert.equal($("workspace-save-status").disabled, true);
    $("workspace-sample").value = "progress-1"; change("workspace-sample");
    $("workspace-status").value = "已记录"; change("workspace-status");
    $("workspace-save-status").click(); await flush(); await flush();
    assert.equal(writes.at(-1).payload.records.length, 1);
    assert.equal(rows.find(row => row.id === "progress-2").status, "已完成");
    $("workspace-status-filter").value = "已完成"; change("workspace-status-filter");
    assert.equal($("experiment-list").querySelectorAll("[data-workspace-key]").length, 1);
    assert.equal($("workspace-sample").options.length, 3, "Status filtering retains sibling samples");
    $("workspace-status-filter").value = "待表征"; change("workspace-status-filter");
    assert.equal($("workspace-detail").hidden, true);
    assert.equal($("workspace-empty").hidden, false);
  } finally { progress.dom.window.close(); }
  const statusConflict = await boot({savedLanguage: "en", statusError: "记录已变化或已归档，未更新任何状态。请刷新后重试。"});
  try {
    const {$, w, rows} = statusConflict;
    $("experiment-view").click();
    $("workspace-status").value = "已完成"; $("workspace-status").dispatchEvent(new w.Event("change"));
    $("workspace-save-status").click(); await flush();
    assert.match($("workspace-status-error").textContent, /No statuses were updated/);
    assert.equal(rows[0].status, "待补全");
    assert.equal($("workspace-save-status").disabled, false);
  } finally { statusConflict.dom.window.close(); }
  const presets = await boot({savedLanguage: "en", savedConditions: {temperature: ["180", "0"], duration: ["2.5", "0"]}});
  try {
    const {$, w, writes} = presets;
    $("new-record").click();
    assert.deepEqual([...$("temperature-presets").options].map(option => option.value), ["", "0", "180", "250"]);
    $("temperature-presets").value = "180"; $("temperature-presets").dispatchEvent(new w.Event("change"));
    $("duration-presets").value = "0"; $("duration-presets").dispatchEvent(new w.Event("change"));
    assert.equal($("editor-temperature").value, "180");
    assert.equal($("editor-duration").value, "0");
    $("record-form").elements.notes.value = "Keep my draft";
    $("editor-temperature").value = "225"; $("save-temperature-option").click(); await flush();
    assert.deepEqual(writes[0].payload, {field: "temperature", name: "225"});
    assert.equal(writes[0].url, "/api/condition-options");
    $("save-temperature-option").click(); await flush(); assert.equal(writes.length, 1);
    $("editor-duration").value = "-1"; $("save-duration-option").click();
    assert.match($("duration-error").textContent, /valid temperature or time/);assert.equal(writes.length, 1);
    $("editor-duration").value = "7.5"; $("save-duration-option").click(); await flush();
    assert.deepEqual(writes[1].payload, {field: "duration", name: "7.5"});
    $("language-switch").click(); $("theme-switch").click();
    assert.equal($("editor-temperature").value, "225");assert.equal($("editor-duration").value, "7.5");
    assert.equal($("record-form").elements.notes.value, "Keep my draft");
    assert.equal($("temperature-presets").options[0].textContent, "常用温度");
    assert.equal($("filter-ligand"), null);
    assert.equal([...$("dashboard-condition-field").options].some(option => option.value === "ligand"), false);
  } finally { presets.dom.window.close(); }
  const amounts = await boot({savedLanguage: "en", savedConditions: {solvent: ["NMP"]}, extraRows: [sample("AMOUNTS", {
    solvent: "ODE + OA", solvents: ["ODE", "OA"], ligand: "", material_amounts: [{name: "ODE", amount: 5, unit: "mL"}, {name: "OA", amount: 0, unit: "mmol"}]
  })]});
  try {
    const {$, w, writes} = amounts;
    const material = name => [...$("editor-solvents").querySelectorAll(".material-option")].find(row => row.querySelector('input[type="checkbox"]').value === name);
    const quantity = name => material(name).querySelector('input[type="number"]');
    const unit = name => material(name).querySelector("select");
    const choose = name => material(name).querySelector('input[type="checkbox"]');
    $("dashboard-records-tab").click(); w.document.querySelector('[data-expand="experiment:default:amounts"]').click();
    w.document.querySelector('[data-open="AMOUNTS"]').click(); $("edit-record").click();
    assert.equal(quantity("ODE").value, "5"); assert.equal(unit("ODE").value, "mL");
    assert.equal(quantity("OA").value, "0"); assert.equal(unit("OA").value, "mmol");
    assert.equal(quantity("NMP").disabled, true); assert.equal(material("NMP").querySelector(".material-amount").hidden, true);
    quantity("ODE").value = "7.25"; quantity("ODE").dispatchEvent(new w.Event("input", {bubbles: true}));
    unit("ODE").value = "g"; unit("ODE").dispatchEvent(new w.Event("change", {bubbles: true}));
    $("language-switch").click(); $("theme-switch").click();
    assert.equal(quantity("ODE").value, "7.25"); assert.equal(unit("ODE").value, "g");
    assert.equal(quantity("ODE").getAttribute("aria-label"), "ODE 添加量");
    $("add-solvent").click(); $("new-solvent-name").value = "EtOH"; $("save-solvent").click(); await flush();
    assert.equal(quantity("ODE").value, "7.25"); assert.equal(quantity("EtOH").value, "");
    quantity("EtOH").value = "-1"; assert.equal(quantity("EtOH").checkValidity(), false);
    choose("EtOH").click(); assert.equal(quantity("EtOH").disabled, true);
    choose("EtOH").click(); quantity("EtOH").value = "";
    material("OA").querySelector("[data-delete-solvent]").click(); await flush();
    assert.equal(choose("OA").checked, true); assert.equal(quantity("OA").value, "0");
    assert.equal(material("OA").querySelector("[data-delete-solvent]"), null, "The selected value remains without being a saved option");
    material("NMP").querySelector("[data-delete-solvent]").click(); await flush(); assert.equal(material("NMP"), undefined);
    $("delete-temperature-option").click(); await flush();
    assert.equal($("editor-temperature").value, "250"); assert.equal($("temperature-presets").value, ""); assert.equal($("delete-temperature-option").disabled, true);
    $("duration-presets").value = "0"; $("duration-presets").dispatchEvent(new w.Event("change"));
    $("delete-duration-option").click(); await flush(); assert.equal($("editor-duration").value, "0");
    $("record-form").dispatchEvent(new w.Event("submit", {cancelable: true})); await flush(); await flush();
    const expected = [{name: "OA", amount: 0, unit: "mmol"}, {name: "ODE", amount: 7.25, unit: "g"}];
    assert.deepEqual(writes.at(-1).payload.material_amounts.sort((a, b) => a.name.localeCompare(b.name)), expected, "Blank remains unknown and zero is retained");
    assert.equal($("detail").open, true); assert.match($("detail").textContent, /OA \(0 mmol\)/); assert.match($("detail").textContent, /ODE \(7.25 g\)/);
    $("edit-record").click();
    assert.equal(quantity("ODE").value, "7.25"); assert.equal(unit("OA").value, "mmol");
    assert.equal(unit("ODE").value, "g");
    assert.equal(material("OA").querySelector("[data-delete-solvent]"), null, "Saving a record cannot restore a deleted option");
    assert.equal([...$("temperature-presets").options].some(option => option.value === "250"), false);
    $("cancel-editor").click(); $("duplicate-record").click();
    assert.equal($("record-form").elements.sample_id.value, ""); assert.equal(quantity("ODE").value, "7.25");
    assert.equal(unit("ODE").value, "g");
    $("cancel-editor").click(); $("close-detail").click(); $("new-record").click();
    assert.equal(material("OA"), undefined, "New samples do not receive deleted choices from historical records");
    assert.equal(quantity("ODE").value, "", "A new sample must not inherit the previous sample's amount");
    $("add-solvent").click(); $("new-solvent-name").value = "OA"; $("save-solvent").click(); await flush();
    assert.equal(choose("OA").checked, true); assert(material("OA").querySelector("[data-delete-solvent]"), "Explicitly adding a deleted option restores it");
  } finally { amounts.dom.window.close(); }
  let finishOptionDeletion;
  const failedDeletion = await boot({savedLanguage: "en", conditionHandler: () => new Promise(resolve => {
    finishOptionDeletion = () => resolve({ok: false, json: async () => ({error: "请求超时，结果尚未确认；当前编辑内容仍保留。"})});
  })});
  try {
    const {$, w, writes} = failedDeletion;
    $("new-record").click();
    const row = [...$("editor-solvents").querySelectorAll(".material-option")].find(row => row.querySelector('input[type="checkbox"]').value === "ODE");
    row.querySelector('input[type="checkbox"]').click(); row.querySelector('input[type="number"]').value = "4";
    row.querySelector("[data-delete-solvent]").click();
    assert.equal($("save-record").disabled, true); assert.equal(row.querySelector("[data-delete-solvent]").disabled, true);
    row.querySelector("[data-delete-solvent]").click(); $("cancel-editor").click();
    $("record-form").dispatchEvent(new w.Event("submit", {cancelable: true})); assert.equal(writes.length, 1); assert.equal($("editor").open, true);
    finishOptionDeletion(); await flush();
    assert.equal($("solvent-error").hidden, false); assert.equal($("new-solvent-panel").hidden, true);
    assert.match($("solvent-error").textContent, /draft is preserved/); assert.equal(row.querySelector('input[type="number"]').value, "4");
    assert.equal($("save-record").disabled, false); assert.equal(row.querySelector("[data-delete-solvent]").disabled, false);
  } finally { failedDeletion.dom.window.close(); }

  let acknowledgedReads = 0;
  const acknowledged = await boot({
    readHandler: catalog => { acknowledgedReads++; if (acknowledgedReads > 1) throw Error("Refresh unavailable"); return {ok: true, json: async () => catalog}; },
    recordHandler: (row, payload) => {Object.assign(row, payload, {solvent: payload.solvents.join(" + "), revision: row.revision + 3});return {ok: true, json: async () => ({id: row.id, record: structuredClone(row)})};}
  });
  try {
    const {$, w, writes} = acknowledged;
    $("experiment-view").click();w.document.querySelector('[data-workspace-key="experiment:default:a"]').click();
    for (const value of [275,280]) {
      $("workspace-edit-record").click();$("editor-temperature").value = String(value);
      $("record-form").dispatchEvent(new w.Event("submit", {cancelable:true}));await flush();await flush();
      assert.equal($("editor").open,false);assert.equal($("form-error").hidden,true);$("close-detail").click();
    }
    assert.deepEqual(writes.map(write=>write.payload.revision),[1,4],"Use the acknowledged revision, not an assumed increment or a later refresh");
    assert.equal(acknowledgedReads,1,"A successful save updates the page without a dependent list read");
    assert.match($("workspace-conditions").textContent,/280/);
  } finally { acknowledged.dom.window.close(); }
  for (const create of [false,true]) {
    const recovered = await boot({recordHandler:(row,payload)=>{Object.assign(row,payload,{solvent:(payload.solvents || []).join(" + "),revision:2});return {ok:true,json:async()=>{throw Error("Response lost after commit");}};}});
    try {
      const {$, w, writes, rows} = recovered;
      if(create) {$("new-record").click();$("record-form").elements.sample_id.value="NEW-1";$("record-form").elements.experiment_no.value="NEW-1";}
      else {$("experiment-view").click();w.document.querySelector('[data-workspace-key="experiment:default:a"]').click();$("workspace-edit-record").click();}
      $("editor-temperature").value="275";$("record-form").dispatchEvent(new w.Event("submit",{cancelable:true}));await flush();await flush();
      assert.equal($("editor").open,false,"An interrupted acknowledgement is confirmed with a read (create="+create+")");
      assert.equal($("form-error").hidden,true);assert.equal(writes.length,1,"Recovery never resubmits the write");
      assert.equal(rows.filter(row=>row.sample_id===(create?"NEW-1":"A")).length,1);
    } finally {recovered.dom.window.close();}
  }
  const conflictingEdit = await boot({savedLanguage:"en",recordHandler:(row)=>{row.revision++;row.notes="Changed in another window";return {ok:false,status:409,json:async()=>({error:"这条记录已在其他窗口更新。请保留当前内容，关闭编辑窗口后刷新再编辑。"})};}});
  try {
    const {$, w, writes, rows}=conflictingEdit;
    $("experiment-view").click();w.document.querySelector('[data-workspace-key="experiment:default:a"]').click();$("workspace-edit-record").click();
    $("editor-temperature").value="275";$("record-form").dispatchEvent(new w.Event("submit",{cancelable:true}));await flush();await flush();
    assert.equal($("editor").open,true);assert.equal($("editor-temperature").value,"275");
    assert.match($("form-error").textContent,/another window/);assert.equal(writes.length,1);
    assert.equal(rows[0].temperature,250);assert.equal(rows[0].notes,"Changed in another window");
    $("cancel-editor").click();w.dispatchEvent(new w.Event("focus"));await flush();
    $("workspace-edit-record").click();assert.equal($("record-form").elements.notes.value,"Changed in another window");
  } finally {conflictingEdit.dom.window.close();}
  let finishStaleRead, raceReads=0;
  const raced = await boot({readHandler:catalog=>++raceReads===1?{ok:true,json:async()=>catalog}:new Promise(resolve=>{finishStaleRead=()=>resolve({ok:true,json:async()=>catalog});})});
  try {
    const {$,w}=raced;
    w.dispatchEvent(new w.Event("focus"));await flush();
    $("experiment-view").click();w.document.querySelector('[data-workspace-key="experiment:default:a"]').click();$("workspace-edit-record").click();
    $("editor-temperature").value="290";$("record-form").dispatchEvent(new w.Event("submit",{cancelable:true}));await flush();await flush();
    finishStaleRead();await flush();$("close-detail").click();$("workspace-edit-record").click();
    assert.equal($("editor-temperature").value,"290","A read started before save must not replace the acknowledged record");
  } finally {raced.dom.window.close();}
  const directEditor = await boot();
  try {
    const {$, w, rows, writes} = directEditor;
    $("experiment-view").click();
    w.document.querySelector('[data-workspace-key="experiment:default:a"]').click();
    assert.equal($("workspace-edit-record").disabled, false, "A single-sample experiment can be edited immediately");
    assert.equal($("workspace-edit-record").textContent, "编辑样品");
    $("workspace-edit-record").click();
    assert.equal($("editor").open, true);
    assert.equal($("detail").open, false);
    $("record-form").elements.temperature.value = "275";
    $("record-form").dispatchEvent(new w.Event("submit", {cancelable: true}));
    await flush(); await flush();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, "/api/experiments/A");
    assert.equal(writes[0].payload.revision, 1);
    assert.equal(rows.find(row => row.id === "A").temperature, 275);
    assert.equal(rows.find(row => row.id === "A").files[0].id, "f1");
    assert.equal($("editor").open, false);
    assert.equal($("workspace-experiment-title").textContent, "A");
    assert.match($("workspace-conditions").textContent, /275/);
  } finally { directEditor.dom.window.close(); }
  const explorer = await boot({savedLanguage: "en", extraProjects: [{id: "other", name: "Other project"}, {id: "empty", name: "Empty"}], extraKinds: ["Raman"], extraRows: [
    sample("one", {sample_id: "XY-III-352-01", experiment_no: "XY-III-352", temperature: 0, duration: null, notes: rawNotes,
      files: [{id: "curve", name: "Pattern.csv", kind: "Raman", size: 10, sha256: "1234"}], extra_conditions: [{name: "Argon", value: "20", unit: "mL"}]}),
    sample("two", {sample_id: "XY-III-352-02", experiment_no: "XY-III-352", temperature: null, duration: 0, precursor: "<script>unsafe</script>",
      files: [{id: "zip", name: "Raw.zip", kind: "TEM", size: 30, sha256: "1234"}, {id: "image", name: "Image.png", kind: "TEM", size: 10, sha256: "1234"}]}),
    sample("same-number", {experiment_no: "XY-III-352", project_id: "other", project_name: "Other project"}),
    sample("excluded-dataset", {sample_id: "资料集-test", notes: "批量导入：local-test"})
  ]});
  try {
    const {$, w, writes} = explorer;
    const change = id => $(id).dispatchEvent(new w.Event("change", {bubbles: true}));
    $("search").value = "no match";
    $("search").dispatchEvent(new w.Event("input"));
    $("experiment-view").click(); await flush();
    assert.equal($("overview-view").hidden, true);
    assert.equal($("experiment-workspace").hidden, false);
    assert.equal($("page-title").textContent, "Experiment workspace");
    assert.equal($("experiment-view").getAttribute("aria-pressed"), "true");
    assert.equal($("active-view").getAttribute("aria-pressed"), "false");
    assert.equal($("experiment-list").querySelectorAll("[data-workspace-key]").length, 3, "Workspace ignores overview filters, archives and datasets");
    w.document.querySelector('[data-workspace-key="experiment:default:xy-iii-352"]').click(); await flush();
    assert.equal($("workspace-sample").options.length, 3);
    assert.equal($("workspace-open-record").disabled, true);
    assert.equal($("workspace-edit-record").disabled, true);
    assert.equal($("workspace-edit-help").hidden, false);
    assert.equal($("workspace-edit-help").textContent, "Select one sample to edit.");
    $("workspace-edit-record").click();
    assert.equal($("editor").open, false, "All samples must not open an arbitrary sample for editing");
    assert.match($("workspace-conditions").textContent, /0.*Not recorded/s);
    assert.equal($("workspace-conditions").querySelector("script"), null);
    assert.equal($("workspace-file").value, "curve");
    assert($("workspace-preview").querySelector("polyline"));
    assert.equal($("workspace-preview").closest(".workspace-data")?.querySelector("h2").textContent, "Data and notes");
    assert.equal($("preview-plot").hidden, false);
    assert.equal($("preview-table").hidden, true);
    w.document.querySelector('[data-preview-mode="table"]').click(); await flush();
    assert.equal($("preview-plot").hidden, true);
    assert.equal($("preview-table").hidden, false);
    w.document.querySelector('[data-preview-mode="plot"]').click(); await flush();
    assert.equal($("preview-plot").hidden, false);
    assert.match($("workspace-preview").textContent, /angle|intensity/);
    assert.equal($("workspace-download").getAttribute("href"), "api/files/curve");
    w.document.querySelector('[data-workspace-kind="TEM"]').click();
    assert.equal($("workspace-file").options.length, 2);
    assert.equal($("workspace-preview").querySelector("img").getAttribute("src"), "api/files/image/preview");
    $("workspace-file").value = "zip"; change("workspace-file");
    assert.match($("workspace-preview").textContent, /appropriate software/);
    $("workspace-sample").value = "one"; change("workspace-sample");
    assert.equal($("workspace-download").hidden, true);
    assert.equal($("workspace-preview").querySelector("img"), null);
    assert.equal($("workspace-open-record").disabled, false);
    assert.equal($("workspace-edit-record").disabled, false);
    assert.equal($("workspace-edit-help").hidden, true);
    assert.equal($("workspace-edit-record").textContent, "Edit sample");
    $("workspace-edit-record").click();
    assert.equal($("detail").open, false, "Direct editing skips the details dialog");
    assert.equal($("editor").open, true);
    assert.equal($("record-form").elements.sample_id.value, "XY-III-352-01");
    assert.equal($("record-form").elements.temperature.value, "0");
    $("cancel-editor").click();
    assert.match($("workspace-conditions").textContent, /Argon20 mL/);
    assert.match($("workspace-notes").querySelector(".notes").textContent, /^Bulk import/);
    assert.equal($("workspace-notes").querySelector(".notes-original .notes").textContent, rawNotes);
    w.document.querySelector('[data-workspace-kind=""]').click(); await flush();
    $("language-switch").click(); $("theme-switch").click(); await flush();
    assert.equal($("workspace-sample").value, "one");
    assert.equal($("workspace-file").value, "curve");
    assert.equal($("workspace-notes").querySelector(".notes").textContent, rawNotes);
    assert.equal(w.document.documentElement.classList.contains("dark"), true);
    $("workspace-open-record").click();
    assert.equal($("detail-title").textContent, "XY-III-352-01");
    $("close-detail").click();
    $("workspace-add-sample").click();
    assert.equal($("record-form").elements.experiment_no.value, "XY-III-352");
    $("cancel-editor").click();
    $("experiment-resizer").dispatchEvent(new w.KeyboardEvent("keydown", {key: "ArrowRight", cancelable: true}));
    assert.equal(w.localStorage.getItem("catalog-index-width"), "270");
    $("experiment-resizer").dispatchEvent(new w.KeyboardEvent("keydown", {key: "End", cancelable: true}));
    assert.equal($("experiment-resizer").getAttribute("aria-valuenow"), "420");
    $("toggle-experiment-list").click();
    assert.equal($("toggle-experiment-list").getAttribute("aria-expanded"), "false");
    $("language-switch").click();
    assert.equal($("experiment-list-toggle-label").textContent, "Show experiment list");
    $("toggle-experiment-list").click();
    $("experiment-search").value = "352-02"; $("experiment-search").dispatchEvent(new w.Event("input"));
    assert.equal($("experiment-list").querySelectorAll("[data-workspace-key]").length, 1);
    assert.equal($("workspace-sample").options.length, 3, "Matching a sample retains its sibling samples");
    $("experiment-search").value = ""; $("experiment-search").dispatchEvent(new w.Event("input"));
    $("project-select").value = "other"; change("project-select");
    assert.equal($("experiment-list").querySelectorAll("[data-workspace-key]").length, 1);
    assert.equal($("workspace-sample").options.length, 2);
    assert.equal($("workspace-preview").querySelector("polyline"), null);
    $("project-select").value = ""; change("project-select");
    assert.equal($("experiment-list").querySelectorAll('[data-workspace-key$="xy-iii-352"]').length, 2);
    $("project-select").value = "empty"; change("project-select");
    assert.equal($("workspace-empty").hidden, false);
    assert.equal($("workspace-detail").hidden, true);
    $("active-view").click();
    assert.equal($("overview-view").hidden, false);
    assert.equal($("experiment-workspace").hidden, true);
    assert.equal($("search").value, "no match");
    assert.equal(writes.length, 0);
  } finally { explorer.dom.window.close(); }
  const dashboard = await boot({savedLanguage: "en", savedTheme: "dark", extraProjects: [{id: "empty", name: "Empty"}, {id: "other", name: "Other"}], extraRows: [
    sample("other-project", {project_id: "other", temperature: null, status: "已完成"}),
    sample("dataset-chart", {sample_id: "资料集-chart", notes: "批量导入：local-test", files: [{id: "chart", name: "reference.PNG", kind: "其他", size: 1024}]})
  ]});
  try {
    const {$, w, writes} = dashboard;
    assert.equal($("dashboard-panels").hidden, false);
    assert.equal($("dashboard-aside").hidden, false);
    assert.equal($("records-panel").hidden, true);
    assert.equal($("stat-total").textContent, "2");
    assert.equal($("stat-files").textContent, "3", "Dashboard includes dataset attachments");
    assert.equal($("dashboard-status").querySelector(".donut-number").textContent, "2", "Sample statistics exclude datasets");
    assert.equal($("dashboard-coverage"), null);
    assert.equal($("dashboard-formats"), null);
    assert.equal($("dashboard-condition-chart"), null);
    assert.equal($("dashboard-condition-field").value, "precursor");
    assert.equal($("dashboard-condition-table").querySelector("svg rect"), null);
    assert.deepEqual([...$("dashboard-condition-table").querySelector('[data-condition-value="Compound A12 (CA12)"]').closest("tr").querySelectorAll("[data-condition-experiment]")].map(button => button.textContent), ["A", "ZERO"]);
    assert.deepEqual([...$("dashboard-condition-table").querySelectorAll("thead th")].map(cell => cell.textContent), ["Precursor", "Experiments", "Related experiments"]);
    $("dashboard-condition-field").value = "temperature"; $("dashboard-condition-field").dispatchEvent(new w.Event("change"));
    const zeroCells = $("dashboard-condition-table").querySelector('[data-condition-value="0"]').closest("tr").cells;
    assert.deepEqual([...zeroCells].map(cell => cell.textContent), ["0 °C", "1", "ZERO"]);
    assert.doesNotMatch($("dashboard-panels").textContent + $("dashboard-aside").textContent, /[\u3400-\u9fff]/u);
    w.document.querySelector('[data-dashboard-open="A"]').click();
    assert.equal($("detail").open, true); $("close-detail").click();
    $("dashboard-records-tab").click();
    assert.equal($("records-panel").hidden, false);
    assert.equal($("dashboard-layout").classList.contains("show-records"), true);
    $("search").value = "unmatched filter";
    $("dashboard-overview-tab").click();
    w.document.querySelector('[data-condition-value="0"]').click();
    assert.equal($("search").value, "");
    assert.equal($("filter-kind").value, "");
    assert.match($("chart-filter-label").textContent, /Temperature.*0/);
    assert.equal($("records").querySelectorAll(".experiment-group").length, 1);
    assert.match($("records").textContent, /ZERO/);
    $("clear-chart-filter").click();
    assert.equal($("records").querySelectorAll(".experiment-group").length, 2);
    $("dashboard-overview-tab").click();
    assert.equal($("stat-pending").textContent, "0", "Fully recorded experiments are not counted as missing conditions");
    assert.equal($("dashboard-show-pending").disabled, true);
    $("dashboard-overview-tab").click();
    $("project-select").value = "other"; $("project-select").dispatchEvent(new w.Event("change"));
    assert.equal($("stat-total").textContent, "1");
    assert.equal($("dashboard-condition-table").querySelector('[data-condition-value=""]').closest("tr").cells[2].textContent, "other-project");
    $("dashboard-condition-table").querySelector('[data-condition-value=""]').click();
    assert.equal($("records").querySelectorAll(".experiment-group").length, 1);
    $("dashboard-overview-tab").click();
    assert.equal($("stat-pending").textContent, "1");
    assert.equal($("dashboard-show-pending").disabled, false);
    assert.deepEqual([...$("dashboard-missing").querySelectorAll("[data-missing-field]")].map(button => button.dataset.missingField), ["temperature"]);
    $("dashboard-missing").querySelector('[data-missing-field="temperature"]').click();
    assert.equal($("records-panel").hidden, false);
    assert.equal($("filter-status").value, "");
    assert.match($("chart-filter-label").textContent, /Missing condition · Temp/);
    assert.equal($("records").querySelectorAll(".experiment-group").length, 1);
    $("dashboard-overview-tab").click();
    $("project-select").value = "empty"; $("project-select").dispatchEvent(new w.Event("change"));
    assert.equal($("stat-total").textContent, "0");
    assert.equal($("dashboard-status").querySelector(".donut-number").textContent, "0");
    assert.equal($("dashboard-condition-table").querySelectorAll("[data-condition-value]").length, 0);
    assert.match($("dashboard-condition-rows").textContent, /No experiments yet/);
    assert.equal($("dashboard-condition-summary"), null);
    assert.doesNotMatch($("dashboard-panels").innerHTML, /NaN|Infinity/);
    $("language-switch").click();
    assert.match($("dashboard-pending").textContent, /0 \/ 0 个实验缺少核心条件/);
    assert.equal($("dashboard-condition-column").textContent, "温度 / °C");
    assert.equal(writes.length, 0);
  } finally { dashboard.dom.window.close(); }
  const overlay = await boot({savedLanguage: "en", previewHandler: url => {
    const id = url.split("/")[3], k = Number(id.replace(/\D/g, "")) || 1;
    return {ok: true, json: async () => ({rows: [["twotheta", "yobs"], ["10", String(k)]], labels: ["twotheta", "yobs"], truncated: false, points: [[10, k], [20, 10 * k], [30, k]]})};
  }, extraRows: Array.from({length: 10}, (_, i) => sample(`OV-${i + 1}min`, {experiment_no: "OV", files: [{id: `f${i + 1}`, name: `ov${i + 1}.csv`, kind: "XRD", size: 10}]}))});
  try {
    const {$, w} = overlay;
    $("experiment-view").click(); await flush();
    w.document.querySelector('[data-workspace-key="experiment:default:ov"]').click(); await flush();
    assert.match($("workspace-preview").textContent, /2θ \(°\)/, "XRD column names become axis titles");
    assert.match($("workspace-preview").textContent, /Intensity \(a\.u\.\)/);
    w.document.querySelector('[data-preview-mode="overlay"]').click(); await flush(); await flush();
    const curves = () => [...$("workspace-preview").querySelectorAll(".csv-plot polyline")].map(line => line.getAttribute("class"));
    assert.equal(curves().length, 8, "At most 8 curves are drawn by default");
    assert.deepEqual(curves(), ["series-0", "series-1", "series-2", "series-3", "series-4", "series-5", "series-6", "series-7"]);
    assert.equal($("workspace-preview").querySelectorAll("[data-overlay-file]:disabled").length, 2, "Further files are disabled at the cap");
    assert.equal($("workspace-preview").querySelectorAll(".series-label").length, 8, "Stacked curves are direct-labeled");
    const box = id => $("workspace-preview").querySelector(`[data-overlay-file="${id}"]`);
    box("f2").checked = false; box("f2").dispatchEvent(new w.Event("change", {bubbles: true})); await flush(); await flush();
    assert.deepEqual(curves(), ["series-0", "series-2", "series-3", "series-4", "series-5", "series-6", "series-7"], "Removing a curve keeps the other colors");
    box("f10").checked = true; box("f10").dispatchEvent(new w.Event("change", {bubbles: true})); await flush(); await flush();
    assert.equal($("workspace-preview").querySelector('[data-overlay-file="f10"]').closest("label").querySelector(".series-swatch").classList.contains("series-bg-1"), true, "New curve takes the freed color slot");
    $("workspace-preview").querySelector('[data-overlay-layout="overlay"]').click(); await flush(); await flush();
    assert.equal($("workspace-preview").querySelectorAll(".series-label").length, 0);
    assert.match($("workspace-preview").textContent, /background subtracted, normalized/, "XRD defaults to background subtraction + normalization");
    assert.match($("workspace-preview").textContent, /SNIP/);
    const toggle = selector => { const box = $("workspace-preview").querySelector(selector); box.checked = !box.checked; box.dispatchEvent(new w.Event("change", {bubbles: true})); };
    const pick = method => $("workspace-preview").querySelector(`[data-plot-method="${method}"]`);
    assert.equal(pick("file").disabled, true, "File bkg option is disabled when no file has a bkg column");
    assert.equal(pick("snip").getAttribute("aria-pressed"), "true", "Without a bkg column the default falls back to SNIP");
    pick("none").click(); await flush(); await flush();
    assert.equal($("workspace-preview").querySelector(".plot-window").hidden, true, "Window only shown with background subtraction");
    assert.match($("workspace-preview").textContent, /min–max/);
    toggle("[data-plot-normalize]"); await flush(); await flush();
    assert.match($("workspace-preview").textContent, /Raw values/);
    $("workspace-preview").querySelector('[data-preview-mode="plot"]').click(); await flush();
    assert.equal(pick("none").getAttribute("aria-pressed"), "true", "Choice is kept across plot modes");
    pick("snip").click(); await flush(); await flush();
    const windowSelect = $("workspace-preview").querySelector("[data-plot-window]");
    windowSelect.value = "2"; windowSelect.dispatchEvent(new w.Event("change", {bubbles: true})); await flush(); await flush();
    assert.match($("workspace-preview").textContent, /±2°/);
    $("workspace-preview").querySelector('[data-preview-mode="table"]').click(); await flush();
    assert.equal($("preview-table").hidden, false);
    assert.equal(overlay.writes.length, 0, "Plotting never writes data");
  } finally { overlay.dom.window.close(); }
  const fileBkg = await boot({savedLanguage: "zh", previewHandler: url => {
    const id = url.split("/")[3];
    const points = [[10, 110], [20, 300], [30, 120]];
    return {ok: true, json: async () => ({rows: [["#twotheta", " yobs", " ycal", " bkg", " diff"]], labels: ["twotheta", "yobs"], truncated: false, points, background: id === "b1" ? [100, 100, 100] : []})};
  }, extraRows: [sample("BK-1", {experiment_no: "BK", files: [{id: "b1", name: "b1.csv", kind: "XRD", size: 1}]}), sample("BK-2", {experiment_no: "BK", files: [{id: "b2", name: "b2.csv", kind: "XRD", size: 1}]})]});
  try {
    const {$, w} = fileBkg;
    $("experiment-view").click(); await flush();
    w.document.querySelector('[data-workspace-key="experiment:default:bk"]').click(); await flush(); await flush();
    assert.match($("workspace-preview").textContent, /已直接减去文件中的 bkg 列/, "Files with a bkg column use it directly");
    assert.equal($("workspace-preview").querySelector(".plot-window").hidden, true, "No SNIP window when the file supplies bkg");
    w.document.querySelector('[data-preview-mode="overlay"]').click(); await flush(); await flush();
    assert.match($("workspace-preview").textContent, /1 条曲线减去文件中的 bkg 列；1 条没有 bkg 列/, "Mixed sources are reported");
    assert.equal($("workspace-preview").querySelector(".plot-window").hidden, false, "Window shown when some curves need SNIP");
    const method = value => $("workspace-preview").querySelector(`[data-plot-method="${value}"]`);
    assert.equal(method("file").getAttribute("aria-pressed"), "true", "XRD with a bkg column defaults to the file method");
    method("snip").click(); await flush(); await flush();
    assert.match($("workspace-preview").textContent, /背底由 SNIP 算法自动估计/, "User can force SNIP even when bkg exists");
    method("none").click(); await flush(); await flush();
    assert.match($("workspace-preview").querySelector(".plot-axis").textContent, /强度 \(a\.u\.\)（已归一化，堆叠偏移）/, "No subtraction note when method is none");
    assert.equal($("workspace-preview").querySelector(".plot-window").hidden, true);
    method("file").click(); await flush(); await flush();
    assert.match($("workspace-preview").textContent, /1 条曲线减去文件中的 bkg 列/);
  } finally { fileBkg.dom.window.close(); }
  const jump = await boot({savedLanguage: "zh", extraRows: [sample("XY-1-279-a", {experiment_no: "XY-1-279", precursor: "CA18"}), sample("XY-II-268-1min", {experiment_no: "XY-II-268"})]});
  try {
    const {$, w} = jump;
    w.document.dispatchEvent(new w.KeyboardEvent("keydown", {key: "k", ctrlKey: true, bubbles: true}));
    assert.equal(w.document.activeElement, $("global-search"), "Ctrl+K focuses the jump box");
    $("global-search").value = "compound a18"; $("global-search").dispatchEvent(new w.Event("input"));
    assert.deepEqual([...$("global-results").querySelectorAll("[data-global-key]")].map(item => item.querySelector("strong").textContent), ["XY-I-279"], "Matches normalized precursor and shows canonical number");
    $("global-search").value = "268"; $("global-search").dispatchEvent(new w.Event("input"));
    $("global-search").dispatchEvent(new w.KeyboardEvent("keydown", {key: "Enter", bubbles: true})); await flush();
    assert.equal($("experiment-workspace").hidden, false);
    assert.equal($("workspace-experiment-title").textContent, "XY-II-268");
    assert.equal($("global-search").value, "");
    const groups = [...$("experiment-list").querySelectorAll(".index-group")].map(item => item.textContent);
    assert.ok(groups.includes("XY-I") && groups.includes("XY-II"), "Notebook headers group the index");
    const item = $("experiment-list").querySelector('[data-workspace-key="experiment:default:xy-ii-268"]');
    assert.equal(item.querySelector(".index-count").textContent, "1");
    assert.match(item.title, /1 条样品 · 0 文件 · 待补全/, "Details move to the tooltip");
    assert.equal($("experiment-list").querySelector(".status"), null, "Default status is not repeated on every row");
    $("global-search").value = "no-such"; $("global-search").dispatchEvent(new w.Event("input"));
    assert.match($("global-results").textContent, /没有匹配的实验/);
    $("global-search").dispatchEvent(new w.KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
    assert.equal($("global-results").hidden, true);
    $("active-view").click();
    w.document.querySelector('[data-stat-action="missing"]').click();
    assert.equal($("records-panel").hidden, false, "Missing-conditions card opens the filtered list");
    assert.match($("chart-filter-label").textContent, /缺少核心条件/);
  } finally { jump.dom.window.close(); }
  const conditionTable = await boot({savedLanguage: "en", extraProjects: [{id: "other", name: "Other"}], extraRows: [
    sample("A-02", {experiment_no: "A", temperature: 0, files: [{id: "extra", name: "a.csv", kind: "XRD", size: 1}]}),
    sample("A-other", {experiment_no: "A", project_id: "other"}),
    sample("unknown", {precursor: "", temperature: null}),
    sample("escaped", {experiment_no: 'E<&"', precursor: '<img src=x onerror="alert(1)">', temperature: 25})
  ]});
  try {
    const {$, w, writes} = conditionTable;
    const C12 = "Compound A12 (CA12)";
    const change = field => { $("dashboard-condition-field").value = field; $("dashboard-condition-field").dispatchEvent(new w.Event("change")); };
    const cellsFor = value => [...$("dashboard-condition-table").querySelectorAll("[data-condition-value]")].find(button => button.dataset.conditionValue === value).closest("tr").cells;
    const experimentKeys = value => [...cellsFor(value)[2].querySelectorAll("[data-condition-experiment]")].map(button => button.dataset.conditionExperiment);
    assert.deepEqual(experimentKeys(C12), ["experiment:default:a", "experiment:default:zero"], "Experiment links deduplicate time points");
    assert.equal(cellsFor('<img src=x onerror="alert(1)">')[0].textContent, '<img src=x onerror="alert(1)">');
    assert.equal($("dashboard-condition-table").querySelector("img"), null);
    assert.equal(cellsFor('<img src=x onerror="alert(1)">')[1].textContent, "1", "Count sits in its own column");
    assert.equal(cellsFor('<img src=x onerror="alert(1)">')[2].querySelector("button").textContent, 'E<&"');
    assert.equal($("dashboard-condition-rows").lastElementChild.querySelector("button").dataset.conditionValue, "");
    for (const field of ["precursor", "temperature", "duration", "solvent"]) {
      change(field);
      const keys = new Set([...$("dashboard-condition-table").querySelectorAll("[data-condition-experiment]")].map(button => button.dataset.conditionExperiment));
      assert.deepEqual([...keys].sort(), ["experiment:default:a", 'experiment:default:e<&"', "experiment:default:unknown", "experiment:default:zero"]);
    }
    change("temperature");
    assert.deepEqual([...$("dashboard-condition-table").querySelectorAll("[data-condition-value]")].map(button => button.dataset.conditionValue), ["0", "25", "250", ""]);
    assert.deepEqual(experimentKeys("0"), ["experiment:default:a", "experiment:default:zero"]);
    change("precursor");
    $("project-select").value = ""; $("project-select").dispatchEvent(new w.Event("change"));
    assert.deepEqual(experimentKeys(C12), ["experiment:default:a", "experiment:other:a", "experiment:default:zero"], "Same experiment number in different projects stays separate");
    assert.deepEqual([...cellsFor(C12)[2].querySelectorAll("small")].map(item => item.textContent), ["Default project", "Other", "Default project"]);
    $("language-switch").click(); $("theme-switch").click();
    assert.equal($("dashboard-condition-column").textContent, "前驱体");
    assert.equal(cellsFor("")[0].textContent, "尚未记录");
    assert.equal(cellsFor(C12)[2].querySelectorAll("button").length, 3);
    cellsFor(C12)[0].querySelector("button").click();
    assert.equal($("records").querySelectorAll(".experiment-group").length, 3);
    $("dashboard-overview-tab").click();
    $("experiment-search").value = "stale search"; $("workspace-status-filter").value = "已完成";
    $("dashboard-condition-table").querySelector('[data-condition-experiment="experiment:other:a"]').click();
    assert.equal($("overview-view").hidden, true);
    assert.equal($("workspace-experiment-title").textContent, "A");
    assert.match($("workspace-experiment-meta").textContent, /Other/);
    assert.equal($("workspace-sample").options[1].value, "A-other");
    assert.equal($("experiment-search").value, "");
    assert.equal($("workspace-status-filter").value, "");
    assert.equal(w.document.activeElement, $("workspace-experiment-title"));
    assert.equal(w.location.hash, "#/workspace/other/A", "Workspace selection is kept in the URL");
    $("active-view").click();
    assert.equal(w.location.hash, "#/");
    w.history.replaceState(null, "", "#/workspace/other/A");
    w.dispatchEvent(new w.PopStateEvent("popstate"));
    assert.equal($("experiment-workspace").hidden, false, "Back/forward restores the workspace view");
    assert.equal($("workspace-experiment-title").textContent, "A");
    $("active-view").click();
    $("dashboard-condition-table").querySelector('[data-condition-experiment="experiment:default:a"]').click();
    assert.equal($("workspace-sample").options.length, 3, "Opening an experiment keeps all its samples");
    assert.equal(writes.length, 0);
  } finally { conditionTable.dom.window.close(); }
  const numericConditions = await boot({extraRows: [-10, -2, 1.11, 1.5, 1.05, null].map((temperature, i) => sample("T-" + i, {temperature}))});
  try {
    const {$, w} = numericConditions;
    $("dashboard-condition-field").value = "temperature";
    $("dashboard-condition-field").dispatchEvent(new w.Event("change"));
    assert.deepEqual([...$("dashboard-condition-table").querySelectorAll("[data-condition-value]")].map(button => button.dataset.conditionValue), ["-10", "-2", "0", "1.05", "1.11", "1.5", "250", ""], "Numeric conditions sort by value, with unknowns last");
  } finally { numericConditions.dom.window.close(); }
  const manyConditions = await boot({extraRows: Array.from({length: 9}, (_, i) => sample("E-" + i))});
  try {
    const {$, w, writes} = manyConditions;
    const row = () => $("dashboard-condition-rows").rows[0];
    assert.equal(row().cells[2].firstElementChild.querySelectorAll("button").length, 8);
    assert.equal(row().querySelector("details").querySelectorAll("button").length, 3);
    row().querySelector("details").open = true;
    $("language-switch").click();
    assert.equal(row().querySelector("details").open, true);
    assert.equal(row().querySelector("summary").textContent, "More experiments");
    row().querySelector("details button").click();
    assert.equal($("workspace-experiment-title").textContent, "E-7");
    assert.equal(writes.length, 0);
  } finally { manyConditions.dom.window.close(); }
  for (const savedOrder of [undefined, "desc"]) {
    const sorted = await boot({savedOrder, extraRows: [sample("E-10"), sample("E-2")]});
    try {
      const {$, w, writes} = sorted;
      $("experiment-view").click();
      const names = () => [...$("experiment-list").querySelectorAll("strong")].map(item => item.textContent);
      const ascending = ["A", "E-2", "E-10", "ZERO"];
      assert.deepEqual(names(), savedOrder === "desc" ? ascending.toReversed() : ascending);
      w.document.querySelector('[data-workspace-key="experiment:default:e-2"]').click();
      $("experiment-order").value = "desc"; $("experiment-order").dispatchEvent(new w.Event("change"));
      assert.deepEqual(names(), ascending.toReversed());
      assert.equal($("workspace-experiment-title").textContent, "E-2");
      assert.equal(w.localStorage.getItem("catalog-experiment-order"), "desc");
      $("experiment-order").value = "asc"; $("experiment-order").dispatchEvent(new w.Event("change"));
      assert.deepEqual(names(), ascending);
      assert.equal($("workspace-experiment-title").textContent, "E-2");
      assert.equal(w.localStorage.getItem("catalog-experiment-order"), "asc");
      assert.equal(writes.length, 0);
    } finally { sorted.dom.window.close(); }
  }
  let finishPreview;
  const delayed = await boot({previewHandler: () => new Promise(resolve => { finishPreview = resolve; })});
  try {
    delayed.$("experiment-view").click();
    delayed.w.document.querySelector('[data-workspace-key="experiment:default:zero"]').click();
    const finishLatest = finishPreview;
    delayed.$("project-select").value = "default";
    delayed.$("active-view").click();
    finishLatest({ok: true, json: async () => ({rows: [["stale"]], points: [], labels: [], truncated: false})});
    await flush();
    assert.doesNotMatch(delayed.$("workspace-preview").textContent, /stale/);
  } finally { delayed.dom.window.close(); }
  const removal = await boot({savedLanguage: "en", extraProjects: [{id: "other", name: "Other"}], extraRows: [
    sample("archive-other", {archived: true, project_id: "other", files: [{id: "kept", name: "Archived.csv", kind: "XRD", size: 8, sha256: "1234"}]})
  ]});
  try {
    const {$, w, kinds, rows, writes} = removal;
    $("manage-categories").click();
    w.document.querySelector('[data-delete-category="XRD"]').click();
    assert.match($("category-delete-help").textContent, /2 attachments.*all projects/);
    $("confirm-delete-category").click();
    assert.equal(writes.length, 0);
    assert.match($("catalog-error").textContent, /destination category/);
    $("cancel-delete-category").click();
    assert.equal(kinds.includes("XRD"), true);
    w.document.querySelector('[data-delete-category="XRD"]').click();
    $("category-replacement").value = "NMR";
    $("confirm-delete-category").click(); await flush(); await flush();
    assert.equal(kinds.includes("XRD"), false);
    assert.equal(w.document.querySelector('[data-kind-view="XRD"]'), null);
    assert.equal([...$("filter-kind").options].some(option => option.value === "XRD"), false);
    assert.equal(rows.find(row => row.id === "archive-other").files[0].id, "kept");
    assert.equal(rows.find(row => row.id === "archive-other").files[0].kind, "NMR");
    w.document.querySelector('[data-delete-category="XPS"]').click();
    assert.equal($("category-replacement-label").hidden, true);
    $("confirm-delete-category").click(); await flush(); await flush();
    assert.equal(kinds.includes("XPS"), false);
    assert.equal($("catalog-name").disabled, false);
    $("catalog-name").value = "Restored category";
    $("catalog-form").dispatchEvent(new w.Event("submit", {cancelable: true})); await flush();
    assert.equal(kinds.includes("Restored category"), true);
    assert.equal($("catalog-dialog").open, false);
  } finally { removal.dom.window.close(); }
  const conflict = await boot({savedLanguage: "en", deleteError: "目标类别存在同一样品的同名附件，未作任何更改。请选择其他类别。"});
  try {
    const {$, w, kinds} = conflict;
    $("manage-categories").click();
    w.document.querySelector('[data-delete-category="XRD"]').click();
    $("category-replacement").value = "NMR";
    $("confirm-delete-category").click(); await flush();
    assert.match($("catalog-error").textContent, /Nothing was changed/);
    assert.equal($("catalog-dialog").open, true);
    assert.equal($("category-replacement").value, "NMR");
    assert.equal($("confirm-delete-category").disabled, false);
    assert.equal(kinds.includes("XRD"), true);
  } finally { conflict.dom.window.close(); }
  const previewPhases = await boot({
    savedLanguage: "en",
    extraRows: [
      sample("aliquot-5", {experiment_no: "Aliquots", duration: 5, files: [{id: "curve-5", name: "5min.csv", kind: "XRD", size: 10}],
        result_summary: {phases: ["Phase-C"], morphologies: ["nanoparticles"], conclusion: "Observed by XRD", confirmation: "confirmed", evidence_ids: ["curve-5"]}}),
      sample("aliquot-15", {experiment_no: "Aliquots", duration: 15, files: [{id: "curve-15", name: "15min.csv", kind: "XRD", size: 12}]})
    ],
    bulkHandler: (payload, rows) => {
      const [{id, revision}] = payload.records, row = rows.find(item => item.id === id);
      assert.equal(payload.records.length, 1);
      assert.equal(payload.preview, false);
      if (revision !== row.revision) return {ok: false, status: 409, json: async () => ({error: "Sample changed"})};
      const phases = payload.changes.phases.value || [];
      row.result_summary = {...row.result_summary, phases, confirmation: payload.changes.confirmation?.value ?? (row.result_summary?.confirmation || "pending")};
      row.revision++;
      if (id === "aliquot-5") throw new Error("Lost the phase save response");
      return {ok: true, json: async () => ({records: [structuredClone(row)]})};
    }
  });
  try {
    const {$, w, rows, writes} = previewPhases;
    const pick = phase => $("preview-phases").querySelector(`[data-phase-choice="${phase}"]`);
    const row = id => rows.find(item => item.id === id);
    $("experiment-view").click();
    w.document.querySelector('[data-workspace-key="experiment:default:aliquots"]').click();
    await flush();
    assert.equal($("workspace-sample").value, "", "All samples can stay in view while labeling an individual");
    $("workspace-preview").querySelector('[data-preview-mode="overlay"]').click();
    await flush();
    const plot = $("workspace-preview").querySelector(".csv-plot");
    assert.equal(plot.querySelectorAll("polyline").length, 2);
    assert.equal($("preview-phase-label").textContent, "Phases · aliquot-5");
    $("workspace-status").value = "待表征";
    $("workspace-status").dispatchEvent(new w.Event("change"));
    pick("Phase-B").click();
    pick("Phase-B").click();
    await flush(); await flush();
    assert.equal(writes.length, 1, "The in-flight write prevents a repeat click");
    assert.equal(writes[0].payload.records[0].id, "aliquot-5");
    assert.equal(pick("Phase-B").getAttribute("aria-pressed"), "true", "A lost response is checked via the saved result");
    assert.deepEqual(row("aliquot-5").result_summary.phases, ["Phase-C", "Phase-B"]);
    assert.deepEqual(row("aliquot-5").result_summary.evidence_ids, ["curve-5"]);
    assert.equal(row("aliquot-5").result_summary.conclusion, "Observed by XRD");
    assert.equal(row("aliquot-15").result_summary, undefined);
    assert.equal($("workspace-preview").querySelector(".csv-plot"), plot, "Saving a phase keeps the current plot and overlays");
    assert.equal($("workspace-status").value, "待表征", "An unrelated pending status choice is preserved");
    assert.match($("workspace-result-content").textContent, /Phase-C \/ Phase-B/);

    $("workspace-file").value = "curve-15";
    $("workspace-file").dispatchEvent(new w.Event("change"));
    await flush();
    assert.equal($("preview-phase-label").textContent, "Phases · aliquot-15");
    pick("Phase-A2p").click();
    await flush();
    assert.deepEqual(row("aliquot-15").result_summary.phases, ["Phase-A2p"]);
    assert.equal(row("aliquot-15").result_summary.confirmation, "pending");
    assert.equal(pick("Phase-B").getAttribute("aria-pressed"), "false");
    pick("Phase-A2p").click();
    await flush();
    assert.deepEqual(row("aliquot-15").result_summary.phases, []);
    assert.equal(row("aliquot-15").result_summary.confirmation, "");

    row("aliquot-15").revision++;
    row("aliquot-15").result_summary = {phases: ["Phase-A2m"], confirmation: "confirmed"};
    pick("Phase-B").click();
    await flush(); await flush();
    assert.equal(writes.length, 4, "A stale revision is refreshed without retrying the write");
    assert.equal(pick("Phase-A2m").getAttribute("aria-pressed"), "true");
    assert.match($("preview-phase-error").textContent, /Review its current phases/);
    $("preview-edit-result").click();
    assert.equal($("record-form").elements.sample_id.value, "aliquot-15");
    assert.equal($("result-phases").querySelector('[data-phase-choice="Phase-A2m"]').getAttribute("aria-pressed"), "true");
  } finally { previewPhases.dom.window.close(); }
  const results = await boot({extraRows: [sample("RESULT-REFERENCE", {result_summary: {phases: ["Phase-A2", "Custom phase"], morphologies: ["nanoparticles"], confirmation: "pending"}})]});
  try {
    const {$, w, rows, writes} = results;
    $("dashboard-records-tab").click();
    w.document.querySelector('[data-expand="experiment:default:a"]').click();
    w.document.querySelector('[data-open="A"]').click();
    $("detail-content").querySelector('[data-edit-result="A"]').click();
    assert.equal(w.document.activeElement, $("result-phase-input"));
    assert.equal($("result-confirmation").value, "");
    assert.equal($("result-evidence-options").querySelectorAll("input").length, 1, "Evidence choices must belong to the edited sample");
    assert.ok([...$("result-phase-options").options].some(option => option.value === "Phase-A2"), "Previous result tags are available for reuse");
    assert($("result-phases").querySelector('[data-phase-choice="Custom phase"]'), "Previously saved phases appear among quick choices");
    const add = value => {
      $("result-phase-input").value = value;
      $("result-phase-input").dispatchEvent(new w.KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true}));
    };
    $("result-phase-input").value = "输入法候选";
    $("result-phase-input").dispatchEvent(new w.KeyboardEvent("keydown", {key: "Enter", isComposing: true, bubbles: true, cancelable: true}));
    const picked = () => [...$("result-phases").querySelectorAll('[aria-pressed="true"]')].map(button => button.dataset.phaseChoice);
    const preset = () => $("result-phases").querySelector('[data-phase-choice="Phase-A2"]');
    assert.deepEqual(picked(), [], "IME confirmation must not add an unfinished tag");
    preset().click();
    assert.equal($("result-phase-input").value, "输入法候选");
    assert.deepEqual(picked(), ["Phase-A2"]);
    assert.equal(writes.length, 0, "The editor keeps a draft until save");
    preset().click();
    assert.equal($("result-confirmation").value, "");
    preset().click();
    add("Phase-A"); add(" Phase-A2 ");
    assert.deepEqual(picked(), ["Phase-A2", "Phase-A"], "Trimmed duplicate tags must not be added twice");
    assert.equal($("result-confirmation").value, "pending");
    $("result-phases").querySelector('[data-phase-choice="Phase-A"]').click();
    assert.deepEqual(picked(), ["Phase-A2"]);
    add("Phase-A");
    $("result-morphology-input").value = "nanoparticles";
    $("result-conclusion").value = '<b>Mixed phases</b>';
    $("result-conclusion").dispatchEvent(new w.Event("input", {bubbles: true}));
    const evidence = $("result-evidence-options").querySelector("input");
    evidence.checked = true; evidence.dispatchEvent(new w.Event("change", {bubbles: true}));
    $("result-confirmation").value = "confirmed";
    $("language-switch").click();
    $("theme-switch").click();
    assert.equal($("result-morphology-input").value, "nanoparticles", "Language and theme changes preserve text awaiting addition");
    assert.equal($("result-confirmation").value, "confirmed");
    assert.equal(evidence.checked, true);
    assert.match($("editor-results").textContent, /Supporting measurements/);
    $("record-form").dispatchEvent(new w.Event("submit", {cancelable: true})); await flush(); await flush();
    assert.equal($("editor").open, false);
    assert.equal(writes.length, 1);
    const saved = rows.find(row => row.id === "A").result_summary;
    assert.deepEqual(saved.phases, ["Phase-A2", "Phase-A"]);
    assert.deepEqual(saved.morphologies, ["nanoparticles"], "Saving also adds a tag still in the entry box");
    assert.deepEqual(saved.evidence_ids, ["f1"]);
    assert.equal(rows.find(row => row.id === "A").status, "待补全", "Result confirmation must not change experiment progress");
    assert.equal($("detail-result-content").querySelector("b"), null, "Conclusions are text, not markup");
    assert.match($("detail-result-content").textContent, /Confirmed/);
    $("detail-result-content").querySelector('[data-result-file="f1"]').click(); await flush();
    assert.equal($("detail").open, false);
    assert.equal($("experiment-workspace").hidden, false);
    assert.equal($("workspace-sample").value, "A");
    assert.equal($("workspace-file").value, "f1", "Evidence opens the associated sample and preview");
    assert.match($("workspace-result-content").textContent, /Mixed phases/);
    $("workspace-edit-results").click();
    assert.equal($("editor").open, true);
    assert.equal($("result-evidence-options").querySelector("input").checked, true);
    $("cancel-editor").click();
    $("active-view").click();
    assert.deepEqual(results.scrollCalls.at(-1), [0, 0], "Returning from evidence resets page scroll below the fixed header");
    $("dashboard-records-tab").click();
    $("filter-phase").value = "Phase-A2"; $("filter-phase").dispatchEvent(new w.Event("change"));
    $("filter-result-confirmation").value = "confirmed"; $("filter-result-confirmation").dispatchEvent(new w.Event("change"));
    assert.equal($("records").querySelectorAll(".experiment-group").length, 1);
    assert.match($("records").textContent, /A/);
    $("filter-solvent").value = "not present";
    $("clear-filters").click();
    assert.equal($("filter-phase").value, "");
    assert.equal($("filter-result-confirmation").value, "");
    $("filter-result-confirmation").value = "unrecorded"; $("filter-result-confirmation").dispatchEvent(new w.Event("change"));
    assert.equal($("records").querySelectorAll(".experiment-group").length, 1);
    assert.match($("records").textContent, /ZERO/);
    $("clear-filters").click();
    w.document.querySelector('[data-open="A"]').click();
    $("duplicate-record").click();
    assert.equal($("result-confirmation").value, "");
    assert.deepEqual(picked(), [], "Copying conditions must not copy scientific conclusions");
    assert.equal($("result-conclusion").value, "");
    assert.equal($("result-evidence-options").querySelectorAll("input").length, 0);
    $("cancel-editor").click();
    $("new-record").click();
    assert.deepEqual(picked(), [], "New samples start with unknown results");
    assert.equal(writes.length, 1, "Opening, previewing, filtering and cancelling never write records");
  } finally { results.dom.window.close(); }
  const resultFailure = await boot({savedLanguage: "en", recordHandler: () => ({ok: false, status: 400, json: async () => ({error: "请先填写物相、形貌或结论，再确认结果。"})})});
  try {
    const {$, w, writes} = resultFailure;
    $("dashboard-records-tab").click();
    w.document.querySelector('[data-expand="experiment:default:a"]').click();
    w.document.querySelector('[data-open="A"]').click();
    $("edit-record").click();
    $("result-confirmation").value = "confirmed";
    $("record-form").dispatchEvent(new w.Event("submit", {cancelable: true})); await flush(); await flush();
    assert.equal($("editor").open, true);
    assert.equal($("result-confirmation").value, "confirmed");
    assert.match($("form-error").textContent, /Enter a phase, morphology, or conclusion/);
    assert.equal(writes.length, 1, "A failed result save must not automatically retry a write");
  } finally { resultFailure.dom.window.close(); }
  const bulkSelection = await boot({savedLanguage: "en", extraRows: [sample("DATASET", {sample_id: "资料集-test", notes: "批量导入：local-test"}), ...Array.from({length: 7}, (_, i) => sample("EXTRA-" + i))]});
  try {
    const {$, w, writes} = bulkSelection;
    $("dashboard-records-tab").click(); $("select-visible").click();
    assert.equal($("selection-count").textContent, "9 selected", "Select filtered includes collapsed samples, excluding datasets and archives");
    assert.equal($("compare").disabled, true, "Comparisons retain the six-sample limit");
    assert.equal($("bulk-edit").disabled, false);
    $("bulk-edit").click();
    assert.match($("bulk-subtitle").textContent, /9 samples/);
    assert.equal($("bulk-temperature-mode").value, "");
    assert.equal($("bulk-temperature").disabled, true);
    assert.equal($("preview-bulk").disabled, true);
    $("cancel-bulk").click();
    assert.equal($("bulk-editor").open, false);
    assert.equal(writes.length, 0, "Opening or cancelling does not request a save");
    $("clear-selection").click();
    w.document.querySelector('[data-select="DATASET"]').checked = true;
    w.document.querySelector('[data-select="DATASET"]').dispatchEvent(new w.Event("change", {bubbles: true}));
    assert.equal($("bulk-edit").disabled, true, "Imported documents are not synthesis samples");
  } finally { bulkSelection.dom.window.close(); }
  const previewRows = (payload, rows) => payload.records.map(item => {
    const row = rows.find(row => row.id === item.id);
    return {id: row.id, revision: row.revision, sample_id: row.sample_id, experiment_no: row.experiment_no, project_id: row.project_id,
      changes: [{field: "temperature", before: row.temperature, after: payload.changes.temperature.value},
                {field: "phases", before: [], after: ["Phase-A2"]}, {field: "confirmation", before: "", after: "pending"}]};
  });
  const saveBulk = (payload, rows) => payload.records.map(item => {
    const row = rows.find(row => row.id === item.id);
    row.temperature = payload.changes.temperature.value;
    row.result_summary = {phases: ["Phase-A2"], morphologies: [], confirmation: "pending", conclusion: "", evidence_ids: []};
    row.revision++;
    return structuredClone(row);
  });
  const bulk = await boot({savedLanguage: "en", bulkHandler: (payload, rows) => {
    assert.deepEqual(Object.keys(payload.changes).sort(), ["phases", "temperature"]);
    assert.deepEqual(payload.changes.phases, {mode: "append", value: ["Phase-A2"]});
    const preview = {preview: true, updated: 2, rows: previewRows(payload, rows)};
    return {ok: true, json: async () => payload.preview ? preview : {preview: false, updated: 2, records: saveBulk(payload, rows)}};
  }});
  try {
    const {$, w, writes, rows} = bulk;
    const original = structuredClone(rows);
    const change = id => $(id).dispatchEvent(new w.Event("change", {bubbles: true}));
    const preview = async () => { $("bulk-form").dispatchEvent(new w.Event("submit", {cancelable: true})); await flush(); await flush(); };
    $("dashboard-records-tab").click(); $("select-visible").click(); $("bulk-edit").click();
    await preview();
    assert.match($("bulk-error").textContent, /Choose at least one/);
    assert.equal(writes.length, 0);
    $("bulk-temperature-mode").value = "set"; change("bulk-temperature-mode"); $("bulk-temperature").value = "300";
    $("bulk-duration").value = "999";
    $("bulk-phases-mode").value = "append"; change("bulk-phases-mode"); $("bulk-phases").value = "Phase-A2\nPhase-A2";
    await preview();
    assert.equal($("bulk-review-step").hidden, false);
    assert.match($("bulk-review").textContent, /300/);
    assert.match($("bulk-review").textContent, /Pending confirmation/);
    assert.deepEqual(rows, original, "Preview is not a data write");
    $("back-bulk").click();
    assert.equal($("confirm-bulk").disabled, true, "Returning to editing invalidates the previous preview");
    $("bulk-temperature").value = "275";
    $("bulk-temperature").dispatchEvent(new w.Event("input", {bubbles: true}));
    $("language-switch").click();
    assert.equal($("bulk-temperature").value, "275");
    assert.equal($("bulk-phases-mode").value, "append");
    assert.equal($("bulk-temperature-mode").selectedOptions[0].textContent, "设为");
    await preview();
    assert.match($("bulk-review").textContent, /待确认/);
    $("language-switch").click();
    assert.match($("bulk-review").textContent, /Pending confirmation/);
    $("confirm-bulk").click(); $("confirm-bulk").click(); await flush(); await flush();
    assert.equal($("bulk-editor").open, false);
    assert.equal(writes.filter(write => write.payload.preview === false).length, 1, "Repeated clicks never repeat the write");
    for (const row of rows.filter(row => !row.archived)) {
      assert.equal(row.temperature, 275);
      assert.equal(row.duration, original.find(item => item.id === row.id).duration, "A value in an unselected field is not saved");
    }
    assert.match($("toast").textContent, /Updated 2 samples/);
  } finally { bulk.dom.window.close(); }
  for (const scenario of ["conflict", "lost-response", "unconfirmed"]) {
    const failure = await boot({savedLanguage: "en", bulkHandler: (payload, rows) => {
      if (payload.preview) return {ok: true, json: async () => ({preview: true, updated: 2, rows: previewRows(payload, rows)})};
      if (scenario === "conflict") return {ok: false, status: 409, json: async () => ({error: "记录已变化或已归档，未修改任何样品。请关闭批量编辑并刷新后重试。"})};
      if (scenario === "lost-response") saveBulk(payload, rows);
      throw new Error("Lost response");
    }});
    try {
      const {$, w, writes, rows} = failure;
      $("dashboard-records-tab").click(); $("select-visible").click(); $("bulk-edit").click();
      for (const [field, mode, value] of [["temperature", "set", "275"], ["phases", "append", "Phase-A2"]]) {
        $("bulk-" + field + "-mode").value = mode;
        $("bulk-" + field + "-mode").dispatchEvent(new w.Event("change", {bubbles: true}));
        $("bulk-" + field).value = value;
      }
      $("bulk-form").dispatchEvent(new w.Event("submit", {cancelable: true})); await flush(); await flush();
      $("confirm-bulk").click(); await flush(); await flush();
      assert.equal(writes.filter(write => write.payload.preview === false).length, 1);
      if (scenario === "lost-response") {
        assert.equal($("bulk-editor").open, false, "Read-back confirms committed data without a second write");
        assert.equal(rows.find(row => row.id === "A").temperature, 275);
      } else {
        assert.equal($("bulk-editor").open, true);
        assert.equal($("bulk-temperature").value, "275", "Failed saves preserve draft values");
        assert.equal($("confirm-bulk").disabled, true);
        assert.match($("bulk-error").textContent, scenario === "conflict" ? /Nothing was changed/ : /could not be confirmed/);
        assert.equal(rows.find(row => row.id === "A").temperature, 250);
      }
    } finally { failure.dom.window.close(); }
  }
  const crossSampleXrd = await boot({savedLanguage: "en", extraRows: [
    sample("XRD-2", {files: [{id: "valid", name: "angle-intensity.csv", kind: "XRD"}]}),
    sample("XRD-3", {files: [{id: "invalid", name: "fitted.csv", kind: "XRD"}]}),
  ], previewHandler: url => ({ok: true, json: async () => ({
    labels: ["two_theta_deg", url.includes("/invalid/") ? "y_background" : "yobs"], points: [[10, 0], [20, 42]],
  })})});
  try {
    const {$} = crossSampleXrd;
    $("dashboard-records-tab").click();
    $("select-visible").click();
    $("compare").click();
    assert.equal($("comparison-xrd-normalize").checked, false);
    $("draw-comparison-xrd").click(); await flush(); await flush();
    assert.equal($("comparison-xrd-plot").querySelectorAll(".comparison-plot-legend li").length, 2);
    assert.match($("comparison-xrd-plot").textContent, /fitted.csv.*measured intensity/);
  } finally { crossSampleXrd.dom.window.close(); }
  {
    const folder = "E:/Backups/catalog";
    const idle = {state: "idle", last: null, folder, stale_after_days: 7};
    let current = idle, started = null;
    const backup = await boot({desktop: true, savedLanguage: "en", readHandler: catalog => ({ok: true, json: async () => ({...catalog, backup: idle})}),
      backupHandler: (url, options) => {
        if (url === "/api/backup/folder") {
          started = JSON.parse(options.body);
          current = {state: "running", phase: "files", total_files: 4, done_files: 1, total_bytes: 2048, done_bytes: 1024, last: null, folder, stale_after_days: 7};
        }
        const reply = current;
        return {ok: true, json: async () => structuredClone(reply)};
      }});
    try {
      const {$, w} = backup;
      await flush();
      assert.equal($("backup-badge").hidden, false, "A catalog that was never backed up shows the reminder");
      assert.match($("backup-badge").title, /Not backed up/);
      $("backup-view").click(); await flush();
      assert.equal($("backup-dialog").open, true);
      assert.equal($("backup-path").value, folder, "The last folder is suggested");
      assert.match($("backup-last").textContent, /No backup has been completed/);
      $("backup-path").value = "";
      $("start-backup").click(); await flush();
      assert.match($("backup-error").textContent, /full path/);
      assert.equal(started, null);
      $("backup-path").value = folder;
      $("backup-verify").checked = true;
      $("start-backup").click(); await flush();
      assert.deepEqual(started, {path: folder, verify: true});
      assert.equal($("start-backup").disabled, true, "One backup at a time");
      assert.match($("backup-progress-text").textContent, /Copying: 1 \/ 4 files/);
      const prompts = [];
      w.confirm = message => { prompts.push(message); return false; };
      assert.equal(w.confirmCatalogClose(), false, "Closing the desktop window during a backup asks first");
      assert.equal(prompts.length, 1);
      $("close-backup").click();
      assert.equal($("backup-dialog").open, false);
      current = {state: "done", phase: "done", copied_files: 3, copied_bytes: 2048, total_bytes: 2048, folder, stale_after_days: 7,
        last: {kind: "folder", path: folder, time: new Date().toISOString(), files: 4, bytes: 4096}};
      await new Promise(resolve => setTimeout(resolve, 1700));
      assert.equal($("backup-badge").hidden, true, "Polling continues after closing and clears the reminder");
      assert.equal(w.confirmCatalogClose(), true);
      $("backup-view").click(); await flush(); await flush();
      assert.match($("backup-progress-text").textContent, /Backup complete: 3 new files/);
      assert.match($("backup-last").textContent, /Last backup: .* Folder · 4 attachments/);
      assert.equal($("start-backup").disabled, false);
      $("language-switch").click(); await flush();
      assert.match($("backup-last").textContent, /上次备份：.*文件夹 · 4 个附件/);
      assert.equal($("backup-path").value, folder, "Switching language keeps the folder");
    } finally { backup.dom.window.close(); }
  }
  {
    // Milestone 1: manage attachments, trash, attachment history and an expired session.
    const trash = [], calls = [];
    const reply = (status, body) => ({ok: status < 300, status, json: async () => structuredClone(body)});
    const find = (rows, fileId) => { for (const row of rows) { const file = row.files.find(item => item.id === fileId); if (file) return {row, file}; } return {}; };
    const attachments = await boot({savedLanguage: "en", extraRows: [sample("B", {files: []}), sample("OLD", {archived: true, files: [{id: "f9", name: "old.csv", kind: "XRD", size: 5, sha256: "abcdefabcdef0000"}]})],
      readHandler: catalog => reply(200, {...catalog, trash_count: trash.length}),
      workflowHandler: url => reply(200, url.startsWith("/api/history") ? {batches: [], has_more: false, file_events: [
        {id: "e1", file_id: "f1", record_id: "A", action: "rename", before: {name: "old.csv", kind: "XRD", record_id: "A"}, after: {name: "pattern.csv", kind: "XRD", record_id: "A"}, created_at: "2026-11-20T10:00:00Z", sample_id: "A"},
        {id: "e2", file_id: "f1", record_id: "B", action: "move", before: {name: "pattern.csv", kind: "XRD", record_id: "A"}, after: {name: "pattern.csv", kind: "XRD", record_id: "B"}, created_at: "2026-11-20T11:00:00Z", sample_id: "B"}]} : {items: []}),
      attachmentHandler: (url, options, rows) => {
        const body = options.body ? JSON.parse(options.body) : {};
        calls.push({url, body});
        if (url.startsWith("/api/trash?")) return reply(200, {items: structuredClone(trash), total_bytes: trash.reduce((sum, item) => sum + item.size, 0)});
        const id = url.split("/")[3];
        if (url.endsWith("/update")) {
          const {row, file} = find(rows, id);
          if (body.record_revision !== row.revision) return reply(409, {error: "这条记录已在其他窗口更新。请保留当前内容，关闭编辑窗口后刷新再编辑。"});
          if (body.name) file.name = body.name;
          if (body.kind) file.kind = body.kind;
          row.revision++;
          const changed = [row];
          if (body.target_record_id) {
            const target = rows.find(item => item.id === body.target_record_id);
            assert.equal(body.target_revision, target.revision);
            row.files = row.files.filter(item => item.id !== id); target.files.push(file); target.revision++; changed.push(target);
          }
          return reply(200, {file, records: changed});
        }
        if (url.endsWith("/delete")) {
          const {row, file} = find(rows, id);
          row.files = row.files.filter(item => item.id !== id); row.revision++;
          trash.push({...file, deleted_at: "2026-11-20T12:00:00Z", record_id: row.id, sample_id: row.sample_id, experiment_no: row.experiment_no, project_id: row.project_id, record_archived: false, name_conflict: true});
          return reply(200, {records: [row], trash_count: trash.length});
        }
        if (url.endsWith("/restore")) {
          const index = trash.findIndex(item => item.id === id), item = trash[index], row = rows.find(entry => entry.id === item.record_id);
          if (item.name_conflict && !body.name) return reply(409, {error: "同名同类附件已存在，请为恢复的附件输入新名称。"});
          trash.splice(index, 1);
          const file = {...item, name: body.name || item.name}; row.files.push(file); row.revision++;
          return reply(200, {file, records: [row], trash_count: trash.length});
        }
        if (url === "/api/trash/purge") {
          assert.equal(body.confirm, "purge");
          const bytes = trash.filter(item => body.file_ids.includes(item.id)).reduce((sum, item) => sum + item.size, 0);
          for (const fileId of body.file_ids) trash.splice(trash.findIndex(item => item.id === fileId), 1);
          return reply(200, {purged: body.file_ids.length, bytes, trash_count: trash.length});
        }
        throw new Error("Unhandled " + url);
      }});
    try {
      const {$, w, rows, confirmations} = attachments;
      const open = id => {
        const find = () => w.document.querySelector(`[data-open="${id}"]`);
        if (!find()) w.document.querySelector(`[data-expand="experiment:default:${id.toLowerCase()}"]`).click();
        find().click();
      };
      $("dashboard-records-tab").click();
      assert.equal($("trash-count").hidden, true, "An empty trash shows no count");
      open("A");
      const manage = () => $("detail-content").querySelector('[data-manage-file="f1"]');
      assert.ok(manage(), "Active samples offer attachment management");
      manage().click();
      assert.equal($("file-dialog").open, true);
      assert.equal($("file-name").value, "pattern.csv");
      assert.deepEqual([...$("file-target").options].map(option => option.value).includes("OLD"), false, "Archived samples are not move targets");
      $("save-file").click(); await flush();
      assert.match($("file-error").textContent, /no changes/i, "Unchanged values are not submitted");
      assert.equal(calls.length, 0);
      $("file-name").value = "renamed.csv";
      $("file-kind").value = "NMR";
      $("save-file").click(); await flush(); await flush();
      assert.deepEqual(calls.at(-1), {url: "/api/files/f1/update", body: {record_revision: 1, name: "renamed.csv", kind: "NMR"}});
      assert.equal($("file-dialog").open, false);
      assert.match($("detail-content").textContent, /renamed\.csv/, "The detail view uses the returned record");
      assert.match($("toast").textContent, /Attachment updated/);
      // A stale revision keeps the dialog open, explains, and refreshes the catalog for a retry.
      rows.find(row => row.id === "A").revision = 7;
      manage().click();
      $("file-name").value = "stale.csv";
      $("save-file").click(); await flush(); await flush(); await flush();
      assert.equal($("file-dialog").open, true);
      assert.match($("file-error").textContent, /updated in another window/i);
      $("save-file").click(); await flush(); await flush();
      assert.equal(calls.at(-1).body.record_revision, 7, "The retry uses the refreshed revision");
      // Move to another sample of the same project.
      manage().click();
      $("file-target").value = "B";
      $("save-file").click(); await flush(); await flush();
      assert.equal(calls.at(-1).body.target_record_id, "B");
      assert.match($("toast").textContent, /moved to B/);
      assert.equal($("detail-content").querySelector('[data-manage-file="f1"]'), null, "The source sample no longer lists the moved file");
      // Trash: delete from B, restore with a new name, then purge.
      $("close-detail").click();
      open("B");
      manage().click();
      $("delete-file").click(); await flush(); await flush();
      assert.match(confirmations.at(-1), /Move stale\.csv to the trash/);
      assert.equal($("trash-count").textContent, "1");
      assert.equal($("trash-count").hidden, false);
      $("close-detail").click();
      $("trash-view").click(); await flush(); await flush();
      assert.equal($("trash-dialog").open, true);
      assert.match($("trash-content").textContent, /stale\.csv/);
      assert.match($("trash-content").textContent, /choose a new name/);
      $("trash-content").querySelector('[data-trash-restore="f1"]').click(); await flush();
      const rename = $("trash-content").querySelector('[data-trash-name="f1"]');
      assert.ok(rename, "A name conflict asks for a new name before restoring");
      rename.value = "restored.csv";
      $("trash-content").querySelector('[data-trash-restore="f1"]').click(); await flush(); await flush(); await flush();
      assert.equal(calls.filter(call => call.url.endsWith("/restore")).at(-1).body.name, "restored.csv");
      assert.match($("toast").textContent, /restored\.csv restored to B/);
      assert.equal($("trash-count").hidden, true);
      assert.match($("trash-content").textContent, /The trash is empty/);
      assert.equal($("purge-all").disabled, true);
      $("trash-close").click();
      open("B"); manage().click(); $("delete-file").click(); await flush(); await flush(); $("close-detail").click();
      $("trash-view").click(); await flush(); await flush();
      const box = $("trash-content").querySelector('[data-trash-select="f1"]');
      box.checked = true; box.dispatchEvent(new w.Event("change", {bubbles: true}));
      assert.equal($("purge-selected").disabled, false);
      w.confirm = message => { confirmations.push(message); return false; };
      $("purge-selected").click(); await flush();
      assert.equal(calls.some(call => call.url === "/api/trash/purge"), false, "Declining the warning purges nothing");
      w.confirm = message => { confirmations.push(message); return true; };
      $("purge-selected").click(); await flush(); await flush(); await flush();
      assert.match(confirmations.at(-1), /Permanently delete 1 attachments.*cannot be undone/);
      assert.deepEqual(calls.filter(call => call.url === "/api/trash/purge").at(-1).body, {file_ids: ["f1"], confirm: "purge", project_id: "default"}, "A project-scoped view sends its scope");
      assert.match($("toast").textContent, /Permanently deleted 1 attachments/);
      $("language-switch").click(); await flush();
      assert.match($("trash-content").textContent, /回收站是空的/);
      $("trash-close").click();
      // Archived records do not offer management; history lists attachment changes.
      $("language-switch").click(); await flush();
      $("archived-view").click();
      open("OLD");
      assert.equal($("detail-content").querySelector("[data-manage-file]"), null);
      $("close-detail").click();
      $("history-view").click(); await flush(); await flush();
      assert.match($("history-content").textContent, /Attachment changes/);
      assert.match($("history-content").textContent, /old\.csv → pattern\.csv/);
      assert.match($("history-content").textContent, /Attachment moved.*pattern\.csv · A → B/);
      $("close-history").click();
    } finally { attachments.dom.window.close(); }
    const expired = await boot({savedLanguage: "en", readHandler: () => ({ok: false, status: 401, json: async () => ({error: "会话已失效，请从启动入口重新打开实验数据目录。"})})});
    try {
      await flush(); await flush();
      assert.equal(expired.$("session-banner").hidden, false, "A 401 shows the session banner");
      assert.match(expired.$("session-banner").textContent, /session has ended/);
    } finally { expired.dom.window.close(); }
  }
  {
    // Review fixes: stale trash scope, conflict refresh keeps only the user's edits, drafts, partial responses, counts.
    const reply = (status, body) => ({ok: status < 300, status, json: async () => structuredClone(body)});
    const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
    const calls = [], pending = [];
    let updateMode = "normal", reads = 0;
    const foreign = {id: "x1", name: "other-project.csv", kind: "XRD", size: 9, sha256: "0".repeat(64), deleted_at: "2026-11-20T09:00:00Z",
      record_id: "Z", sample_id: "Z", experiment_no: "Z", project_id: "other-lab", record_archived: false, name_conflict: false};
    const local = {...foreign, id: "l1", name: "local.csv", record_id: "A", sample_id: "A", experiment_no: "A", project_id: "default", name_conflict: true};
    const env = await boot({savedLanguage: "en", extraProjects: [{id: "other-lab", name: "Other lab"}],
      readHandler: catalog => { reads++; return reply(200, {...catalog, trash_count: 2, category_counts: {XRD: {active: 1, trashed: 0}, TEM: {active: 0, trashed: 3}}}); },
      attachmentHandler: (url, options, rows) => {
        const body = options.body ? JSON.parse(options.body) : {};
        calls.push({url, body});
        if (url.startsWith("/api/trash?")) {
          const all = url.endsWith("project_id=");
          const response = reply(200, {items: all ? [local, foreign] : [local], total_bytes: 18});
          if (all) { const gate = deferred(); pending.push(gate); return gate.promise.then(() => response); }
          return response;
        }
        if (url.endsWith("/restore")) return reply(409, {error: "同名同类附件已存在，请为恢复的附件输入新名称。"});
        if (url === "/api/trash/purge") return reply(200, {purged: body.file_ids.length, bytes: 9, pending_bytes: 4, trash_count: 1});
        if (url.endsWith("/update")) {
          const row = rows.find(item => item.id === "A"), file = row.files[0];
          if (updateMode === "conflict") {
            updateMode = "normal";
            file.kind = "NMR"; row.revision = 5;  // Another window recategorized the file meanwhile.
            return reply(409, {error: "这条记录已在其他窗口更新。请保留当前内容，关闭编辑窗口后刷新再编辑。"});
          }
          if (body.name) file.name = body.name;
          if (body.kind) file.kind = body.kind;
          row.revision++;
          return reply(200, updateMode === "partial" ? {file} : {file, records: [row]});
        }
        throw new Error("Unhandled " + url);
      }});
    try {
      const {$, w, confirmations} = env;
      $("dashboard-records-tab").click();
      w.document.querySelector('[data-expand="experiment:default:a"]').click();
      w.document.querySelector('[data-open="A"]').click();
      // 1. Conflict refresh: only the rename survives; the refreshed category is shown and not sent back.
      $("detail-content").querySelector('[data-manage-file="f1"]').click();
      $("file-name").value = "renamed.csv";
      updateMode = "conflict";
      $("save-file").click(); for (let i = 0; i < 4; i++) await flush();
      assert.equal($("file-dialog").open, true);
      assert.equal($("file-kind").value, "NMR", "The dialog shows the category changed elsewhere");
      assert.equal($("file-name").value, "renamed.csv", "The user's rename is kept");
      assert.match($("file-error").textContent, /latest details are shown/);
      $("save-file").click(); await flush(); await flush();
      assert.deepEqual(calls.filter(call => call.url.endsWith("/update")).at(-1).body, {record_revision: 5, name: "renamed.csv"}, "No unintended recategorization");
      // 2. A partial success response reloads and still shows the change.
      $("detail-content").querySelector('[data-manage-file="f1"]').click();
      $("file-name").value = "partial.csv";
      updateMode = "partial";
      const before = reads;
      $("save-file").click(); for (let i = 0; i < 4; i++) await flush();
      assert.ok(reads > before, "Missing records trigger a reload");
      assert.match($("detail-content").textContent, /partial\.csv/);
      updateMode = "normal";
      // 3. Unsaved attachment edits are guarded.
      $("detail-content").querySelector('[data-manage-file="f1"]').click();
      $("file-name").value = "draft.csv";
      w.confirm = message => { confirmations.push(message); return false; };
      $("cancel-file").click();
      assert.equal($("file-dialog").open, true, "Declining keeps the dialog and the draft");
      assert.match(confirmations.at(-1), /not saved/);
      w.confirm = message => { confirmations.push(message); return true; };
      $("cancel-file").click();
      assert.equal($("file-dialog").open, false);
      $("close-detail").click();
      // 4. Category deletion counts trashed attachments from the server.
      $("manage-categories").click();
      w.document.querySelector('[data-delete-category="TEM"]').click();
      assert.match($("category-delete-help").textContent, /3 of them are in the trash/);
      assert.equal($("category-replacement-label").hidden, false, "A category used only in the trash needs a replacement");
      $("cancel-delete-category").click();
      $("close-catalog").click();
      // 5. A late all-projects response cannot replace the current-project view, and purge waits for the shown scope.
      $("trash-view").click(); await flush(); await flush();
      assert.match($("trash-content").textContent, /local\.csv/);
      $("trash-all-projects").checked = true; $("trash-all-projects").dispatchEvent(new w.Event("change", {bubbles: true}));
      await flush();
      assert.equal($("purge-all").disabled, true, "Purge is disabled while the new scope loads");
      $("trash-all-projects").checked = false; $("trash-all-projects").dispatchEvent(new w.Event("change", {bubbles: true}));
      await flush(); await flush();
      pending.forEach(gate => gate.resolve()); await flush(); await flush();
      assert.doesNotMatch($("trash-content").textContent, /other-project\.csv/, "The stale all-projects response is discarded");
      assert.equal($("purge-all").disabled, false);
      assert.ok($("trash-content").querySelector('a[href="api/files/l1"][download]'), "Trashed files can be downloaded");
      $("purge-all").click(); await flush(); await flush(); await flush();
      assert.deepEqual(calls.filter(call => call.url === "/api/trash/purge").at(-1).body, {file_ids: ["l1"], confirm: "purge", project_id: "default"});
      assert.match($("toast").textContent, /could not be removed from disk yet/);
      // 6. A rejected restore keeps the proposed name.
      $("trash-content").querySelector('[data-trash-restore="l1"]')?.click(); await flush();
      const input = $("trash-content").querySelector('[data-trash-name="l1"]');
      assert.ok(input, "The conflicting item asks for a new name");
      {
        input.value = "kept.csv"; input.dispatchEvent(new w.Event("input", {bubbles: true}));
        $("trash-content").querySelector('[data-trash-restore="l1"]').click(); for (let i = 0; i < 5; i++) await flush();
        assert.equal($("trash-content").querySelector('[data-trash-name="l1"]').value, "kept.csv", "The draft survives the refresh after 409");
        w.confirm = message => { confirmations.push(message); return false; };
        $("trash-close").click();
        assert.equal($("trash-dialog").open, true, "An unsubmitted restore name is guarded");
        w.confirm = () => true;
      }
      $("trash-close").click();
    } finally { env.dom.window.close(); }
  }
  {
    // Re-review fixes: dialog sessions, opened-with revisions, partial move responses, stale trash failures, identity.
    const reply = (status, body) => ({ok: status < 300, status, json: async () => structuredClone(body)});
    const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return {promise, resolve, reject}; };
    let readGate = null, trashGate = null;
    const calls = [];
    const env = await boot({savedLanguage: "en", desktop: true, extraRows: [sample("B", {files: []})],
      readHandler: catalog => { const response = reply(200, {...catalog, trash_count: 0}); return readGate ? readGate.promise.then(() => response) : response; },
      attachmentHandler: (url, options, rows) => {
        const body = options.body ? JSON.parse(options.body) : {};
        calls.push({url, body});
        if (url.startsWith("/api/trash?")) {
          if (url.endsWith("project_id=") && trashGate) return trashGate.promise;
          return reply(200, {items: [], total_bytes: 0});
        }
        const row = rows.find(item => item.id === "A");
        if (body.record_revision !== row.revision) return reply(409, {error: "这条记录已在其他窗口更新。请保留当前内容，关闭编辑窗口后刷新再编辑。"});
        if (body.target_record_id) {
          const file = row.files[0], target = rows.find(item => item.id === body.target_record_id);
          row.files = []; target.files.push(file); row.revision++; target.revision++;
          return reply(200, {file, records: [row]});  // Partial: the destination record is missing.
        }
        if (body.name) row.files[0].name = body.name;
        row.revision++;
        return reply(200, {file: row.files[0], records: [row]});
      }});
    try {
      const {$, w, rows, writes} = env;
      assert.equal(w.document.querySelector(".brand").getAttribute("href"), "./?desktop=1", "The desktop shell keeps its parameter");
      $("dashboard-records-tab").click();
      w.document.querySelector('[data-expand="experiment:default:a"]').click();
      w.document.querySelector('[data-open="A"]').click();
      const manage = () => $("detail-content").querySelector('[data-manage-file="f1"]');
      // 1. A catalog read that resolves after the dialog opened must not turn the untouched category into a change.
      $("close-detail").click();
      const shownRevision = rows.find(row => row.id === "A").revision;
      rows.find(row => row.id === "A").files[0].kind = "NMR";  // Another window recategorized meanwhile.
      rows.find(row => row.id === "A").revision++;
      readGate = deferred();
      const reads = calls.length;
      const pendingLoad = w.dispatchEvent(new w.Event("focus"));  // The refresh request is in flight...
      w.document.querySelector('[data-open="A"]').click();      // ...while the user opens the attachment dialog.
      manage().click();
      assert.equal($("file-kind").value, "XRD", "The dialog shows the values loaded before the refresh");
      readGate.resolve(); readGate = null; for (let i = 0; i < 4; i++) await flush();
      assert.equal(env.rows.find(row => row.id === "A").files[0].kind, "NMR");
      assert.equal(calls.length, reads);
      $("file-name").value = "renamed.csv";
      $("save-file").click(); for (let i = 0; i < 4; i++) await flush();
      const first = calls.filter(call => call.url.endsWith("/update"))[0];
      assert.deepEqual(first.body, {record_revision: shownRevision, name: "renamed.csv"}, "Changes and revision come from the values the dialog showed");
      assert.equal($("file-kind").value, "NMR", "The 409 refresh then shows the newer category");
      assert.equal($("file-name").value, "renamed.csv");
      // 2. The dialog stays busy while a conflict refresh runs, and a late refresh cannot reach a reopened dialog.
      rows.find(row => row.id === "A").revision++;
      readGate = deferred();
      $("save-file").click(); await flush(); await flush();
      assert.equal($("cancel-file").disabled, true, "Busy during the refresh");
      $("cancel-file").click();
      assert.equal($("file-dialog").open, true, "Cannot be closed mid-refresh");
      readGate.resolve(); readGate = null; for (let i = 0; i < 4; i++) await flush();
      assert.equal($("cancel-file").disabled, false);
      $("save-file").click(); for (let i = 0; i < 4; i++) await flush();
      assert.equal($("file-dialog").open, false, "The retry with the refreshed revision succeeds");
      // 3. A move response without the destination record reloads before showing the result.
      manage().click();
      $("file-target").value = "B";
      $("save-file").click(); for (let i = 0; i < 6; i++) await flush();
      $("close-detail").click();
      w.document.querySelector('[data-expand="experiment:default:b"]').click();
      w.document.querySelector('[data-open="B"]').click();
      assert.ok($("detail-content").querySelector('[data-manage-file="f1"]'), "The destination shows the moved file after the reload");
      // 4. Uploads carry the identity the detail dialog showed.
      const upload = $("upload-files");
      Object.defineProperty(upload, "files", {value: [new w.File(["1,2"], "extra.csv")], configurable: true});
      $("upload-button").click(); for (let i = 0; i < 4; i++) await flush();
      const sent = new URL(writes.filter(write => write.url.includes("/files?")).at(-1).url, "http://127.0.0.1/");
      assert.equal(sent.searchParams.get("sample_id"), "B");
      assert.equal(sent.searchParams.get("project_id"), "default");
      $("close-detail").click();
      // 5. A stale all-projects failure does not show an error over the current list.
      trashGate = deferred();
      $("trash-view").click(); await flush(); await flush();
      $("trash-all-projects").checked = true; $("trash-all-projects").dispatchEvent(new w.Event("change", {bubbles: true})); await flush();
      $("trash-all-projects").checked = false; $("trash-all-projects").dispatchEvent(new w.Event("change", {bubbles: true})); await flush(); await flush();
      trashGate.reject(new Error("network down")); trashGate = null; for (let i = 0; i < 4; i++) await flush();
      assert.equal($("trash-error").hidden, true, "The stale failure is ignored");
      assert.match($("trash-content").textContent, /The trash is empty/);
      $("trash-close").click();
      assert.ok(pendingLoad !== undefined);
    } finally { env.dom.window.close(); }
  }
  {
    // Milestone 2: project field settings applied across the UI, key fields, and both settings dialogs.
    const reply = (status, body) => ({ok: status < 300, status, json: async () => structuredClone(body)});
    const template = {revision: 2, name: "Films", fields: [
      {key: "0", label: "Substrate", section: "condition", type: "single", unit: "", options: ["Si", "Glass"], required: false},
      {key: "1", label: "Thickness", section: "condition", type: "number", unit: "nm", options: [], required: false},
      {key: "2", label: "Notes", section: "result", type: "text", unit: "", options: [], required: false}]};
    const film = (id, values, fields = {}) => sample(id, {experiment_no: id, template, lab_data: {template_revision: 2, values}, ...fields});
    const settings = {builtin: {precursor: {enabled: true, label: {zh: "电解液", en: "Electrolyte"}}, temperature: {enabled: false, label: {zh: "", en: ""}},
      duration: {enabled: true, label: {zh: "", en: ""}}, materials: {enabled: true, label: {zh: "", en: ""}}},
      key_fields: [{section: "condition", label: "Substrate", check_missing: true}, {section: "condition", label: "Thickness", check_missing: false}], phase_presets: ["Phase I"]};
    const fields = [{id: "key:condition:substrate", section: "condition", label: "Substrate", check_missing: true, available: true, type: "single", unit: "", options: ["Si", "Glass"]},
      {id: "key:condition:thickness", section: "condition", label: "Thickness", check_missing: false, available: true, type: "number", unit: "nm", options: []}];
    let entry = {settings, revision: 3, fields}, conflictOnce = false;
    const puts = [];
    const local = {catalog: {notebook_prefixes: ["XY"], precursor_aliases: [{label: "Compound A12 (CA12)", aliases: ["CA12", "PA12"]}], translations: {}}, revision: "abc"};
    const env = await boot({savedLanguage: "en", extraRows: [film("F1", {0: "Si", 1: 120}), film("F2", {0: "Glass", 1: 80}), film("F3", {1: 50})],
      readHandler: catalog => reply(200, {...catalog, templates: {default: template}, project_settings: {default: entry}}),
      settingsHandler: (url, options) => {
        if (url.startsWith("/api/local-catalog")) {
          if (options.method === "PUT") { puts.push({url, body: JSON.parse(options.body)}); return reply(200, {...local, revision: "def"}); }
          return reply(200, local);
        }
        if (options.method === "PUT") {
          const body = JSON.parse(options.body);
          puts.push({url, body});
          if (conflictOnce) { conflictOnce = false; return reply(409, {error: "项目设置已在其他窗口修改，请刷新后再保存。"}); }
          entry = {settings: body.settings, revision: entry.revision + 1, fields};
          return reply(200, entry);
        }
        return reply(200, entry);
      }});
    try {
      const {$, w, writes} = env;
      $("dashboard-records-tab").click(); await flush();
      // Labels and visibility
      assert.match($("filter-precursor").closest("label").textContent, /Electrolyte/, "Custom label replaces the built-in name");
      assert.equal($("temp-min").closest("fieldset").hidden, true, "A switched-off built-in leaves the filters");
      assert.equal(w.document.querySelector(".records-table").classList.contains("hide-temperature"), true);
      assert.equal([...$("dashboard-condition-field").options].find(option => option.value === "temperature").disabled, true);
      assert.ok([...$("dashboard-condition-field").options].some(option => option.value === "key:condition:substrate"), "Key fields join the distribution");
      // Key-field filters
      assert.equal($("key-filters").hidden, false);
      const substrate = $("key-filters").querySelector('[data-key-filter="key:condition:substrate"]');
      substrate.value = "Si"; substrate.dispatchEvent(new w.Event("change", {bubbles: true}));
      assert.ok(w.document.querySelector('[data-expand="experiment:default:f1"]'));
      assert.equal(w.document.querySelector('[data-expand="experiment:default:f2"]'), null, "The option filter excludes other values");
      $("clear-filters").click();
      const [low] = $("key-filters").querySelectorAll('[data-key-filter="key:condition:thickness"]');
      low.value = "100"; low.dispatchEvent(new w.Event("input", {bubbles: true}));
      assert.ok(w.document.querySelector('[data-expand="experiment:default:f1"]'));
      assert.equal(w.document.querySelector('[data-expand="experiment:default:f3"]'), null, "The number range applies");
      $("clear-filters").click();
      // Details, list chips and comparison
      w.document.querySelector('[data-expand="experiment:default:f1"]').click();
      assert.match(w.document.querySelector('[data-open="F1"]').closest("tr").textContent, /Substrate.*Si/, "Key fields show as chips");
      assert.doesNotMatch(w.document.querySelector('[data-open="F1"]').closest("tr").textContent, /Temp\./);
      w.document.querySelector('[data-open="F1"]').click();
      assert.match($("detail-content").textContent, /Electrolyte/);
      assert.match($("detail-content").textContent, /Thickness120 nm/);
      assert.doesNotMatch($("detail-content").textContent, /Temperature \/ °C/);
      $("close-detail").click();
      // Dashboard distribution by a key field
      $("dashboard-overview-tab").click();
      $("dashboard-condition-field").value = "key:condition:thickness"; $("dashboard-condition-field").dispatchEvent(new w.Event("change", {bubbles: true}));
      assert.match($("dashboard-condition-rows").textContent, /50 nm.*80 nm.*120 nm/s, "Numbers sort numerically with their unit");
      $("dashboard-records-tab").click();
      // Bulk edit offers key fields of the selected project
      for (const id of ["F1", "F2"]) if (!w.document.querySelector(`[data-select="${id}"]`)) w.document.querySelector(`[data-expand="experiment:default:${id.toLowerCase()}"]`).click();
      for (const id of ["F1", "F2"]) { const box = w.document.querySelector(`[data-select="${id}"]`); box.checked = true; box.dispatchEvent(new w.Event("change", {bubbles: true})); }
      $("bulk-edit").click();
      assert.equal($("bulk-editor").open, true);
      assert.equal($("bulk-temperature-mode"), null, "Switched-off built-ins are not offered");
      $("bulk-key0-mode").value = "set"; $("bulk-key0-mode").dispatchEvent(new w.Event("change", {bubbles: true}));
      $("bulk-key0").value = "Glass";
      let bulkBody = null;
      env.w.fetch = (original => async (url, options = {}) => {
        if (String(url).endsWith("experiments/bulk")) { bulkBody = JSON.parse(options.body); return reply(200, {updated: 1, rows: [{id: "F1", sample_id: "F1", project_id: "default", experiment_no: "F1", changes: [{field: "key:condition:substrate", before: "Si", after: "Glass"}]}]}); }
        return original(url, options);
      })(env.w.fetch);
      $("bulk-form").dispatchEvent(new w.Event("submit", {cancelable: true})); await flush(); await flush();
      assert.deepEqual(bulkBody.changes, {key_fields: [{section: "condition", label: "Substrate", mode: "set", value: "Glass"}]});
      assert.match($("bulk-review").textContent, /Substrate.*Si.*Glass/, "Key-field changes are labelled in the preview");
      w.confirm = () => true;
      $("close-bulk").click();
      // Project settings dialog
      $("project-settings-view").click(); await flush(); await flush();
      assert.equal($("project-settings-dialog").open, true);
      assert.equal($("settings-builtin").querySelector('[data-builtin-enabled="temperature"]').checked, false);
      assert.equal($("settings-builtin").querySelector('[data-builtin-label="precursor"][data-lang="en"]').value, "Electrolyte");
      assert.equal($("settings-key-fields").querySelector('[data-key-pick="0"]').checked, true);
      assert.equal($("settings-key-fields").querySelector('[data-key-missing="1"]').checked, false);
      $("settings-builtin").querySelector('[data-builtin-enabled="temperature"]').checked = true;
      $("settings-key-fields").querySelector('[data-key-pick="2"]').click();
      $("settings-phases").value = "Phase I\nPhase II\nPhase I";
      $("settings-phases").dispatchEvent(new w.Event("input", {bubbles: true}));
      conflictOnce = true;
      $("save-project-settings").click(); for (let i = 0; i < 4; i++) await flush();
      assert.equal($("project-settings-dialog").open, true);
      assert.match($("project-settings-error").textContent, /latest settings are shown/, "A conflict shows the other window's settings");
      assert.equal($("settings-builtin").querySelector('[data-builtin-enabled="temperature"]').checked, false);
      $("settings-builtin").querySelector('[data-builtin-enabled="temperature"]').checked = true;
      $("settings-phases").value = "Phase I\nPhase II\nPhase I";
      $("save-project-settings").click(); for (let i = 0; i < 4; i++) await flush();
      const saved = puts.filter(put => put.url.includes("/settings")).at(-1).body;
      assert.equal(saved.revision, 3);
      assert.equal(saved.settings.builtin.temperature.enabled, true);
      assert.deepEqual(saved.settings.phase_presets, ["Phase I", "Phase II"], "Duplicates are dropped");
      assert.deepEqual(saved.settings.key_fields.map(item => item.label), ["Substrate", "Thickness"]);
      assert.equal($("project-settings-dialog").open, false);
      assert.match($("toast").textContent, /Project settings saved/);
      assert.equal($("temp-min").closest("fieldset").hidden, false, "Saved settings apply immediately");
      // Conventions dialog
      $("conventions-view").click(); await flush(); await flush();
      assert.equal($("conventions-prefixes").value, "XY");
      const aliasRows = () => [...$("conventions-aliases").querySelectorAll("[data-alias-row]")];
      assert.equal(aliasRows()[0].querySelector("[data-alias-label]").value, "Compound A12 (CA12)");
      assert.equal(aliasRows()[0].querySelector("[data-alias-list]").value, "CA12\nPA12");
      $("conventions-prefixes").value = "XY, A1";
      $("save-conventions").click(); await flush();
      assert.match($("conventions-error").textContent, /only 1–20 letters: A1/);
      $("conventions-prefixes").value = "XY, AB";
      $("conventions-translations").value = JSON.stringify({noteRules: [{pattern: "([", replacement: "x"}]});
      $("save-conventions").click(); await flush();
      assert.match($("conventions-error").textContent, /not a valid regular expression/);
      $("conventions-translations").value = "";
      $("add-alias-row").click();
      aliasRows()[1].querySelector("[data-alias-label]").value = "A=B, C";  // "=" and commas survive the structured editor
      aliasRows()[1].querySelector("[data-alias-list]").value = "1,2-dichloroethane\ncb\ncb";
      $("save-conventions").click(); for (let i = 0; i < 4; i++) await flush();
      const conventions = puts.filter(put => put.url.includes("local-catalog")).at(-1).body;
      assert.deepEqual(conventions, {catalog: {notebook_prefixes: ["XY", "AB"], precursor_aliases: [{label: "Compound A12 (CA12)", aliases: ["CA12", "PA12"]}, {label: "A=B, C", aliases: ["1,2-dichloroethane", "cb"]}], translations: {}}, revision: "abc"});
      assert.equal($("conventions-dialog").open, false);
      assert.ok(writes !== undefined);
    } finally { env.dom.window.close(); }
  }
  {
    // Milestone 2 review fixes: mixed-project visibility, units, rendering edge cases, settings binding, XSS.
    const reply = (status, body) => ({ok: status < 300, status, json: async () => structuredClone(body)});
    const evil = "<img src=x onerror=alert(1)>";
    const template = {revision: 2, name: "Films", fields: [
      {key: "0", label: "Thickness", section: "condition", type: "number", unit: "nm", options: [], required: false}]};
    const old = {revision: 1, name: "Films", fields: [{key: "0", label: "thickness", section: "condition", type: "number", unit: "", options: [], required: false}]};
    const film = (id, project, values, tpl = template, fields = {}) => sample(id, {experiment_no: id, project_id: project, template: tpl, lab_data: {template_revision: tpl.revision, values}, ...fields});
    const builtin = enabled => ({precursor: {enabled: true, label: {}}, temperature: {enabled, label: {}}, duration: {enabled: true, label: {}}, materials: {enabled: true, label: {}}});
    const thickness = {id: "key:condition:thickness", section: "condition", label: "Thickness", check_missing: false, available: true, type: "number", unit: "nm", options: []};
    let projectSettings = {
      default: {revision: 1, settings: {builtin: builtin(false), key_fields: [{section: "condition", label: "Thickness"}], phase_presets: Array.from({length: 12}, (_, i) => `P${i + 1}`)}, fields: [thickness]},
      "other-lab": {revision: 1, settings: {builtin: builtin(true), key_fields: [], phase_presets: []}, fields: []}};
    let failSettings = false, bulkBody = null;
    const env = await boot({savedLanguage: "en", extraProjects: [{id: "other-lab", name: "Other lab"}],
      extraRows: [film("K1", "default", {0: 10}, template, {temperature: 250}), film("K2", "default", {0: 10}, old, {temperature: 250}),
        sample("O1", {project_id: "other-lab", project_name: "Other lab", temperature: 100})],
      readHandler: catalog => reply(200, {...catalog, templates: {default: {...template, fields: [...template.fields, {key: "1", label: evil, section: "condition", type: "text", unit: "", options: [], required: false}]}}, project_settings: projectSettings}),
      settingsHandler: url => failSettings && url.includes("other-lab") ? reply(500, {error: "操作未完成，请检查磁盘空间及服务日志；页面内容尚未清空。"})
        : reply(200, {...projectSettings[url.includes("other-lab") ? "other-lab" : "default"], ...(url.includes("other-lab") ? {} : {settings: {...projectSettings.default.settings, key_fields: [{section: "condition", label: evil}, {section: "condition", label: evil + " gone"}]}})})});
    try {
      const {$, w} = env;
      const projectSelect = $("project-select");
      const chooseProject = value => { projectSelect.value = value; projectSelect.dispatchEvent(new w.Event("change", {bubbles: true})); };
      // All projects: temperature is shown (another project uses it) but never matches records of a project that switched it off.
      chooseProject("");
      $("dashboard-records-tab").click();
      assert.equal($("temp-min").closest("fieldset").hidden, false);
      $("temp-min").value = "200"; $("temp-min").dispatchEvent(new w.Event("input", {bubbles: true}));
      assert.equal(w.document.querySelector('[data-expand="experiment:default:k1"]'), null, "A switched-off field never matches, whatever is stored");
      $("clear-filters").click();
      // Dashboard buckets keep a unitless historical value apart from the current unit.
      chooseProject("default");
      $("dashboard-overview-tab").click();
      $("dashboard-condition-field").value = "key:condition:thickness"; $("dashboard-condition-field").dispatchEvent(new w.Event("change", {bubbles: true}));
      const buckets = [...$("dashboard-condition-rows").querySelectorAll("[data-condition-value]")].map(button => button.textContent);
      assert.deepEqual(buckets.filter(label => label !== "Not recorded").sort(), ["10 (—)", "10 nm"], "Different units are separate buckets");
      // Removing the key field while its chart filter is active clears the filter instead of failing.
      $("dashboard-condition-rows").querySelector("[data-condition-value]").click();
      projectSettings = {...projectSettings, default: {...projectSettings.default, fields: []}};
      w.dispatchEvent(new w.Event("focus")); for (let i = 0; i < 4; i++) await flush();
      assert.equal($("chart-filter").hidden, true, "A chart filter on a removed key field is cleared");
      // With every built-in off and no key fields the dashboard renders an empty distribution.
      projectSettings = {...projectSettings, default: {...projectSettings.default, settings: {...projectSettings.default.settings,
        builtin: {precursor: {enabled: false, label: {}}, temperature: {enabled: false, label: {}}, duration: {enabled: false, label: {}}, materials: {enabled: false, label: {}}}}}};
      $("dashboard-overview-tab").click();
      w.dispatchEvent(new w.Event("focus")); for (let i = 0; i < 4; i++) await flush();
      assert.equal($("dashboard-condition-field").value, "");
      projectSettings = {...projectSettings, default: {...projectSettings.default, settings: {...projectSettings.default.settings, builtin: builtin(false)}, fields: [thickness]}};
      w.dispatchEvent(new w.Event("focus")); for (let i = 0; i < 4; i++) await flush();
      // Key filter state does not follow the user into another project.
      $("dashboard-records-tab").click();
      const low = $("key-filters").querySelector('[data-key-filter="key:condition:thickness"][data-key-part="min"]');
      low.value = "999"; low.dispatchEvent(new w.Event("input", {bubbles: true}));
      chooseProject("other-lab"); chooseProject("default");
      assert.equal($("key-filters").querySelector('[data-key-part="min"]').value, "", "Switching projects resets key filters");
      // Phase presets: all twelve configured presets are offered.
      w.document.querySelector('[data-expand="experiment:default:k1"]').click();
      w.document.querySelector('[data-open="K1"]').click();
      w.document.querySelector("[data-edit-result]").click();
      assert.equal($("result-phases").querySelectorAll("[data-phase-choice]").length >= 12, true, "Configured presets are not capped at eight");
      $("cancel-editor")?.click(); if ($("editor").open) $("editor").close();
      // Bulk: units travel with number edits; key-number inputs have no built-in bounds; switched-off built-ins are not offered.
      for (const id of ["K1", "K2"]) { if (!w.document.querySelector(`[data-select="${id}"]`)) w.document.querySelector(`[data-expand="experiment:default:${id.toLowerCase()}"]`).click(); const box = w.document.querySelector(`[data-select="${id}"]`); box.checked = true; box.dispatchEvent(new w.Event("change", {bubbles: true})); }
      env.w.fetch = (original => async (url, options = {}) => {
        if (String(url).endsWith("experiments/bulk")) { bulkBody = JSON.parse(options.body); return reply(200, {updated: 1, rows: [{id: "K1", revision: 1, sample_id: "K1", project_id: "default", experiment_no: "K1", changes: [{field: "key:condition:thickness", before: 10, after: -1.25, unit: "nm"}]}]}); }
        return original(url, options);
      })(env.w.fetch);
      $("bulk-edit").click();
      assert.equal($("bulk-temperature-mode"), null);
      assert.equal($("bulk-key0").hasAttribute("min"), false, "Key numbers accept negative values");
      $("bulk-key0-mode").value = "set"; $("bulk-key0-mode").dispatchEvent(new w.Event("change", {bubbles: true}));
      $("bulk-key0").value = "-1.25";
      $("bulk-form").dispatchEvent(new w.Event("submit", {cancelable: true})); await flush(); await flush();
      assert.deepEqual(bulkBody.changes.key_fields, [{section: "condition", label: "Thickness", mode: "set", value: -1.25, unit: "nm"}]);
      assert.match($("bulk-review").textContent, /10 nm.*-1\.25 nm/, "The preview shows each value with its unit");
      w.confirm = () => true; $("close-bulk").click();
      // Project settings: an unavailable entry with markup is shown as text; a failed load disables saving.
      $("project-settings-view").click(); for (let i = 0; i < 3; i++) await flush();
      assert.equal($("project-settings-dialog").querySelector("img"), null, "Template labels never become markup");
      assert.match($("settings-key-fields").textContent, /<img src=x/);
      assert.match($("settings-key-fields").textContent, /no longer in the current template.*<img src=x onerror=alert\(1\)> gone/, "The stale-field notice is text");
      failSettings = true;
      $("settings-project").value = "other-lab"; $("settings-project").dispatchEvent(new w.Event("change", {bubbles: true}));
      for (let i = 0; i < 3; i++) await flush();
      assert.equal($("save-project-settings").disabled, true, "Nothing can be saved into a project whose settings did not load");
      $("cancel-project-settings").click();
    } finally { env.dom.window.close(); }
  }
  {
    // Milestone 2 re-review: per-record visibility everywhere in mixed views, hidden ranges, units, unreadable conventions.
    const reply = (status, body) => ({ok: status < 300, status, json: async () => structuredClone(body)});
    const builtin = enabled => ({precursor: {enabled, label: {}}, temperature: {enabled, label: {}}, duration: {enabled: true, label: {}}, materials: {enabled: true, label: {}}});
    let settings = {default: {revision: 1, settings: {builtin: builtin(false), key_fields: [], phase_presets: []}, fields: []},
      "other-lab": {revision: 1, settings: {builtin: builtin(true), key_fields: [], phase_presets: []}, fields: []}};
    const env = await boot({savedLanguage: "en", extraProjects: [{id: "other-lab", name: "Other lab"}],
      extraRows: [sample("HIDDEN", {temperature: 250, precursor: "SecretPrecursor"}), sample("SHOWN", {project_id: "other-lab", project_name: "Other lab", temperature: 250})],
      readHandler: catalog => reply(200, {...catalog, project_settings: settings}),
      settingsHandler: url => reply(200, {catalog: {notebook_prefixes: [], precursor_aliases: env.conflict ? [] : [{label: "Compound", aliases: ["Foo\nBar"]}], translations: {}}, revision: "r1",
        ...(url.includes("local-catalog") && env.broken ? {error: "local-catalog.json 无法解析，请先修复文件或删除后再编辑。", error_kind: "unparsable"} : {}),
        ...(url.includes("local-catalog") && env.conflict ? {error: "以下实验在新的编号前缀下会合并，但共用条件不一致：AB-1-42、AB-I-42。请先统一这些实验的共用条件，再修改前缀。", error_kind: "prefix_conflict"} : {})})});
    try {
      const {$, w} = env;
      const choose = value => { $("project-select").value = value; $("project-select").dispatchEvent(new w.Event("change", {bubbles: true})); };
      choose("");
      // Drill-down from the 250 °C bucket lists only records whose project uses temperature.
      $("dashboard-overview-tab").click();
      $("dashboard-condition-field").value = "temperature"; $("dashboard-condition-field").dispatchEvent(new w.Event("change", {bubbles: true}));
      [...$("dashboard-condition-rows").querySelectorAll("[data-condition-value]")].find(button => button.dataset.conditionValue === "250").click();
      assert.ok(w.document.querySelector('[data-expand="experiment:other-lab:shown"]'));
      assert.equal(w.document.querySelector('[data-expand="experiment:default:hidden"]'), null, "A disabled field's bucket never includes that project's records");
      $("clear-chart-filter").click();
      // Filter options and text search skip values of fields switched off in the record's project.
      $("dashboard-records-tab").click();
      assert.equal([...$("filter-precursor").options].some(option => option.value === "SecretPrecursor"), false);
      $("search").value = "SecretPrecursor"; $("search").dispatchEvent(new w.Event("input", {bubbles: true}));
      assert.equal(w.document.querySelector('[data-expand="experiment:default:hidden"]'), null, "Text search ignores switched-off fields");
      $("global-search").value = "SecretPrecursor"; $("global-search").dispatchEvent(new w.Event("input", {bubbles: true}));
      assert.equal($("global-results").querySelectorAll("[data-global-key]").length, 0, "Ctrl+K search ignores switched-off fields too");
      $("global-search").value = ""; $("global-search").dispatchEvent(new w.Event("input", {bubbles: true}));
      $("clear-filters").click();
      // A reversed range entered while temperature was visible does not empty the list once it is hidden everywhere.
      $("temp-min").value = "300"; $("temp-max").value = "100"; $("temp-min").dispatchEvent(new w.Event("input", {bubbles: true}));
      settings = {...settings, "other-lab": {...settings["other-lab"], settings: {...settings["other-lab"].settings, builtin: builtin(false)}}};
      w.dispatchEvent(new w.Event("focus")); for (let i = 0; i < 4; i++) await flush();
      assert.equal($("temp-min").closest("fieldset").hidden, true);
      assert.ok(w.document.querySelector('[data-expand="experiment:default:hidden"]'), "A hidden range no longer filters");
      assert.equal($("filter-error").hidden, true);
      // Conventions: an alias with a line break is split visibly; an unreadable file blocks saving.
      $("conventions-view").click(); for (let i = 0; i < 3; i++) await flush();
      assert.match($("conventions-error").textContent, /control characters/);
      assert.equal($("save-conventions").disabled, true, "Values the form cannot represent are never rewritten");
      $("close-conventions").click();
      env.conflict = true;
      $("conventions-view").click(); for (let i = 0; i < 3; i++) await flush();
      assert.match($("conventions-error").textContent, /would merge/);
      assert.equal($("save-conventions").disabled, false, "A prefix conflict can be fixed in the editor");
      $("close-conventions").click();
      env.conflict = false;
      env.broken = true;
      $("conventions-view").click(); for (let i = 0; i < 3; i++) await flush();
      assert.match($("conventions-error").textContent, /cannot be read/);
      assert.equal($("save-conventions").disabled, true, "An unreadable file cannot be replaced from the editor");
      $("close-conventions").click();
    } finally { env.dom.window.close(); }
  }
  {
    // §8.3: decisions on automatic missing-condition items carry exactly the fields shown.
    const decided = [];
    const item = {id: "d".repeat(32), record_id: "A", project_id: "default", experiment_no: "A", sample_id: "A", title: "缺少条件", field: "", kind: "missing_conditions",
      status: "pending", revision: 1, record_revision: 1, sources: [], missing: ["precursor"], generated: false, resolution: ""};
    const env = await boot({savedLanguage: "en", workflowHandler: async (url, options) => {
      const respond = data => ({ok: true, json: async () => structuredClone(data)});
      if (!options.method) return respond({items: [item]});
      const payload = JSON.parse(options.body);
      decided.push({url, payload});
      return respond({});
    }});
    try {
      env.$("review-view").click(); await flush(); await flush();
      env.w.document.querySelector("[data-review-item]").click();
      env.$("confirm-review").click(); await flush(); await flush();
      const decision = decided.find(entry => entry.url.endsWith("/decide"));
      assert.ok(decision, "The decision was sent");
      assert.deepEqual(decision.payload.missing, ["precursor"], "The displayed missing fields travel with the decision");
    } finally { env.dom.window.close(); }
  }
  {
    // §9: raw prefixes the input cannot represent, committed-but-pending saves, legacy review items.
    const reply = (status, body) => ({ok: status < 300, status, json: async () => structuredClone(body)});
    let raw = ["AB\n"], puts = 0;
    const decided = [];
    const legacy = {id: "e".repeat(32), record_id: "A", project_id: "default", experiment_no: "A", sample_id: "A", title: "缺少条件", field: "", kind: "missing_conditions",
      status: "dismissed", revision: 2, record_revision: 1, sources: [], generated: false, resolution: "old"};
    const env = await boot({savedLanguage: "en",
      settingsHandler: (url, options) => {
        if (options.method === "PUT") { puts++; return reply(200, {catalog: {notebook_prefixes: ["XY"], precursor_aliases: [], translations: {}}, revision: "r2", active_prefixes: ["XY"], publication_pending: true}); }
        return reply(200, {catalog: {notebook_prefixes: raw, precursor_aliases: [], translations: {}}, revision: "r1", active_prefixes: []});
      },
      workflowHandler: async (url, options) => {
        if (!options.method) return reply(200, {items: [legacy]});
        decided.push({url, payload: JSON.parse(options.body)});
        return reply(200, {});
      }});
    try {
      const {$} = env;
      $("conventions-view").click(); for (let i = 0; i < 3; i++) await flush();
      assert.equal($("save-conventions").disabled, true, "A prefix with a line break blocks the editor instead of being trimmed");
      $("close-conventions").click();
      raw = ["XY"];
      $("conventions-view").click(); for (let i = 0; i < 3; i++) await flush();
      assert.equal($("save-conventions").disabled, false);
      $("save-conventions").click(); for (let i = 0; i < 5; i++) await flush();
      assert.equal(puts, 1);
      assert.match($("toast").textContent, /updated automatically once the file can be written/, "A committed but unpublished save is reported as saved");
      $("review-view").click(); await flush(); await flush();
      $("review-status").value = "dismissed"; $("review-status").dispatchEvent(new env.w.Event("input", {bubbles: true})); await flush();
      env.w.document.querySelector("[data-review-item]").click();
      $("review-outcome").value = "pending"; $("review-outcome").dispatchEvent(new env.w.Event("change", {bubbles: true}));
      $("confirm-review").click(); await flush(); await flush();
      const decision = decided.find(entry => entry.url.endsWith("/decide"));
      assert.ok(decision, "The legacy item can be reopened");
      assert.deepEqual(decision.payload.missing, [], "Legacy items send an empty displayed list");
    } finally { env.dom.window.close(); }
  }
  {
    // Milestone 3: onboarding wizard, demo catalog, record import.
    const reply = (status, body) => ({ok: status < 300, status, json: async () => structuredClone(body)});
    const calls = [];
    let onboarding = {empty: true, done: false}, demo = false, previewCount = 0;
    const filmTemplate = {revision: 1, name: "Film deposition", fields: [
      {key: "0", label: "基底", section: "condition", type: "single", unit: "", options: ["玻璃", "硅片", "金属箔"], required: true},
      {key: "1", label: "沉积功率", section: "condition", type: "number", unit: "W", options: [], required: true}]};
    let templates = {};
    const handler = (url, options, rows) => {
      const body = options.body && typeof options.body === "string" ? JSON.parse(options.body) : null;
      calls.push({url, method: options.method || "GET", body});
      if (url === "/api/onboarding/done") { onboarding = {...onboarding, done: true}; return reply(200, {done: true}); }
      if (/^\/api\/projects\/[^/]+$/.test(url)) return reply(200, {project: {id: "default", name: body.name}});
      if (url === "/api/templates") { templates = {default: filmTemplate}; return reply(200, filmTemplate); }
      if (url.endsWith("/preset")) { templates = {default: filmTemplate}; return reply(200, {template: filmTemplate, settings: {settings: body.settings, revision: 1, fields: []}}); }
      if (url === "/api/demo" && options.method === "POST") { demo = true; return reply(201, {project_id: "demo", records: 12, files: 4}); }
      if (url === "/api/demo" && options.method === "DELETE") { demo = false; return reply(200, {deleted_records: 12, deleted_files: 4}); }
      if (url.startsWith("/api/import/records/parse")) return reply(200, {upload_id: "u1", format: "csv", sheets: ["Sheet1"], sheet: "Sheet1",
        columns: ["样品编号", "温度 (°C)", "基底", "备注", "颜色"], rows: [["S-1", "250", "玻璃", "ok", "red"], ["S-2", "abc", "硅片", "", "blue"]], total_rows: 2});
      if (url === "/api/import/records/preview") {
        previewCount++;
        const bad = body.mapping["1"] === "temperature";
        return reply(200, {rows: [{row: 1, sample_id: "S-1", action: "create", errors: [], values: {}}, {row: 2, sample_id: "S-2", action: bad ? "error" : "create", errors: bad ? ["第 2 行 温度 不是有效的数值。"] : [], values: {}}],
          counts: {create: bad ? 1 : 2, skip: 0, error: bad ? 1 : 0}, token: "t" + previewCount});
      }
      if (url === "/api/import/records/commit") return reply(201, {batch_id: "b".repeat(32), created: 2, skipped: 0});
      if (url.startsWith("/api/import/batches/")) return reply(200, {archived: 2, kept: 0});
      throw new Error("Unhandled " + url);
    };
    const env = await boot({savedLanguage: "en", m3Handler: handler,
      readHandler: catalog => reply(200, {...catalog, onboarding, templates, projects: [...catalog.projects, ...(demo ? [{id: "demo", name: "示例项目"}] : [])],
        project_settings: {default: {revision: Object.keys(templates).length ? 1 : 0, settings: {builtin: {}, key_fields: [], phase_presets: []}, fields: []}}}),
      settingsHandler: (url, options) => { const body = options.body ? JSON.parse(options.body) : null; calls.push({url, method: options.method || "GET", body}); return reply(200, {settings: body?.settings || {}, revision: 1, fields: []}); },
      backupHandler: () => reply(200, {state: "idle", last: null, folder: "", stale_after_days: 7})});
    try {
      const {$, w} = env;
      await flush(); await flush();
      // The wizard opens for a new, empty catalog.
      assert.equal($("onboarding-dialog").open, true, "A new catalog opens the onboarding wizard");
      assert.match($("onboarding-step-label").textContent, /Step 1 of 4/);
      $("onboarding-project-name").value = "";
      $("onboarding-next").click();
      assert.match($("onboarding-error").textContent, /Enter a project name/);
      $("onboarding-project-name").value = "Thin films";
      $("onboarding-next").click();
      w.document.querySelector('[name="onboarding-preset"][value="film"]').checked = true;
      $("onboarding-next").click(); $("onboarding-next").click();
      $("onboarding-demo").checked = true;
      $("onboarding-next").click(); for (let i = 0; i < 8; i++) await flush();
      const order = calls.map(call => `${call.method} ${call.url}`);
      assert.deepEqual(order.filter(item => !item.startsWith("GET")), ["PUT /api/projects/default", "POST /api/projects/default/preset", "POST /api/demo", "POST /api/onboarding/done"],
        "Finish renames, applies the preset in one call, loads the demo and marks onboarding done, in that order");
      const presetBody = calls.find(call => call.url === "/api/projects/default/preset").body;
      assert.equal(presetBody.settings.builtin.precursor.enabled, false, "The film preset switches off precursors");
      assert.deepEqual(presetBody.settings.key_fields.map(field => field.label), ["Substrate", "Deposition power"], "Key fields match the template sent with them");
      assert.deepEqual(presetBody.template.fields.slice(0, 2).map(field => field.label), ["Substrate", "Deposition power"]);
      assert.deepEqual([presetBody.expected_template_revision, presetBody.expected_settings_revision], [0, 0], "The preset states the revisions it expects");
      assert.equal(presetBody.template.fields.length, 4);
      assert.equal($("onboarding-dialog").open, false);
      assert.equal($("backup-dialog").open, true, "Backup settings open when requested");
      $("close-backup").click();
      // Demo catalog: delete asks first, then removes it.
      w.confirm = () => false;
      $("demo-view").click(); await flush();
      assert.equal(calls.some(call => call.method === "DELETE" && call.url === "/api/demo"), false, "Declining keeps the demo");
      w.confirm = () => true;
      $("demo-view").click(); for (let i = 0; i < 4; i++) await flush();
      assert.ok(calls.some(call => call.method === "DELETE" && call.url === "/api/demo" && call.body.confirm === "delete-demo"));
      assert.match($("toast").textContent, /Demo catalog deleted \(12 samples\)/);
      // Record import: auto-guessed mapping, row errors block the commit, fixing the mapping allows it, undo archives.
      $("records-import-view").click();
      const file = new w.File(["样品编号,温度\nS-1,250"], "records.csv");
      Object.defineProperty($("ri-file"), "files", {value: [file], configurable: true});
      $("ri-file").dispatchEvent(new w.Event("change", {bubbles: true})); for (let i = 0; i < 4; i++) await flush();
      const target = index => $("ri-mapping").querySelector(`[data-import-column="${index}"]`).value;
      assert.equal(target(0), "sample_id");
      assert.equal(target(1), "temperature", "Headers with units are recognised");
      assert.equal(target(2), "template:0", "Template fields are matched by label");
      assert.equal(target(3), "notes");
      assert.equal(target(4), "", "Unknown columns are not imported by default");
      $("ri-preview-button").click(); for (let i = 0; i < 4; i++) await flush();
      assert.match($("ri-summary").textContent, /1 new, 0 skipped, 1 with errors/);
      assert.match($("ri-preview").textContent, /Row 2: 温度 is not a valid number/);
      assert.equal($("ri-commit").disabled, true, "Rows with errors block the import");
      const temp = $("ri-mapping").querySelector('[data-import-column="1"]');
      temp.value = ""; temp.dispatchEvent(new w.Event("change", {bubbles: true}));
      assert.equal($("ri-commit").disabled, true, "Changing the mapping requires a new preview");
      $("ri-preview-button").click(); for (let i = 0; i < 4; i++) await flush();
      assert.equal($("ri-commit").disabled, false);
      $("ri-commit").click(); for (let i = 0; i < 5; i++) await flush();
      const commit = calls.find(call => call.url === "/api/import/records/commit").body;
      assert.equal(commit.token, "t2", "The commit carries the token of the latest preview");
      assert.deepEqual(commit.mapping, {0: "sample_id", 2: "template:0", 3: "notes"});
      assert.match($("ri-summary").textContent, /Imported 2 samples/);
      assert.equal($("ri-undo").hidden, false);
      $("ri-undo").click(); for (let i = 0; i < 4; i++) await flush();
      assert.ok(calls.some(call => call.url === `/api/import/batches/${"b".repeat(32)}/archive`));
      assert.match($("ri-summary").textContent, /Archived 2 imported samples/);
      $("ri-cancel").click();
      assert.equal($("records-import-dialog").open, false);
    } finally { env.dom.window.close(); }
    // Skipping marks onboarding done and does not change anything else.
    const skipCalls = [];
    const skip = await boot({savedLanguage: "en", m3Handler: (url, options) => { skipCalls.push(url); return reply(200, {done: true}); },
      readHandler: catalog => reply(200, {...catalog, onboarding: {empty: true, done: false}})});
    try {
      await flush(); await flush();
      assert.equal(skip.$("onboarding-dialog").open, true);
      skip.$("skip-onboarding").click(); await flush();
      assert.deepEqual(skipCalls, ["/api/onboarding/done"]);
      assert.equal(skip.$("onboarding-dialog").open, false);
    } finally { skip.dom.window.close(); }
  }
  {
    // M3 review fixes: replacement uploads, sheet list after a failed parse, header priority, configured projects, history undo.
    const reply = (status, body) => ({ok: status < 300, status, json: async () => structuredClone(body)});
    const calls = [];
    let failNext = false;
    const batch = {id: "c".repeat(32), action: "import", source: "import", created_at: "2026-11-20T10:00:00Z", count: 2, remaining: 2};
    const handler = (url, options) => {
      const body = options.body && typeof options.body === "string" ? JSON.parse(options.body) : null;
      calls.push({url, method: options.method || "GET", body});
      if (url.startsWith("/api/import/records/parse")) {
        if (url.includes("sheet=Samples")) return reply(200, {upload_id: "u3", format: "xlsx", sheets: ["Overview", "Samples"], sheet: "Samples", columns: ["序号", "样品编号"], rows: [["1", "S-1"]], total_rows: 1});
        if (failNext) return reply(400, {error: "表格最多 2000 行、100 列，请拆分后再导入。", sheets: ["Overview", "Samples"], sheet: "Overview"});
        return reply(200, {upload_id: "u1", format: "csv", sheets: [], sheet: "", columns: ["编号", "样品编号"], rows: [["1", "S-1"]], total_rows: 1});
      }
      if (url === "/api/import/records/preview") return reply(200, {rows: [{row: 1, sample_id: "S-1", action: "create", errors: []}], counts: {create: 1, skip: 0, error: 0}, token: "t1"});
      if (url.startsWith("/api/import/batches/")) return reply(200, {archived: 2, kept: 0, already_archived: 1});
      if (url === "/api/onboarding/done") return reply(200, {done: true});
      if (url === "/api/templates" || /^\/api\/projects\/[^/]+$/.test(url)) return reply(200, {});
      throw new Error("Unhandled " + url);
    };
    const env = await boot({savedLanguage: "en", m3Handler: handler,
      readHandler: catalog => reply(200, {...catalog, onboarding: {empty: true, done: false},
        project_settings: {default: {revision: 3, settings: {builtin: {}, key_fields: [], phase_presets: ["Kept"]}, fields: []}}}),
      settingsHandler: (url, options) => { calls.push({url, method: options.method || "GET"}); return reply(200, {settings: {}, revision: 3, fields: []}); },
      workflowHandler: async url => reply(200, url.startsWith("/api/history") ? {batches: [batch], has_more: false, file_events: []} : {items: []})});
    try {
      const {$, w} = env;
      await flush(); await flush();
      // Onboarding on a project that already has saved settings keeps them.
      w.document.querySelector('[name="onboarding-preset"][value="film"]').checked = true;
      for (let i = 0; i < 4; i++) $("onboarding-next").click();
      for (let i = 0; i < 6; i++) await flush();
      assert.equal(calls.some(call => call.url === "/api/templates" || call.url.endsWith("/preset") || call.url.endsWith("/settings") && call.method === "PUT"), false, "Configured projects are never overwritten");
      assert.match($("toast").textContent, /kept as they are/);
      if ($("backup-dialog").open) $("close-backup").click();
      // Two columns that both fit the sample ID ("编号", "样品编号") are left for the user to map.
      $("records-import-view").click();
      const choose = name => { Object.defineProperty($("ri-file"), "files", {value: [new w.File(["x"], name)], configurable: true}); $("ri-file").dispatchEvent(new w.Event("change", {bubbles: true})); };
      choose("a.csv"); for (let i = 0; i < 4; i++) await flush();
      assert.deepEqual([0, 1].map(index => $("ri-mapping").querySelector(`[data-import-column="${index}"]`).value), ["", ""], "An ambiguous sample ID is not guessed");
      const idColumn = $("ri-mapping").querySelector('[data-import-column="1"]');
      idColumn.value = "sample_id"; idColumn.dispatchEvent(new w.Event("change", {bubbles: true}));
      $("ri-preview-button").click(); for (let i = 0; i < 4; i++) await flush();
      assert.equal($("ri-commit").disabled, false);
      // A replacement file that fails to parse leaves nothing to commit, but offers the workbook's other sheets.
      failNext = true;
      choose("b.xlsx"); for (let i = 0; i < 4; i++) await flush();
      assert.equal($("ri-commit").disabled, true, "The previous upload can no longer be committed");
      assert.equal($("ri-preview-button").disabled, true);
      assert.equal($("ri-mapping").textContent, "");
      assert.equal($("ri-sheet-label").hidden, false, "The sheet picker is offered after a failed parse");
      $("ri-sheet").value = "Samples"; $("ri-sheet").dispatchEvent(new w.Event("change", {bubbles: true})); for (let i = 0; i < 4; i++) await flush();
      assert.ok(calls.some(call => call.url.includes("sheet=Samples")));
      assert.equal($("ri-mapping").querySelector('[data-import-column="1"]').value, "sample_id");
      w.confirm = () => true;
      $("ri-cancel").click();
      // Import batches can be archived from Change history.
      $("history-view").click(); for (let i = 0; i < 3; i++) await flush();
      $("history-content").querySelector("[data-archive-import]").click(); for (let i = 0; i < 4; i++) await flush();
      assert.ok(calls.some(call => call.url === `/api/import/batches/${"c".repeat(32)}/archive`), "History archives the import batch");
      assert.match($("toast").textContent, /1 were already archived/, "Already archived samples are reported separately");
      $("history-content").querySelector("[data-history-batch]").click(); for (let i = 0; i < 3; i++) await flush();
      assert.equal($("preview-undo").hidden, true, "Import batches are undone by archiving, not by field undo");
    } finally { env.dom.window.close(); }
  }
  {
    // §8.3: a preset that lost the race to another window changes nothing and onboarding still completes.
    const reply = (status, body) => ({ok: status < 300, status, json: async () => structuredClone(body)});
    const calls = [];
    const env = await boot({savedLanguage: "en",
      m3Handler: (url, options) => { calls.push(`${options.method || "GET"} ${url}`);
        if (url.endsWith("/preset")) return reply(409, {error: "项目已在其他窗口设置，引导未做修改。"});
        return reply(200, url === "/api/onboarding/done" ? {done: true} : {project: {id: "default", name: "X"}}); },
      readHandler: catalog => reply(200, {...catalog, onboarding: {empty: true, done: false}})});
    try {
      const {$, w} = env;
      await flush(); await flush();
      w.document.querySelector('[name="onboarding-preset"][value="powder"]').checked = true;
      $("onboarding-backup").checked = false;
      for (let i = 0; i < 4; i++) $("onboarding-next").click();
      for (let i = 0; i < 6; i++) await flush();
      assert.ok(calls.includes("POST /api/projects/default/preset"));
      assert.ok(calls.includes("POST /api/onboarding/done"), "Onboarding still completes");
      assert.equal($("onboarding-dialog").open, false);
      assert.match($("toast").textContent, /kept as they are/);
    } finally { env.dom.window.close(); }
  }
  {
    // §9: the demo is identified by the server's demo_project_id; deleting it can keep the user's own samples.
    const reply = (status, body) => ({ok: status < 300, status, json: async () => structuredClone(body)});
    let demoId = "demo-2";
    const calls = [];
    const env = await boot({savedLanguage: "en", extraProjects: [{id: "demo", name: "示例项目"}, {id: "demo-2", name: "示例项目"}],
      m3Handler: (url, options) => {
        calls.push(`${options.method || "GET"} ${url}`);
        if (url === "/api/demo" && options.method === "DELETE") { demoId = null; return reply(200, {deleted_records: 12, deleted_files: 4, kept_records: 1, project_kept: true}); }
        if (url === "/api/demo" && options.method === "POST") { demoId = "demo-3"; return reply(201, {project_id: "demo-3", records: 12, files: 4}); }
        throw new Error("Unhandled " + url);
      },
      readHandler: catalog => reply(200, {...catalog, demo_project_id: demoId, projects: demoId === "demo-3" ? [...catalog.projects, {id: "demo-3", name: "示例项目"}] : catalog.projects})});
    try {
      const {$, w} = env;
      w.confirm = () => true;
      $("demo-view").click(); for (let i = 0; i < 4; i++) await flush();
      assert.deepEqual(calls, ["DELETE /api/demo"], "A kept 'demo' project is not mistaken for the current demo");
      assert.match($("toast").textContent, /The 1 samples you added stay in “Demo project”/);
      $("demo-view").click(); for (let i = 0; i < 4; i++) await flush();
      assert.deepEqual(calls, ["DELETE /api/demo", "POST /api/demo"], "Without a current demo the entry creates one");
      assert.equal($("project-select").value, "demo-3", "The new demo project id comes from the server");
    } finally { env.dom.window.close(); }
  }
  {
    // Auto-mapping guesses only exact names or names with the field's own unit, and only when unambiguous.
    const reply = (status, body) => ({ok: status < 300, status, json: async () => structuredClone(body)});
    const field = (key, label, unit, section = "condition") => ({key, label, section, type: "number", unit, options: [], required: false});
    const template = {name: "Mapping", fields: [field("0", "Chamber pressure (base)", "Pa"), field("1", "Chamber pressure", "Pa"), field("2", "腔体压力（基压）", "Pa"),
      field("3", "Coating thickness", "nm"), field("4", "Anneal time", "min"), field("5", "Anneal time (min)", "min"), field("6", "Temperature (actual)", "°C", "result"),
      field("7", "Mass fraction", ""), field("8", "Stage temperature setpoint", "°C"), field("9", "Bias", "mV"),
      field("10", "İletkenlik", "S/m"), field("11", "İletkenlik₂", "S/m"), field("12", "Time", "h"), field("13", "Time", "s", "result")]};
    const cases = {
      "a.csv": [["Sample ID", "Chamber pressure（base）（Pa）", "Chamber pressure (Pa)"], ["sample_id", "template:0", "template:1"]],
      "b.csv": [["Chamber pressure (base)", "Chamber pressure (base) (Pa)"], ["", ""]],
      "c.csv": [["腔体压力 (基压) (Pa)", "Coating thickness (µm)", "Mass fraction (%)", "Chamber pressure (mPa)"], ["template:2", "", "", ""]],
      "d.csv": [["Anneal time (min)", "Anneal time"], ["", ""]],
      "e.csv": [["Temperature (actual) (°C)", "Temperature (°C)", "Stage temperature (K) setpoint", "Bias / mV"], ["template:6", "temperature", "", "template:9"]],
      "f.csv": [["Temperature (°F)", "Temperature (℃)", "Time (h)", "Reaction time / min"], ["", "temperature", "template:12", "duration"]],
      "g.csv": [["温度", "Temperature"], ["", ""]],
      "h.csv": [["İletkenlik (S/m)", "İletkenlik₂ (S/m)", "Mass fraction ()"], ["template:10", "template:11", "template:7"]],
      "i.csv": [["Sample ID", "Time"], ["sample_id", ""]],
      "j.csv": [["Reaction time", "Duration", "Time (min)"], ["", "", ""]],
    };
    const env = await boot({savedLanguage: "en", readHandler: catalog => reply(200, {...catalog, templates: {default: template}}), m3Handler: url => {
      const name = new URL(url, "http://x").searchParams.get("name");
      if (url.startsWith("/api/import/records/parse")) return reply(200, {upload_id: "u-" + name, format: "csv", sheets: [], sheet: "", columns: cases[name][0], rows: [cases[name][0].map(() => "1")], total_rows: 1});
      throw new Error("Unhandled " + url);
    }});
    try {
      const {$, w} = env;
      $("records-import-view").click();
      for (const [name, [columns, expected]] of Object.entries(cases)) {
        Object.defineProperty($("ri-file"), "files", {value: [new w.File(["x"], name)], configurable: true});
        $("ri-file").dispatchEvent(new w.Event("change", {bubbles: true})); for (let i = 0; i < 4; i++) await flush();
        assert.deepEqual(columns.map((_, index) => $("ri-mapping").querySelector(`[data-import-column="${index}"]`).value), expected, `Guesses for ${columns.join(" | ")}`);
      }
    } finally { env.dom.window.close(); }
  }
  {
    // Ties stay unguessed in later tiers: a tied field keeps the next tier ambiguous; without a template no generic guess fills a tie.
    const reply = (status, body) => ({ok: status < 300, status, json: async () => structuredClone(body)});
    const run = async (templates, columns) => {
      const env = await boot({savedLanguage: "en", readHandler: catalog => reply(200, {...catalog, templates}), m3Handler: url => {
        if (url.startsWith("/api/import/records/parse")) return reply(200, {upload_id: "u1", format: "csv", sheets: [], sheet: "", columns, rows: [columns.map(() => "1")], total_rows: 1});
        throw new Error("Unhandled " + url);
      }});
      try {
        const {$, w} = env;
        $("records-import-view").click();
        Object.defineProperty($("ri-file"), "files", {value: [new w.File(["x"], "t.csv")], configurable: true});
        $("ri-file").dispatchEvent(new w.Event("change", {bubbles: true})); for (let i = 0; i < 4; i++) await flush();
        return columns.map((_, index) => $("ri-mapping").querySelector(`[data-import-column="${index}"]`).value);
      } finally { env.dom.window.close(); }
    };
    const tied = {default: {name: "Tie", fields: [{key: "0", label: "Temp", section: "condition", type: "text", unit: "", options: [], required: false},
      {key: "1", label: "Temperature", section: "result", type: "number", unit: "°C", options: [], required: false}]}};
    assert.deepEqual(await run(tied, ["Sample ID", "Temp", "Temperature (°C)"]), ["sample_id", "", ""], "A tied built-in still makes the next tier ambiguous");
    assert.deepEqual(await run({}, ["Reaction time", "Duration", "Time"]), ["", "", ""], "A specific tie is not filled by a generic name");
    const times = {default: {name: "Times", fields: [{key: "0", label: "Time", section: "condition", type: "number", unit: "min", options: [], required: false},
      {key: "1", label: "Time", section: "result", type: "number", unit: "s", options: [], required: false}]}};
    assert.deepEqual(await run(times, ["Sample ID", "Time", "Time (min)", "时间 (min)"]), ["sample_id", "", "", ""], "A column that fits two fields keeps both of them contested");
  }
  console.log("UI DOM checks passed: selection, previews, XRD overlays, bilingual drafts, conflicts and lost-response recovery.");
})().catch(error => { console.error(error); process.exitCode = 1; });
