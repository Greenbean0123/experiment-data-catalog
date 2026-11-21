"""Local Experiment Data Catalog. Python 3.9+, standard library only."""
import argparse
import csv
import errno
import hashlib
import io
import json
import logging
import math
import os
import re
import secrets
import shutil
import socket
import sqlite3
import tempfile
import threading
import uuid
import webbrowser
import zipfile
from contextlib import contextmanager, nullcontext
from datetime import date, datetime, timezone
from http.client import HTTPConnection, HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import combinations
from pathlib import Path
from sys import float_info
from urllib.parse import parse_qs, parse_qsl, quote, unquote, urlencode, urlsplit

ROOT = Path(__file__).resolve().parent
STATUSES = ("待补全", "已记录", "待表征", "已完成")
KINDS = ("XRD", "NMR", "TEM", "SEM", "XPS", "DFT", "其他")
CONDITION_FIELDS = ("precursor", "solvent", "ligand", "temperature", "duration")
PROJECT_BUILTINS = {
    "precursor": ("前驱体", ("precursor", "precursors")),
    "temperature": ("温度", ("temperature",)),
    "duration": ("反应/取样时间", ("duration",)),
    "materials": ("溶剂 / 配体", ("solvent", "solvents", "ligand", "material_amounts")),
}
NUMERIC_CONDITIONS = {"temperature": (-273.15, 2500), "duration": (0, 100000)}
EMPTY_RESULT = {"phases": [], "morphologies": [], "confirmation": "", "conclusion": "", "evidence_ids": []}
RESULT_LIST_ERROR = "物相和形貌各最多 20 项，每项最多 80 个字符；证据附件最多 100 个。"
MAX_FILE = 256 * 1024 * 1024
MAX_FOLDER_FILES = 300
IMPORT_ISSUES = {
    "sample": "缺少可匹配的样品编号",
    "category": "数据类别待确认",
    "duplicate": "同一样品下已有同名同类附件",
    "size": "空文件或超过单文件大小限制",
    "archived": "目标样品已归档或属于资料集",
    "failed": "文件保存结果待核对",
}
TEXT_LIMITS = {"sample_id": 120, "experiment_no": 120, "series": 120, "experiment_date": 10,
               "precursor": 250, "solvent": 250, "ligand": 250, "notes": 20000}
HISTORY_FIELDS = (*TEXT_LIMITS, *NUMERIC_CONDITIONS, "status", "extra_conditions", "project_id",
                  "precursors", "solvents", "material_amounts", "result_summary", "archived", "lab_data")
JSON_FIELDS = {"extra_conditions", "precursors", "solvents", "material_amounts", "result_summary", "lab_data"}
CONDITION_LIST_ERRORS = {
    "precursor": "请选择最多 20 项前驱体，每个名称最多 250 个字符。",
    "solvent": "请选择最多 20 项溶剂 / 配体，每个名称最多 250 个字符。",
}
OUTCOMES = ("", "not_measured", "measurement_failed", "no_target", "measured")
EMPTY_SHARED_CONDITIONS = {"precursors": [], "temperature": None,
                           "materials": {"solvents": [], "material_amounts": []}}
EMPTY_SHARED_STATE = {"conditions": {}, "overrides": {}, "last_save": "", "origin_keys": []}
# Bump when the database layout changes; older programs refuse catalogs written by newer ones.
SCHEMA_VERSION = 4
FILE_FIELDS = ("id", "experiment_id", "name", "kind", "size", "sha256", "source", "created_at")
STALE_RECORD = "这条记录已在其他窗口更新。请保留当前内容，关闭编辑窗口后刷新再编辑。"
ARCHIVED_ATTACHMENTS = "已归档的记录不能修改附件，请先恢复记录。"
# Already-compressed formats gain nothing from DEFLATE; storing them keeps large backups fast.
COMPRESSED_SUFFIXES = {".zip", ".7z", ".rar", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".png", ".jpg", ".jpeg",
                       ".gif", ".webp", ".heic", ".mp4", ".mov", ".avi", ".mkv", ".mp3", ".m4a", ".docx",
                       ".xlsx", ".pptx", ".opju", ".jdx", ".brml"}
BACKUP_MARKER = "backup-info.json"
SESSION_FILE = ".catalog-session.json"
PENDING_PURGE_PREFIX = "purge-file:"
APP_ID = "experiment-data-catalog"
# Lab-specific conventions (labels, precursor aliases, phase presets, ID prefixes) live in the data folder,
# never in the program source. See README, "Lab conventions".
LOCAL_CATALOG = "local-catalog.json"
STALE_LOCAL_CATALOG = "本地约定已在其他窗口修改，请刷新后再保存。"
UNPARSABLE_LOCAL_CATALOG = "local-catalog.json 无法解析，请先修复文件或删除后再编辑。"
JS_WHITESPACE = ("\t\n\v\f\r \u00a0\u1680" + "".join(chr(code) for code in range(0x2000, 0x200b))
                 + "\u2028\u2029\u202f\u205f\u3000\ufeff")
ALIAS_WHITESPACE = str.maketrans("", "", JS_WHITESPACE)
CATALOG_TRANSLATION_MAPS = ("en", "categories", "datasetTitles", "noteLines")
CATALOG_EDITOR_KEYS = {"notebook_prefixes", "precursor_aliases", "translations"}
MAX_CATALOG_JSON = 512 * 1024 * 1024  # The translation maps can contain 32 million characters, even before JSON escaping.
DB_HISTORY_KEEP = 30
STALE_BACKUP_DAYS = 7


class Problem(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class CatalogUnavailable(RuntimeError):
    """The data folder cannot be opened safely by this process."""


class DataDirInUse(CatalogUnavailable):
    """Another process holds the data folder lock."""


class DataDirLock:
    """Exclusive lock so only one running program writes a data folder at a time."""

    FILENAME = ".catalog.lock"

    def __init__(self, data_dir):
        data_dir = Path(data_dir)
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / self.FILENAME
        try:
            self.handle = open(self.path, "a+b")
        except OSError as exc:
            raise CatalogUnavailable(f"无法写入数据目录 / Cannot write to the data folder: {data_dir}\n{exc}") from exc
        try:
            if os.name == "nt":
                import msvcrt
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.handle.close()
            self.handle = None
            raise DataDirInUse(
                "此数据目录已被另一个实验数据目录程序（浏览器版或桌面版）打开。请先关闭它再启动。\n"
                f"This data folder is already open in another Experiment Data Catalog window or service. Close it first.\n{data_dir}")

    def release(self):
        if self.handle:
            if os.name == "nt":
                import msvcrt
                self.handle.seek(0)
                try:
                    msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
            self.handle.close()
            self.handle = None


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def validate_file_name(name):
    if (not isinstance(name, str) or not name or len(name) > 240 or
            any(ord(char) < 32 or 127 <= ord(char) <= 159 or 0xd800 <= ord(char) <= 0xdfff for char in name) or
            any(char in name for char in '/\\') or name in (".", "..")):
        raise Problem("文件名无效，请使用不含路径的文件名。")


def experiment_number(sample_id):
    # shortcut: infer notebook-style IDs only; use the editable experiment number for other naming schemes.
    match = re.match(r"^([A-Za-z]+-(?:[IVX]+|\d+)-\d+)(?=$|[-_\s(])", sample_id, re.I)
    return match[1].upper() if match else sample_id


def experiment_key(number, notebook_prefixes):
    match = re.match(r"([A-Za-z]+)-1-(?=[0-9])", number, re.ASCII)
    if match and match[1].upper() in notebook_prefixes:
        number = match[1] + "-I-" + number[match.end():]
    return number.lower()


def record_experiment_key(record, prefixes):
    return experiment_key(record["experiment_no"] or experiment_number(record["sample_id"]), prefixes)


def record_materials(record):
    values = record.get("solvents")
    if values is None:
        values = [record["solvent"]] if record.get("solvent") else []
    return list(dict.fromkeys([*values, *([record["ligand"]] if record.get("ligand") else [])]))


def record_precursors(record):
    values = record.get("precursors")
    if isinstance(values, str):
        return json.loads(values)
    return values if values is not None else ([record["precursor"]] if record["precursor"] else [])


def shared_values(row):
    record = dict(row)
    record["solvents"] = json.loads(record["solvents"]) if record["solvents"] is not None else None
    return {"precursors": sorted(record_precursors(record)),
            "temperature": record["temperature"],
            "materials": {"solvents": sorted(record_materials(record)),
                          "material_amounts": sorted(json.loads(record["material_amounts"]), key=lambda item: item["name"])}}


def shared_columns(values):
    columns = {}
    if "precursors" in values:
        names = values["precursors"]
        columns.update(precursor=" + ".join(names), precursors=json.dumps(names, ensure_ascii=False) if len(names) > 1 else None)
    if "temperature" in values:
        columns["temperature"] = values["temperature"]
    if "materials" in values:
        materials = values["materials"]
        columns.update(solvent=" + ".join(materials["solvents"]), ligand="",
                       solvents=json.dumps(materials["solvents"], ensure_ascii=False),
                       material_amounts=json.dumps(materials["material_amounts"], ensure_ascii=False))
    return columns


def material_summary(record):
    amounts = {item["name"]: item for item in record.get("material_amounts", [])}
    return " + ".join(name + (f" ({amounts[name]['amount']:.15g} {amounts[name]['unit']})" if name in amounts else "") for name in record_materials(record))


def is_dataset(record):
    return record["sample_id"].startswith("资料集-") and (record["notes"].startswith("批量导入：local-") or record["series"] == "导入报告 / Import report")


def history_state(row):
    if row is None:
        return None
    state = dict(row)
    state.setdefault("lab_data", "{}")
    state.setdefault("precursors", None)
    return {key: state[key] for key in HISTORY_FIELDS}


def decoded_state(state):
    return {key: json.loads(value) if key in JSON_FIELDS and value is not None else value for key, value in state.items()}


def history_changes(before, after):
    old, new = decoded_state(history_state(before)) if before else {}, decoded_state(history_state(after))
    changes = []
    materials = {"solvent", "ligand", "solvents", "material_amounts"}
    for field in HISTORY_FIELDS:
        if field in materials or field == "precursors":
            continue
        left, right = old.get(field), new[field]
        if field == "result_summary":
            left, right = validate_result_summary(left or {}), validate_result_summary(right)
        if field == "lab_data":
            left, right = left or {}, right or {}
        if field == "precursor":
            left, right = old.get("precursors") or left, new.get("precursors") or right
        if left != right:
            changes.append({"field": field, "before": left, "after": right})
    left = material_summary(old) if before else ""
    right = material_summary(new)
    if left != right:
        changes.append({"field": "materials", "before": left, "after": right})
    return changes


def validate_condition_option(payload):
    field = payload.get("field") if isinstance(payload, dict) else None
    if field not in CONDITION_FIELDS:
        raise Problem("请选择前驱体、溶剂 / 配体、温度或时间。")
    name = payload.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 250 or any(ord(c) < 32 for c in name):
        raise Problem("条件选项不能为空，最多 250 个字符，不能包含控制字符。")
    name = name.strip()
    if field in NUMERIC_CONDITIONS:
        try:
            value = float(name)
        except ValueError:
            raise Problem("常用温度或时间必须是有效范围内的数值。")
        lower, upper = NUMERIC_CONDITIONS[field]
        if not math.isfinite(value) or not lower <= value <= upper:
            raise Problem("常用温度或时间必须是有效范围内的数值。")
        name = format(value, ".15g")
    return field, name


def validate_result_summary(value):
    if not isinstance(value, dict) or set(value) - set(EMPTY_RESULT):
        raise Problem("实验结果格式不正确。")
    result = {}
    for field in ("phases", "morphologies", "evidence_ids"):
        items = value.get(field, [])
        if (not isinstance(items, list) or (field != "evidence_ids" and len(items) > 20) or
                any(not isinstance(item, str) or not item.strip() or len(item) > 80 or
                    any(ord(char) < 32 for char in item) for item in items)):
            raise Problem(RESULT_LIST_ERROR)
        result[field] = list(dict.fromkeys(item.strip() for item in items))
    confirmation = value.get("confirmation", "")
    if confirmation not in ("", "pending", "confirmed"):
        raise Problem("请选择有效的结果确认状态。")
    conclusion = value.get("conclusion", "")
    if not isinstance(conclusion, str) or len(conclusion) > 2000 or "\x00" in conclusion:
        raise Problem("结果结论最多 2000 个字符，不能包含空字符。")
    result["conclusion"] = conclusion.strip()
    if confirmation == "confirmed" and not (result["phases"] or result["morphologies"] or result["conclusion"]):
        raise Problem("请先填写物相、形貌或结论，再确认结果。")
    result["confirmation"] = confirmation or ("pending" if any(result.values()) else "")
    return {key: result[key] for key in EMPTY_RESULT}


def validate(payload):
    if not isinstance(payload, dict):
        raise Problem("实验记录必须是对象。")
    clean = {}
    for field, limit in TEXT_LIMITS.items():
        value = "" if field in CONDITION_LIST_ERRORS and field + "s" in payload else payload.get(field, "")
        if not isinstance(value, str) or len(value) > limit or "\x00" in value:
            raise Problem(f"{field} 格式不正确或内容过长。")
        clean[field] = value.strip()
    for field, error in CONDITION_LIST_ERRORS.items():
        key = field + "s"
        if key not in payload:
            continue
        values = payload[key]
        if (not isinstance(values, list) or len(values) > 20 or
                any(not isinstance(value, str) or not value.strip() or len(value) > 250 or
                    any(ord(char) < 32 for char in value) for value in values)):
            raise Problem(error)
        values = list(dict.fromkeys(value.strip() for value in values))
        clean[key] = None if field == "precursor" and len(values) < 2 else json.dumps(values, ensure_ascii=False)
        clean[field] = " + ".join(values)
    if "material_amounts" in payload:
        amounts, names = payload["material_amounts"], set()
        materials = record_materials({**clean, "solvents": json.loads(clean["solvents"]) if "solvents" in clean else None})
        if not isinstance(amounts, list) or len(amounts) > len(materials):
            raise Problem("添加量必须对应已选择的溶剂 / 配体，且每项只能记录一次。")
        for item in amounts:
            if not isinstance(item, dict) or not isinstance(item.get("name"), str) or item["name"] not in materials or item["name"] in names:
                raise Problem("添加量必须对应已选择的溶剂 / 配体，且每项只能记录一次。")
            try:
                finite = type(item.get("amount")) in (int, float) and math.isfinite(item["amount"])
            except OverflowError:
                finite = False
            if not finite or item["amount"] < 0 or item.get("unit") not in ("mL", "mmol", "g"):
                raise Problem("请填写非负有限数值，单位可选 mL、mmol 或 g。未知时留空。")
            names.add(item["name"])
        clean["material_amounts"] = json.dumps([{key: item[key] for key in ("name", "amount", "unit")} for item in amounts], ensure_ascii=False)
    if not clean["sample_id"]:
        raise Problem("请填写样品编号。")
    clean["experiment_no"] = clean["experiment_no"] or experiment_number(clean["sample_id"])
    if clean["experiment_date"]:
        try:
            if date.fromisoformat(clean["experiment_date"]).isoformat() != clean["experiment_date"]:
                raise ValueError()
        except ValueError:
            raise Problem("实验日期格式应为 YYYY-MM-DD。")
    for field, (lower, upper) in NUMERIC_CONDITIONS.items():
        value = payload.get(field)
        if value is not None:
            if type(value) not in (int, float) or not lower <= value <= upper or not math.isfinite(value):
                raise Problem(f"{field} 必须是 {lower} 到 {upper} 范围内的有限数值，未知时留空。")
        clean[field] = value
    clean["status"] = payload.get("status", "待补全")
    if clean["status"] not in STATUSES:
        raise Problem("记录状态不正确。")
    conditions = payload.get("extra_conditions", [])
    if not isinstance(conditions, list) or len(conditions) > 30:
        raise Problem("自定义条件最多 30 项。")
    extra, names = [], set()
    for condition in conditions:
        if not isinstance(condition, dict):
            raise Problem("自定义条件格式不正确。")
        item = {}
        for key in ("name", "value", "unit"):
            value = condition.get(key, "")
            if not isinstance(value, str) or len(value) > 250 or "\x00" in value:
                raise Problem("自定义条件的名称、数值和单位应为简短文本。")
            item[key] = value.strip()
        if not item["name"] or item["name"].casefold() in names:
            raise Problem("自定义条件名称不能为空或重复。")
        names.add(item["name"].casefold())
        extra.append(item)
    clean["extra_conditions"] = json.dumps(extra, ensure_ascii=False)
    if "result_summary" in payload:
        clean["result_summary"] = json.dumps(validate_result_summary(payload["result_summary"]), ensure_ascii=False)
    return clean


def lab_text(value, maximum, required=False):
    if (not isinstance(value, str) or len(value) > maximum or
            any(ord(char) < 32 or 0xd800 <= ord(char) <= 0xdfff for char in value) or (required and not value.strip())):
        raise Problem("模板或样品扩展字段格式不正确。")
    return value.strip()


def validate_template(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("fields"), list) or len(payload["fields"]) > 30:
        raise Problem("模板最多支持 30 个字段。")
    name = lab_text(payload.get("name"), 80, required=True)
    fields, names = [], set()
    for index, field in enumerate(payload["fields"]):
        if not isinstance(field, dict):
            raise Problem("模板或样品扩展字段格式不正确。")
        label = lab_text(field.get("label"), 80, required=True)
        section, kind, required = field.get("section"), field.get("type"), field.get("required", False)
        if section not in ("condition", "result") or kind not in ("text", "number", "single", "multi") or type(required) is not bool:
            raise Problem("模板或样品扩展字段格式不正确。")
        key = (section, label.lower())
        if key in names:
            raise Problem("同一区域内的模板字段名称不能重复。")
        names.add(key)
        unit = lab_text(field.get("unit", ""), 32) if kind == "number" else ""
        options = []
        if kind in ("single", "multi"):
            choices = field.get("options")
            if not isinstance(choices, list) or not 1 <= len(choices) <= 30:
                raise Problem("选择字段应包含 1–30 个选项。")
            options = [lab_text(option, 80, required=True) for option in choices]
            if len({option.casefold() for option in options}) != len(options):
                raise Problem("模板选项名称不能重复。")
        fields.append(dict(key=str(index), label=label, section=section, type=kind,
                           unit=unit, options=options, required=required))
    return {"name": name, "fields": fields}


def key_field_identity(field):
    return field["section"], field["label"].lower()


def key_field_name(field):
    return f"key:{field['section']}:{field['label']}"


def template_field(template, identity):
    return next((field for field in template["fields"] if key_field_identity(field) == identity), None) if template else None


def valid_settings_text(value, maximum):
    return (isinstance(value, str) and len(value) <= maximum
            and not re.search(r"[\x00-\x1f\x7f-\x9f\ud800-\udfff]", value))


def validate_project_settings(payload, template):
    invalid = Problem("项目设置格式不正确。")
    if not isinstance(payload, dict) or set(payload) - {"builtin", "key_fields", "phase_presets"}:
        raise invalid
    builtin, key_fields, phases = payload.get("builtin", {}), payload.get("key_fields", []), payload.get("phase_presets", [])
    if not isinstance(builtin, dict) or set(builtin) - set(PROJECT_BUILTINS):
        raise invalid
    settings = {"builtin": {}, "key_fields": [], "phase_presets": []}
    for field in PROJECT_BUILTINS:
        entry = builtin.get(field, {})
        if not isinstance(entry, dict) or set(entry) - {"enabled", "label"}:
            raise invalid
        enabled, label = entry.get("enabled", True), entry.get("label", {})
        if (type(enabled) is not bool or not isinstance(label, dict) or set(label) - {"zh", "en"}
                or any(not valid_settings_text(value, 40) for value in label.values())):
            raise invalid
        settings["builtin"][field] = {"enabled": enabled, "label": {lang: label.get(lang, "").strip() for lang in ("zh", "en")}}
    if not isinstance(key_fields, list) or len(key_fields) > 8:
        raise Problem("关键字段最多支持 8 项。")
    seen = set()
    for key in key_fields:
        if not isinstance(key, dict) or set(key) - {"section", "label", "check_missing"}:
            raise invalid
        section, label, check_missing = key.get("section"), key.get("label"), key.get("check_missing", False)
        field = (template_field(template, (section, label.strip().lower()))
                 if section in ("condition", "result") and valid_settings_text(label, 80) else None)
        if not field:
            raise Problem("关键字段必须来自当前实验模板。")
        identity = key_field_identity(field)
        if identity in seen:
            raise Problem("关键字段不能重复。")
        if type(check_missing) is not bool:
            raise invalid
        seen.add(identity)
        settings["key_fields"].append({"section": section, "label": field["label"], "check_missing": check_missing})
    if not isinstance(phases, list) or len(phases) > 20 or any(not valid_settings_text(tag, 80) or not tag.strip() for tag in phases):
        raise Problem("物相预设最多支持 20 项，每项最多 80 个字符。")
    settings["phase_presets"] = [tag.strip() for tag in phases]
    if len({tag.casefold() for tag in settings["phase_presets"]}) != len(phases):
        raise Problem("物相预设不能重复。")
    return settings


def project_settings_info(settings, revision, template):
    fields = []
    for key in settings["key_fields"]:
        field = template_field(template, key_field_identity(key)) or {}
        fields.append({**key, "id": f"key:{key['section']}:{key['label'].lower()}", "label": field.get("label", key["label"]),
                       "available": bool(field), "type": field.get("type", ""),
                       "unit": field.get("unit", ""), "options": field.get("options", [])})
    return {"settings": settings, "revision": revision, "fields": fields}


def resolve_key_field(template, details, info):
    if not info or not info["available"] or not template or template["revision"] != details.get("template_revision"):
        return None, None
    field = template_field(template, key_field_identity(info))
    if field is None or field["type"] != info["type"]:
        return None, None
    return field, details.get("values", {}).get(field["key"])


def validate_template_value(field, value):
    kind = field["type"]
    if kind == "number":
        if type(value) not in (int, float) or not -float_info.max <= value <= float_info.max:
            raise Problem("数值字段必须是有限数字。")
    elif kind == "text":
        return lab_text(value, 250, required=True)
    elif kind == "single":
        if value not in field["options"]:
            raise Problem("请选择模板中已有的选项。")
    elif (not isinstance(value, list) or not value or len(value) > len(field["options"])
          or any(option not in field["options"] for option in value) or len(set(value)) != len(value)):
        raise Problem("请选择模板中已有的选项。")
    return value


def missing_template_fields(template, details, section):
    if not template or (section == "result" and details.get("outcome") in OUTCOMES[1:4]):
        return []
    values = details.get("values", {})
    return [field for field in template["fields"]
            if field["required"] and field["section"] == section and field["key"] not in values]


def review_fingerprint(item_id, relevant):
    return hashlib.sha256(json.dumps([item_id, relevant]).encode()).hexdigest()[:32]


def restore_lab_fields(before, after, current):
    before, after, current = map(json.loads, (before, after, current))
    groups = [("parent_id", "treatment"), ("outcome",)]
    template_changed = before.get("template_revision") != after.get("template_revision")
    if template_changed:
        groups.append(("template_revision", "values"))
    conflict = Problem("相关字段已有后续修改，未撤销任何记录。请刷新后核对。", 409)
    for group in groups:
        if not any(before.get(key) != after.get(key) for key in group):
            continue
        if any(current.get(key) != after.get(key) for key in group):
            raise conflict
        for key in group:
            if key in before:
                current[key] = before[key]
            else:
                current.pop(key, None)
    if not template_changed:
        old_values, new_values = before.get("values", {}), after.get("values", {})
        values = current.get("values", {}).copy()
        for key in set(old_values) | set(new_values):
            if old_values.get(key) == new_values.get(key):
                continue
            if current.get("template_revision") != after.get("template_revision") or values.get(key) != new_values.get(key):
                raise conflict
            if key in old_values:
                values[key] = old_values[key]
            else:
                values.pop(key, None)
        if values:
            current["values"] = values
        else:
            current.pop("values", None)
    return json.dumps(current, ensure_ascii=False)


def folder_path(value):
    lab_text(value, 420, required=True)
    path = value
    if "\\" in path or ":" in path or any(part in ("", ".", "..") for part in path.split("/")) or len(path.rsplit("/", 1)[-1]) > 240:
        raise Problem("请选择有效的相对文件路径。")
    return path


def folder_entry(entry):
    if not isinstance(entry, dict) or type(entry.get("size")) is not int or not 0 <= entry["size"] <= 2**50:
        raise Problem("文件夹导入预览格式不正确。")
    return {"path": folder_path(entry.get("path")), "size": entry["size"],
            "sample_id": lab_text(entry.get("sample_id", ""), 120),
            "kind": lab_text(entry.get("kind", ""), 80)}


def catalog_prefixes(value):
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and re.fullmatch(r"[A-Za-z]{1,20}", item)]


