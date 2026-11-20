# Milestone 1 — attachment management and local session token

Contract between the backend (`server.py`, `desktop.py`, launch scripts, `test_server.py`) and the
front end (`web/*`, `test_ui.cjs`, `test_app.cjs`). Both sides build against this document.

Constraints for all work: Python 3.9+ standard library only, no new runtime dependencies; keep the existing
style (Chinese user-facing error strings in the server, translated by `web/i18n.js`); every write is atomic
(`BEGIN IMMEDIATE`, all-or-nothing); existing behaviour and tests keep passing.

## 1. Attachment management

### Data model (schema version 1 → 2)

- `SCHEMA_VERSION = 2`. The existing pre-migration snapshot and "newer schema" guard apply.
- `files.deleted_at TEXT` (NULL = active). Trashed files keep their row, ID, checksum and stored copy until purged.
- New table `file_events(id TEXT PRIMARY KEY, file_id TEXT NOT NULL, record_id TEXT NOT NULL, action TEXT NOT NULL,
  before TEXT, after TEXT, created_at TEXT NOT NULL)`. `before`/`after` are JSON `{"name", "kind", "record_id"}` or NULL.
  Actions: `upload`, `rename`, `recategorize`, `move`, `delete`, `restore`, `purge`. Log `upload` for new uploads
  (single and folder import) from now on. One event per changed aspect is fine; a combined update may log
  one event per action in the same transaction.
- Name/kind uniqueness applies to **active** files only: the v2 migration rebuilds `files` without the table-level
  `UNIQUE(experiment_id, name, kind)` and adds `CREATE UNIQUE INDEX files_active_name ON files(experiment_id, name, kind)
  WHERE deleted_at IS NULL`. Trashed rows do not occupy their name/kind, so a user can trash a wrong file and upload
  the corrected one under the same name; restoring then reports `name_conflict` (see restore). Every duplicate check
  (upload, folder-import preview, rename, recategorize, move, restore, category deletion) considers active files only.

### Visibility rules

- `record.files` in every API response, CSV export, share ZIP, comparisons, review-queue automatic checks
  ("no usable attachment") and preview lists include **active files only**.
- `result_summary.evidence_ids` are **filtered on read** to the record's active attachments. Deleting or moving a
  file does not rewrite the stored result; restoring/moving back makes the link reappear. Writes must not fail
  merely because a stored or undo-restored evidence ID is trashed, moved or purged; a write still rejects an
  evidence ID the client newly adds that is not an active attachment of that record.
- `GET /api/files/{id}` and `/preview` keep working for trashed files (download from the trash).
- Full backups (ZIP and folder) include trashed-but-not-purged files and the `file_events` table.

### Concurrency

Every attachment write carries the owning record's current `revision` (and the target's for a move). A mismatch
returns 409 with the existing message `这条记录已在其他窗口更新。请保留当前内容，关闭编辑窗口后刷新再编辑。`.
Each successful write bumps `revision` and `updated_at` of every record whose file list changed (owner, target).
These bumps must not break undo of unrelated earlier edits (add a test). Archived records and archived targets
reject attachment writes with 409 `已归档的记录不能修改附件，请先恢复记录。`.

### Endpoints (JSON bodies, existing Host/Origin/`X-Catalog-Local` checks, plus the session token in §2)

| Method | Path | Body | Success |
|---|---|---|---|
| POST | `/api/files/{id}/update` | `{"record_revision": int, "name"?: str, "kind"?: str, "target_record_id"?: str, "target_revision"?: int}` | 200 `{"file": File, "records": [Record, ...]}` |
| POST | `/api/files/{id}/delete` | `{"record_revision": int}` | 200 `{"records": [Record], "trash_count": int}` |
| GET | `/api/trash?project_id=` | — (empty `project_id` = all projects) | 200 `{"items": [TrashItem], "total_bytes": int}` |
| POST | `/api/trash/{id}/restore` | `{"record_revision": int, "name"?: str}` | 200 `{"file": File, "records": [Record], "trash_count": int}` |
| POST | `/api/trash/purge` | `{"file_ids": [str, ...], "confirm": "purge"}` | 200 `{"purged": int, "bytes": int, "trash_count": int}` |

