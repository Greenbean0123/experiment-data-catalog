# Milestone 3 — onboarding, demo catalog, record import

Goal: a new user can start in minutes (name a project, pick a field preset, set up backups), try the app on a demo
catalog without touching real data, and bring existing records in from a spreadsheet.

Same constraints as before: Python 3.9 standard library only; atomic writes; Chinese server error strings exactly as
below; existing behaviour and tests keep passing; preserve each file's line endings.

## Review severity rule (applies to every M3 review)

Medium or higher only for problems a single user can hit in normal use that lose or silently change stored data, show
wrong data, or block a normal workflow. Fault injection, concurrent hand edits of files and upgrades from unreleased
layouts are low. Low findings go to `docs/backlog.md` and do not block a release.

## 1. Project rename

- `PUT /api/projects/{id}` `{"name": str}` → 200 `{"project": {"id", "name"}}`. Name rules as for new projects
  (1–80 chars, unique case-insensitively → 409 `该名称已存在，请直接选择或使用其他名称。`). Unknown id → 404 `找不到该项目。`.
  The id never changes. Not part of change history.

## 2. Onboarding state

- `GET /api/experiments` adds `"onboarding": {"done": bool, "empty": bool}`. `empty` is true when the catalog has no
  records outside the demo project. `done` is stored in `app_settings` (`onboarding_done`).
- `POST /api/onboarding/done` `{}` → 200 `{"done": true}`. Idempotent.
- Existing catalogs (any records at upgrade) count as `done`.

## 3. Demo catalog

- `POST /api/demo` `{}` → 201 `{"project_id": "demo", "records": int, "files": int}`. Creates project id `demo` named
  `示例项目`, a template (film example: substrate single-choice, thickness number nm, anneal temperature number °C,
  sheet resistance result number Ω/sq), project settings with two key fields, three experiments with 12 synthetic
  samples (conditions, results, notes saying they are synthetic demo data), and 4 synthetic XRD-like CSV attachments
  generated in code. Everything is deterministic and contains no external data. 409 `示例实验库已存在。` if present.
  The demo project id is stored in `app_settings` (`demo_project_id`).
- `DELETE /api/demo` `{"confirm": "delete-demo"}` → 200 `{"deleted_records": int, "deleted_files": int}`. Permanently
  removes the demo project and everything that belongs to it (records, files and their stored copies, file events,
  history entries/batches that only concern demo records, review items, template versions, project settings, shared
  defaults), in one transaction, then unlinks stored copies. Missing confirm → 400 `请确认删除示例实验库。`. No demo
  → 404 `没有示例实验库。`. This is the only operation that deletes records; it never touches other projects.
- Demo records are ordinary records otherwise (editable, exportable, included in backups).

## 4. Record import (CSV / XLSX)

### 4.1 Parse

- `POST /api/import/records/parse?name={filename}[&sheet={name}]` with the raw file as body (≤ 5 MiB) →
  200 `{"upload_id", "format": "csv"|"xlsx", "sheets": [str], "sheet": str, "columns": [str], "rows": [[str]] (first 20),
  "total_rows": int}`.
- CSV: UTF-8 (with or without BOM), else GB18030; delimiter detected among `,` `;` tab; first row is the header.
- XLSX: parsed with `zipfile` + `xml.etree` (shared strings, inline strings, numbers, booleans); first sheet unless
  `sheet` is given; date-formatted numeric cells become `YYYY-MM-DD`; formulas use their cached values.
- At most 2000 data rows and 100 columns, else 400 `表格最多 2000 行、100 列，请拆分后再导入。`. Unreadable file → 400
  `无法读取这个文件，请另存为 UTF-8 CSV 或 .xlsx 后重试。`. Empty header cells become `列 {n}`.
- The parsed table is kept in memory for 30 minutes keyed by `upload_id` (random hex). Expired/unknown → 404
  `导入文件已过期，请重新选择文件。`.

### 4.2 Mapping and preview

- `POST /api/import/records/preview` `{"upload_id", "project_id", "mapping": {column_index: target}, "existing": "skip"|"fail"}`
  → 200 `{"rows": [{"row": int (1-based data row), "sample_id", "action": "create"|"skip"|"error", "errors": [str],
  "values": {...}}], "counts": {"create", "skip", "error"}, "token": str}`.
- Targets: `sample_id` (required, exactly one column), `experiment_no`, `series`, `experiment_date`, `precursors`,
  `temperature`, `duration`, `solvents`, `notes`, `template:{field_key}` (fields of the project's **current** template;
  the record gets that template version), `extra:{name}` (custom condition; text). Unmapped columns are ignored.
  Built-in targets disabled in the project's settings are rejected (400 `项目已关闭字段 {label}，不能导入到该字段。`).
