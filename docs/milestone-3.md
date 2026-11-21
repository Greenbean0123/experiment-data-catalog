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
