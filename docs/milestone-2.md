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
  (`\t\n\v\f\r`, space, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF). Validation
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

## 6. Re-review amendments (binding; supersede §5.4 where they conflict)

### 6.1 Notebook-prefix merges never overwrite a group's own defaults

- A prefix change that would merge experiment keys whose stored shared defaults disagree on any field is rejected:
  `PUT /api/local-catalog` → 409 `以下实验在新的编号前缀下会合并，但共用条件不一致：{experiments}。请先统一这些实验的共用条件，再修改前缀。`
  (experiments joined by `、`, at most 10). Nothing changes.
- When the running service detects such a change in a hand-edited file, it keeps the previous prefixes active and
  `GET /api/local-catalog` reports the same message in `error` until the file is fixed.
- Merges that are allowed (identical defaults, or only one group has stored defaults) never delete the original rows.
  A shared save on a merged group writes only the fields that changed and are enabled, to the merged key and to every
  original row it covers, so removing the prefix later leaves each original group consistent. Per-sample overrides keep
  belonging to their own group. This replaces the "most recent wins" ordering of §5.4, which is no longer needed.

### 6.2 Review dispositions created before §5.6

- Automatic missing-condition items whose stored fingerprint covered a set of built-in fields (older format) are
  matched by the fields they covered: an issue already resolved/dismissed for those fields stays closed, and a new
  pending item is generated only for fields it did not cover.

### 6.3 Local-catalog text

- Precursor labels, aliases, notebook prefixes and translation map keys/values reject control characters, including
  line breaks (400 `本地约定格式不正确：{detail}`).
- Local `translations.en` adds English for catalog-specific terms only; it cannot replace the program's own wording
  (which is also used inside HTML templates). This is intentional.

### 6.4 Known residual race (documented, not fixed)

- `PUT /api/local-catalog` compares the file bytes immediately before `os.replace`, but Windows offers no atomic
  compare-and-replace, so a hand edit landing in that instant can be overwritten. Edit `local-catalog.json` by hand only
  while the app is stopped (README says so).

## 7. Final amendments (binding; replace §5.4 and the merge rules of §6.1)

### 7.1 One state per experiment group; deterministic merge and split

- Shared defaults and per-sample overrides of an experiment group live in exactly one `experiment_defaults` row per
  **current** experiment key. There is no propagation to rows of other keys.
- A prefix change is applied in one transaction together with the rewrite of affected rows:
  - **Merge** (several current keys become one): allowed only if at most one of them has a stored row, or all stored rows
    have identical defaults. The merged row takes those defaults and the union of the per-sample overrides; the old rows
    are deleted. Otherwise 409 (message of §6.1) and nothing changes.
  - **Split** (one key becomes several): the row is copied to every resulting key; per-sample overrides go with the
    sample to its new key. No information is lost, and nothing is created for keys that have no samples.
- When a sample's experiment key changes (edit of its experiment number or sample ID), its per-sample override moves
  with it to the new group row, or is dropped when the new group has no row.

### 7.2 Accepted notebook prefixes

- The last accepted prefix set is stored in `app_settings` (`accepted_notebook_prefixes`) whenever prefixes are applied.
- At startup, and whenever the file changes, the file's prefixes are applied only if they do not conflict (§7.1);
  otherwise the stored accepted set stays active. Only when no accepted set has ever been stored does the service fall
  back to an empty set.

### 7.3 Error kinds of `GET /api/local-catalog`

- `error_kind`: `"unparsable"` (file cannot be parsed; editor read-only, `PUT` 409) or `"prefix_conflict"` (file parses
  but its prefixes conflict; the editor stays editable so the user can fix the prefixes; a conflicting `PUT` is 409).
- Each `GET` re-checks a rejected file against the current defaults and applies it once it no longer conflicts, so the
  error disappears after the user makes the defaults agree.

### 7.4 Review coverage

- When an automatic missing-condition item is resolved or dismissed, the `missing` fields shown at that moment are stored
  with the disposition; later coverage uses exactly that set. Items decided before this change keep using the fields of
  their stored fingerprint (§6.2).

### 7.5 Not changed

- A first shared save in a group still fills blank values of other members with the group's known common value. This is
  the documented existing behaviour (README: "首次设置也会补入可用的空白条件"), independent of prefixes.

## 8. Last amendments for M2 (binding)

### 8.1 Schema

- `SCHEMA_VERSION = 4`. The v3→v4 step adds the stored review coverage and performs the §7 row remapping, so the existing
  pre-migration snapshot guard runs for catalogs created at the earlier unreleased v3 layout.

### 8.2 Local-catalog publication is recoverable