- Values: lists split on `;` `；` `、` newline and ` + `; numbers accept a trailing unit equal to the field's unit
  (`250 °C`, `60 min`, `120 nm`), anything else → row error `第 {n} 行 {field} 不是有效的数值。`; dates accept
  `YYYY-MM-DD`, `YYYY/MM/DD`, `YYYY.MM.DD` and must be real dates; template choice values must be existing options.
  Empty cells mean unknown. All existing validation (lengths, ranges) applies per row; errors list every problem of a row.
- Duplicates: a sample ID that already exists in the project (archived included) → `skip` with `existing: "skip"`, else
  `error`; a sample ID repeated inside the file → `error` on every occurrence after the first.
- `token` = hash of upload, mapping, options and the catalog state that affects the result.

### 4.3 Commit and undo

- `POST /api/import/records/commit` `{"upload_id", "project_id", "mapping", "existing", "token"}` → 201
  `{"batch_id", "created": int, "skipped": int}`. Rejected if any row is `error` (400 `还有 {count} 行有错误，请修正后再导入。`)
  or if the token no longer matches (409 `数据已变化，请重新预览。`). All rows are created in one transaction with one
  history batch (action `import`, source `import`); shared defaults of their experiment groups are applied like for
  new samples; key-field and template rules apply.
- `POST /api/import/batches/{batch_id}/archive` `{}` → 200 `{"archived": int, "kept": int}`. Archives every record of
  that import batch that is unchanged since the import (revision still the imported one) and not archived; changed
  records are kept and counted in `kept`. Archive is the existing reversible archive (recorded in history).
- `GET /api/history` lists import batches like other batches.

## 5. Front end (owned by the front-end side)

Onboarding wizard (shown when `empty && !done`: project name → field preset → backup reminder → optional demo), demo
create/remove entry, import dialog (file, sheet, column mapping with auto-guess from Chinese/English headers, preview
table, commit, "archive this import" from the result toast and history), bilingual strings.

## 6. Out of scope for M3

Updating existing records from a spreadsheet, deleting real projects, importing attachments together with records,
packaging (M4).

## 7. Review amendments (binding)

### Backend

- **Demo deletion keeps real history.** File events and history entries that concern any non-demo record (or a file
  that still belongs to a non-demo record) are kept; only events and entries whose records are all demo records are
  deleted. A history batch that still has entries is kept.
- **CSV delimiter.** For each candidate (`,` `;` tab) parse the first 50 rows with the csv module; choose the delimiter
  whose rows have the most consistent column count (most rows equal to the header width), ties broken by the larger
  header width, then by the order `,` `;` tab. Only delimiters that split the header into at least two columns compete;
  if none does, `,` is used. (A one-column parse is otherwise trivially consistent and would win for files whose rows
  have uneven widths.)
- **Sheet list on errors.** When the selected (or default first) XLSX sheet fails validation (limits, unreadable), the
  400 response also carries `"sheets": [...]` and `"sheet": name`, so the UI can offer another sheet.
- **Row numbers.** Data-row numbers come from explicit cell coordinates when the `<row>` element has no `r`.
- **Translatable row errors.** Template-choice errors use `第 {n} 行 {field}：请选择模板中已有的选项。`; other per-row validation
  errors follow the same `第 {n} 行 {field}：{message}` shape with the message taken verbatim from the existing validators.

### Front end

- Changing the file or sheet clears the upload, mapping and preview immediately; nothing can be committed until a new
  file parses and is previewed.
- Onboarding applies a preset only to a project with no template and no saved settings (revision 0); otherwise it keeps
  everything and says so.
- Mapping guesses use specific headers (e.g. `样品编号`, `sample id`) across all columns before generic ones (`编号`).
- Import batches in Change history offer "Undo this import (archive)" using the batch archive endpoint; the result toast
  mentions it.

## 8. Release-check amendments (binding)

### 8.1 Demo deletion only deletes generated content

- When the demo is created, the ids of its generated records and files are stored in `app_settings`
  (`demo_contents`).
- `DELETE /api/demo` is allowed only when the demo project contains nothing but generated records, each holding only
  generated files, and no generated file has been moved to a record outside the demo project (and no outside file into
  a demo record). Otherwise 409 `示例项目中有不是示例生成的样品或附件，无法整体删除。请先把它们移到其他项目。` and nothing changes.
  Edits, archiving and trashing of generated content are fine.