def catalog_text(value, limit=None):
    return (isinstance(value, str) and (limit is None or len(value) <= limit)
            and not re.search(r"[\ud800-\udfff]", value))


def validate_local_catalog(payload):
    def invalid(detail):
        return Problem("本地约定格式不正确：" + detail)

    def valid_text(value, limit):
        if not catalog_text(value, limit):
            return False
        if re.search(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]", value):
            raise invalid("文本不能包含控制字符或换行。")
        return True

    if not isinstance(payload, dict) or set(payload) - CATALOG_EDITOR_KEYS:
        raise invalid("应为本地约定对象。")
    prefixes = payload.get("notebook_prefixes", [])
    if not isinstance(prefixes, list) or len(prefixes) > 50 or len(catalog_prefixes(prefixes)) != len(prefixes):
        raise invalid("编号前缀最多 50 项，每项需为 1–20 个英文字母。")

    aliases = payload.get("precursor_aliases", [])
    if not isinstance(aliases, list) or len(aliases) > 200:
        raise invalid("前驱体别名最多 200 组。")
    entries, claimed = [], set()
    for entry in aliases:
        if not isinstance(entry, dict) or set(entry) != {"label", "aliases"}:
            raise invalid("每组前驱体别名需包含显示名称与别名列表。")
        label, names = entry["label"], entry["aliases"]
        if not valid_text(label, 250) or not label.strip(JS_WHITESPACE):
            raise invalid("前驱体名称需为 1–250 个字符。")
        if (not isinstance(names, list) or len(names) > 50
                or any(not valid_text(name, 250) or not name.strip(JS_WHITESPACE) for name in names)):
            raise invalid("每组最多 50 个别名，每个别名需为 1–250 个字符。")
        keys = {name.lower().translate(ALIAS_WHITESPACE) for name in [label, *names]}
        if claimed & keys:
            raise invalid("同一别名不能属于不同前驱体。")
        claimed.update(keys)
        entries.append({"label": label.strip(JS_WHITESPACE), "aliases": [name.strip(JS_WHITESPACE) for name in names]})

    translations = payload.get("translations", {})
    if not isinstance(translations, dict) or set(translations) - {*CATALOG_TRANSLATION_MAPS, "noteRules"}:
        raise invalid("译法应为包含受支持字段的对象。")
    maps = {}
    for key in CATALOG_TRANSLATION_MAPS:
        mapping = translations.get(key, {})
        if (not isinstance(mapping, dict) or len(mapping) > 2000
                or any(not valid_text(name, 2000) or not valid_text(value, 2000) for name, value in mapping.items())):
            raise invalid("每个译法表最多 2000 项，键和值均需为不超过 2000 个字符的文本。")
        maps[key] = mapping
    rules = translations.get("noteRules", [])
    if not isinstance(rules, list) or len(rules) > 200:
        raise invalid("备注规则最多 200 项。")
    maps["noteRules"] = []
    for rule in rules:
        if not isinstance(rule, dict) or set(rule) - {"pattern", "flags", "replacement"}:
            raise invalid("备注规则需包含匹配式和替换文本。")
        pattern, replacement, flags = rule.get("pattern"), rule.get("replacement"), rule.get("flags", "")
        if not catalog_text(pattern) or not catalog_text(replacement):
            raise invalid("备注规则的匹配式和替换内容需为文本。")
        if not isinstance(flags, str) or not re.fullmatch(r"[imsu]{0,4}", flags) or len(set(flags)) != len(flags):
            raise invalid("备注规则标记只能使用不重复的 i、m、s、u。")
        maps["noteRules"].append({"pattern": pattern, "flags": flags, "replacement": replacement})
    return {"notebook_prefixes": prefixes, "precursor_aliases": entries, "translations": maps}


def decode_local_catalog(data):
    try:
        value = json.loads(data.decode("utf-8")) if data is not None else {}
    except (ValueError, RecursionError):
        return None
    return value if isinstance(value, dict) else None


def local_catalog_revision(data):
    return hashlib.sha256(data).hexdigest() if data is not None else ""


@contextmanager
def prepare_file_replacement(path, data):
    target = tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".part-{path.stem}-", delete=False)
    part = Path(target.name)
    try:
        with target:
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
        yield part
    finally:
        part.unlink(missing_ok=True)


