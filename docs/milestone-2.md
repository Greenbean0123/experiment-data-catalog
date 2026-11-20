# Milestone 2 — project field settings and catalog conventions UI

Goal: the catalog fits fields other than solution synthesis without migrating stored data. Each project decides which
built-in condition fields it uses and what they are called, and promotes experiment-template fields to **key fields**
that behave like built-in conditions (filters, dashboard distribution, list, comparison, CSV, bulk edit, missing checks).
Catalog-wide conventions in `data/local-catalog.json` become editable in the app.

Same constraints as M1: Python 3.9 standard library only; atomic writes; Chinese server error strings exactly as below;
existing behaviour and tests keep passing; preserve each file's line endings.

## 1. Project settings

### Storage

- `SCHEMA_VERSION = 3`. New table `project_settings(project_id TEXT PRIMARY KEY REFERENCES projects(id),
  settings TEXT NOT NULL, revision INTEGER NOT NULL)`. A project without a row has the defaults below (revision 0).
- Normalized settings shape (input may omit any key; output always has the full shape):

```json
{
  "builtin": {
    "precursor":   {"enabled": true, "label": {"zh": "", "en": ""}},
    "temperature": {"enabled": true, "label": {"zh": "", "en": ""}},
    "duration":    {"enabled": true, "label": {"zh": "", "en": ""}},
    "materials":   {"enabled": true, "label": {"zh": "", "en": ""}}
  },
  "key_fields": [{"section": "condition", "label": "Substrate", "check_missing": true}],
  "phase_presets": ["Phase I", "Phase II"]
}
```

- `materials` is the solvent / ligand list together with its amounts. Empty labels mean the default label.
  Labels ≤ 40 characters, no control characters. Units of built-in numbers stay °C and min.
- `key_fields`: at most 8, unique by `(section, label.casefold())`. On save every entry must match a field of the
  project's **current** template (same section, label compared case-insensitively) of type text, number, single or
  multi, else 400 `关键字段必须来自当前实验模板。`. Stored labels use the template's spelling.
- `phase_presets`: at most 20 strings of ≤ 80 characters, unique case-insensitively. They replace the earlier
  `local-catalog.json` `phase_presets`; the file's entry is still read as a fallback when a project has no row.

### Key-field resolution (used everywhere)

For a record, a key field resolves to the field of **the record's own template version** (`lab_data.template_revision`)
with the same section, the same label (case-insensitive) and the same type, and its value is
`lab_data.values[field.key]`. A number field additionally carries its unit; consumers compare numbers only when the
record's unit equals the current template's unit and treat other units as "unit differs". Records without that
field have no value.

### API

| Method | Path | Body | Success |
|---|---|---|---|
| GET | `/api/projects/{id}/settings` | — | 200 `{"settings": Settings, "revision": int, "fields": [KeyFieldInfo]}` |
| PUT | `/api/projects/{id}/settings` | `{"settings": Settings, "revision": int}` | 200 same shape as GET |

- `KeyFieldInfo` = one entry per configured key field: `{section, label, check_missing, available (bool: still in the
  current template), type, unit, options}` (type/unit/options from the current template, empty when unavailable).
- Stale `revision` → 409 `项目设置已在其他窗口修改，请刷新后再保存。`. Unknown project → 404 `找不到该项目。`.
- `GET /api/experiments` adds `"project_settings": {project_id: {"settings", "revision", "fields"}}` for every project.
- Settings changes are not part of change history or undo in M2.

### Missing-condition checks (review queue, automatic items)

- Built-in fields are checked only when enabled for the record's project (`materials` covers solvents/ligands).
- Each key field with `check_missing: true` is checked: missing when the record has no value. Result-section key fields
  are waived when `lab_data.outcome` is `not_measured`, `measurement_failed` or `no_target` (as for template results).
- Key-field items use `field = "key:{section}:{label}"` and the title `缺少关键字段：{label}`. Existing item
  fingerprints/dispositions for built-in fields must keep working.

### CSV export (`/api/export.csv`)

Append one column per distinct key field (by section + label, case-insensitive) across the projects of the exported
records, after the existing columns. Header: the label, plus ` ({unit})` for numbers. Values: number as stored,
multi joined with ` / `, empty when the record has no value; a number whose unit differs is written as `"{value} {unit}"`.
Keep the existing formula-injection protection for text cells.

### Bulk edit (`POST /api/experiments/bulk`)

`changes` may include `"key_fields": [{"section", "label", "mode", "value"}]`. Modes: number/text/single → `set` | `clear`;
multi → `replace` | `append` | `clear`. Each target record must have the field in its own template version (resolution
above); otherwise 400 `以下样品的模板没有字段 {label}：{samples}` (samples joined by `、`, at most 10 listed) and
nothing changes. Values are validated against each record's field definition (options, finite numbers, text ≤ 250).
Preview rows report key-field changes alongside built-in ones, using the field name `key:{section}:{label}` and the
same before/after structure the preview already uses. Unchanged values do not bump revisions; history entries record
the `lab_data` change so undo restores it.

## 2. Catalog conventions editor (`data/local-catalog.json`)