- Because only generated content can be deleted, every file event and history entry of the deleted records is demo-only
  and is removed with them; nothing outside the demo is touched. This replaces the mixed-history rules of §7.

### 8.2 CSV delimiter candidates that fail to parse are disqualified

- A candidate whose sampling raises `csv.Error` does not compete, whatever score it accumulated before failing.

### 8.3 Onboarding preset is applied atomically

- `POST /api/projects/{id}/preset` `{"template": {name, fields}, "settings": Settings, "expected_template_revision": 0,
  "expected_settings_revision": int}` → 200 `{"template", "settings": {settings, revision, fields}}`. In one transaction
  it checks that the project's current template revision is 0 and its settings revision equals the expected one, then
  saves the template (revision 1) and the settings (key fields validated against that new template). Any mismatch →
  409 `项目已在其他窗口设置，引导未做修改。` and nothing changes.

### 8.4 Archive counts

- `POST /api/import/batches/{id}/archive` also returns `"already_archived": int`; `kept` counts only records that changed
  since the import and are not archived.

## 9. Demo deletion keeps what the user added (binding; replaces the refusal rule of §8.1)

Found in the end-to-end run: after loading the demo the page switches to the demo project, so a new sample is easily
created there; it gets the demo template and, like every templated sample, cannot move to another project. With §8.1 the
demo could then never be deleted.

- `DELETE /api/demo` deletes only **generated** content (records and files recorded in `demo_contents`, or recovered
  for legacy demos) together with their file events, history entries, review items and stored copies.
- Records and files the user added to the demo project stay. If any record remains, the project stays as an ordinary
  project (same id and name, the demo marker `demo_project_id` is cleared, its template and settings are kept); if none
  remains, the project and its template/settings/defaults are removed as before.
- It is still refused, with 409 `示例样品和其他样品之间移动过附件，无法自动区分。请先把这些附件移回原来的样品。` and no change, when any
  generated file (active or trashed) belongs to a non-generated record, or any non-generated file belongs to a generated
  record.
- Response: `{"deleted_records", "deleted_files", "kept_records": int, "project_kept": bool}`.
- After a demo whose project was kept, `POST /api/demo` creates a new demo project with a fresh id (`demo`, `demo-2`, ...);
  `project_id` in its response is authoritative.
- `GET /api/experiments` adds `"demo_project_id": str | null` (the current demo project, if any). The front end uses it to
  decide between creating and deleting the demo; it never guesses from project ids.

## 10. Release check round 1 (binding)

### 10.1 Unlinked review items keep the demo project

- A review item in the demo project without a record (for example an unmatched folder-import file, `record_id` null)
  was created by the user. `DELETE /api/demo` never deletes it. The project is kept (as in §9) when any record **or**
  any such review item remains: `project_kept = kept_records > 0 or unlinked reviews remain`. `kept_records` still
  counts records only.

### 10.2 Reassigned review items do not hide warnings

- When demo deletion moves a review item of a record that now lives in another project to that project, the item keeps
  its status, resolution, sources and history, but its `coverage` becomes `[]`: it no longer covers any missing
  condition, so the new project's missing-condition warnings appear as they would without it.

### 10.3 A demo id is never reused

- Each `POST /api/demo` uses a demo id that no earlier demo used: the first demo gets `demo` (if free), later ones
  `demo-2`, `demo-3`, ... A counter in `app_settings` (kept when the demo is deleted) records the highest number used;
  ids of existing projects are skipped as before. Undo entries that refer to a deleted demo therefore keep answering 409
  `原项目已不存在，无法恢复这次修改。` after a new demo is created.

### 10.4 The demo always has its XRD category

- If the category `XRD` does not exist, `POST /api/demo` adds it (as an ordinary category, in the same transaction) and
  files its curves under it. The category stays after the demo is deleted.

### 10.5 Front end (done)

- Import auto-mapping (release-check rounds 2–6) guesses only unambiguous exact matches: a header that is a field name,
  or a field name followed by that field's own unit in brackets or after `/` (`温度 (°C)`, `Reaction time / min`); a
  field without a unit also accepts an empty `()` (as in the catalog's own CSV export). The unit suffix is removed
  exactly (case-sensitive, except the listed spellings of °C and min) before the name is compared, ignoring case,
  full-width brackets and spacing. In one pass every column collects every field it fits by any rule; a column is
  guessed only when it fits exactly one field and no other column fits that field. Everything else is mapped by hand.
  A template label that itself contains a unit (`Thickness (µm)` on a field stored in nm) is trusted as written.
- Confirming a whole-batch undo sends no `record_ids` (the 500-id limit applies to explicit selections only).