- `PUT /api/local-catalog` stores the new file bytes in `app_settings` (`pending_local_catalog`) in the **same**
  transaction as the accepted prefixes and the experiment-defaults rewrite, then replaces the file, then clears the
  pending entry. If the process fails in between, startup (and the next grouping-dependent operation) re-publishes the
  pending bytes before anything else, so the database and the file always agree. A failure before commit changes nothing.
- Folder backups publish the database snapshot first and the conventions file second; a failure while publishing the
  database leaves the previous backup generation untouched.
- `GET /api/local-catalog` returns strings exactly as stored (no trimming) so the editor can detect control characters,
  and adds `"active_prefixes": [...]` (the prefixes currently applied by the service).

### 8.3 Review decisions are tied to what was shown

- `POST /api/reviews/{id}/decide` for automatic missing-condition items must include `"missing": [...]` exactly as
  displayed; if the item's current missing set differs, 409 `待核对项已变化，请刷新后再处理。` and nothing changes.
- Stored coverage entries use field identity: built-ins by name (`temperature`), template fields by
  `template:{template_revision}:{field_key}`, key fields by their lower-cased id. Coverage of one kind never suppresses
  another kind with the same label.

### 8.4 Group rows remember where they came from

- Every `experiment_defaults` row records its origin key(s) (the keys whose stored defaults it holds). On a split, a copy
  goes to every resulting key that has samples **and** to each origin key, even without samples; rows with no samples and
  no origin are dropped.
- When undo (or any edit) moves a sample into a group, its per-sample override is recomputed: the sample follows the
  group when its restored values equal the group's defaults for the shared fields, otherwise it keeps an override for the
  differing fields. Overrides created by the undone change are not carried along.

### 8.5 Accepted residual risks after M2 (documented)

- §6.4 hand-edit race; and a crash in the instant between publishing a folder backup's database and its conventions
  file can leave that one backup with the previous conventions file. Low-severity review findings after this round are
  recorded for M3 instead of blocking the M2 release.

## 9. Release-check amendments (binding)

### 9.1 Upgrade scope

- Schema v3 was never released (the published edition is at v2). Upgrade guarantees cover v1/v2 catalogs and fresh v4
  catalogs. Development catalogs at the v3 layout must still open without data loss, using the same legacy rules as v2.

### 9.2 Legacy rows and legacy review decisions

- `experiment_defaults` rows that existed before v4 have **unknown** origin. A split copies such a row only to resulting
  keys that have samples; it never invents an origin key. Origin keys are recorded only for rows written under v4.
- Review decisions made before v4 (no stored display list) cover each label in their fingerprint for every field kind it
  can name on that record (built-in and template fields with that label), so an unchanged catalog never shows the same
  issue as both decided and pending after upgrade.
- Automatic missing-condition items always carry `missing` as a list (possibly empty) in `GET /api/reviews`, including
  legacy items; decide requests send it back unchanged, so legacy items can be reopened and decided.

### 9.3 Template coverage identity

- Template coverage entries are `template:{project_id}:{template_revision}:{field_key}`.

### 9.4 Folder backup publication order

- The database-history copy is written and verified before the mirror's database is replaced; any failure before the
  database replacement leaves the previous backup generation (database, history, conventions, marker) unchanged.

### 9.5 Committed but not yet published conventions

- If `PUT /api/local-catalog` commits the database transaction but cannot replace the file (e.g. the file is held open),
  it answers 200 with the new `catalog`, `revision`, `active_prefixes` and `"publication_pending": true`. The change is
  accepted and will be published automatically (§8.2). The UI tells the user that the conventions were saved and the file
  will be written shortly. A failure before commit still returns an error and changes nothing.

## 10. Release-check 2 amendments (binding)

- **Prefix changes touch only affected groups.** A prefix change rewrites only `experiment_defaults` rows whose key is
  merged or split by that change. Every other row, including rows of groups that currently have no samples, stays
  exactly as stored.
- **Legacy decisions stay in their project.** A review decision made before v4 only covers issues of the same project
  as the stored review item.
- **Legacy coverage is frozen at upgrade.** The v3→v4 step (and v1/v2 upgrades) computes each legacy automatic
  missing-condition decision's coverage from its stored fingerprint against the record and template as they are at
  upgrade time, and stores it as the decision's coverage. Later edits never shrink or reinterpret it.
- **Pending conventions publication never breaks reads.** While `pending_local_catalog` cannot be published (file
  locked), every endpoint serves the committed settings from the database (translations, conventions, active prefixes)
  and retries publication later; no request fails because of it.
- Deferred to M3 (low): recovery of a first-time folder backup interrupted while publishing its history file.

## 11. Released with known limitations

M2 was released after release check 3. Its three remaining findings concern upgrades of v2 catalogs only, never change
stored sample records, and err towards showing information again (a prefilled default visible before saving, dismissed
issues shown as pending again). They are tracked in `docs/backlog.md` together with the deferred low-severity items.