| Method | Path | Body | Success |
|---|---|---|---|
| GET | `/api/local-catalog` | — | 200 `{"catalog": Conventions, "revision": str}` |
| PUT | `/api/local-catalog` | `{"catalog": Conventions, "revision": str}` | 200 same shape |

- `Conventions` = `{"notebook_prefixes": [str], "precursor_aliases": [{"label", "aliases": [str]}], "translations":
  {"en", "categories", "datasetTitles", "noteLines", "noteRules"}}`. `revision` = SHA-256 hex of the file bytes, or `""`
  when the file does not exist.
- PUT validates strictly (reject, do not drop): prefixes 1–20 ASCII letters, ≤ 50 prefixes; ≤ 200 aliases, labels and
  aliases ≤ 250 chars, ≤ 50 aliases each, no alias claimed by two labels; translation maps of strings ≤ 2000 chars, ≤ 2000
  entries per map; `noteRules` ≤ 200 of `{pattern, flags (subset of "imsu"), replacement}`. Invalid → 400
  `本地约定格式不正确：{detail}` (detail in Chinese, short). Regex syntax is validated by the front end (rules run in JS).
- Stale revision → 409 `本地约定已在其他窗口修改，请刷新后再保存。`.
- Write atomically (temporary file + replace) and keep unknown top-level keys of the existing file (e.g. `about`,
  legacy `phase_presets`). After a successful write the running service uses the new values immediately: notebook
  prefixes are **replaced** (not merged) and `GET /api/experiments` returns the new `translations` / `conventions`.
- The file stays part of both backup kinds.

## 3. Front end (summary; owned by the front-end side)

Project settings dialog (built-in toggles and labels, key-field picker from the current template with
`check_missing`, phase presets); conventions dialog (prefixes, aliases, translations JSON with regex validation);
disabled built-ins hidden and labels applied across filters, editor, details, dashboard, list, comparison and bulk edit;
key fields in filters (number range, option select, text contains), dashboard distribution tabs, list summary,
comparison rows, bulk edit and the editor/detail emphasis.

## 4. Out of scope for M2

Renaming or deleting projects, per-project units for built-in numbers, moving built-in data into template fields,
onboarding and imports (M3), packaging (M4).

## 5. Review amendments (binding; supersede earlier text where they conflict)

### 5.1 Identity and normalization (server and browser must agree)

- Key-field and template-label matching uses `label.lower()` in Python and `label.toLowerCase()` in JS (no
  `casefold`), so both sides resolve identically. `KeyFieldInfo` adds `"id": "key:{section}:{label.lower()}"`; the
  front end uses this id for lookups, settings matching and comparison grouping. Review items for key fields use the
  same lower-cased id in `field` (title keeps the template spelling).
- Precursor-alias normalization on both sides: lower-case, then remove every character of the JS `\s` class
  (`	
`, space, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF). Validation
  rejects two labels that normalize to the same alias.

### 5.2 Disabled built-ins are never written by indirect paths

- Shared-condition saves update only fields enabled for the project; defaults and per-sample overrides of disabled
  fields are left exactly as they are.
- Bulk edits that change a built-in field disabled in the project of any selected record → 400
  `以下样品所在项目已关闭字段 {label}：{samples}` and nothing changes.

### 5.3 Units in bulk numeric key-field edits

- A number `set` must include `"unit"` (the unit shown, possibly `""`). Every target record's field unit must equal
  it, else 400 `以下样品的单位与所填单位不同：{samples}` and nothing changes. Preview changes for number key fields
  carry `"unit"` (the record's field unit).

### 5.4 Notebook-prefix changes merge experiment groups safely

- When a prefix change makes two experiment keys collapse into one, the merged group's shared defaults come from the
  group that has stored defaults (if both do, keep the one updated most recently and keep per-sample overrides from
  both), so no sample loses its override protection. Apply this both on `PUT /api/local-catalog` and when the running
  service notices that the file changed on disk.

### 5.5 Local catalog file robustness

- If `local-catalog.json` exists but cannot be parsed, `GET /api/local-catalog` returns 200
  `{"catalog": <empty>, "revision": <sha of bytes>, "error": "local-catalog.json 无法解析，请先修复文件或删除后再编辑。"}` and
  `PUT` returns 409 with that message; the file is never replaced while unparsable.
- `PUT` re-reads the bytes immediately before the atomic replace and returns 409
  `本地约定已在其他窗口修改，请刷新后再保存。` if they changed after the revision check.
- The running service re-reads the file when its bytes change (checked on `GET /api/experiments` and before any
  grouping-dependent write), so translations **and** notebook prefixes follow hand edits.
- A folder backup removes `data/local-catalog.json` from the mirror when the catalog has none.

### 5.6 Review-queue stability

- Switching a built-in off and on again, or a casing-only rename of a promoted template field, must not create new
  pending items for issues that were already resolved or dismissed: fingerprints of built-in items do not include the
  set of enabled fields, and key-field fingerprints use the lower-cased identity.
- Key fields that are no longer available in the current template (`available: false`) generate no automatic items.