class Store:
    def __init__(self, data_dir):
        self.data = Path(data_dir)
        self.files = self.data / "files"
        self.files.mkdir(parents=True, exist_ok=True)
        self.db = self.data / "experiments.sqlite3"
        self.lock = threading.RLock()
        self.backup_guard = threading.Lock()
        self.file_copy_lock = threading.Lock()
        self.backup_state_lock = threading.Lock()
        self.backup_progress = {"state": "idle"}
        self._catalog_data = {}
        self._catalog_revision = None
        self._catalog_error = {}
        self.check_schema_version()
        with self.connect() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            new_categories = not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='categories'").fetchone()
            experiment_schema = """CREATE TABLE IF NOT EXISTS experiments (
                id TEXT PRIMARY KEY, sample_id TEXT NOT NULL COLLATE NOCASE,
                series TEXT NOT NULL, experiment_date TEXT NOT NULL,
                precursor TEXT NOT NULL, temperature REAL, duration REAL,
                solvent TEXT NOT NULL, ligand TEXT NOT NULL, status TEXT NOT NULL,
                notes TEXT NOT NULL, extra_conditions TEXT NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                experiment_no TEXT NOT NULL DEFAULT '',
                project_id TEXT NOT NULL DEFAULT 'default' REFERENCES projects(id),
                UNIQUE(project_id, sample_id)
            )"""
            db.executescript("""
                CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
                CREATE TABLE IF NOT EXISTS categories (name TEXT PRIMARY KEY COLLATE NOCASE);
                CREATE TABLE IF NOT EXISTS condition_options (
                    field TEXT NOT NULL CHECK(field IN ('precursor', 'solvent', 'ligand', 'temperature', 'duration')),
                    name TEXT NOT NULL, PRIMARY KEY(field, name)
                );
                INSERT OR IGNORE INTO projects VALUES ('default', '默认项目');
            """)
            if "'temperature'" not in db.execute("SELECT sql FROM sqlite_master WHERE name='condition_options'").fetchone()["sql"]:
                db.execute("BEGIN IMMEDIATE")
                db.execute("ALTER TABLE condition_options RENAME TO condition_options_v1")
                db.execute("CREATE TABLE condition_options (field TEXT NOT NULL CHECK(field IN ('precursor', 'solvent', 'ligand', 'temperature', 'duration')), name TEXT NOT NULL, PRIMARY KEY(field, name))")
                db.execute("INSERT INTO condition_options(field,name) SELECT field,name FROM condition_options_v1")
                db.execute("DROP TABLE condition_options_v1")
            db.execute(experiment_schema)
            files_schema = """CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id),
                name TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL,
                sha256 TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
                deleted_at TEXT
            )"""
            db.execute(files_schema)
            if "experiment_no" not in {row["name"] for row in db.execute("PRAGMA table_info(experiments)")}:
                db.execute("ALTER TABLE experiments ADD COLUMN experiment_no TEXT NOT NULL DEFAULT ''")
            if "project_id" not in {row["name"] for row in db.execute("PRAGMA table_info(experiments)")}:
                # Rebuild atomically to scope sample uniqueness to projects; keep file references and IDs intact.
                db.commit()
                db.execute("PRAGMA foreign_keys=OFF")
                db.execute("BEGIN IMMEDIATE")
                columns = ",".join(row["name"] for row in db.execute("PRAGMA table_info(experiments)"))
                db.execute(experiment_schema.replace("experiments (", "experiments_v2 (", 1))
                db.execute(f"INSERT INTO experiments_v2 ({columns}) SELECT {columns} FROM experiments")
                db.execute("DROP TABLE experiments")
                db.execute("ALTER TABLE experiments_v2 RENAME TO experiments")
                if db.execute("PRAGMA foreign_key_check").fetchall():
                    raise RuntimeError("Project migration failed its reference check")
                db.commit()
                db.execute("PRAGMA foreign_keys=ON")
            if new_categories:
                db.executemany("INSERT OR IGNORE INTO categories VALUES (?)", ((kind,) for kind in KINDS))
            db.execute("INSERT OR IGNORE INTO categories SELECT DISTINCT kind FROM files")
            columns = {row["name"] for row in db.execute("PRAGMA table_info(experiments)")}
            for field in CONDITION_LIST_ERRORS:
                if field + "s" not in columns:
                    db.execute(f"ALTER TABLE experiments ADD COLUMN {field}s TEXT")
            if "material_amounts" not in {row["name"] for row in db.execute("PRAGMA table_info(experiments)")}:
                db.execute("ALTER TABLE experiments ADD COLUMN material_amounts TEXT NOT NULL DEFAULT '[]'")
            if "result_summary" not in {row["name"] for row in db.execute("PRAGMA table_info(experiments)")}:
                db.execute("ALTER TABLE experiments ADD COLUMN result_summary TEXT NOT NULL DEFAULT '{}'")
            if "lab_data" not in {row["name"] for row in db.execute("PRAGMA table_info(experiments)")}:
                db.execute("ALTER TABLE experiments ADD COLUMN lab_data TEXT NOT NULL DEFAULT '{}'")
            if "hidden" not in {row["name"] for row in db.execute("PRAGMA table_info(condition_options)")}:
                db.execute("ALTER TABLE condition_options ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1))")
            for field in CONDITION_FIELDS:
                if field in CONDITION_LIST_ERRORS:
                    for row in db.execute(f"SELECT {field}, {field}s FROM experiments"):
                        values = json.loads(row[1]) if row[1] is not None else ([row[0]] if row[0] else [])
                        db.executemany("INSERT OR IGNORE INTO condition_options(field,name) VALUES (?,?)", ((field, value) for value in values))
                elif field in NUMERIC_CONDITIONS:
                    db.executemany("INSERT OR IGNORE INTO condition_options(field,name) VALUES (?,?)", ((field, format(row[field], ".15g")) for row in db.execute(f"SELECT DISTINCT {field} FROM experiments WHERE {field} IS NOT NULL")))
                else:
                    db.execute(f"INSERT OR IGNORE INTO condition_options(field,name) SELECT ?, {field} FROM experiments WHERE {field}<>''", (field,))
            db.executescript("""
                CREATE TABLE IF NOT EXISTS template_versions (
                    project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL,
                    definition TEXT NOT NULL, PRIMARY KEY(project_id, revision)
                );
                CREATE TABLE IF NOT EXISTS experiment_defaults (
                    project_id TEXT NOT NULL REFERENCES projects(id), experiment_key TEXT NOT NULL,
                    settings TEXT NOT NULL, PRIMARY KEY(project_id, experiment_key)
                );
                CREATE TABLE IF NOT EXISTS folder_import_receipts (
                    id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id)
                );
                CREATE TABLE IF NOT EXISTS review_sources (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, sha256 TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS record_sources (
                    record_id TEXT NOT NULL REFERENCES experiments(id), source_id TEXT NOT NULL REFERENCES review_sources(id),
                    page TEXT NOT NULL, caption TEXT NOT NULL, PRIMARY KEY(record_id, source_id)
                );
                CREATE TABLE IF NOT EXISTS review_items (
                    id TEXT PRIMARY KEY, record_id TEXT REFERENCES experiments(id), project_id TEXT NOT NULL REFERENCES projects(id),
                    experiment_no TEXT NOT NULL, kind TEXT NOT NULL, field TEXT NOT NULL, title TEXT NOT NULL,
                    sources TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', resolution TEXT NOT NULL DEFAULT '',
                    revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1)), missing TEXT, coverage TEXT
                );
                CREATE TABLE IF NOT EXISTS history_batches (
                    id TEXT PRIMARY KEY, action TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
                    review_id TEXT REFERENCES review_items(id), review_revision INTEGER
                );
                CREATE TABLE IF NOT EXISTS history_entries (
                    batch_id TEXT NOT NULL REFERENCES history_batches(id), record_id TEXT NOT NULL REFERENCES experiments(id),
                    before_state TEXT, after_state TEXT NOT NULL, after_revision INTEGER NOT NULL,
                    reverted_by TEXT REFERENCES history_batches(id), PRIMARY KEY(batch_id, record_id)
                );
                CREATE INDEX IF NOT EXISTS history_record ON history_entries(record_id);
            """)
            rebuild_files = self.has_legacy_file_constraint(db)
            if rebuild_files:
                db.execute("PRAGMA foreign_keys=OFF")
            db.execute("BEGIN IMMEDIATE")
            if rebuild_files:
                # Preserve rowids used to order attachments with the same deletion time.
                columns = "rowid," + ",".join(row["name"] for row in db.execute("PRAGMA table_info(files)"))
                db.execute(files_schema.replace("files (", "files_v2 (", 1))
                db.execute(f"INSERT INTO files_v2 ({columns}) SELECT {columns} FROM files")
                db.execute("DROP TABLE files")
                db.execute("ALTER TABLE files_v2 RENAME TO files")
                if db.execute("PRAGMA foreign_key_check").fetchone():
                    raise RuntimeError("Attachment migration failed its reference check")
            db.execute("""CREATE UNIQUE INDEX IF NOT EXISTS files_active_name
                          ON files(experiment_id, name, kind) WHERE deleted_at IS NULL""")
            db.execute("""CREATE TABLE IF NOT EXISTS file_events (
                id TEXT PRIMARY KEY, file_id TEXT NOT NULL, record_id TEXT NOT NULL, action TEXT NOT NULL,
                before TEXT, after TEXT, created_at TEXT NOT NULL
            )""")
            review_columns = {row["name"] for row in db.execute("PRAGMA table_info(review_items)")}
            if "automatic" not in review_columns:
                db.execute("ALTER TABLE review_items ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1))")
            if "missing" not in review_columns:
                db.execute("ALTER TABLE review_items ADD COLUMN missing TEXT")
            if "coverage" not in review_columns:
                db.execute("ALTER TABLE review_items ADD COLUMN coverage TEXT")
            db.execute("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            db.execute("INSERT OR IGNORE INTO app_settings VALUES ('catalog_id', ?)", (json.dumps(uuid.uuid4().hex),))
            self.grouping_prefixes = frozenset(self.setting(db, "accepted_notebook_prefixes", []))
            db.execute("""CREATE TABLE IF NOT EXISTS project_settings (
                project_id TEXT PRIMARY KEY REFERENCES projects(id), settings TEXT NOT NULL, revision INTEGER NOT NULL
            )""")
            if version < 4:
                self.migrate_shared_defaults(db)
            db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            if rebuild_files:
                db.commit()
                db.execute("PRAGMA foreign_keys=ON")
        self.local_catalog()

    @staticmethod
    def has_legacy_file_constraint(db):
        return db.execute("SELECT 1 FROM pragma_index_list('files') WHERE origin='u'").fetchone() is not None

    def check_schema_version(self):
        """Refuse catalogs from newer programs and snapshot databases before migration."""
        if not self.db.exists():
            return
        source = sqlite3.connect(self.db, timeout=15)
        try:
            version = source.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise CatalogUnavailable(
                    f"此实验库由更新版本的程序创建（结构版本 {version}，本程序支持 {SCHEMA_VERSION}）。请使用新版程序打开，未做任何修改。\n"
                    f"This catalog was written by a newer program (schema {version}; this program supports {SCHEMA_VERSION}). "
                    "Open it with the newer program. Nothing was changed.")
            populated = source.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='experiments'").fetchone()
            if populated and (version < SCHEMA_VERSION or self.has_legacy_file_constraint(source)):
                folder = self.data / "migration-backups"
                folder.mkdir(exist_ok=True)
                stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                target = sqlite3.connect(folder / f"experiments-schema{version}-{stamp}.sqlite3")
                try:
                    source.backup(target)
                finally:
                    target.close()
        finally:
            source.close()

    def local_catalog_bytes(self):
        with self.lock:
            try:
                return (self.data / LOCAL_CATALOG).read_bytes()
            except FileNotFoundError:
                return None

    def local_catalog(self):
        with self.lock:
            self.recover_local_catalog()
            try:
                data = self.local_catalog_bytes()
            except OSError:
                return self._catalog_data
            self.refresh_local_catalog(data)
            return self._catalog_data

    def recover_local_catalog(self):
        with self.connect() as db:
            pending = db.execute("SELECT value FROM app_settings WHERE key='pending_local_catalog'").fetchone()
            if pending is not None:
                path = self.data / LOCAL_CATALOG
                with prepare_file_replacement(path, pending["value"]) as part:
                    self.publish_local_catalog(db, path, part)
                self.grouping_prefixes = frozenset(self.setting(db, "accepted_notebook_prefixes", []))
                self._catalog_revision = None

    @staticmethod
    def publish_local_catalog(db, path, part):
        os.replace(part, path)
        db.execute("DELETE FROM app_settings WHERE key='pending_local_catalog'")

    def migrate_shared_defaults(self, db):
        try:
            local = decode_local_catalog(self.local_catalog_bytes())
        except OSError:
            local = None
        if local is not None:
            prefixes = frozenset(item.upper() for item in catalog_prefixes(local.get("notebook_prefixes")))
            try:
                self.remap_shared_defaults(db, prefixes, legacy=True)
            except Problem:
                pass
            else:
                self.write_setting(db, "accepted_notebook_prefixes", sorted(prefixes))
                self.grouping_prefixes = prefixes
                return
        self.remap_shared_defaults(db, self.grouping_prefixes, legacy=True)

    def refresh_local_catalog(self, data, *, retry_conflict=False):
        revision = local_catalog_revision(data)
        if revision == self._catalog_revision and not (retry_conflict and self._catalog_error.get("error_kind") == "prefix_conflict"):
            return
        local = decode_local_catalog(data)
        if local is None:
            self._catalog_error = {"error": UNPARSABLE_LOCAL_CATALOG, "error_kind": "unparsable"}
        else:
            prefixes = frozenset(item.upper() for item in catalog_prefixes(local.get("notebook_prefixes")))
            try:
                with self.connect() as db:
                    db.execute("BEGIN IMMEDIATE")
                    self.apply_notebook_prefixes(db, prefixes)
            except Problem as conflict:
                self._catalog_error = {"error": str(conflict), "error_kind": "prefix_conflict"}
            else:
                self.grouping_prefixes = prefixes
                self._catalog_error = {}
            self._catalog_data = local
        self._catalog_revision = revision

    def apply_notebook_prefixes(self, db, prefixes):
        if prefixes != self.grouping_prefixes:
            self.remap_shared_defaults(db, prefixes)
        self.write_setting(db, "accepted_notebook_prefixes", sorted(prefixes))

    def remap_shared_defaults(self, db, prefixes, *, legacy=False):
        stored = {(row["project_id"], row["experiment_key"]): json.loads(row["settings"]) for row in db.execute(
            "SELECT project_id, experiment_key, settings FROM experiment_defaults ORDER BY project_id, experiment_key")}
        if not stored:
            return
        source_prefixes = self.grouping_prefixes
        if legacy:
            # Legacy catalogs used the file's prefixes before tracking accepted prefixes in the database.
            source_prefixes = frozenset(self.setting(db, "accepted_notebook_prefixes", prefixes))
        destinations, members = {}, {}
        for row in db.execute("SELECT id, project_id, experiment_no, sample_id, notes, series FROM experiments"):
            if is_dataset(row):
                continue
            project = row["project_id"]
            source = (project, record_experiment_key(row, source_prefixes))
            target = (project, record_experiment_key(row, prefixes))
            members.setdefault(target, set()).add(row["id"])
            destinations.setdefault(source, set()).add(target)

        rewritten = {}
        conflicts = set()
        for (project, key), state in stored.items():
            source = (project, experiment_key(key, source_prefixes))
            targets = set(destinations.get(source, ()))
            if legacy and not targets and source_prefixes == prefixes:
                # Opening the same grouping preserves saved rows even when no samples remain.
                targets.add(source)
            origins = {}
            origin_keys = () if legacy else state.get("origin_keys", ())
            for origin in origin_keys:
                target = (project, experiment_key(origin, prefixes))
                targets.add(target)
                origins.setdefault(target, []).append(origin)
            for target in sorted(targets):
                merged = rewritten.setdefault(target, {**state, "overrides": {}, "origin_keys": []})
                if merged["conditions"] != state["conditions"]:
                    conflicts.add(target[1].upper())
                if not merged["last_save"]:
                    merged["last_save"] = state["last_save"]
                merged["origin_keys"] = sorted(set(merged["origin_keys"]).union(origins.get(target, ())))
                for sample in sorted(members.get(target, set()) & state["overrides"].keys()):
                    overrides = merged["overrides"]
                    overrides[sample] = sorted(set(overrides.get(sample, ())).union(state["overrides"][sample]))
        if conflicts:
            experiments = "、".join(sorted(conflicts)[:10])
            raise Problem(f"以下实验在新的编号前缀下会合并，但共用条件不一致：{experiments}。"
                          "请先统一这些实验的共用条件，再修改前缀。", 409)

        db.executemany("DELETE FROM experiment_defaults WHERE project_id=? AND experiment_key=?",
                       stored.keys() - rewritten.keys())
        for (project, key), state in rewritten.items():
            if state != stored.get((project, key)):
                self.write_shared_defaults(db, project, key, state)

    def local_translations(self, local=None):
        value = (self.local_catalog() if local is None else local).get("translations")
        return value if isinstance(value, dict) else {}

    def conventions(self, local=None):
        """Optional display conventions for the page; invalid legacy entries are dropped."""
        if local is None:
            local = self.local_catalog()
        aliases = []
        for entry in local.get("precursor_aliases", []) if isinstance(local.get("precursor_aliases"), list) else []:
            if isinstance(entry, dict) and isinstance(entry.get("label"), str) and entry["label"].strip(JS_WHITESPACE):
                names = entry.get("aliases") if isinstance(entry.get("aliases"), list) else []
                aliases.append({"label": entry["label"].strip(JS_WHITESPACE)[:250],
                                "aliases": [name.strip(JS_WHITESPACE)[:250] for name in names
                                            if isinstance(name, str) and name.strip(JS_WHITESPACE)][:50]})
        presets = local.get("phase_presets") if isinstance(local.get("phase_presets"), dict) else {}
        phases = {}
        for project, tags in presets.items():
            if isinstance(tags, list):
                unique = {}
                for tag in tags:
                    if isinstance(tag, str):
                        tag = tag.strip()[:80]
                        if tag and valid_settings_text(tag, 80):
                            unique.setdefault(tag.casefold(), tag)
                phases[project] = list(unique.values())[:20]
        return {"precursor_aliases": aliases[:200], "phase_presets": phases, "notebook_prefixes": sorted(self.grouping_prefixes)}

    def notebook_prefixes(self):
        with self.lock:
            self.local_catalog()
            return sorted(self.grouping_prefixes)

    def get_local_catalog(self):
        with self.lock:
            self.recover_local_catalog()
            self.refresh_local_catalog(self.local_catalog_bytes(), retry_conflict=True)
            revision, error = self._catalog_revision, self._catalog_error
            local = {} if error.get("error_kind") == "unparsable" else self._catalog_data
            active_prefixes = sorted(self.grouping_prefixes)
        prefixes = local.get("notebook_prefixes")
        aliases = []
        for entry in local.get("precursor_aliases", []) if isinstance(local.get("precursor_aliases"), list) else []:
            if isinstance(entry, dict) and catalog_text(entry.get("label")):
                names = entry.get("aliases")
                aliases.append({"label": entry["label"], "aliases": [name for name in names if catalog_text(name)]
                                if isinstance(names, list) else []})
        translations = self.local_translations(local)
        maps = {}
        for key in CATALOG_TRANSLATION_MAPS:
            mapping = translations.get(key)
            maps[key] = {name: value for name, value in mapping.items() if catalog_text(name) and catalog_text(value)} if isinstance(mapping, dict) else {}
        rules = translations.get("noteRules")
        maps["noteRules"] = [{"pattern": rule["pattern"], "replacement": rule["replacement"], "flags": rule.get("flags", "")}
                             for rule in rules if isinstance(rule, dict) and catalog_text(rule.get("pattern"))
                             and catalog_text(rule.get("replacement")) and catalog_text(rule.get("flags", ""))] if isinstance(rules, list) else []
        catalog = {"notebook_prefixes": [prefix for prefix in prefixes if catalog_text(prefix)] if isinstance(prefixes, list) else [],
                   "precursor_aliases": aliases, "translations": maps}
        return {"catalog": catalog, "revision": revision, "active_prefixes": active_prefixes, **error}

    def save_local_catalog(self, payload):
        if not isinstance(payload, dict) or not isinstance(payload.get("revision"), str):
            raise Problem("本地约定格式不正确：需提供版本号。")
        with self.lock:
            self.recover_local_catalog()
            data = self.local_catalog_bytes()
            local = decode_local_catalog(data)
            if local is None:
                raise Problem(UNPARSABLE_LOCAL_CATALOG, 409)
            if payload["revision"] != local_catalog_revision(data):
                raise Problem(STALE_LOCAL_CATALOG, 409)
            catalog = validate_local_catalog(payload.get("catalog"))
            prefixes = frozenset(item.upper() for item in catalog["notebook_prefixes"])
            updated = {**local, **catalog}
            content = (json.dumps(updated, ensure_ascii=False, indent=2) + "\n").encode("utf-8", errors="backslashreplace")

            path = self.data / LOCAL_CATALOG
            publication = {}
            with prepare_file_replacement(path, content) as part, self.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                self.apply_notebook_prefixes(db, prefixes)
                db.execute("INSERT INTO app_settings VALUES ('pending_local_catalog', ?)", (content,))
                if self.local_catalog_bytes() != data:
                    raise Problem(STALE_LOCAL_CATALOG, 409)
                db.commit()
                self.grouping_prefixes = prefixes
                try:
                    self.publish_local_catalog(db, path, part)
                except OSError:
                    publication["publication_pending"] = True
            self._catalog_data = updated
            self._catalog_revision = local_catalog_revision(content)
            self._catalog_error = {}
            return {"catalog": catalog, "revision": self._catalog_revision, "active_prefixes": sorted(prefixes), **publication}

    def setting(self, db, key, default=None):
        row = db.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def put_setting(self, key, value):
        with self.lock, self.connect() as db:
            self.write_setting(db, key, value)

    def write_setting(self, db, key, value):
        db.execute("INSERT INTO app_settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                   (key, json.dumps(value, ensure_ascii=False)))

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.db, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def list(self):
        # shortcut: load the local notebook in one request; add pagination for tens of thousands of records.
        with self.connect() as db:
            db.execute("BEGIN")
            records = [dict(row) for row in db.execute(
                "SELECT experiments.*, projects.name AS project_name FROM experiments JOIN projects ON projects.id=project_id "
                "ORDER BY updated_at DESC, sample_id COLLATE NOCASE")]
            attachments = {}
            for row in db.execute("SELECT * FROM files WHERE deleted_at IS NULL ORDER BY created_at, name"):
                attachments.setdefault(row["experiment_id"], []).append({key: row[key] for key in FILE_FIELDS})
            templates = {}
            for row in db.execute("SELECT * FROM template_versions ORDER BY revision"):
                template = {**json.loads(row["definition"]), "revision": row["revision"]}
                templates[row["project_id"], row["revision"]] = template
        for record in records:
            record["experiment_no"] = record["experiment_no"] or experiment_number(record["sample_id"])
            record["extra_conditions"] = json.loads(record["extra_conditions"])
            if record["precursors"] is not None:
                record["precursors"] = record_precursors(record)
            else:
                del record["precursors"]
            record["solvents"] = json.loads(record["solvents"]) if record["solvents"] is not None else ([record["solvent"]] if record["solvent"] else [])
            record["material_amounts"] = json.loads(record["material_amounts"])
            record["files"] = attachments.get(record["id"], [])
            active_ids = {file["id"] for file in record["files"]}
            result = validate_result_summary(json.loads(record["result_summary"]))
            result["evidence_ids"] = [file_id for file_id in result["evidence_ids"] if file_id in active_ids]
            record["result_summary"] = result
            record["archived"] = bool(record["archived"])
            details = json.loads(record.pop("lab_data"))
            if details:
                record["lab_data"] = details
            template = templates.get((record["project_id"], details.get("template_revision")))
            if template and not is_dataset(record):
                record["template"] = template
        return records

    def catalog(self):
        with self.connect() as db:
            return {"projects": [dict(row) for row in db.execute("SELECT * FROM projects ORDER BY rowid")],
                    "kinds": [row["name"] for row in db.execute("SELECT name FROM categories ORDER BY rowid")],
                    "templates": {row["project_id"]: {**json.loads(row["definition"]), "revision": row["revision"]}
                                  for row in db.execute("SELECT * FROM template_versions ORDER BY revision")},
                    "condition_options": {field: [row["name"] for row in db.execute("SELECT name FROM condition_options WHERE field=? AND hidden=0 ORDER BY name", (field,))] for field in CONDITION_FIELDS}}

    def shared_group(self, db, project_id, number):
        prefixes = self.grouping_prefixes
        key = experiment_key(number, prefixes)
        members = [row for row in db.execute("SELECT * FROM experiments WHERE project_id=? AND archived=0 ORDER BY id", (project_id,))
                   if record_experiment_key(row, prefixes) == key and not is_dataset(row)]
        state = self.read_shared_defaults(db, project_id, key)
        conditions = dict((state or EMPTY_SHARED_STATE)["conditions"])
        if conditions.keys() != EMPTY_SHARED_CONDITIONS.keys():
            recorded = [shared_values(row) for row in members]
            for field, empty in EMPTY_SHARED_CONDITIONS.items():
                if field in conditions:
                    continue
                known = [values[field] for values in recorded if values[field] != empty]
                conditions[field] = known[0] if known and all(value == known[0] for value in known) else empty
        snapshot = [project_id, key, state, [(row["id"], row["revision"]) for row in members]]
        token = hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode("utf-8")).hexdigest()
        return members, state, conditions, token

    def shared_defaults(self, project_id, number):
        project_id, number = lab_text(project_id, 120, required=True), lab_text(number, 120, required=True)
        with self.lock, self.connect() as db:
            self.local_catalog()
            db.execute("BEGIN")
            members, state, conditions, token = self.shared_group(db, project_id, number)
        last_save = (state or EMPTY_SHARED_STATE)["last_save"]
        return {"conditions": conditions, "token": token, "count": len(members), "last_save": last_save}

    def apply_shared_conditions(self, db, group, project_id, number, record_id, clean, now, disabled):
        members, state, previous, token = group
        submitted = {field: value for field, value in shared_values(clean).items()
                     if ("precursor" if field == "precursors" else field) not in disabled}
        if not submitted:
            return {}
        state = state or EMPTY_SHARED_STATE
        stored = state["conditions"]
        first_setup = not state["last_save"]
        overrides = state["overrides"]
        active_ids = {record_id, *(row["id"] for row in members)}
        kept = {sample: [field for field in fields if sample not in active_ids or field not in submitted]
                for sample, fields in overrides.items()}
        before = {}
        for row in members:
            if row["id"] == record_id:
                continue
            fixed = overrides.get(row["id"], [])
            values = shared_values(row)
            patch = {}
            for field, new in submitted.items():
                value = values[field]
                follows = value == previous[field] or ((first_setup or field not in stored)
                                                       and value == EMPTY_SHARED_CONDITIONS[field])
                if field in fixed or not follows:
                    kept.setdefault(row["id"], []).append(field)
                elif value != new:
                    patch[field] = new
            if patch:
                columns = shared_columns(patch)
                before[row["id"]] = row
                db.execute("UPDATE experiments SET " + ",".join(key + "=?" for key in columns) + ",revision=revision+1,updated_at=? WHERE id=?",
                           (*columns.values(), now, row["id"]))
        self.write_shared_defaults(db, project_id, experiment_key(number, self.grouping_prefixes), {
            "conditions": {**stored, **submitted},
            "overrides": {sample: sorted(fields) for sample, fields in kept.items() if fields},
            "last_save": f"{token}:{record_id}",
            "origin_keys": state["origin_keys"] or [experiment_key(number, ())],
        })
        return before

    def read_shared_defaults(self, db, project_id, key):
        row = db.execute("SELECT settings FROM experiment_defaults WHERE project_id=? AND experiment_key=?",
                         (project_id, key)).fetchone()
        return json.loads(row["settings"]) if row else None

    def write_shared_defaults(self, db, project_id, key, values):
        db.execute("""INSERT INTO experiment_defaults VALUES (?,?,?)
                      ON CONFLICT(project_id, experiment_key) DO UPDATE SET settings=excluded.settings""",
                   (project_id, key, json.dumps(values, ensure_ascii=False)))

    def move_shared_override(self, db, current, clean):
        prefixes = self.grouping_prefixes
        source = (current["project_id"], record_experiment_key(current, prefixes)) if not is_dataset(current) else None
        target = (clean["project_id"], record_experiment_key(clean, prefixes)) if not is_dataset(clean) else None
        if source == target:
            return None
        record_id = current["id"]
        state = self.read_shared_defaults(db, *source) if source else None
        if state is not None and state["overrides"].pop(record_id, None) is not None:
            self.write_shared_defaults(db, *source, state)
        other = self.read_shared_defaults(db, *target) if target else None
        if other is not None:
            values = shared_values(clean)
            fixed = sorted(field for field, value in other["conditions"].items() if values[field] != value)
            overrides = other["overrides"]
            if fixed != overrides.get(record_id, []):
                if fixed:
                    overrides[record_id] = fixed
                else:
                    overrides.pop(record_id, None)
                self.write_shared_defaults(db, *target, other)
        return other

    def remember_shared_baseline(self, db, group, record_id, current, clean):
        members, state, previous, _ = group
        if not members or (current and len(members) == 1 and members[0]["id"] == record_id and not state):
            return
        key = experiment_key(clean["experiment_no"], self.grouping_prefixes)
        state = state or EMPTY_SHARED_STATE
        baseline, overrides = dict(state["conditions"]), dict(state["overrides"])
        values = shared_values(clean)
        old = shared_values(current) if current else {}
        previous_fixed = set(overrides.get(record_id, []))
        fixed = previous_fixed.copy()
        for field, value in values.items():
            if current and value == old[field]:
                continue
            if value == previous[field]:
                fixed.discard(field)
            elif previous[field] != EMPTY_SHARED_CONDITIONS[field]:
                if field not in state["conditions"]:
                    baseline[field] = previous[field]
                if value == EMPTY_SHARED_CONDITIONS[field]:
                    fixed.add(field)
        if fixed != previous_fixed:
            if fixed:
                overrides[record_id] = sorted(fixed)
            else:
                overrides.pop(record_id, None)
        updated = {**state, "conditions": baseline, "overrides": overrides}
        if updated != state:
            if state is EMPTY_SHARED_STATE:
                updated["origin_keys"] = [record_experiment_key(clean, ())]
            self.write_shared_defaults(db, clean["project_id"], key, updated)

    def project_template(self, db, project_id, revision=0):
        if revision:
            row = db.execute("SELECT * FROM template_versions WHERE project_id=? AND revision=?", (project_id, revision)).fetchone()
        else:
            row = db.execute("SELECT * FROM template_versions WHERE project_id=? ORDER BY revision DESC LIMIT 1", (project_id,)).fetchone()
        return {**json.loads(row["definition"]), "revision": row["revision"]} if row else None

    def save_template(self, payload):
        definition = validate_template(payload)
        project_id, revision = payload.get("project_id"), payload.get("revision")
        if not isinstance(project_id, str) or type(revision) is not int or revision < 0:
            raise Problem("请选择项目并刷新模板后重试。")
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise Problem("请选择项目并刷新模板后重试。")
            current = self.project_template(db, project_id)
            if revision != (current["revision"] if current else 0):
                raise Problem("模板已更新，请重新打开后核对。", 409)
            if current == {**definition, "revision": revision}:
                return current
            db.execute("INSERT INTO template_versions VALUES (?,?,?)", (project_id, revision + 1, json.dumps(definition, ensure_ascii=False)))
        return {**definition, "revision": revision + 1}

    def project_settings(self, db, project_id, legacy_phases=()):
        row = db.execute("SELECT settings, revision FROM project_settings WHERE project_id=?", (project_id,)).fetchone()
        settings, revision = (json.loads(row["settings"]), row["revision"]) if row else (
            validate_project_settings({"phase_presets": list(legacy_phases)}, None), 0)
        return project_settings_info(settings, revision, self.project_template(db, project_id))

    def project_settings_map(self, db, legacy_phases):
        return {row["id"]: self.project_settings(db, row["id"], legacy_phases.get(row["id"], []))
                for row in db.execute("SELECT id FROM projects ORDER BY rowid")}

    def get_project_settings(self, project_id):
        with self.lock, self.connect() as db:
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise Problem("找不到该项目。", 404)
            return self.project_settings(db, project_id, self.conventions()["phase_presets"].get(project_id, []))

    def save_project_settings(self, project_id, payload):
        if not isinstance(payload, dict) or type(payload.get("revision")) is not int or payload["revision"] < 0:
            raise Problem("项目设置格式不正确。")
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise Problem("找不到该项目。", 404)
            row = db.execute("SELECT revision FROM project_settings WHERE project_id=?", (project_id,)).fetchone()
            revision = row["revision"] if row else 0
            if payload["revision"] != revision:
                raise Problem("项目设置已在其他窗口修改，请刷新后再保存。", 409)
            template = self.project_template(db, project_id)
            settings = validate_project_settings(payload.get("settings"), template)
            revision += 1
            db.execute("""INSERT INTO project_settings VALUES (?,?,?)
                          ON CONFLICT(project_id) DO UPDATE SET settings=excluded.settings, revision=excluded.revision""",
                       (project_id, json.dumps(settings, ensure_ascii=False), revision))
            return project_settings_info(settings, revision, template)

    def check_required_fields(self, db, project_id, details, status):
        if status != STATUSES[-1] or not details.get("template_revision"):
            return
        template = self.project_template(db, project_id, details["template_revision"])
        missing = missing_template_fields(template, details, "condition") + missing_template_fields(template, details, "result")
        if missing:
            raise Problem("标记已完成前请填写必填字段：" + "、".join(field["label"] for field in missing))

    def validate_lab_data(self, db, project_id, record_id, details, status, dataset=False):
        if not isinstance(details, dict) or set(details) - {"template_revision", "values", "parent_id", "treatment", "outcome"}:
            raise Problem("模板或样品扩展字段格式不正确。")
        revision = details.get("template_revision", 0)
        values = details.get("values", {})
        if type(revision) is not int or revision < 0 or revision > 2**31 - 1 or not isinstance(values, dict):
            raise Problem("模板或样品扩展字段格式不正确。")
        template = self.project_template(db, project_id, revision) if revision else None
        if revision and not template:
            raise Problem("此项目找不到所选模板版本。", 409)
        fields = {field["key"]: field for field in template["fields"]} if template else {}
        if set(values) - set(fields):
            raise Problem("字段与所选模板版本不匹配。", 409)
        clean = {key: validate_template_value(fields[key], value) for key, value in values.items()}
        parent_id = lab_text(details.get("parent_id", ""), 32)
        treatment = lab_text(details.get("treatment", ""), 250)
        outcome = details.get("outcome", "")
        if outcome not in OUTCOMES or (dataset and (parent_id or treatment)):
            raise Problem("模板或样品扩展字段格式不正确。")
        seen, parent = {record_id}, parent_id
        while parent:
            if parent in seen:
                raise Problem("样品来源不能形成循环。", 409)
            row = db.execute("SELECT * FROM experiments WHERE id=?", (parent,)).fetchone()
            if not row or row["project_id"] != project_id or is_dataset(row):
                raise Problem("请从同一项目选择有效的来源样品。", 409)
            seen.add(parent)
            parent = json.loads(row["lab_data"]).get("parent_id", "")
        result = {key: value for key, value in dict(template_revision=revision, values=clean,
                   parent_id=parent_id, treatment=treatment, outcome=outcome).items() if value}
        self.check_required_fields(db, project_id, result, status)
        return result

    def check_child_links(self, db, record_id, project_id, dataset=False):
        for row in db.execute("SELECT project_id, lab_data FROM experiments WHERE lab_data<>'{}'"):
            if json.loads(row["lab_data"]).get("parent_id") == record_id and (dataset or row["project_id"] != project_id):
                raise Problem("此样品仍有关联的派生样品。请先解除关联。", 409)

    def log_history(self, db, before_rows, action, source="app", batch_id=None, created_at=None, review_id=None, review_revision=None):
        entries = []
        for record_id, before in before_rows.items():
            row = db.execute("SELECT * FROM experiments WHERE id=?", (record_id,)).fetchone()
            old, new = history_state(before), history_state(row)
            # The only field change being undone may have been an evidence link already removed by purge.
            if old != new or action == "undo":
                entries.append((record_id, json.dumps(old, ensure_ascii=False) if old is not None else None,
                                json.dumps(new, ensure_ascii=False), row["revision"]))
        if not entries:
            return None
        batch_id = batch_id or uuid.uuid4().hex
        db.execute("INSERT INTO history_batches VALUES (?,?,?,?,?,?)", (batch_id, action, source, created_at or timestamp(), review_id, review_revision))
        db.executemany("INSERT INTO history_entries(batch_id,record_id,before_state,after_state,after_revision) VALUES (?,?,?,?,?)",
                       ((batch_id, *entry) for entry in entries))
        return batch_id

    def history(self, record_id="", project_id="", offset=0):
        if type(offset) is not int or not 0 <= offset <= 1000000:
            raise Problem("历史记录分页不正确。")
        with self.connect() as db:
            db.execute("BEGIN")
            rows = db.execute("""SELECT b.*, count(e.record_id) AS count,
                sum(CASE WHEN e.reverted_by IS NULL THEN 1 ELSE 0 END) AS remaining
                FROM history_batches b JOIN history_entries e ON e.batch_id=b.id
                WHERE EXISTS (SELECT 1 FROM history_entries f JOIN experiments r ON r.id=f.record_id
                              WHERE f.batch_id=b.id AND (?='' OR f.record_id=?) AND (?='' OR r.project_id=?))
                GROUP BY b.id ORDER BY b.rowid DESC LIMIT 51 OFFSET ?""",
                              (record_id, record_id, project_id, project_id, offset)).fetchall()
            events = []
            for row in db.execute("""SELECT e.*, r.sample_id FROM file_events e JOIN experiments r ON r.id=e.record_id
                WHERE (?='' OR e.record_id=? OR e.action='move') AND (?='' OR r.project_id=?)
                ORDER BY e.rowid DESC""", (record_id, record_id, project_id, project_id)):
                event = dict(row)
                for field in ("before", "after"):
                    event[field] = json.loads(event[field]) if event[field] else None
                if record_id and event["record_id"] != record_id and event["after"]["record_id"] != record_id:
                    continue
                events.append(event)
                if len(events) == 200:
                    break
        return {"batches": [dict(row) for row in rows[:50]], "has_more": len(rows) > 50, "file_events": events}

    def history_detail(self, batch_id):
        with self.connect() as db:
            batch = db.execute("SELECT * FROM history_batches WHERE id=?", (batch_id,)).fetchone()
            if not batch:
                raise Problem("找不到这次修改。", 404)
            rows = []
            for entry in db.execute("SELECT * FROM history_entries WHERE batch_id=? ORDER BY rowid", (batch_id,)):
                before = json.loads(entry["before_state"]) if entry["before_state"] else None
                after = json.loads(entry["after_state"])
                current = db.execute("SELECT revision FROM experiments WHERE id=?", (entry["record_id"],)).fetchone()
                rows.append({"id": entry["record_id"], "sample_id": after["sample_id"], "project_id": after["project_id"],
                             "revision": current["revision"], "reverted_by": entry["reverted_by"], "changes": history_changes(before, after)})
        return {**dict(batch), "rows": rows}

    def validate_restored(self, db, state, record_id):
        payload = decoded_state(state)
        for key in ("precursors", "solvents"):
            if payload[key] is None:
                del payload[key]
        validate(payload)
        if not db.execute("SELECT 1 FROM projects WHERE id=?", (state["project_id"],)).fetchone():
            raise Problem("原项目已不存在，无法恢复这次修改。", 409)
        self.validate_lab_data(db, state["project_id"], record_id, payload["lab_data"], state["status"], is_dataset(state))
        self.check_child_links(db, record_id, state["project_id"], is_dataset(state))

    def undo_history(self, batch_id, payload):
        if not isinstance(payload, dict) or type(payload.get("preview")) is not bool:
            raise Problem("撤销请求不正确。")
        selected = payload.get("record_ids")
        if selected is not None and (not isinstance(selected, list) or not 1 <= len(selected) <= 500 or
                                     any(not isinstance(value, str) for value in selected) or len(set(selected)) != len(selected)):
            raise Problem("撤销请求不正确。")
        preview = payload["preview"]
        rows, updates = [], []
        try:
            with self.lock, self.connect() as db:
                if not preview:
                    self.local_catalog()
                db.execute("BEGIN" if preview else "BEGIN IMMEDIATE")
                batch = db.execute("SELECT * FROM history_batches WHERE id=?", (batch_id,)).fetchone()
                if not batch or batch["action"] in {"create", "undo"}:
                    raise Problem("这次操作不支持撤销。", 409)
                entries = db.execute("SELECT * FROM history_entries WHERE batch_id=? AND reverted_by IS NULL ORDER BY rowid", (batch_id,)).fetchall()
                if selected is not None:
                    entries = [entry for entry in entries if entry["record_id"] in selected]
                ids = {entry["record_id"] for entry in entries}
                if not entries or (selected is not None and ids != set(selected)):
                    raise Problem("这次修改已撤销，请刷新历史记录。", 409)
                revisions = payload.get("revisions", [])
                if not preview and (not isinstance(revisions, list) or len(revisions) != len(ids) or
                                    any(not isinstance(item, dict) or not isinstance(item.get("id"), str) or type(item.get("revision")) is not int for item in revisions) or
                                    {item["id"] for item in revisions} != ids):
                    raise Problem("请先预览撤销内容。")
                versions = {item["id"]: item["revision"] for item in revisions} if not preview else {}
                file_ids = {row["id"] for row in db.execute("SELECT id FROM files")}
                for entry in entries:
                    before, after = history_state(json.loads(entry["before_state"])), history_state(json.loads(entry["after_state"]))
                    current = db.execute("SELECT * FROM experiments WHERE id=?", (entry["record_id"],)).fetchone()
                    state = history_state(current)
                    if before["result_summary"] != after["result_summary"]:
                        for version in (before, after, state):
                            result = validate_result_summary(json.loads(version["result_summary"]))
                            result["evidence_ids"] = [file_id for file_id in result["evidence_ids"] if file_id in file_ids]
                            version["result_summary"] = json.dumps(result, ensure_ascii=False)
                    changed = {key: before[key] for key in HISTORY_FIELDS if key != "lab_data" and before[key] != after[key]}
                    if changed.keys() & {"precursor", "precursors"}:
                        changed.update(precursor=before["precursor"], precursors=before["precursors"])
                    if (not preview and current["revision"] != versions[entry["record_id"]]) or any(state[key] != after[key] for key in changed):
                        raise Problem("相关字段已有后续修改，未撤销任何记录。请刷新后核对。", 409)
                    if before["lab_data"] != after["lab_data"]:
                        changed["lab_data"] = restore_lab_fields(before["lab_data"], after["lab_data"], current["lab_data"])
                    restored = {**state, **changed}
                    if restored["project_id"] != current["project_id"] and json.loads(restored["lab_data"]).get("template_revision"):
                        raise Problem("此样品使用当前项目的模板，无法撤销到其他项目。", 409)
                    try:
                        self.validate_restored(db, restored, entry["record_id"])
                    except Problem:
                        raise Problem("原值与当前数据约束冲突，未撤销任何记录。请手动核对。", 409)
                    rows.append({"id": entry["record_id"], "sample_id": current["sample_id"], "project_id": current["project_id"],
                                 "revision": current["revision"], "changes": history_changes(state, restored)})
                    updates.append((dict(current), changed))
                if batch["review_id"]:
                    review = db.execute("SELECT * FROM review_items WHERE id=?", (batch["review_id"],)).fetchone()
                    if review["revision"] != batch["review_revision"] or review["status"] != "resolved":
                        raise Problem("待核对项已有后续处理，请先手动核对。", 409)
                if not preview:
                    now = timestamp()
                    for current, changed in updates:
                        if changed:
                            if changed.keys() & {"experiment_no", "sample_id", "project_id", "notes", "series"}:
                                self.move_shared_override(db, current, {**current, **changed})
                            db.execute("UPDATE experiments SET " + ",".join(key + "=?" for key in changed) + ",revision=revision+1,updated_at=? WHERE id=?",
                                       (*changed.values(), now, current["id"]))
                    undo_id = self.log_history(db, {current["id"]: current for current, _ in updates}, "undo")
                    db.executemany("UPDATE history_entries SET reverted_by=? WHERE batch_id=? AND record_id=?", ((undo_id, batch_id, record_id) for record_id in ids))
                    if batch["review_id"]:
                        db.execute("UPDATE review_items SET status='pending',resolution='',missing=NULL,coverage=NULL,revision=revision+1,updated_at=? WHERE id=?",
                                   (now, batch["review_id"]))
        except sqlite3.IntegrityError:
            raise Problem("恢复原编号会产生重复，未撤销任何记录。", 409)
        result = {"preview": preview, "rows": rows, "updated": len(rows), "revisions": [{"id": row["id"], "revision": row["revision"]} for row in rows]}
        if not preview:
            result.update(records=[record for record in self.list() if record["id"] in ids], condition_options=self.catalog()["condition_options"])
        return result

    def review_list(self, *, include_coverage=False):
        with self.lock, self.connect() as db:
            records = self.list()
            settings = self.project_settings_map(db, {})
            sources = {}
            for row in db.execute("SELECT r.*,s.name FROM record_sources r JOIN review_sources s ON s.id=r.source_id"):
                sources.setdefault(row["record_id"], []).append({"label": row["name"] + " · p. " + row["page"], "source_id": row["source_id"], "value": row["caption"]})
            items = [dict(row) for row in db.execute("SELECT * FROM review_items ORDER BY created_at, rowid")]
        by_id = {row["id"]: row for row in records}
        stored_keys, closed_conditions, legacy_conditions = {}, {}, {}
        for item in items:
            item["sources"] = json.loads(item["sources"])
            stored_missing = item.pop("missing")
            coverage = item.pop("coverage")
            if stored_missing is not None:
                item["missing"] = json.loads(stored_missing)
            if item["automatic"] and item["field"].startswith("key:"):
                item["field"] = item["field"].lower()
                stored_keys.setdefault((item["record_id"], item["field"]), set()).add(item["id"])
            if item["automatic"] and item["kind"] == "missing_conditions":
                item.setdefault("missing", [])
                if item["status"] in ("resolved", "dismissed"):
                    if coverage is not None:
                        closed_conditions.setdefault(item["record_id"], set()).update(json.loads(coverage))
                    elif not item["field"]:
                        legacy_conditions.setdefault(item["record_id"], {})[item["id"]] = item
            record = by_id.get(item["record_id"])
            if not record and not item["record_id"] and item["kind"] != "folder_import":
                matches = [row for row in records if row["project_id"] == item["project_id"] and row["experiment_no"] == item["experiment_no"] and not is_dataset(row)]
                if len(matches) == 1:
                    record = matches[0]
                    item["record_id"] = record["id"]
            item.update(sample_id=record["sample_id"] if record else item["experiment_no"], record_revision=record["revision"] if record else None,
                        current=record.get(item["field"]) if record else None, generated=False)
            if record:
                item["sources"].extend(source for source in sources.get(record["id"], []) if source["source_id"] not in {entry.get("source_id") for entry in item["sources"]})
        for record in records:
            if record["archived"] or is_dataset(record):
                continue
            project = settings[record["project_id"]]
            details, template = record.get("lab_data", {}), record.get("template")
            issue_id = "conditions-" + record["id"]
            covered = closed_conditions.get(record["id"], set()).copy()
            if template:
                fields = [(f"template:{record['project_id']}:{template['revision']}:{field['key']}", field["label"])
                          for field in missing_template_fields(template, details, "condition")]
            else:
                missing = [field for field in ("precursor", "temperature", "duration") if record[field] is None or record[field] == ""]
                extra = {item["name"]: item["value"] for item in record["extra_conditions"]}
                if "temperature" in missing and extra.get("Temperature description", "").startswith("Room temperature"):
                    missing.remove("temperature")
                if not record_materials(record) and extra.get("Reaction medium") != "Solvent-free":
                    missing.append("materials")
                fields = [(field, field) for field in missing]
            legacy = legacy_conditions.get(record["id"])
            if legacy:
                # Legacy IDs hash labels, including enabled subsets of the four built-ins.
                candidates = [[label for _, label in fields]] if template and fields else []
                candidates.extend(names for size in range(1, len(PROJECT_BUILTINS) + 1)
                                  for names in combinations(PROJECT_BUILTINS, size))
                labels = set()
                for names in candidates:
                    old = legacy.get(review_fingerprint(issue_id, names))
                    if old is not None:
                        old["missing"] = old["missing"] or list(names)
                        labels.update(old["missing"])
                covered.update(identity for identity, label in fields if label in labels)
            remaining = [(identity, label) for identity, label in fields if identity not in covered]
            shown = [(identity, label) for identity, label in remaining
                     if template or project["settings"]["builtin"][identity]["enabled"]]
            base = {"record_id": record["id"], "project_id": record["project_id"], "experiment_no": record["experiment_no"],
                    "sample_id": record["sample_id"], "record_revision": record["revision"], "sources": sources.get(record["id"], []),
                    "status": "pending", "resolution": "", "generated": True, "field": "", "revision": 0}
            if shown:
                items.append({**base, "id": issue_id, "kind": "missing_conditions", "title": "缺少实验条件",
                              "missing": [label for _, label in shown], "coverage": [identity for identity, _ in shown],
                              "fingerprint_missing": [identity for identity, _ in remaining]})
            for info in project["fields"]:
                if (not info["available"] or not info["check_missing"] or info["id"] in covered
                        or (info["section"] == "result" and details.get("outcome") in OUTCOMES[1:4])):
                    continue
                _, value = resolve_key_field(template, details, info)
                if value is None:
                    field = info["id"]
                    items.append({**base, "id": issue_id + ":" + field, "field": field,
                                  "kind": "missing_conditions", "title": f"缺少关键字段：{info['label']}", "missing": [info["label"]],
                                  "coverage": [field], "fingerprint_missing": [info["label"].lower()]})
            usable = [file for file in record["files"] if not any(marker in file["name"] for marker in ("-empty-only.zip", "-missing.json")) and file["size"] > 0 and (self.files / file["id"]).is_file()]
            if not usable:
                items.append({**base, "id": "data-" + record["id"], "kind": "missing_data", "title": "数据附件待补充", "missing": []})
        persistent = {item["id"]: item for item in items if not item["generated"]}
        output, generated_ids = [], set()
        for item in items:
            if item["generated"]:
                if item["kind"] == "missing_conditions":
                    relevant = item.pop("fingerprint_missing")
                    coverage = item.pop("coverage")
                    if include_coverage:
                        item["coverage"] = coverage
                    existing = stored_keys.get((item["record_id"], item["field"]), set())
                    if not item["field"] and relevant != item["missing"]:
                        # Legacy IDs used the enabled built-ins or unqualified template labels.
                        old_id = review_fingerprint(item["id"], item["missing"])
                        if persistent.get(old_id, {}).get("status") == "pending":
                            existing = {old_id}
                else:
                    relevant = [(file["id"], file["size"], (self.files / file["id"]).is_file())
                                for file in by_id[item["record_id"]]["files"]]
                    existing = set()
                item["id"] = review_fingerprint(item["id"], relevant)
                matches = existing | ({item["id"]} & persistent.keys())
                generated_ids.update(matches)
                generated_ids.add(item["id"])
                if matches:
                    if item["kind"] == "missing_conditions":
                        for match in matches:
                            if persistent[match]["status"] == "pending":
                                persistent[match]["missing"] = item["missing"]
                                if include_coverage:
                                    persistent[match]["coverage"] = coverage
                            elif not persistent[match]["missing"]:
                                persistent[match]["missing"] = item["missing"]
                    continue
            output.append(item)
        return {"items": [item for item in output if not item.get("automatic") or item["status"] != "pending" or item["id"] in generated_ids]}

    def add_review(self, payload):
        if isinstance(payload, dict) and payload.get("issue_id"):
            with self.lock, self.connect() as db:
                existing = next((item for item in self.review_list()["items"] if item["id"] == payload["issue_id"]), None)
                if not existing:
                    raise Problem("待核对项已变化，请刷新后再处理。", 409)
                if not existing["generated"]:
                    return {"id": existing["id"], "revision": existing["revision"]}
                now = timestamp()
                db.execute("BEGIN IMMEDIATE")
                record = db.execute("SELECT revision FROM experiments WHERE id=?", (existing["record_id"],)).fetchone()
                if record["revision"] != existing["record_revision"]:
                    raise Problem("样品已有后续修改，请刷新后再核对。", 409)
                db.execute("INSERT OR IGNORE INTO review_items(id,record_id,project_id,experiment_no,kind,field,title,sources,created_at,updated_at,automatic) VALUES (?,?,?,?,?,?,?,?,?,?,1)",
                           (existing["id"], existing["record_id"], existing["project_id"], existing["experiment_no"], existing["kind"], existing["field"], existing["title"], json.dumps(existing["sources"], ensure_ascii=False), now, now))
            return {"id": existing["id"], "revision": 1}
        if not isinstance(payload, dict) or not isinstance(payload.get("record_id"), str) or not isinstance(payload.get("title"), str) or not 1 <= len(payload["title"].strip()) <= 250 or "\x00" in payload["title"]:
            raise Problem("请填写待核对内容，最多 250 个字符。")
        field = payload.get("field", "")
        note = payload.get("note", "")
        if not isinstance(field, str) or field not in {"", "precursor", "temperature", "duration", "solvents"} or not isinstance(note, str) or len(note) > 2000:
            raise Problem("待核对内容格式不正确。")
        review_id, now = uuid.uuid4().hex, timestamp()
        with self.lock, self.connect() as db:
            record = db.execute("SELECT * FROM experiments WHERE id=?", (payload.get("record_id"),)).fetchone()
            if not record or is_dataset(record):
                raise Problem("请选择要核对的实验样品。")
            sources = [{"label": "人工备注", "value": note}] if note else []
            db.execute("INSERT INTO review_items(id,record_id,project_id,experiment_no,kind,field,title,sources,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                       (review_id, record["id"], record["project_id"], record["experiment_no"] or experiment_number(record["sample_id"]),
                        "manual", field, payload["title"].strip(), json.dumps(sources, ensure_ascii=False), now, now))
        return {"id": review_id}

    def decide_review(self, review_id, payload):
        if not isinstance(payload, dict) or type(payload.get("preview")) is not bool or not isinstance(payload.get("status"), str) or payload["status"] not in {"resolved", "dismissed", "pending"}:
            raise Problem("待核对处理请求不正确。")
        note, apply_value = payload.get("note", ""), payload.get("apply_value", False)
        if not isinstance(note, str) or len(note) > 2000 or type(apply_value) is not bool:
            raise Problem("待核对内容格式不正确。")
        if payload["status"] == "dismissed" and not note.strip():
            raise Problem("请填写处理说明。")
        preview, changed_record = payload["preview"], None
        with self.lock, self.connect() as db:
            db.execute("BEGIN" if preview else "BEGIN IMMEDIATE")
            review = db.execute("SELECT * FROM review_items WHERE id=?", (review_id,)).fetchone()
            if not review:
                raise Problem("找不到待核对项。", 404)
            if type(payload.get("revision")) is not int or payload["revision"] != review["revision"]:
                raise Problem("待核对项已变化，请刷新后再处理。", 409)
            shown = None
            if review["automatic"] and review["kind"] == "missing_conditions":
                shown = next((item for item in self.review_list(include_coverage=True)["items"] if item["id"] == review_id), None)
                if shown is None or payload.get("missing") != shown["missing"]:
                    raise Problem("待核对项已变化，请刷新后再处理。", 409)
            record_id = review["record_id"]
            if not record_id and review["kind"] != "folder_import":
                record_id = payload.get("record_id")
            current = db.execute("SELECT * FROM experiments WHERE id=?", (record_id,)).fetchone() if isinstance(record_id, str) else None
            if current and not review["record_id"] and (current["project_id"] != review["project_id"] or (current["experiment_no"] or experiment_number(current["sample_id"])) != review["experiment_no"] or is_dataset(current)):
                raise Problem("请选择要核对的实验样品。")
            if current and (type(payload.get("record_revision")) is not int or payload["record_revision"] != current["revision"]):
                raise Problem("样品已有后续修改，请刷新后再核对。", 409)
            changes, values = [], {}
            if apply_value:
                if payload.get("value") is None or payload["value"] == "" or payload["value"] == []:
                    raise Problem("请填写确认值。")
                if not current or current["archived"] or review["field"] not in {"precursor", "temperature", "duration", "solvents"} or payload["status"] != "resolved":
                    raise Problem("请先在样品编辑器中核对这项内容。")
                candidate = decoded_state(history_state(current))
                candidate[review["field"]] = payload.get("value")
                columns = {review["field"]}
                if review["field"] == "precursor":
                    value = candidate["precursor"]
                    if isinstance(value, list):
                        candidate["precursors"] = value
                    elif value != current["precursor"]:
                        candidate["precursors"] = None
                    columns.add("precursors")
                if candidate["precursors"] is None:
                    del candidate["precursors"]
                if review["field"] == "solvents":
                    if not isinstance(candidate["solvents"], list):
                        raise Problem("待核对内容格式不正确。")
                    candidate["ligand"] = ""
                    candidate["material_amounts"] = [item for item in candidate["material_amounts"] if item["name"] in candidate["solvents"]]
                    columns.update(("solvent", "ligand", "material_amounts"))
                elif candidate["solvents"] is None:
                    del candidate["solvents"]
                clean = validate(candidate)
                clean.setdefault("precursors", None)
                values = {field: clean[field] for field in columns if clean[field] != current[field]}
                changed_record = {**history_state(current), **values}
                changes = history_changes(history_state(current), changed_record)
            result = {"preview": preview, "changes": changes, "status": payload["status"], "id": review_id, "sample_id": current["sample_id"] if current else review["experiment_no"]}
            if not preview:
                missing, coverage = review["missing"], review["coverage"]
                if payload["status"] == "pending":
                    missing = coverage = None
                elif shown is not None and review["status"] == "pending":
                    missing = json.dumps(shown["missing"], ensure_ascii=False)
                    coverage = json.dumps(shown["coverage"], ensure_ascii=False)
                now = timestamp()
                if values:
                    db.execute("UPDATE experiments SET " + ",".join(field + "=?" for field in values) + ",revision=revision+1,updated_at=? WHERE id=?",
                               (*values.values(), now, current["id"]))
                    if values.keys() & {"precursor", "precursors"}:
                        db.executemany("INSERT OR IGNORE INTO condition_options(field,name) VALUES ('precursor',?)", ((name,) for name in record_precursors(clean)))
                    for field in ("temperature", "duration"):
                        if field in values and values[field] is not None and values[field] != "":
                            name = format(values[field], ".15g") if field in NUMERIC_CONDITIONS else values[field]
                            db.execute("INSERT OR IGNORE INTO condition_options(field,name) VALUES (?,?)", (field, name))
                    if "solvents" in values:
                        db.executemany("INSERT OR IGNORE INTO condition_options(field,name) VALUES ('solvent',?)", ((value,) for value in json.loads(values["solvents"])))
                resolution = note.strip()
                if apply_value and not resolution:
                    resolution = "Confirmed value: " + json.dumps(payload["value"], ensure_ascii=False)
                db.execute("UPDATE review_items SET record_id=?,status=?,resolution=?,missing=?,coverage=?,revision=revision+1,updated_at=? WHERE id=?",
                           (current["id"] if current else None, payload["status"], resolution if payload["status"] != "pending" else "", missing, coverage, now, review_id))
                if values:
                    self.log_history(db, {current["id"]: current}, "review", review_id=review_id, review_revision=review["revision"] + 1)
        if not preview:
            result.update(records=[record for record in self.list() if current and record["id"] == current["id"]], condition_options=self.catalog()["condition_options"])
        return result

    def review_source(self, source_id):
        with self.connect() as db:
            source = db.execute("SELECT * FROM review_sources WHERE id=?", (source_id,)).fetchone()
        if not source or source["mime"] not in {"image/jpeg", "image/png", "image/webp"}:
            raise Problem("找不到来源照片。", 404)
        path = self.data / "review-sources" / source_id
        if not path.is_file():
            raise Problem("来源照片缺失，请检查备份。", 404)
        return path, source["mime"]

    def add_catalog_item(self, collection, payload):
        if collection not in ("projects", "categories", "condition-options"):
            raise Problem("找不到该页面或操作。", 404)
        condition = collection == "condition-options"
        if condition:
            field, name = validate_condition_option(payload)
        else:
            name = payload.get("name") if isinstance(payload, dict) else None
            if not isinstance(name, str) or not name.strip() or len(name) > 80 or any(ord(c) < 32 for c in name):
                raise Problem("名称不能为空，最多 80 个字符，不能包含控制字符。")
            name = name.strip()
        if collection == "categories" and name.casefold() == "none":
            raise Problem("none 是筛选保留名称，请使用其他类别名称。")
        with self.lock, self.connect() as db:
            if condition:
                if db.execute("SELECT 1 FROM condition_options WHERE field=? AND name=? AND hidden=0", (field, name)).fetchone():
                    raise Problem("该名称已存在，请直接选择或使用其他名称。", 409)
                db.execute("INSERT INTO condition_options(field,name,hidden) VALUES (?,?,0) ON CONFLICT(field,name) DO UPDATE SET hidden=0", (field, name))
                return {"field": field, "name": name}
            if any(row["name"].casefold() == name.casefold() for row in db.execute(f"SELECT name FROM {collection}")):
                raise Problem("该名称已存在，请直接选择或使用其他名称。", 409)
            if collection == "projects":
                project = {"id": uuid.uuid4().hex, "name": name}
                db.execute("INSERT INTO projects VALUES (?,?)", (project["id"], name))
                return {"project": project}
            db.execute("INSERT INTO categories VALUES (?)", (name,))
            return {"kind": name}

    def delete_condition_option(self, payload):
        field, name = validate_condition_option(payload)
        fields = ("solvent", "ligand") if field in ("solvent", "ligand") else (field,)
        with self.lock, self.connect() as db:
            db.executemany("INSERT INTO condition_options(field,name,hidden) VALUES (?,?,1) ON CONFLICT(field,name) DO UPDATE SET hidden=1", ((key, name) for key in fields))
        return {"field": field, "name": name}

    def delete_category(self, payload):
        if not isinstance(payload, dict) or not isinstance(payload.get("name"), str):
            raise Problem("请选择有效的数据类型。")
        name, replacement = payload["name"], payload.get("replacement", "")
        if not isinstance(replacement, str):
            raise Problem("请选择其他类别接收附件。")
        try:
            with self.lock, self.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                kinds = [row["name"] for row in db.execute("SELECT name FROM categories")]
                if name not in kinds:
                    raise Problem("该类别已不存在，请刷新后重试。", 409)
                if len(kinds) <= 1:
                    raise Problem("至少保留一个数据类别。")
                files = db.execute("SELECT * FROM files WHERE kind=?", (name,)).fetchall()
                if (files or replacement) and (replacement not in kinds or replacement == name):
                    raise Problem("请选择其他类别接收附件。")
                if files:
                    now = timestamp()
                    db.execute("UPDATE files SET kind=? WHERE kind=?", (replacement, name))
                    self.touch_file_records(db, {file["experiment_id"] for file in files}, now)
                    for file in files:
                        self.log_file_event(db, "recategorize", file, {**file, "kind": replacement}, now)
                db.execute("DELETE FROM categories WHERE name=?", (name,))
                return {"ok": True, "moved": len(files)}
        except sqlite3.IntegrityError:
            raise Problem("目标类别存在同一样品的同名附件，未作任何更改。请选择其他类别。", 409)

    def preview(self, file_id):
        path, name = self.file(file_id)
        suffix = Path(name).suffix.lower()
        if suffix == ".csv":
            if path.stat().st_size > 5 * 1024 * 1024:
                raise Problem("CSV 预览上限为 5 MB，请下载查看。", 413)
            try:
                rows = []
                with path.open(encoding="utf-8-sig", newline="") as stream:
                    for row in csv.reader(stream):
                        if any(cell.strip() for cell in row):
                            rows.append(row)
                        if len(rows) > 20000:
                            raise Problem("CSV 超过 20000 行，请下载查看。", 413)
            except (UnicodeError, csv.Error):
                raise Problem("暂时无法预览此 CSV 编码或格式，请下载查看。")
            points, labels = [], []
            # shortcut: plot the first two CSV columns; add column selection when other axes are needed.
            if rows and all(len(row) >= 2 for row in rows):
                for index, row in enumerate(rows):
                    point = []
                    for cell in row[:2]:
                        try:
                            point.append(float(cell))
                        except ValueError:
                            pass
                    if index == 0 and not point and all(cell.strip() for cell in row[:2]):
                        labels = [cell.strip().lstrip("#") for cell in row[:2]]
                    elif len(point) == 2 and all(math.isfinite(value) for value in point):
                        points.append(point)
                    else:
                        points = []
                        break
            # Refinement exports (twotheta, yobs, ycal, bkg, diff) already contain the fitted background:
            # return it aligned with points so the preview can plot yobs - bkg directly.
            background = []
            if labels and len(points) > 1:
                names = [cell.strip().lstrip("#").strip().lower() for cell in rows[0]]
                column = next((index for index, name in enumerate(names) if index >= 2 and name in {"bkg", "ybkg", "y_bkg", "background", "ybackground"}), None)
                if column is not None:
                    for row in rows[1:]:
                        try:
                            value = float(row[column])
                        except (IndexError, ValueError):
                            background = []
                            break
                        if not math.isfinite(value):
                            background = []
                            break
                        background.append(value)
                    if len(background) != len(points):
                        background = []
            return {"rows": [[cell[:1000] for cell in row[:20]] for row in rows[:51]],
                    "truncated": len(rows) > 51 or any(len(row) > 20 or any(len(cell) > 1000 for cell in row) for row in rows[:51]),
                    "points": points if len(points) > 1 else [], "labels": labels, "background": background}
        with path.open("rb") as stream:
            magic = stream.read(12)
        image_types = {".png": ("image/png", magic.startswith(b"\x89PNG\r\n\x1a\n")),
                       ".jpg": ("image/jpeg", magic.startswith(b"\xff\xd8\xff")),
                       ".jpeg": ("image/jpeg", magic.startswith(b"\xff\xd8\xff")),
                       ".gif": ("image/gif", magic[:6] in (b"GIF87a", b"GIF89a")),
                       ".webp": ("image/webp", magic[:4] == b"RIFF" and magic[8:12] == b"WEBP")}
        mime, valid = image_types.get(suffix, (None, False))
        if not valid:
            raise Problem("此格式暂不支持预览，请下载后用相应软件打开。", 415)
        return path, mime

    def save(self, payload, record_id=None):
        if not isinstance(payload, dict):
            raise Problem("实验记录必须是对象。")
        now = timestamp()
        shared = "shared_token" in payload
        if shared and (not isinstance(payload["shared_token"], str) or not re.fullmatch(r"[a-f0-9]{64}", payload["shared_token"])):
            raise Problem("请先读取本实验的共用条件。")
        try:
            with self.lock, self.connect() as db:
                self.local_catalog()
                db.execute("BEGIN IMMEDIATE")
                current = None
                if record_id:
                    current = db.execute("SELECT * FROM experiments WHERE id=?", (record_id,)).fetchone()
                    if not current:
                        raise Problem("找不到该实验。", 404)
                    if type(payload.get("revision")) is not int or payload["revision"] != current["revision"]:
                        raise Problem(STALE_RECORD, 409)
                    if "precursors" not in payload and current["precursors"] and payload.get("precursor") == current["precursor"]:
                        payload = {**payload, "precursors": json.loads(current["precursors"])}
                project_id = payload.get("project_id", current["project_id"] if current else "default")
                if not isinstance(project_id, str) or not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                    raise Problem("请选择有效的实验项目。")
                disabled = set()
                if shared:
                    builtin = self.project_settings(db, project_id)["settings"]["builtin"]
                    disabled = {field for field, entry in builtin.items() if not entry["enabled"]}
                disabled_columns = {column for field in disabled for column in PROJECT_BUILTINS[field][1]}
                if disabled_columns:
                    payload = {field: value for field, value in payload.items() if field not in disabled_columns}
                clean = validate(payload)
                clean.setdefault("precursors", None)
                clean["project_id"] = project_id
                details = json.loads(current["lab_data"]) if current else {}
                dataset = is_dataset(clean)
                active_sample = not dataset and not (current and (current["archived"] or is_dataset(current)))
                group = self.shared_group(db, project_id, clean["experiment_no"]) if active_sample else None
                if shared and group is None:
                    raise Problem("只能为未归档的实验样品设置共用条件。", 409)
                if shared and group[3] != payload["shared_token"]:
                    raise Problem("同实验的样品或共用条件已更新，请核对后重新保存。", 409)
                active = self.project_template(db, project_id) if not dataset and not details.get("template_revision") else None
                if current and (current["project_id"] != project_id or dataset):
                    self.check_child_links(db, record_id, project_id, dataset)
                    if current["project_id"] != project_id and details.get("template_revision"):
                        raise Problem("使用项目模板的样品不能移到其他项目。", 409)
                if "lab_data" in payload:
                    submitted = payload["lab_data"]
                    if not current and active and isinstance(submitted, dict) and "template_revision" not in submitted:
                        submitted = {**submitted, "template_revision": active["revision"]}
                    new_details = self.validate_lab_data(db, project_id, record_id, submitted, clean["status"], dataset)
                    if details.get("template_revision") and new_details.get("template_revision") != details["template_revision"]:
                        raise Problem("此样品使用保存时的模板版本。", 409)
                    if active and not details.get("template_revision"):
                        expected = active["revision"]
                        source_id = payload.get("copy_from")
                        if not current and isinstance(source_id, str):
                            source = db.execute("SELECT lab_data FROM experiments WHERE id=? AND project_id=?",
                                                (source_id, project_id)).fetchone()
                            if source:
                                expected = json.loads(source["lab_data"]).get("template_revision", expected)
                        revision = new_details.get("template_revision")
                        if (not current or revision) and revision != expected:
                            raise Problem("实验模板已更新，请重新打开编辑窗口后核对。", 409)
                    clean["lab_data"] = json.dumps(new_details, ensure_ascii=False)
                else:
                    if not current and active:
                        details["template_revision"] = active["revision"]
                        clean["lab_data"] = json.dumps(details)
                    self.validate_lab_data(db, project_id, record_id, details, clean["status"], dataset)
                if "result_summary" in clean:
                    result = json.loads(clean["result_summary"])
                    evidence = result["evidence_ids"]
                    previous = json.loads(current["result_summary"]).get("evidence_ids", []) if current else []
                    owned = {row["id"] for row in db.execute("SELECT id FROM files WHERE experiment_id=? AND deleted_at IS NULL", (record_id,))}
                    added = set(evidence) - set(previous)
                    if added - owned:
                        raise Problem("结果证据只能选择本样品已有的附件；请先保存样品并上传文件。")
                    visible = [file_id for file_id in evidence if file_id in owned]
                    # Restoring a file can expose more than 100 links, which can still be saved without adding more.
                    if added and len(visible) > 100:
                        raise Problem(RESULT_LIST_ERROR)
                    if visible == [file_id for file_id in previous if file_id in owned]:
                        result["evidence_ids"] = previous
                    else:
                        result["evidence_ids"] = visible + [file_id for file_id in previous if file_id not in owned]
                    clean["result_summary"] = json.dumps(result, ensure_ascii=False)
                if "solvents" not in payload:
                    clean["solvents"] = current["solvents"] if current and clean["solvent"] == current["solvent"] else None
                if "material_amounts" not in payload:
                    materials = record_materials({**clean, "solvents": json.loads(clean["solvents"]) if clean["solvents"] is not None else None})
                    previous = json.loads(current["material_amounts"]) if current else []
                    clean["material_amounts"] = json.dumps([item for item in previous if item["name"] in materials], ensure_ascii=False)
                if not current and not shared and group:
                    inherit = {"precursors": ("precursors", "precursor"), "temperature": ("temperature",),
                               "materials": ("solvents", "solvent", "ligand", "material_amounts")}
                    missing = [field for field, keys in inherit.items() if not any(key in payload for key in keys)]
                    if missing:
                        defaults = group[2]
                        clean.update(shared_columns({field: defaults[field] for field in missing if defaults[field] != EMPTY_SHARED_CONDITIONS[field]}))
                if record_id:
                    columns = {field: value for field, value in clean.items() if field not in disabled_columns}
                    db.execute("UPDATE experiments SET " + ", ".join(f"{key}=?" for key in columns) +
                               ", updated_at=?, revision=revision+1 WHERE id=?",
                               (*columns.values(), now, record_id))
                else:
                    record_id = self.insert_record(db, clean, now)
                for field in CONDITION_LIST_ERRORS:
                    if field in disabled_columns:
                        continue
                    stored = clean[field + "s"]
                    values = json.loads(stored) if stored is not None else ([clean[field]] if clean[field] else [])
                    db.executemany("INSERT OR IGNORE INTO condition_options(field,name) VALUES (?,?)", ((field, value) for value in values))
                if clean["ligand"]:
                    db.execute("INSERT OR IGNORE INTO condition_options(field,name) VALUES ('ligand',?)", (clean["ligand"],))
                db.executemany("INSERT OR IGNORE INTO condition_options(field,name) VALUES (?,?)", ((field, format(clean[field], ".15g")) for field in NUMERIC_CONDITIONS if clean[field] is not None))
                if current:
                    moved = self.move_shared_override(db, current, {**current, **columns})
                    if moved is not None and group:
                        members, _, conditions, token = group
                        group = members, moved, conditions, token
                if not shared or not current:
                    self.log_history(db, {record_id: current}, "edit" if current else "create")
                if shared:
                    previous_rows = self.apply_shared_conditions(db, group, project_id, clean["experiment_no"], record_id, clean, now, disabled)
                    if current:
                        previous_rows[record_id] = current
                    self.log_history(db, previous_rows, "shared")
                elif group:
                    self.remember_shared_baseline(db, group, record_id, current, clean)
        except sqlite3.IntegrityError:
            raise Problem("该项目内样品编号已存在（含已归档记录）。请使用不同编号。", 409)
        return record_id

    def update_status(self, payload):
        if not isinstance(payload, dict) or payload.get("status") not in STATUSES:
            raise Problem("记录状态不正确。")
        items = payload.get("records")
        if not isinstance(items, list) or not 1 <= len(items) <= 500:
            raise Problem("请选择 1–500 条样品更新状态。")
        ids = set()
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or type(item.get("revision")) is not int or item["id"] in ids:
                raise Problem("状态更新请求不正确。")
            ids.add(item["id"])
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            before_rows = {}
            for item in items:
                row = db.execute("SELECT * FROM experiments WHERE id=?", (item["id"],)).fetchone()
                if not row or row["archived"] or row["revision"] != item["revision"]:
                    raise Problem("记录已变化或已归档，未更新任何状态。请刷新后重试。", 409)
                self.check_required_fields(db, row["project_id"], json.loads(row["lab_data"]), payload["status"])
                before_rows[item["id"]] = dict(row)
            now = timestamp()
            db.executemany("UPDATE experiments SET status=?, updated_at=?, revision=revision+1 WHERE id=?",
                           ((payload["status"], now, item["id"]) for item in items))
            self.log_history(db, before_rows, "status")
        return {"ok": True, "updated": len(items)}

    def resolve_bulk_key_fields(self, db, rows, actions, settings):
        projects = {project: {key_field_identity(info): info for info in entry["fields"]}
                    for project, entry in settings.items()}
        details = {record_id: json.loads(row["lab_data"]) for record_id, row in rows.items()}
        versions = {record_id: (row["project_id"], details[record_id].get("template_revision")) for record_id, row in rows.items()}
        templates = {(project, revision): self.project_template(db, project, revision)
                     for project, revision in set(versions.values()) if revision}
        resolved = {record_id: [] for record_id in rows}
        for identity, action in actions.items():
            missing, wrong_unit = [], []
            for record_id, row in rows.items():
                info = projects[row["project_id"]].get(identity)
                field, value = resolve_key_field(templates.get(versions[record_id]), details[record_id], info)
                if field is None:
                    missing.append(row["sample_id"])
                elif field["type"] == "number" and action["mode"] == "set" and action.get("unit") != field["unit"]:
                    wrong_unit.append(row["sample_id"])
                else:
                    resolved[record_id].append((info, field, value, action))
            if missing:
                raise Problem(f"以下样品的模板没有字段 {action['label']}：{'、'.join(missing[:10])}")
            if wrong_unit:
                raise Problem(f"以下样品的单位与所填单位不同：{'、'.join(wrong_unit)}")
        return resolved

    def bulk_update(self, payload):
        fields = {"precursor", "precursors", "temperature", "duration", "solvents", "status", "phases", "morphologies", "confirmation", "conclusion"}
        result_fields = {"phases", "morphologies", "confirmation", "conclusion"}
        lists = {"precursors", "solvents", "phases", "morphologies"}
        if not isinstance(payload, dict) or type(payload.get("preview")) is not bool:
            raise Problem("批量编辑请求不正确。")
        items, changes = payload.get("records"), payload.get("changes")
        if not isinstance(items, list) or not 1 <= len(items) <= 500:
            raise Problem("请选择 1–500 条样品批量编辑。")
        ids = set()
        for item in items:
            if (not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"] or
                    type(item.get("revision")) is not int or item["id"] in ids):
                raise Problem("批量编辑请求不正确。")
            ids.add(item["id"])
        if not isinstance(changes, dict) or set(changes) - (fields | {"key_fields"}):
            raise Problem("请至少选择一个可批量修改的字段。")
        key_fields = changes.get("key_fields", [])
        if not isinstance(key_fields, list) or len(key_fields) > 8:
            raise Problem("批量编辑操作不正确。")
        actions = {}
        for entry in key_fields:
            if (not isinstance(entry, dict) or set(entry) - {"section", "label", "mode", "value", "unit"}
                    or entry.get("section") not in ("condition", "result") or not valid_settings_text(entry.get("label"), 80)
                    or not entry["label"].strip() or entry.get("mode") not in ("set", "clear", "replace", "append")
                    or (entry["mode"] != "clear" and "value" not in entry)):
                raise Problem("批量编辑操作不正确。")
            action = {**entry, "label": entry["label"].strip()}
            identity = key_field_identity(action)
            if identity in actions:
                raise Problem("批量编辑操作不正确。")
            actions[identity] = action
        changes = {field: action for field, action in changes.items() if field != "key_fields"}
        if not changes and not actions:
            raise Problem("请至少选择一个可批量修改的字段。")
        if {"precursor", "precursors"} <= changes.keys():
            raise Problem("批量编辑操作不正确。")
        for field, action in changes.items():
            allowed = {"set", "append", "clear"} if field in lists else {"set"} if field in {"status", "confirmation"} else {"set", "clear"}
            if (not isinstance(action, dict) or not isinstance(action.get("mode"), str) or action["mode"] not in allowed or
                    set(action) - {"mode", "value"} or (action["mode"] != "clear" and "value" not in action)):
                raise Problem("批量编辑操作不正确。")
            if field in lists and action["mode"] != "clear":
                limit, length = (20, 250) if field in ("precursors", "solvents") else (20, 80)
                values = action["value"]
                if (not isinstance(values, list) or not 1 <= len(values) <= limit or
                        any(not isinstance(value, str) or not value.strip() or len(value) > length or
                            any(ord(char) < 32 for char in value) for value in values)):
                    raise Problem("批量标签或材料应逐行填写，每次最多 20 项。")
        builtins = {field: label for field, (label, columns) in PROJECT_BUILTINS.items()
                    if changes.keys() & columns}
        preview = payload["preview"]
        rows, updates, before_rows = [], [], {}
        with self.lock:
            with self.connect() as db:
                db.execute("BEGIN" if preview else "BEGIN IMMEDIATE")
                for item in items:
                    row = db.execute("SELECT * FROM experiments WHERE id=?", (item["id"],)).fetchone()
                    if not row or row["archived"] or row["revision"] != item["revision"]:
                        raise Problem("记录已变化或已归档，未修改任何样品。请关闭批量编辑并刷新后重试。", 409)
                    if is_dataset(row):
                        raise Problem("批量编辑仅支持实验样品，请取消选择资料集。")
                    before_rows[item["id"]] = row
                settings = {project: self.project_settings(db, project)
                            for project in {row["project_id"] for row in before_rows.values()}} if builtins or actions else {}
                for field, label in builtins.items():
                    disabled = [row["sample_id"] for row in before_rows.values()
                                if not settings[row["project_id"]]["settings"]["builtin"][field]["enabled"]]
                    if disabled:
                        raise Problem(f"以下样品所在项目已关闭字段 {label}：{'、'.join(disabled)}")
                resolved = self.resolve_bulk_key_fields(db, before_rows, actions, settings) if actions else {}
                for record_id, row in before_rows.items():
                    before = dict(row)
                    for key in ("extra_conditions", "material_amounts", "result_summary"):
                        before[key] = json.loads(before[key])
                    before["result_summary"] = validate_result_summary(before["result_summary"])
                    before["precursors"] = json.loads(before["precursors"]) if before["precursors"] is not None else None
                    before["solvents"] = json.loads(before["solvents"]) if before["solvents"] is not None else ([before["solvent"]] if before["solvent"] else [])
                    after = {**before, "result_summary": dict(before["result_summary"])}
                    columns = set()
                    for field, action in changes.items():
                        target = after["result_summary"] if field in result_fields else after
                        mode = action["mode"]
                        value = ([] if field in lists else None if field in NUMERIC_CONDITIONS else "") if mode == "clear" else action["value"]
                        if field in lists:
                            value = list(dict.fromkeys(value.strip() for value in value))
                            if mode == "append":
                                previous = record_precursors(before) if field == "precursors" else record_materials(before) if field == "solvents" else target[field]
                                value = list(dict.fromkeys([*previous, *value]))
                        target[field] = value
                        columns.add("result_summary" if field in result_fields else field)
                        if field == "precursor" and value != before["precursor"]:
                            after["precursors"] = None
                            columns.add("precursors")
                        if field == "precursors":
                            columns.add("precursor")
                        if field == "solvents":
                            after["ligand"] = ""
                            after["material_amounts"] = [amount for amount in before["material_amounts"] if amount["name"] in value]
                            columns.update(("solvent", "ligand", "material_amounts"))
                    if after["precursors"] is None:
                        del after["precursors"]
                    clean = validate(after)
                    clean.setdefault("precursors", None)
                    json_fields = {"precursors", "solvents", "material_amounts", "result_summary"}
                    decoded = {key: json.loads(value) if key in json_fields and value is not None else value for key, value in clean.items()}
                    diff = []
                    for field in sorted(set(changes) | (result_fields if "result_summary" in columns else set())):
                        if field in result_fields:
                            old, new = before["result_summary"][field], decoded["result_summary"][field]
                        elif field == "precursors":
                            old, new = record_precursors(before), record_precursors(decoded)
                        elif field == "solvents":
                            old, new = material_summary(before), material_summary(decoded)
                        else:
                            old, new = before[field], decoded[field]
                        if old != new:
                            diff.append({"field": field, "before": old, "after": new})
                    key_changes = resolved.get(record_id, [])
                    if key_changes:
                        details = json.loads(row["lab_data"])
                        values = details.pop("values", {})
                        for info, field, old, action in key_changes:
                            mode = action["mode"]
                            allowed = ("replace", "append", "clear") if field["type"] == "multi" else ("set", "clear")
                            if mode not in allowed:
                                raise Problem("批量编辑操作不正确。")
                            value = None if mode == "clear" else validate_template_value(field, action["value"])
                            if mode == "append":
                                value = list(dict.fromkeys([*(old or []), *value]))
                            if old == value:
                                continue
                            if value is None:
                                values.pop(field["key"], None)
                            else:
                                values[field["key"]] = value
                            change = {"field": key_field_name(info), "before": old, "after": value}
                            if field["type"] == "number":
                                change["unit"] = field["unit"]
                            diff.append(change)
                            columns.add("lab_data")
                        if values:
                            details["values"] = values
                        if "lab_data" in columns:
                            clean["lab_data"] = json.dumps(details, ensure_ascii=False)
                    if "status" in columns or "lab_data" in columns:
                        self.check_required_fields(db, row["project_id"],
                                                   details if key_changes else json.loads(row["lab_data"]), clean["status"])
                    rows.append({"id": record_id, "revision": row["revision"], "sample_id": before["sample_id"],
                                 "experiment_no": before["experiment_no"], "project_id": before["project_id"], "changes": diff})
                    if diff:
                        updates.append((record_id, {key: clean[key] for key in sorted(columns)}))
                if not preview:
                    now = timestamp()
                    for record_id, clean in updates:
                        db.execute("UPDATE experiments SET " + ", ".join(key + "=?" for key in clean) + ", revision=revision+1, updated_at=? WHERE id=?",
                                   (*clean.values(), now, record_id))
                        options = [(field, format(clean[field], ".15g")) for field in NUMERIC_CONDITIONS if field in clean and clean[field] is not None]
                        if "precursor" in clean:
                            options.extend(("precursor", name) for name in record_precursors(clean))
                        options.extend(("solvent", value) for value in json.loads(clean.get("solvents", "[]")))
                        db.executemany("INSERT OR IGNORE INTO condition_options(field,name) VALUES (?,?)", options)
                    self.log_history(db, before_rows, "bulk")
            result = {"preview": preview, "updated": len(updates), "rows": rows}
            if not preview:
                result["records"] = [record for record in self.list() if record["id"] in ids]
                result["condition_options"] = self.catalog()["condition_options"]
            return result

    def archive(self, record_id, payload):
        if not isinstance(payload, dict) or type(payload.get("archived")) is not bool:
            raise Problem("归档状态不正确。")
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM experiments WHERE id=?", (record_id,)).fetchone()
            if not row:
                raise Problem("找不到该实验。", 404)
            if type(payload.get("revision")) is not int or payload["revision"] != row["revision"]:
                raise Problem("记录已更新，请刷新后重试。", 409)
            db.execute("UPDATE experiments SET archived=?, updated_at=?, revision=revision+1 WHERE id=?",
                       (int(payload["archived"]), timestamp(), record_id))
            self.log_history(db, {record_id: row}, "archive")

    def preview_folder(self, payload):
        if (not isinstance(payload, dict) or not isinstance(payload.get("project_id"), str)
                or type(payload.get("create")) is not bool or not isinstance(payload.get("files"), list)
                or not 1 <= len(payload["files"]) <= MAX_FOLDER_FILES):
            raise Problem("每次请选择 1–300 个文件。")
        project_id = payload["project_id"]
        experiment_no = lab_text(payload.get("experiment_no", ""), 120)
        entries = [folder_entry(row) for row in payload["files"]]
        if len({entry["path"] for entry in entries}) != len(entries):
            raise Problem("所选文件的相对路径不能重复。")
        excluded = payload.get("excluded", [])
        if (not isinstance(excluded, list) or len(excluded) > len(entries)
                or any(not isinstance(path, str) for path in excluded)):
            raise Problem("文件夹导入预览格式不正确。")
        excluded = set(excluded)
        plans = []
        with self.connect() as db:
            db.execute("BEGIN")
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise Problem("请选择有效的实验项目。")
            kinds = {row["name"] for row in db.execute("SELECT name FROM categories")}
            targets, new_samples = {}, {}
            fold = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
            for entry in entries:
                sample, kind, path = entry["sample_id"], entry["kind"], entry["path"]
                name = path.rsplit("/", 1)[-1]
                row = db.execute("SELECT * FROM experiments WHERE project_id=? AND sample_id=?", (project_id, sample)).fetchone()
                record_id = row["id"] if row else ""
                number = (row["experiment_no"] or experiment_number(row["sample_id"])) if row else (experiment_no or experiment_number(sample))
                # Match the database's ASCII-only NOCASE identity rule.
                folded = sample.translate(fold)
                target = (record_id, folded, name, kind)
                reason = ""
                if not 0 < entry["size"] <= MAX_FILE:
                    reason = "size"
                elif not sample or (not row and not payload["create"]):
                    reason = "sample"
                elif row and (row["archived"] or is_dataset(row)):
                    reason = "archived"
                elif kind not in kinds:
                    reason = "category"
                elif row and db.execute("SELECT 1 FROM files WHERE experiment_id=? AND name=? AND kind=? AND deleted_at IS NULL",
                                        (record_id, name, kind)).fetchone():
                    reason = "duplicate"
                if row:
                    sample = row["sample_id"]
                elif not reason and path not in excluded:
                    sample, number = new_samples.setdefault(folded, (sample, number))
                plan = {**entry, "name": name, "sample_id": sample,
                        "record_id": record_id, "experiment_no": number,
                        "action": "review" if reason else "attach" if row else "new", "reason": reason}
                if not reason and path not in excluded:
                    targets.setdefault(target, []).append(plan)
                plans.append(plan)
        for duplicate in targets.values():
            if len(duplicate) > 1:
                for plan in duplicate:
                    plan.update(action="review", reason="duplicate")
        return {"rows": plans}

    def folder_issues(self, payload):
        if (not isinstance(payload, dict) or not isinstance(payload.get("project_id"), str)
                or not isinstance(payload.get("batch_id"), str) or not re.fullmatch(r"[a-f0-9]{32}", payload["batch_id"])
                or not isinstance(payload.get("issues"), list) or not 1 <= len(payload["issues"]) <= MAX_FOLDER_FILES):
            raise Problem("文件夹导入预览格式不正确。")
        project_id, count, pending = payload["project_id"], 0, set()
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
                raise Problem("请选择有效的实验项目。")
            for issue in payload["issues"]:
                entry = folder_entry(issue)
                reason = issue.get("reason")
                if not isinstance(reason, str) or reason not in IMPORT_ISSUES:
                    raise Problem("文件夹导入预览格式不正确。")
                sample = entry["sample_id"]
                record = db.execute("SELECT * FROM experiments WHERE project_id=? AND sample_id=?", (project_id, sample)).fetchone()
                number = (record["experiment_no"] or experiment_number(record["sample_id"])) if record else sample
                key = json.dumps([project_id, payload["batch_id"], entry, reason], sort_keys=True)
                issue_id = hashlib.sha256(key.encode()).hexdigest()[:32]
                now = timestamp()
                sources = [{"label": "所选文件夹内的相对路径", "value": entry["path"]},
                           {"label": "导入待核对原因", "value": IMPORT_ISSUES[reason]},
                           {"label": "导入批次（UTC）", "value": now + " · " + payload["batch_id"][:8]}]
                cursor = db.execute("""INSERT OR IGNORE INTO review_items
                    (id,record_id,project_id,experiment_no,kind,field,title,sources,created_at,updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (issue_id, record["id"] if record else None, project_id, number, "folder_import", "",
                     "文件导入待核对", json.dumps(sources, ensure_ascii=False), now, now))
                count += cursor.rowcount
                if db.execute("SELECT status FROM review_items WHERE id=?", (issue_id,)).fetchone()["status"] == "pending":
                    pending.add(issue_id)
        return {"created": count, "pending": len(pending)}

    def insert_record(self, db, clean, now):
        record_id = uuid.uuid4().hex
        keys = ["id", *clean, "created_at", "updated_at"]
        db.execute(f"INSERT INTO experiments ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})",
                   (record_id, *clean.values(), now, now))
        return record_id

    @staticmethod
    def check_file_kind(db, kind):
        if not isinstance(kind, str) or not db.execute("SELECT 1 FROM categories WHERE name=? COLLATE BINARY", (kind,)).fetchone():
            raise Problem("请选择有效的数据类型。")

    @staticmethod
    def check_file_slot(db, record_id, name, kind, file_id, restoring_original=False):
        conflict = db.execute("""SELECT 1 FROM files WHERE experiment_id=? AND name=? AND kind=?
                                 AND deleted_at IS NULL AND id<>?""", (record_id, name, kind, file_id)).fetchone()
        if conflict:
            if restoring_original:
                raise Problem("同名同类附件已存在，请为恢复的附件输入新名称。", 409)
            raise Problem(f"同类型附件 {name} 已存在，未覆盖。请重命名后再上传。", 409)

    @staticmethod
    def check_file_record(record, revision):
        if record["archived"]:
            raise Problem(ARCHIVED_ATTACHMENTS, 409)
        if type(revision) is not int or revision != record["revision"]:
            raise Problem(STALE_RECORD, 409)

    @staticmethod
    def log_file_event(db, action, before, after, now):
        file = before if before is not None else after
        states = [json.dumps({"name": row["name"], "kind": row["kind"], "record_id": row["experiment_id"]},
                             ensure_ascii=False) if row is not None else None for row in (before, after)]
        db.execute("INSERT INTO file_events VALUES (?,?,?,?,?,?,?)",
                   (uuid.uuid4().hex, file["id"], file["experiment_id"], action, *states, now))

    @staticmethod
    def touch_file_records(db, record_ids, now):
        db.executemany("UPDATE experiments SET updated_at=?,revision=revision+1 WHERE id=?",
                       ((now, record_id) for record_id in record_ids))

    def add_file(self, record_id, name, kind, stream, size, source="", folder_target=None, receipt="",
                 *, project_id=None, sample_id=None):
        validate_file_name(name)
        if not 0 < size <= MAX_FILE:
            raise Problem("请选择非空文件；单个文件上限为 256 MB。", 413)
        file_id = uuid.uuid4().hex
        destination = self.files / file_id
        temporary = self.files / (".part-" + file_id)
        digest = hashlib.sha256()
        published = False
        try:
            remaining = size
            with temporary.open("xb") as output:
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise Problem("文件传输中断，请重试。")
                    output.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
            with self.lock:
                if folder_target is not None:
                    self.local_catalog()
                with self.connect() as db:
                    db.execute("BEGIN IMMEDIATE")
                    self.check_file_kind(db, kind)
                    if receipt and db.execute("SELECT 1 FROM folder_import_receipts WHERE id=?", (receipt,)).fetchone():
                        raise Problem("这次文件导入已有保存回执。", 409)
                    created = False
                    if folder_target is not None:
                        project, sample, number = folder_target
                        if not db.execute("SELECT 1 FROM projects WHERE id=?", (project,)).fetchone():
                            raise Problem("请选择有效的实验项目。")
                        row = db.execute("SELECT * FROM experiments WHERE project_id=? AND sample_id=?", (project, sample)).fetchone()
                        if record_id != (row["id"] if row else "") or (row and (is_dataset(row)
                                or (row["experiment_no"] or experiment_number(row["sample_id"])) != number)):
                            raise Problem("目标样品已变化，请重新预览文件夹。", 409)
                        if row and row["archived"]:
                            raise Problem(ARCHIVED_ATTACHMENTS, 409)
                        if not row:
                            clean = validate({"sample_id": sample, "experiment_no": number})
                            _, _, defaults, _ = self.shared_group(db, project, clean["experiment_no"])
                            clean.update(shared_columns({key: value for key, value in defaults.items() if value != EMPTY_SHARED_CONDITIONS[key]}))
                            template = self.project_template(db, project)
                            if template:
                                clean["lab_data"] = json.dumps({"template_revision": template["revision"]})
                            clean["project_id"] = project
                            record_id = self.insert_record(db, clean, timestamp())
                            created = True
                    else:
                        row = db.execute("SELECT archived, project_id, sample_id FROM experiments WHERE id=?", (record_id,)).fetchone()
                        if not row:
                            raise Problem("请先保存实验，再添加文件。", 404)
                        if ((project_id is not None and project_id != row["project_id"]) or
                                (sample_id is not None and sample_id != row["sample_id"])):
                            raise Problem("目标样品已变化，请刷新后再上传。", 409)
                        if row["archived"]:
                            raise Problem(ARCHIVED_ATTACHMENTS, 409)
                    self.check_file_slot(db, record_id, name, kind, file_id)
                    temporary.replace(destination)
                    published = True
                    now = timestamp()
                    db.execute("INSERT INTO files(id,experiment_id,name,kind,size,sha256,source,created_at) VALUES (?,?,?,?,?,?,?,?)",
                               (file_id, record_id, name, kind, size, digest.hexdigest(), source, now))
                    self.log_file_event(db, "upload", None, {"id": file_id, "experiment_id": record_id, "name": name, "kind": kind}, now)
                    if receipt:
                        db.execute("INSERT INTO folder_import_receipts VALUES (?,?)", (receipt, file_id))
                    if created:
                        self.log_history(db, {record_id: None}, "create", source="folder")
                    else:
                        self.touch_file_records(db, (record_id,), now)
        except Exception:
            if published:
                destination.unlink(missing_ok=True)
            raise
        finally:
            temporary.unlink(missing_ok=True)
        return {"id": file_id, "record_id": record_id} if folder_target is not None else file_id

    def folder_receipt(self, receipt):
        with self.connect() as db:
            row = db.execute("""SELECT files.id, experiment_id AS record_id FROM folder_import_receipts
                              JOIN files ON files.id=file_id WHERE folder_import_receipts.id=? AND files.deleted_at IS NULL""",
                             (receipt,)).fetchone()
        if not row:
            raise Problem("本次文件导入尚无保存回执。", 404)
        return dict(row)

    @staticmethod
    def trash_count(db):
        return db.execute("SELECT count(*) FROM files WHERE deleted_at IS NOT NULL").fetchone()[0]

    @staticmethod
    def category_counts(db):
        return {row["name"]: {"active": row["active"], "trashed": row["trashed"]} for row in db.execute("""
            SELECT c.name, count(CASE WHEN f.deleted_at IS NULL THEN f.id END) AS active,
                   count(f.deleted_at) AS trashed
            FROM categories c LEFT JOIN files f ON f.kind=c.name GROUP BY c.name
        """)}

    def trash(self, project_id=""):
        with self.connect() as db:
            items = [dict(row) for row in db.execute("""SELECT f.*, r.id AS record_id, r.sample_id, r.experiment_no,
                r.project_id, r.archived AS record_archived, EXISTS (
                    SELECT 1 FROM files a WHERE a.experiment_id=f.experiment_id AND a.name=f.name
                    AND a.kind=f.kind AND a.deleted_at IS NULL
                ) AS name_conflict
                FROM files f JOIN experiments r ON r.id=f.experiment_id
                WHERE f.deleted_at IS NOT NULL AND (?='' OR r.project_id=?)
                ORDER BY f.deleted_at DESC, f.rowid DESC""", (project_id, project_id))]
        for item in items:
            item["experiment_no"] = item["experiment_no"] or experiment_number(item["sample_id"])
            item["record_archived"] = bool(item["record_archived"])
            item["name_conflict"] = bool(item["name_conflict"])
        return {"items": items, "total_bytes": sum(item["size"] for item in items)}

    def change_file(self, file_id, action, payload):
        if not isinstance(payload, dict):
            raise Problem("附件操作请求不正确。")
        with self.lock:
            with self.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                before = db.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
                if not before:
                    raise Problem("附件不存在。", 404)
                owner_id = before["experiment_id"]
                owner = db.execute("SELECT * FROM experiments WHERE id=?", (owner_id,)).fetchone()
                if not owner:
                    raise Problem("找不到该实验。", 404)
                self.check_file_record(owner, payload.get("record_revision"))
                if (before["deleted_at"] is not None) != (action == "restore"):
                    raise Problem("附件不存在。", 404)

                now = timestamp()
                after = dict(before)
                events = [action]
                if action == "delete":
                    after["deleted_at"] = now
                else:
                    after["name"] = payload.get("name", before["name"])
                    if "name" in payload:
                        validate_file_name(after["name"])
                    if action == "restore":
                        after["deleted_at"] = None
                    else:
                        if "kind" in payload:
                            after["kind"] = payload["kind"]
                            self.check_file_kind(db, after["kind"])
                        target_id = payload.get("target_record_id", owner_id)
                        if not isinstance(target_id, str) or not target_id:
                            raise Problem("目标样品不存在，请刷新后重试。")
                        if target_id != owner_id:
                            target = db.execute("SELECT * FROM experiments WHERE id=?", (target_id,)).fetchone()
                            if not target:
                                raise Problem("目标样品不存在，请刷新后重试。", 404)
                            if target["project_id"] != owner["project_id"]:
                                raise Problem("附件只能移到同一项目的样品。")
                            self.check_file_record(target, payload.get("target_revision"))
                            after["experiment_id"] = target_id
                        events = [event for key, event in (("name", "rename"), ("kind", "recategorize"), ("experiment_id", "move"))
                                  if before[key] != after[key]]
                        if not events:
                            raise Problem("没有需要保存的修改。")
                    self.check_file_slot(db, after["experiment_id"], after["name"], after["kind"], file_id,
                                         restoring_original=action == "restore" and after["name"] == before["name"])

                db.execute("UPDATE files SET name=?,kind=?,experiment_id=?,deleted_at=? WHERE id=?",
                           (after["name"], after["kind"], after["experiment_id"], after["deleted_at"], file_id))
                for event in events:
                    self.log_file_event(db, event, None if action == "restore" else before,
                                        None if action == "delete" else after, now)
                record_ids = (owner_id,) if owner_id == after["experiment_id"] else (owner_id, after["experiment_id"])
                self.touch_file_records(db, record_ids, now)
                result = {}
                if action != "delete":
                    result["file"] = {key: after[key] for key in FILE_FIELDS}
                if action != "update":
                    result["trash_count"] = self.trash_count(db)
            records = {record["id"]: record for record in self.list() if record["id"] in record_ids}
            result["records"] = [records[record_id] for record_id in record_ids]
        return result

    def purge_trash(self, payload):
        if not isinstance(payload, dict) or payload.get("confirm") != "purge":
            raise Problem("请确认永久删除所选附件。")
        ids = payload.get("file_ids")
        if not isinstance(ids, list) or any(not isinstance(file_id, str) for file_id in ids):
            raise Problem("附件操作请求不正确。")
        with self.file_copy_lock:
            with self.lock, self.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                files = [db.execute("""SELECT files.*, experiments.project_id FROM files
                             JOIN experiments ON experiments.id=files.experiment_id
                             WHERE files.id=? AND files.deleted_at IS NOT NULL""", (file_id,)).fetchone()
                         for file_id in dict.fromkeys(ids)]
                if any(file is None or ("project_id" in payload and file["project_id"] != payload["project_id"]) for file in files):
                    raise Problem("回收站内容已变化，请刷新后再清空。", 409)
                now = timestamp()
                pending = {file["id"]: file["size"] for file in files}
                for file in files:
                    db.execute("DELETE FROM folder_import_receipts WHERE file_id=?", (file["id"],))
                    db.execute("DELETE FROM files WHERE id=?", (file["id"],))
                    self.log_file_event(db, "purge", file, None, now)
                if pending:
                    for row in db.execute("SELECT id, result_summary FROM experiments").fetchall():
                        result = json.loads(row["result_summary"])
                        evidence = result.get("evidence_ids", [])
                        kept = [file_id for file_id in evidence if file_id not in pending]
                        if kept != evidence:
                            result["evidence_ids"] = kept
                            db.execute("UPDATE experiments SET result_summary=?, revision=revision+1, updated_at=? WHERE id=?",
                                       (json.dumps(result, ensure_ascii=False), now, row["id"]))
                    # Commit the unlink intent with the purge in case the process stops after the transaction.
                    db.executemany("INSERT OR REPLACE INTO app_settings VALUES (?, ?)",
                                   ((PENDING_PURGE_PREFIX + file_id, json.dumps(size)) for file_id, size in pending.items()))
                remaining = self.trash_count(db)
            reclaimed, pending_bytes = self.unlink_purged_files(pending)
        return {"purged": len(files), "bytes": reclaimed, "pending_bytes": pending_bytes, "trash_count": remaining}

    def unlink_purged_files(self, pending):
        reclaimed = pending_bytes = 0
        completed = []
        for file_id, size in pending.items():
            path = self.files / file_id
            try:
                size = path.lstat().st_size
                path.unlink()
            except FileNotFoundError:
                pass
            except OSError as exc:
                pending_bytes += size
                logging.getLogger(__name__).warning("无法删除已清空的附件副本 %s: %s", file_id, exc)
                continue
            else:
                reclaimed += size
            completed.append((PENDING_PURGE_PREFIX + file_id,))
        if completed:
            try:
                with self.lock, self.connect() as db:
                    db.execute("BEGIN IMMEDIATE")
                    db.executemany("DELETE FROM app_settings WHERE key=?", completed)
            except sqlite3.Error as exc:
                logging.getLogger(__name__).warning("无法清除已删除附件的待处理记录: %s", exc)
        return reclaimed, pending_bytes

    def reconcile_storage(self):
        with self.connect() as db:
            referenced = {row["id"].lower() for row in db.execute("SELECT id FROM files")}
            pending = {}
            for row in db.execute("SELECT key, value FROM app_settings WHERE key GLOB ?", (PENDING_PURGE_PREFIX + "*",)):
                file_id = row["key"][len(PENDING_PURGE_PREFIX):]
                if file_id not in referenced and re.fullmatch(r"[a-f0-9]{32}", file_id):
                    pending[file_id] = json.loads(row["value"])
        self.unlink_purged_files(pending)
        orphaned = self.data / "orphaned"
        for path in self.files.iterdir():
            name = path.name
            if name.lower() in referenced or name in pending:
                continue
            if not (name.startswith(".part-") or re.fullmatch(r"[a-f0-9]{32}", name)):
                continue
            if not (path.is_symlink() or path.is_file()):
                continue
            try:
                orphaned.mkdir(exist_ok=True)
                destination = orphaned / path.name
                while os.path.lexists(destination):
                    destination = orphaned / uuid.uuid4().hex
                path.rename(destination)
            except OSError as exc:
                logging.getLogger(__name__).warning("无法移出无记录的附件副本 %s: %s", path.name, exc)

    def file(self, file_id):
        with self.connect() as db:
            row = db.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
        if not row:
            raise Problem("附件不存在。", 404)
        path = self.files / row["id"]
        if not path.is_file():
            raise Problem("附件文件缺失，请检查数据目录或备份。", 404)
        return path, row["name"]

    def share_experiments(self, ids, revisions, destination, language):
        english = language == "en"
        stale = "The selected samples changed. Return to the experiment list and refresh." if english else "选中的样品已变化，请返回实验列表刷新后重试。"
        if (not 1 <= len(ids) <= 500 or len(revisions) != len(ids) or len(set(ids)) != len(ids)
                or any(not re.fullmatch(r"[a-f0-9]{32}", key) for key in ids)):
            raise Problem("Select experiments to export." if english else "请选择要导出的实验。")
        with self.file_copy_lock:
            with self.lock:
                self.local_catalog()
                prefixes = self.grouping_prefixes
                records = self.list()
            by_id = {record["id"]: record for record in records if not is_dataset(record)}
            if any(key not in by_id or by_id[key]["revision"] != version for key, version in zip(ids, revisions)):
                raise Problem(stale, 409)

            def group(record):
                return record["project_id"], experiment_key(record["experiment_no"], prefixes), record["archived"]

            groups = {group(by_id[key]) for key in ids}
            if {key for key, record in by_id.items() if group(record) in groups} != set(ids):
                raise Problem(stale, 409)
            selected = {key: by_id[key] for key in ids}
            linked, rows, files = {}, [], []
            for record in selected.values():
                parent_id = record.get("lab_data", {}).get("parent_id")
                while parent_id and parent_id not in selected and parent_id not in linked:
                    parent = by_id[parent_id]
                    linked[parent_id] = {key: parent[key] for key in ("id", "sample_id", "experiment_no", "project_id")}
                    parent_id = parent.get("lab_data", {}).get("parent_id")
                    linked[parent["id"]]["parent_id"] = parent_id
                portable_files = []
                for file in record["files"]:
                    path = self.files / file["id"]
                    if not path.is_file() or path.stat().st_size != file["size"]:
                        raise Problem(("Attachment missing or size changed: " if english else "附件缺失或大小已变化：") + file["name"], 409)
                    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", file["name"]).rstrip(". ") or "file"
                    stem, suffix = Path(name).stem, Path(name).suffix
                    name = stem.encode("utf-8")[:96].decode("utf-8", errors="ignore").rstrip(". ")
                    name = (name or "file") + (suffix if re.fullmatch(r"\.[A-Za-z0-9]{1,15}", suffix) else "")
                    member = f"files/{file['id']}-{name}"
                    portable_files.append({**{key: value for key, value in file.items() if key != "source"}, "path": member})
                    files.append((path, member, file))
                rows.append({**{key: value for key, value in record.items() if key != "notes"}, "files": portable_files})
            manifest = {"schema": "experiment-data-catalog/share-v1", "experiments": len(groups),
                        "samples": rows, "external_parents": list(linked.values())}
            with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
                archive.writestr("samples.csv", export_csv([{**row, "notes": ""} for row in rows], language, include_template=True))
                for path, member, file in files:
                    digest = hashlib.sha256()
                    with path.open("rb") as source, archive.open(member, "w") as target:
                        for chunk in iter(lambda: source.read(1024 * 1024), b""):
                            digest.update(chunk)
                            target.write(chunk)
                    if digest.hexdigest() != file["sha256"]:
                        raise Problem(("Attachment checksum no longer matches: " if english else "附件校验值已变化：") + file["name"], 409)
                archive.writestr("README.txt", "Start with samples.csv or manifest.json. The files field in the manifest maps each sample to its original attachments and checksums. Parent IDs outside the selection are listed under external_parents as references. This package is for handoff; use Full backup to restore the app.\n")

    def snapshot_database(self, destination):
        """Copy the live database consistently; return the attachments and source photos it references."""
        with self.lock, self.connect() as source:
            self.recover_local_catalog()
            target = sqlite3.connect(destination)
            try:
                source.backup(target)
                target.row_factory = sqlite3.Row
                files = [dict(row) for row in target.execute("SELECT id, name, size, sha256 FROM files ORDER BY id")]
                sources = [dict(row) for row in target.execute("SELECT id, name, sha256 FROM review_sources ORDER BY id")]
                summary = {"records": target.execute("SELECT COUNT(*) FROM experiments").fetchone()[0],
                           "catalog_id": json.loads(target.execute("SELECT value FROM app_settings WHERE key='catalog_id'").fetchone()[0])}
            finally:
                target.close()
            conventions = self.local_catalog_bytes()
        return files, sources, summary, conventions

    def backup(self, destination):
        with self.file_copy_lock, tempfile.TemporaryDirectory() as folder:
            snapshot = Path(folder) / "experiments.sqlite3"
            files, review_sources, summary, conventions = self.snapshot_database(snapshot)
            # Prevent purge from removing snapshot files during compression without blocking other writes.
            with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
                archive.write(snapshot, "data/experiments.sqlite3")
                for file in files:
                    stored = Path(file["name"]).suffix.lower() in COMPRESSED_SUFFIXES
                    archive.write(self.files / file["id"], "data/files/" + file["id"],
                                  compress_type=zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED)
                for source in review_sources:
                    archive.write(self.data / "review-sources" / source["id"], "data/review-sources/" + source["id"],
                                  compress_type=zipfile.ZIP_STORED)
                if conventions is not None:
                    archive.writestr("data/" + LOCAL_CATALOG, conventions)
                archive.writestr("RESTORE.txt", "Experiment Data Catalog backup\nStop the app before restoring. Keep the existing data folder as a separate backup. Extract this archive into a fresh copy of the app folder (never merge two data folders), then start the app. The data folder includes all records, archived records, and attachments. CSV exports alone are not full backups.\n")
        return {"records": summary["records"], "files": len(files), "bytes": sum(item["size"] for item in files)}

    def record_zip_backup(self, summary):
        self.put_setting("last_backup", {"kind": "zip", "path": "", "time": timestamp(), "records": summary["records"],
                                         "files": summary["files"], "bytes": summary["bytes"]})

    def backup_status(self):
        with self.connect() as db:
            last, folder = self.setting(db, "last_backup"), self.setting(db, "backup_folder", "")
        with self.backup_state_lock:
            progress = dict(self.backup_progress)
        return {**progress, "last": last, "folder": folder, "stale_after_days": STALE_BACKUP_DAYS}

    def set_backup_progress(self, **values):
        with self.backup_state_lock:
            self.backup_progress.update(values)

    def backup_target(self, value):
        """Validate a folder for incremental backups; never allow writing into a live catalog."""
        if not isinstance(value, str) or not value.strip() or len(value) > 1000 or any(ord(c) < 32 for c in value):
            raise Problem("请填写备份文件夹的完整路径。")
        target = Path(value.strip()).expanduser()
        if not target.is_absolute():
            raise Problem("请填写备份文件夹的完整路径，例如 E:\\实验数据备份。")
        target = target.resolve()
        live = self.data.resolve()
        mirror = target / "data"
        if target == live or target.is_relative_to(live) or mirror == live or live.is_relative_to(mirror):
            raise Problem("备份文件夹不能是当前实验库的数据目录或其子目录，请选择另一个位置（最好是另一块磁盘）。")
        if target.exists() and not target.is_dir():
            raise Problem("备份路径已存在且不是文件夹。")
        if (mirror / DataDirLock.FILENAME).exists():
            self.lock_backup_destination(mirror).release()
        self.check_backup_catalog(target)
        return target

    @staticmethod
    def lock_backup_destination(mirror):
        try:
            return DataDirLock(mirror)
        except DataDirInUse as exc:
            raise Problem("目标文件夹是一个正在使用的实验库，不是备份位置。") from exc
        except CatalogUnavailable as exc:
            raise Problem(str(exc)) from exc

    def check_backup_catalog(self, target):
        marker = target / BACKUP_MARKER
        if marker.exists():
            try:
                info = json.loads(marker.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                raise Problem("目标文件夹的备份说明文件无法读取，请换一个空文件夹。")
            with self.connect() as db:
                catalog_id = self.setting(db, "catalog_id")
            if info.get("catalog_id") != catalog_id:
                raise Problem("目标文件夹保存的是另一个实验库的备份，请换一个文件夹。", 409)
        elif (target / "data" / "experiments.sqlite3").exists():
            raise Problem("目标文件夹已有实验库文件，但不是本程序生成的备份。请换一个空文件夹。", 409)

    def start_folder_backup(self, payload):
        if not self.backup_guard.acquire(blocking=False):
            raise Problem("已有备份正在进行，请等待完成。", 409)
        try:
            target = self.backup_target(payload.get("path") if isinstance(payload, dict) else None)
            verify = bool(payload.get("verify"))
            self.set_backup_progress(state="running", phase="prepare", target=str(target), verify=verify, error="",
                                     started_at=timestamp(), finished_at="", total_files=0, done_files=0,
                                     copied_files=0, total_bytes=0, done_bytes=0, copied_bytes=0)
            worker = threading.Thread(target=self.run_folder_backup, args=(target, verify), name="catalog-backup", daemon=True)
            worker.start()
        except Exception:
            self.backup_guard.release()
            raise
        return self.backup_status()

    def run_folder_backup(self, target, verify):
        try:
            result = self.folder_backup(target, verify)
            self.set_backup_progress(state="done", phase="done", finished_at=timestamp(), **result)
        except Exception as exc:
            if not isinstance(exc, (Problem, OSError)):
                import traceback
                traceback.print_exc()
            message = str(exc) if isinstance(exc, Problem) else "备份未完成：" + str(exc)
            self.set_backup_progress(state="failed", error=message, finished_at=timestamp())
        finally:
            self.backup_guard.release()

    @staticmethod
    def copy_verified(source, destination, expected, progress):
        """Copy through a temporary name and publish only when the checksum matches."""
        partial = destination.with_name(".part-" + destination.name)
        digest = hashlib.sha256()
        try:
            with source.open("rb") as reader, partial.open("wb") as writer:
                for chunk in iter(lambda: reader.read(4 * 1024 * 1024), b""):
                    digest.update(chunk)
                    writer.write(chunk)
                    progress(len(chunk))
                writer.flush()
                os.fsync(writer.fileno())
            if digest.hexdigest() != expected:
                raise Problem(f"附件校验值不一致，备份未完成：{source.name}", 409)
            os.replace(partial, destination)
        finally:
            partial.unlink(missing_ok=True)

    @staticmethod
    def file_digest(path):
        digest = hashlib.sha256()
        with path.open("rb") as reader:
            for chunk in iter(lambda: reader.read(4 * 1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def folder_backup(self, target, verify=False):
        lock = self.lock_backup_destination(target / "data")
        try:
            self.check_backup_catalog(target)
            return self.write_folder_backup(target, verify)
        finally:
            lock.release()

    def write_folder_backup(self, target, verify):
        """Mirror the catalog into target/data. Attachments are immutable, so only new files are copied.

        Publish the database snapshot before updating the conventions file.
        """
        mirror = target / "data"
        history = target / "db-history"
        for folder in (mirror / "files", mirror / "review-sources", history):
            folder.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        snapshot = mirror / ".part-experiments.sqlite3"
        history_copy = history / ".part-experiments.sqlite3"
        snapshot.unlink(missing_ok=True)
        try:
            with self.file_copy_lock:
                files, sources, summary, conventions = self.snapshot_database(snapshot)
                check = sqlite3.connect(snapshot)
                try:
                    if check.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                        raise Problem("数据库快照完整性检查未通过，备份未完成。请查看服务日志。", 500)
                finally:
                    check.close()
                entries = [(self.files / item["id"], mirror / "files" / item["id"], item["sha256"], item.get("size"), item["name"]) for item in files]
                entries += [(self.data / "review-sources" / item["id"], mirror / "review-sources" / item["id"], item["sha256"], None, item["name"]) for item in sources]
                missing = [name for source, _, _, _, name in entries if not source.is_file()]
                if missing:
                    raise Problem("以下附件在实验库中缺失，备份未完成：" + "、".join(missing[:5]) + (" 等" if len(missing) > 5 else ""), 409)
                pending = []
                for source, destination, expected, size, name in entries:
                    size = source.stat().st_size if size is None else size
                    if destination.is_file() and destination.stat().st_size == size and (not verify or self.file_digest(destination) == expected):
                        continue
                    pending.append((source, destination, expected, size))
                needed = sum(size for *_, size in pending) + snapshot.stat().st_size * 2
                free = shutil.disk_usage(target).free
                if free < needed + 64 * 1024 * 1024:
                    raise Problem(f"备份磁盘空间不足：还需要约 {needed / 1e9:.2f} GB，可用 {free / 1e9:.2f} GB。", 507)
                total_bytes = sum(size for *_, size in pending)
                self.set_backup_progress(phase="files", total_files=len(entries), done_files=len(entries) - len(pending),
                                         total_bytes=total_bytes, done_bytes=0)
                copied = 0

                def advance(count):
                    nonlocal copied
                    copied += count
                    self.set_backup_progress(done_bytes=copied)

                for index, (source, destination, expected, _) in enumerate(pending, 1):
                    self.copy_verified(source, destination, expected, advance)
                    self.set_backup_progress(done_files=len(entries) - len(pending) + index, copied_files=index)
            self.set_backup_progress(phase="database")
            database = mirror / "experiments.sqlite3"
            catalog_path = mirror / LOCAL_CATALOG
            prepared = nullcontext() if conventions is None else prepare_file_replacement(catalog_path, conventions)
            with prepared as part:
                shutil.copy2(snapshot, history_copy)
                with history_copy.open("r+b") as copied_db:
                    os.fsync(copied_db.fileno())
                if self.file_digest(history_copy) != self.file_digest(snapshot):
                    raise Problem("数据库快照完整性检查未通过，备份未完成。请查看服务日志。", 500)
                os.replace(snapshot, database)
                os.replace(history_copy, history / f"experiments-{stamp}.sqlite3")
                if part is None:
                    catalog_path.unlink(missing_ok=True)
                else:
                    os.replace(part, catalog_path)
            for old in sorted(history.glob("experiments-*.sqlite3"))[:-DB_HISTORY_KEEP]:
                old.unlink(missing_ok=True)
        finally:
            snapshot.unlink(missing_ok=True)
            history_copy.unlink(missing_ok=True)
        info = {"app": "experiment-data-catalog-backup", "catalog_id": summary["catalog_id"], "schema_version": SCHEMA_VERSION,
                "time": timestamp(), "records": summary["records"], "files": len(files), "review_sources": len(sources),
                "bytes": sum(item["size"] for item in files)}
        marker = target / BACKUP_MARKER
        with prepare_file_replacement(marker, json.dumps(info, ensure_ascii=False, indent=2).encode("utf-8")) as part:
            os.replace(part, marker)
        (target / "RESTORE.txt").write_text(
            "Experiment Data Catalog folder backup / 实验数据目录文件夹备份\n\n"
            "data/ is a complete catalog folder (database, attachments, source photos). db-history/ keeps earlier database snapshots.\n"
            "To restore: stop the app, keep the current data folder aside, copy this data/ folder into a fresh copy of the app folder "
            "(or open it with --data-dir), then start the app. Never merge two data folders.\n\n"
            "data/ 是完整的实验库目录（数据库、附件、来源照片），db-history/ 保留历次数据库快照。\n"
            "恢复：先停止程序，把现有 data 文件夹另存，再把这里的 data 文件夹复制到一份干净的程序目录（或用 --data-dir 打开），然后启动。不要合并两个 data 文件夹。\n",
            encoding="utf-8")
        record = {"kind": "folder", "path": str(target), "time": info["time"], "records": info["records"],
                  "files": info["files"], "bytes": info["bytes"], "copied_files": len(pending), "copied_bytes": total_bytes}
        self.put_setting("last_backup", record)
        self.put_setting("backup_folder", str(target))
        return {"copied_files": len(pending), "copied_bytes": total_bytes}


def export_csv(records, language="zh", *, include_template=False, project_settings=None):
    project_fields, key_columns = {}, {}
    if project_settings:
        records = list(records)
        selected = {record["project_id"] for record in records}
        for project, entry in project_settings.items():
            if project in selected:
                project_fields[project] = {}
                for info in entry["fields"]:
                    identity = key_field_identity(info)
                    project_fields[project][identity] = info
                    if identity not in key_columns or (info["available"] and not key_columns[identity]["available"]):
                        key_columns[identity] = info
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    columns = [("sample_id", "样品编号"), ("series", "实验系列"), ("experiment_date", "实验日期"),
               ("precursor", "前驱体"), ("temperature", "温度 (°C)"), ("duration", "反应/取样时间 (min)"),
               ("solvent", "溶剂 / 配体"), ("status", "记录状态"), ("notes", "备注"), ("experiment_no", "实验编号"), ("project_name", "实验项目")]
    english = language == "en"
    headings = ["Sample ID", "Experiment series", "Experiment date", "Precursor", "Temperature (°C)",
                "Reaction / sampling time (min)", "Solvents / ligands", "Record status", "Notes", "Experiment number", "Project"] if english else [label for _, label in columns]
    headings += ["Custom conditions (JSON)", "Attachments (JSON)", "Material amounts (JSON)", "Phases", "Morphologies", "Result confirmation", "Result conclusion", "Result summary (JSON)", "Archived", "Solvents / ligands (JSON)"] if english else [
        "自定义条件 (JSON)", "附件 (JSON)", "添加量 (JSON)", "物相", "形貌", "结果确认", "结果结论", "结果摘要 (JSON)", "已归档", "溶剂 / 配体 (JSON)"]
    if include_template:
        headings += ["Sample details (JSON)", "Template (JSON)"] if english else ["样品扩展数据 (JSON)", "实验模板 (JSON)"]
    statuses = dict(zip(STATUSES, ("Incomplete", "Recorded", "Awaiting analysis", "Complete")))
    confirmations = {"": "", "pending": "Pending confirmation" if english else "待确认", "confirmed": "Confirmed" if english else "已确认"}

    def cell(value):
        # Excel must treat untrusted sample names and notes as text, not formulas.
        if isinstance(value, str) and (value.lstrip().startswith(("=", "+", "-", "@")) or value.startswith(("\t", "\r"))):
            return "'" + value
        return value

    for info in key_columns.values():
        label, unit = info["label"], info["unit"]
        headings.append(cell(f"{label} ({unit})" if info["type"] == "number" else label))
    writer.writerow(headings)
    for record in records:
        result = {**EMPTY_RESULT, **record.get("result_summary", {})}
        row = [cell(material_summary(record) if key == "solvent" else statuses.get(record[key], record[key]) if english and key == "status" else record[key]) for key, _ in columns] + [
            json.dumps(record["extra_conditions"], ensure_ascii=False),
            json.dumps(record["files"], ensure_ascii=False), json.dumps(record.get("material_amounts", []), ensure_ascii=False),
            cell(" / ".join(result["phases"])), cell(" / ".join(result["morphologies"])), confirmations[result["confirmation"]], cell(result["conclusion"]), json.dumps(result, ensure_ascii=False),
            ("Yes" if record["archived"] else "No") if english else ("是" if record["archived"] else "否"),
            json.dumps(record_materials(record), ensure_ascii=False)]
        if include_template:
            row.extend(json.dumps(record.get(field, {}), ensure_ascii=False) for field in ("lab_data", "template"))
        infos = project_fields.get(record.get("project_id"), {})
        for identity, column in key_columns.items():
            info = infos.get(identity)
            field, value = resolve_key_field(record.get("template"), record.get("lab_data", {}), info)
            if isinstance(value, list):
                value = " / ".join(value)
            elif value is not None and field["type"] == "number" and (field["unit"] != info["unit"] or field["unit"] != column["unit"]):
                value = f"{value} {field['unit']}"
            row.append(cell(value))
        writer.writerow(row)
    return output.getvalue().encode("utf-8-sig")


class Handler(BaseHTTPRequestHandler):
    server_version = "ExperimentDataCatalog/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(60)

    def log_request(self, code="-", size="-"):
        # The parsed route omits launch parameters and the instance prefix.
        path = quote(getattr(self, "route", "[redacted]"), safe="/[]")
        self.log_message('"%s %s %s" %s %s', self.command, path, self.request_version, code, size)

    def log_message(self, format, *args):
        # Malformed request lines can also appear in parser errors.
        message = format % args
        for credential in (self.server.session_token, self.server.instance):
            message = message.replace(credential, "[redacted]")
        super().log_message("%s", message)

    def send_headers(self, status, content_type, length, filename=None, *, headers=()):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        if filename:
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(filename))
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()

    def send_json(self, value, status=200):
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_headers(status, "application/json; charset=utf-8", len(data))
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_file(self, path, content_type, filename=None, *, status=200):
        with path.open("rb") as stream:
            self.send_headers(status, content_type, os.fstat(stream.fileno()).st_size, filename)
            if self.command != "HEAD":
                shutil.copyfileobj(stream, self.wfile)

    def body_length(self, maximum):
        try:
            size = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            raise Problem("请求长度无效。")
        if self.headers.get("Transfer-Encoding") or size < 0 or size > maximum:
            raise Problem("请求过大或长度无效。", 413)
        return size

    def json_body(self, maximum=1024 * 1024):
        if self.headers.get_content_type() != "application/json":
            raise Problem("请求必须为 JSON。", 415)
        try:
            return json.loads(self.rfile.read(self.body_length(maximum)))
        except (ValueError, UnicodeError):
            raise Problem("JSON 格式不正确。")

    def save_experiment(self, record_id=None):
        store, payload = self.server.store, self.json_body()
        with store.lock:
            saved_id = store.save(payload, record_id)
            records = store.list()
            record = next(row for row in records if row["id"] == saved_id)
            result = {"id": saved_id, "record": record, "condition_options": store.catalog()["condition_options"]}
            if "shared_token" in payload:
                project = record["project_id"]
                prefixes = store.grouping_prefixes
                key = experiment_key(record["experiment_no"], prefixes)
                result["records"] = [row for row in records if row["project_id"] == project
                                     and experiment_key(row["experiment_no"], prefixes) == key and not row["archived"] and not is_dataset(row)]
        return self.send_json(result, 200 if record_id else 201)

    def valid_token(self, value):
        return bool(value and value.isascii() and secrets.compare_digest(value, self.server.session_token))

    def valid_cookie(self):
        # A legacy Path=/ cookie may follow the current cookie in the same header.
        for header in self.headers.get_all("Cookie", []):
            for pair in header.split(";"):
                name, _, value = pair.strip().partition("=")
                if name == "catalog_session" and self.valid_token(value.strip('"')):
                    return True
        return False

    def locked_page(self, status=401):
        return self.send_file(ROOT / "web" / "locked.html", "text/html; charset=utf-8", status=status)

    def root_page(self, query):
        params = parse_qsl(query, keep_blank_values=True)
        if any(name == "token" and self.valid_token(value) for name, value in params):
            remaining = urlencode([(name, value) for name, value in params if name != "token"])
            prefix = self.server.session_prefix
            location = prefix + "?" + remaining if remaining else prefix
            cookie = f"catalog_session={self.server.session_token}; HttpOnly; SameSite=Strict; Path={prefix}"
            return self.send_headers(303, "text/html; charset=utf-8", 0, headers=(("Location", location), ("Set-Cookie", cookie)))
        return self.locked_page()

    def parse_request(self):
        if not super().parse_request():
            return False
        try:
            return self.authorize_request()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return False

    def authorize_request(self):
        self.allowed_hosts = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        if self.headers.get("Host") not in self.allowed_hosts:
            self.send_json({"error": "仅接受本机地址访问。"}, 403)
            return False
        try:
            self.url = urlsplit(self.path)
        except ValueError:
            self.send_json({"error": "找不到该页面或操作。"}, 404)
            return False
        path = unquote(self.url.path)
        namespaced = path.startswith("/s/")
        self.scoped = path.startswith(self.server.session_prefix)
        self.route = "/" + path[3:].partition("/")[2] if namespaced else path
        api = self.route == "/api" or self.route.startswith("/api/")
        if namespaced:
            if self.scoped and self.valid_cookie():
                return True
            if not api:
                self.locked_page()
                return False
        elif not api or self.valid_token(self.headers.get("X-Catalog-Token")):
            return True
        elif self.command == "GET" and self.route == "/api/health":
            self.send_json({"app": APP_ID, "version": 1})
            return False
        self.send_json({"error": "会话已失效，请从启动入口重新打开实验数据目录。"}, 401)
        return False

    def dispatch(self):
        path, store = self.route, self.server.store
        if self.command != "GET":
            if self.headers.get("Origin") not in {"http://" + host for host in self.allowed_hosts} or self.headers.get("X-Catalog-Local") != "1":
                raise Problem("请从本机实验数据目录页面操作。", 403)
        query = parse_qs(self.url.query, keep_blank_values=self.command == "POST" and path.endswith("/files"))
        if path == "/api/local-catalog" and self.command == "GET":
            return self.send_json(store.get_local_catalog())
        if path == "/api/local-catalog" and self.command == "PUT":
            return self.send_json(store.save_local_catalog(self.json_body(MAX_CATALOG_JSON)))
        settings_match = re.fullmatch(r"/api/projects/([^/]+)/settings", path)
        if settings_match and self.command == "GET":
            return self.send_json(store.get_project_settings(settings_match[1]))
        if settings_match and self.command == "PUT":
            return self.send_json(store.save_project_settings(settings_match[1], self.json_body()))
        if self.command == "GET":
            if path == "/":
                if self.scoped:
                    return self.send_file(ROOT / "web" / "index.html", "text/html; charset=utf-8")
                return self.root_page(self.url.query)
            if path == "/locked.html":
                return self.locked_page(200)
            if path == "/locked.css":
                return self.send_file(ROOT / "web" / "locked.css", "text/css; charset=utf-8")
            if self.scoped:
                static = {"/app.js": ("web/app.js", "text/javascript"),
                          "/i18n.js": ("web/i18n.js", "text/javascript"),
                          "/newapi-theme.css": ("web/newapi-theme.css", "text/css"),
                          "/style.css": ("web/style.css", "text/css"),
                          "/notices.txt": ("THIRD_PARTY_NOTICES.txt", "text/plain"),
                          "/license.txt": ("LICENSE", "text/plain")}
                if path in static:
                    name, mime = static[path]
                    return self.send_file(ROOT / name, mime + "; charset=utf-8")
            elif path.endswith(".html"):
                return self.locked_page()
            if path == "/api/health":
                return self.send_json({"app": APP_ID, "version": 1, "workspace": str(store.data.resolve())})
            if path == "/api/source.zip":
                from package_app import FILES, PACKAGE_NAME
                with tempfile.TemporaryDirectory() as folder:
                    archive_path = Path(folder) / (PACKAGE_NAME + "-source.zip")
                    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
                        for name in FILES:
                            archive.write(ROOT / name, PACKAGE_NAME + "/" + name)
                    return self.send_file(archive_path, "application/zip", PACKAGE_NAME + "-source.zip")
            if path == "/api/experiments":
                with store.lock, store.connect() as db:
                    local = store.local_catalog()
                    conventions = store.conventions(local)
                    project_settings = store.project_settings_map(db, conventions["phase_presets"])
                    conventions["phase_presets"].update({project: entry["settings"]["phase_presets"]
                                                         for project, entry in project_settings.items() if entry["revision"]})
                    result = {"experiments": store.list(), **store.catalog(), "backup": store.backup_status(),
                              "translations": store.local_translations(local), "conventions": conventions,
                              "project_settings": project_settings,
                              "trash_count": store.trash_count(db), "category_counts": store.category_counts(db)}
                return self.send_json(result)
            if path == "/api/trash":
                return self.send_json(store.trash(query.get("project_id", [""])[0]))
            if path == "/api/backup/status":
                return self.send_json(store.backup_status())
            if path == "/api/experiment-defaults":
                return self.send_json(store.shared_defaults(query.get("project_id", [""])[0], query.get("experiment_no", [""])[0]))
            if path == "/api/condition-options":
                return self.send_json({"condition_options": store.catalog()["condition_options"]})
            if path == "/api/history":
                offset = query.get("offset", ["0"])[0]
                if not offset.isdecimal():
                    raise Problem("历史记录分页不正确。")
                return self.send_json(store.history(query.get("record_id", [""])[0], query.get("project_id", [""])[0], int(offset)))
            if re.fullmatch(r"/api/history/[a-f0-9]{32}", path):
                return self.send_json(store.history_detail(path.rsplit("/", 1)[-1]))
            if path == "/api/reviews":
                return self.send_json(store.review_list())
            if re.fullmatch(r"/api/folder-import/receipts/[a-f0-9]{32}", path):
                return self.send_json(store.folder_receipt(path.rsplit("/", 1)[-1]))
            if re.fullmatch(r"/api/review-sources/[a-f0-9]{32}", path):
                return self.send_file(*store.review_source(path.rsplit("/", 1)[-1]))
            match = re.fullmatch(r"/api/files/([a-f0-9]{32})(/preview)?", path)
            if match:
                file_id, action = match.groups()
                try:
                    if action:
                        preview = store.preview(file_id)
                        if isinstance(preview, dict):
                            return self.send_json(preview)
                        return self.send_file(*preview)
                    file_path, name = store.file(file_id)
                    return self.send_file(file_path, "application/octet-stream", name)
                except FileNotFoundError:
                    raise Problem("附件文件缺失，请检查数据目录或备份。", 404)
            if path == "/api/export.csv":
                selected = set(query.get("ids", [""])[0].split(","))
                with store.lock, store.connect() as db:
                    records = [record for record in store.list() if record["id"] in selected]
                    project_settings = store.project_settings_map(db, {})
                data = export_csv(records, query.get("lang", ["zh"])[0], project_settings=project_settings)
                self.send_headers(200, "text/csv; charset=utf-8", len(data), "Experiment-data.csv")
                return self.wfile.write(data)
            if path == "/api/experiments/share.zip":
                lang = query.get("lang", ["zh"])[0]
                revisions = query.get("revisions", [""])[0].split(",")
                if any(not re.fullmatch(r"[1-9][0-9]{0,14}", version) for version in revisions):
                    raise Problem("Select experiments to export." if lang == "en" else "请选择要导出的实验。")
                try:
                    with tempfile.TemporaryDirectory() as folder:
                        package = Path(folder) / "experiments.zip"
                        store.share_experiments(query.get("ids", [""])[0].split(","), list(map(int, revisions)), package, lang)
                        return self.send_file(package, "application/zip", "Experiments-" + date.today().isoformat() + ".zip")
                except OSError as exc:
                    if exc.errno != errno.ENOSPC:
                        raise
                    raise Problem("Free up temporary disk space or export fewer experiments." if lang == "en" else "临时磁盘空间不足，请腾出空间或减少导出的实验。", 507) from exc
            if path == "/api/backup.zip":
                if not store.backup_guard.acquire(blocking=False):
                    raise Problem("已有备份正在进行，请等待完成。", 409)
                try:
                    with tempfile.TemporaryDirectory() as folder:
                        backup = Path(folder) / "backup.zip"
                        summary = store.backup(backup)
                        self.send_file(backup, "application/zip", "Experiment-Data-Catalog-backup-" + date.today().isoformat() + ".zip")
                    store.record_zip_backup(summary)
                    return
                except OSError as exc:
                    if exc.errno != errno.ENOSPC:
                        raise
                    raise Problem("临时磁盘空间不足，无法生成 ZIP。请改用“备份到文件夹”。", 507) from exc
                finally:
                    store.backup_guard.release()
        if self.command == "POST":
            match = re.fullmatch(r"/api/files/([a-f0-9]{32})/(update|delete)", path)
            if match:
                return self.send_json(store.change_file(*match.groups(), self.json_body()))
            match = re.fullmatch(r"/api/trash/([a-f0-9]{32})/restore", path)
            if match:
                return self.send_json(store.change_file(match[1], "restore", self.json_body()))
            if path == "/api/trash/purge":
                return self.send_json(store.purge_trash(self.json_body()))
        if self.command == "POST" and path in ("/api/projects", "/api/categories", "/api/condition-options"):
            return self.send_json(store.add_catalog_item(path.rsplit("/", 1)[-1], self.json_body()), 201)
        if self.command == "POST" and path == "/api/backup/folder":
            return self.send_json(store.start_folder_backup(self.json_body()), 202)
        if self.command == "POST" and path == "/api/experiments/status":
            return self.send_json(store.update_status(self.json_body()))
        if self.command == "PUT" and path == "/api/templates":
            return self.send_json(store.save_template(self.json_body()))
        if self.command == "POST" and path == "/api/folder-import/preview":
            return self.send_json(store.preview_folder(self.json_body()))
        if self.command == "POST" and path == "/api/folder-import/issues":
            return self.send_json(store.folder_issues(self.json_body()), 201)
        if self.command == "POST" and path == "/api/folder-import/file":
            relative = folder_path(query.get("path", [""])[0])
            project = lab_text(query.get("project_id", [""])[0], 40, required=True)
            sample = lab_text(query.get("sample_id", [""])[0], 120, required=True)
            number = lab_text(query.get("experiment_no", [""])[0], 120, required=True)
            expected = query.get("record_id", [""])[0]
            receipt = query.get("receipt", [""])[0]
            if not re.fullmatch(r"[a-f0-9]{32}", receipt) or (expected and not re.fullmatch(r"[a-f0-9]{32}", expected)):
                raise Problem("文件夹导入预览格式不正确。")
            return self.send_json(store.add_file(expected, relative.rsplit("/", 1)[-1], query.get("kind", [""])[0],
                                                 self.rfile, self.body_length(MAX_FILE), source=relative,
                                                 folder_target=(project, sample, number), receipt=receipt), 201)
        if self.command == "POST" and path == "/api/experiments/bulk":
            return self.send_json(store.bulk_update(self.json_body()))
        if self.command == "POST" and re.fullmatch(r"/api/history/[a-f0-9]{32}/undo", path):
            return self.send_json(store.undo_history(path.split("/")[-2], self.json_body()))
        if self.command == "POST" and path == "/api/reviews":
            return self.send_json(store.add_review(self.json_body()), 201)
        if self.command == "POST" and re.fullmatch(r"/api/reviews/[a-f0-9]{32}/decide", path):
            return self.send_json(store.decide_review(path.split("/")[-2], self.json_body()))
        if self.command == "DELETE" and path == "/api/categories":
            return self.send_json(store.delete_category(self.json_body()))
        if self.command == "DELETE" and path == "/api/condition-options":
            return self.send_json(store.delete_condition_option(self.json_body()))
        if self.command == "POST" and path == "/api/experiments":
            return self.save_experiment()
        if self.command == "POST" and path == "/api/shutdown":
            self.send_json({"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        match = re.fullmatch(r"/api/experiments/([a-f0-9]{32})(/archive|/files)?", path)
        if match:
            record_id, action = match.groups()
            if self.command == "PUT" and action is None:
                return self.save_experiment(record_id)
            if self.command == "POST" and action == "/archive":
                store.archive(record_id, self.json_body())
                return self.send_json({"ok": True})
            if self.command == "POST" and action == "/files":
                file_id = store.add_file(record_id, query.get("name", [""])[0], query.get("kind", [""])[0],
                                         self.rfile, self.body_length(MAX_FILE),
                                         project_id=query.get("project_id", [None])[0], sample_id=query.get("sample_id", [None])[0])
                return self.send_json({"id": file_id}, 201)
        raise Problem("找不到该页面或操作。", 404)

    def handle_request(self):
        try:
            self.dispatch()
        except Problem as exc:
            if (self.route in ("/api/experiments/share.zip", "/api/backup.zip")
                    and "text/html" in self.headers.get("Accept", "")):
                message = str(exc).encode("utf-8")
                self.send_headers(exc.status, "text/plain; charset=utf-8", len(message))
                self.wfile.write(message)
                return
            self.send_json({"error": str(exc)}, exc.status)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception:
            import traceback
            traceback.print_exc()
            self.send_json({"error": "操作未完成，请检查磁盘空间及服务日志；页面内容尚未清空。"}, 500)

    do_GET = do_POST = do_PUT = do_DELETE = handle_request
    do_HEAD = do_PATCH = do_OPTIONS = do_TRACE = do_CONNECT = handle_request


class LocalHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def make_server(data_dir, port=8765, *, server_type=LocalHTTPServer):
    # Bind first so a second launch of the same service still reaches the "already running" path in main().
    server = server_type(("127.0.0.1", port), Handler)
    try:
        lock = DataDirLock(data_dir)
    except BaseException:
        server.server_close()
        raise
    session_path = lock.path.with_name(SESSION_FILE)
    temporary = None
    try:
        server.daemon_threads = False  # Finish in-flight writes before the process exits.
        server.store = Store(data_dir)
        server.store.reconcile_storage()
        server.session_token = secrets.token_urlsafe(32)
        server.instance = secrets.token_hex(16)
        server.session_prefix = f"/s/{server.instance}/"
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=session_path.parent,
                                         prefix=".part-catalog-session-", delete=False) as output:
            temporary = Path(output.name)
            json.dump({"port": server.server_port, "token": server.session_token,
                       "instance": server.instance, "pid": os.getpid(), "started_at": timestamp()}, output)
        temporary.replace(session_path)
    except BaseException:
        try:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        finally:
            lock.release()
            server.server_close()
        raise
    close = server.server_close

    def server_close():
        try:
            close()
        finally:
            if lock.handle is not None:
                try:
                    session_path.unlink(missing_ok=True)
                finally:
                    lock.release()

    server.server_close = server_close
    return server


def launch_url(port, token, **params):
    return f"http://127.0.0.1:{port}/?" + urlencode({**params, "token": token})


def running_session(data_dir, *, stop=False):
    session = json.loads((data_dir / SESSION_FILE).read_text(encoding="utf-8"))
    if not isinstance(session, dict):
        raise ValueError("Invalid local session file.")
    port, token = session.get("port"), session.get("token")
    if type(port) is not int or not 1 <= port <= 65535 or not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
        raise ValueError("Invalid local session file.")
    # Talk directly to loopback so the credential stays off proxies and redirects.
    headers = {"X-Catalog-Token": token}
    client = HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        client.request("GET", "/api/health", headers=headers)
        with client.getresponse() as response:
            health = json.load(response)
            if (response.status != 200 or not isinstance(health, dict) or health.get("app") != APP_ID or
                    health.get("workspace") != str(data_dir.resolve())):
                raise ValueError("This port belongs to another workspace.")
        if stop:
            headers.update({"Origin": f"http://127.0.0.1:{port}", "X-Catalog-Local": "1"})
            client.request("POST", "/api/shutdown", headers=headers)
            with client.getresponse() as response:
                stopped = json.load(response)
                if response.status != 200 or not isinstance(stopped, dict) or not stopped.get("ok"):
                    raise ValueError("The local server did not accept the shutdown request.")
    finally:
        client.close()
    return port, token


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--open", action="store_true")
    parser.add_argument("--stop", action="store_true", help="Stop this workspace's running local server")
    args = parser.parse_args()
    if args.stop:
        try:
            running_session(args.data_dir, stop=True)
        except (OSError, ValueError, HTTPException) as exc:
            raise SystemExit(f"Could not stop this workspace: {exc}")
        print("Experiment Data Catalog is stopping. Saved experiments and files are kept.")
        return
    try:
        server = make_server(args.data_dir, args.port)
    except (CatalogUnavailable, OSError) as exc:
        if args.open:
            try:
                session = running_session(args.data_dir)
            except (OSError, ValueError, HTTPException):
                pass
            else:
                webbrowser.open(launch_url(*session))
                return
        if isinstance(exc, CatalogUnavailable):
            raise SystemExit(str(exc))
        raise SystemExit(f"Port {args.port} is unavailable. Use --port with another local port.")
    print(f"Experiment Data Catalog: http://127.0.0.1:{server.server_port}\nData: {server.store.data}", flush=True)
    try:
        if args.open:
            webbrowser.open(launch_url(server.server_port, server.session_token))
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