- `File` = the existing attachment object (`id, experiment_id, name, kind, size, sha256, source, created_at`).
- `Record` = the same record object `GET /api/experiments` returns, after the change.
- `TrashItem` = `File` + `deleted_at, record_id, sample_id, experiment_no, project_id, record_archived (bool),
  name_conflict (bool: an active file with the same name and kind exists on that record)`. Newest first.
- `update`: any subset of `name`, `kind`, target. At least one real change, else 400 `没有需要保存的修改。`.
  Name rules = upload rules (no path separators/control chars, ≤ 240 chars). `kind` must be an existing category.
  Move: target must be another non-archived record **in the same project**, `target_revision` required; cross-project
  → 400 `附件只能移到同一项目的样品。`. Name/kind collision on the destination → 409
  `同类型附件 {name} 已存在，未覆盖。请重命名后再上传。` (reuse the existing upload wording).
- `restore`: owner must still exist and not be archived. If `name_conflict`, require `name` (a new name) else 409
  `同名同类附件已存在，请为恢复的附件输入新名称。`.
- `purge`: every ID must currently be in the trash, else 409 `回收站内容已变化，请刷新后再清空。` and nothing is purged.
  `confirm` must equal `"purge"`. Delete DB rows (and `folder_import_receipts` rows referencing them; keep
  `file_events`, adding a `purge` event) in one transaction, then unlink stored copies after commit; an unlink
  failure is logged, not reported as a failed purge.
- `GET /api/history?record_id=...|project_id=...` additionally returns `"file_events": [FileEvent]` (newest first,
  at most 200) for that record or project. `FileEvent` = `{id, file_id, record_id, action, before, after, created_at,
  sample_id}`. These are informational; undo stays record-field-only (the trash is the undo for delete).
- `GET /api/experiments` additionally returns `"trash_count": int` (all projects).

## 2. Local session token

Goal: other OS users or local programs that cannot read this user's data folder cannot use the API.

- Each service start generates `token = secrets.token_urlsafe(32)`. After the data-folder lock is taken, write
  `data/.catalog-session.json` = `{"port", "token", "pid", "started_at"}`; remove it in `server_close`.
  (Exclude it from backups like `.catalog.lock`.)
- Launch URL: `http://127.0.0.1:{port}/?token={token}`. A GET of `/` with a valid `token` sets cookie
  `catalog_session={token}; HttpOnly; SameSite=Strict; Path=/` and answers 303 to the same URL with only the `token`
  parameter removed (keep e.g. `desktop=1`).
- Every `/api/*` request (all methods) needs the cookie, or header `X-Catalog-Token: {token}` for scripts.
  Otherwise 401 `{"error": "会话已失效，请从启动入口重新打开实验数据目录。"}`. Existing Host/Origin/`X-Catalog-Local`
  checks stay. Exception: `GET /api/health` without a token returns only `{"app", "version"}` (no workspace path).
- `GET /` without a valid cookie serves `web/locked.html` with status 401 (front end provides this static page; it
  must not need scripts; it loads `/locked.css`, which the server must serve as `text/css`). Other static files
  (`/app.js`, `/i18n.js`, CSS including `/locked.css`, `/notices.txt`, `/license.txt`) stay public.
  Add `web/locked.html` and `web/locked.css` to `package_app.FILES`.
- `--open` opens the launch URL. If the port is busy and `.catalog-session.json` belongs to this data folder and the
  running service answers `/api/health`, open that service's launch URL instead of failing. `--stop` reads the session
  file and calls `/api/shutdown` with the token.
- `desktop.py` opens `/?desktop=1&token=...`. Launch scripts keep working; `start.ps1` prints that the catalog
  was opened in the browser and that re-running the launcher reopens it.
- Tests: add a helper that obtains the cookie; cover 401 without/with wrong token, cookie flags, redirect keeping
  `desktop=1`, header access, health minimal vs full, `--stop`/`--open` reuse via the session file.

## 3. Out of scope for M1

Undo for attachment operations (trash restore covers delete), configurable core fields (M2), settings UI for
`local-catalog.json` (M2), onboarding and imports (M3), packaging (M4).
