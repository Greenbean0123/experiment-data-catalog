# Backlog

Open items carried forward from reviews. Severity follows the release rule: medium or higher only for problems a single
user can hit in normal use that lose or silently change stored data, show wrong data, or block a normal workflow.

## From the M2 release checks (low)

- **Upgrade from v2: empty merged group keeps its default after its prefix is removed.** Save shared 240 °C for the merged
  `AB-1-42`/`AB-I-42` group in v2, renumber both samples out of it, upgrade, remove `AB`: a new `AB-I-42` sample is
  prefilled with 240 °C. The value is visible in the editor before saving; stored samples are unchanged.
- **Upgrade from v2: a dismissal made while the sample later moved projects.** Dismiss missing temperature in project A,
  move the sample to B in v2, upgrade, move it back to A: a new pending temperature item appears next to the old
  dismissal (shown as covering no fields). The issue is shown again rather than hidden.
- **Upgrade from v2: a multi-field dismissal edited before upgrade.** Dismiss missing `Pressure` and `Substrate` in v2, fill
  `Substrate`, upgrade, clear it again: both fields are pending. The issue is shown again rather than hidden.
- **First-time folder backup interrupted while publishing its history file** (needs an injected failure): the folder keeps
  a database but no marker, and a retry answers 409 until the folder is emptied. Make the interrupted publication
  recoverable on retry.

## From the M3 release checks (low)

- **English import errors keep Chinese built-in labels**, e.g. `Row 2: 温度 is not a valid number`; the invalid-mapping
  and missing-import-batch errors have no English entry yet. Translate built-in labels in import errors.

## Accepted residual risks (documented in the contracts)

- Hand edits of `local-catalog.json` while the app runs can be overwritten by a save in the same instant (M2 §6.4).
- A crash between publishing a folder backup's database and its conventions file can leave that one backup with the
  previous conventions file (M2 §8.5).
- A data folder used with an unreleased pre-counter M3 build that deleted its demo there can reuse the id `demo` once
  (M3 §10.3 applies from the released build on).

## Planned

- M4: installer and updates, code signing, replace the AGPL-derived theme.
- Rebuild the Windows desktop package from current code (the existing build predates the data-folder lock and session).
