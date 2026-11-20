"""Run with: py -3.9 -m unittest -v test_server.py (temporary data only)."""
import csv
import hashlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from contextlib import contextmanager
from http.client import HTTPConnection
from http.cookiejar import CookieJar
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen
from urllib.parse import urlencode

import server
from server import Store, Problem, export_csv, make_server, validate, experiment_number

server.NOTEBOOK_PREFIXES.add("XY")  # Synthetic notebook prefix used throughout these tests.


def launch_request(service, **params):
    client = HTTPConnection("127.0.0.1", service.server_port, timeout=3)
    try:
        client.request("GET", "/?" + urlencode(params))
        with client.getresponse() as response:
            return response.status, response.read(), response.headers
    finally:
        client.close()


def session_cookie(service):
    status, _, headers = launch_request(service, token=service.session_token)
    if status != 303:
        raise AssertionError(f"Expected session redirect, received {status}")
    return headers["Set-Cookie"].split(";", 1)[0]


@contextmanager
def serving(service):
    thread = threading.Thread(target=service.serve_forever, daemon=True)
    thread.start()
    try:
        yield
    finally:
        service.shutdown()
        thread.join()


class StoreTests(unittest.TestCase):
    def test_shared_conditions_preserve_overrides_and_aliquot_times(self):
        amount = [{"name": "ODE", "amount": 0.5, "unit": "g"}]
        fields = {"precursors": ["B", "A"], "temperature": 250, "solvents": ["ODE"], "material_amounts": amount}
        a = self.store.save({"sample_id": "XY-1-780_5", **fields, "duration": 5})
        b = self.store.save({"sample_id": "XY-I-780_10", **fields, "duration": 10, "notes": "Sample note"})
        blank = self.store.save({"sample_id": "XY-I-780_15", "temperature": None, "precursors": [], "solvents": [], "duration": 15})
        archived = self.store.save({"sample_id": "XY-I-780_20", **fields, "duration": 20})
        self.store.archive(archived, {"archived": True, "revision": 1})
        dataset = self.store.save({"sample_id": "资料集-580", "experiment_no": "XY-I-780", "notes": "批量导入：local-test", "temperature": 250})
        project = self.store.add_catalog_item("projects", {"name": "Other lab"})["project"]["id"]
        separate = self.store.save({"sample_id": "XY-I-780_10", "project_id": project, "temperature": 250})
        with self.store.connect() as db:
            db.execute("DELETE FROM experiment_defaults")  # Model an existing catalog before the feature.
        attachment = self.store.add_file(b, "trace.csv", "XRD", io.BytesIO(b"1,2"), 3)

        def rows():
            return {row["id"]: row for row in self.store.list()}

        def defaults():
            return self.store.shared_defaults("default", "xy-I-780")

        def set_shared(temp, token=None):
            self.store.save({**rows()[a], "temperature": temp, "shared_token": token or defaults()["token"]}, a)

        before = rows()
        self.assertEqual(defaults()["count"], 3)
        self.assertEqual(defaults()["conditions"]["temperature"], 250)
        stale = defaults()["token"]
        self.store.save({**before[b], "notes": "Edited elsewhere"}, b)
        latest = rows()
        with self.assertRaises(Problem) as outdated:
            set_shared(260, stale)
        self.assertEqual(outdated.exception.status, 409)
        self.assertEqual(rows(), latest)
        self.assertEqual(defaults()["last_save"], "")

        set_shared(260)
        saved = rows()
        for record_id, time in [(a, 5), (b, 10), (blank, 15)]:
            self.assertEqual((saved[record_id]["temperature"], saved[record_id]["duration"]), (260, time))
            self.assertEqual(saved[record_id]["material_amounts"], amount)
            self.assertEqual(sorted(saved[record_id]["precursors"]), ["A", "B"])
        for record_id in (dataset, archived, separate):
            self.assertEqual(saved[record_id], before[record_id])
        self.assertEqual(saved[b]["notes"], "Edited elsewhere")
        self.assertEqual(saved[b]["files"][0]["id"], attachment)
        self.assertEqual(self.store.history()["batches"][0]["action"], "shared")

        self.store.save({**saved[b], "temperature": 270, "ligand": "", "solvents": [], "material_amounts": []}, b)
        set_shared(270)
        set_shared(300)
        new_id = self.store.save({"sample_id": "XY-I-780_30", "duration": 30})
        from_folder = self.store.add_file("", "aliquot.txt", "NMR", io.BytesIO(b"data"), 4,
                                          folder_target=("default", "XY-I-780_45", "XY-I-780"))["record_id"]
        latest = rows()
        self.assertEqual((latest[b]["temperature"], latest[b]["solvents"], latest[b]["duration"]), (270, [], 10))
        self.assertEqual((latest[blank]["temperature"], latest[blank]["duration"]), (300, 15))
        self.assertEqual((latest[new_id]["temperature"], latest[new_id]["duration"]), (300, 30))
        self.assertEqual((latest[from_folder]["temperature"], latest[from_folder]["duration"]), (300, None))
        self.assertEqual(latest[from_folder]["material_amounts"], amount)

        batch = next(item for item in self.store.history()["batches"] if item["action"] == "shared")
        undo = self.store.undo_history(batch["id"], {"preview": True, "record_ids": [blank]})
        self.store.undo_history(batch["id"], {"preview": False, "record_ids": [blank], "revisions": undo["revisions"]})
        self.assertEqual(rows()[blank]["temperature"], 270)
        self.assertEqual(Store(self.store.data).shared_defaults("default", "XY-1-780")["conditions"]["temperature"], 300)

    def test_individual_save_retains_agreed_defaults_and_explicit_blanks(self):
        group = {"experiment_no": "Test run", "precursors": ["Ni source"], "temperature": 0}
        base = self.store.save({**group, "sample_id": "First"})
        other = self.store.save({**group, "sample_id": "Second"})
        manual = next(row for row in self.store.list() if row["id"] == other)
        self.store.save({**manual, "temperature": None}, other)
        before = self.store.shared_defaults("default", "Test run")
        self.assertEqual(before["conditions"]["temperature"], 0)
        self.store.save({**group, "sample_id": "First", "temperature": 25, "revision": 1, "shared_token": before["token"]}, base)
        self.assertIsNone(next(row for row in self.store.list() if row["id"] == other)["temperature"])

        # Conflicting legacy values do not supply a default for that field.
        self.store.save({"experiment_no": "Uncertain", "sample_id": "Lab A", "temperature": 100})
        self.store.save({"experiment_no": "Uncertain", "sample_id": "Lab B", "temperature": 200})
        with self.store.connect() as db:
            db.execute("DELETE FROM experiment_defaults WHERE experiment_key='uncertain'")
        self.assertIsNone(self.store.shared_defaults("default", "Uncertain")["conditions"]["temperature"])

    def test_precursors_preserve_legacy_names_and_support_bulk_review_and_undo(self):
        legacy = "Legacy mixture A + B"
        record_id = self.store.save({"sample_id": "PRECURSORS", "precursor": legacy})
        row = self.store.list()[0]
        self.assertEqual(row["precursor"], legacy)
        self.assertNotIn("precursors", row)
        particularly_long = ["First " + "x" * 140, "Second " + "y" * 140]
        self.store.save({**row, "precursors": [*particularly_long, particularly_long[0]]}, record_id)
        row = self.store.list()[0]
        self.assertEqual(row["precursors"], particularly_long)
        self.assertEqual(row["precursor"], " + ".join(particularly_long))
        self.assertNotIn(row["precursor"], self.store.catalog()["condition_options"]["precursor"])
        self.store.save({key: value for key, value in row.items() if key != "precursors"}, record_id)
        row = self.store.list()[0]
        self.assertEqual(row["precursors"], particularly_long, "Older clients preserve the unchanged summary")

        plan = {"records": [{"id": record_id, "revision": row["revision"]}],
                "changes": {"precursors": {"mode": "append", "value": ["Third"]}}}
        preview = self.store.bulk_update({**plan, "preview": True})
        self.assertEqual(preview["rows"][0]["changes"],
                         [{"field": "precursors", "before": particularly_long, "after": [*particularly_long, "Third"]}])
        self.store.bulk_update({**plan, "preview": False})
        batch = self.store.history(record_id)["batches"][0]["id"]
        undo = self.store.undo_history(batch, {"preview": True})
        self.store.undo_history(batch, {"preview": False, "revisions": undo["revisions"]})
        self.assertEqual(self.store.list()[0]["precursors"], particularly_long)

        review_id = self.store.add_review({"record_id": record_id, "title": "Resolve precursor", "field": "precursor"})["id"]
        choice = {"preview": False, "revision": 1, "record_revision": self.store.list()[0]["revision"],
                  "status": "resolved", "apply_value": True, "value": ["First", "Second"]}
        self.store.decide_review(review_id, choice)
        self.assertEqual(self.store.list()[0]["precursors"], ["First", "Second"])
        with self.assertRaises(Problem):
            validate({"sample_id": "INVALID", "precursors": ["Valid", "Bad\nname"]})

    def test_adding_precursor_does_not_wait_for_backup_compression(self):
        entered, resume = threading.Event(), threading.Event()
        original_write = zipfile.ZipFile.write

        def pause_compression(archive, *args, **kwargs):
            entered.set()
            if not resume.wait(5):
                raise TimeoutError("Backup fixture did not resume")
            return original_write(archive, *args, **kwargs)

        with patch.object(zipfile.ZipFile, "write", pause_compression), ThreadPoolExecutor(max_workers=2) as workers:
            backup = workers.submit(self.store.backup, self.store.data / "backup.zip")
            try:
                self.assertTrue(entered.wait(3))
                write = workers.submit(self.store.add_catalog_item, "condition-options", {"field": "precursor", "name": "Concurrent choice"})
                self.assertEqual(write.result(timeout=2)["name"], "Concurrent choice")
            finally:
                resume.set()
            backup.result(timeout=3)

    def test_project_template_versions_required_values_and_history(self):
        fields = [
            dict(label="Substrate", type="single", section="condition", options=["Si", "Glass"], required=True),
            dict(label="Dopants", type="multi", section="condition", options=["A", "B"]),
            dict(label="Film thickness", type="number", unit="nm", section="result", required=True),
        ]
        payload = dict(project_id="default", name="Film", fields=fields, revision=0)
        template = self.store.save_template(payload)
        self.assertEqual(template["revision"], 1)
        with self.assertRaises(Problem):
            self.store.save_template(payload)
        film = self.store.save({"sample_id": "FILM"})
        before = self.store.list()[0]
        with self.assertRaises(Problem):
            self.store.update_status({"records": [{"id": film, "revision": 1}], "status": "已完成"})
        with self.assertRaises(Problem):
            self.store.save({**before, "lab_data": {"template_revision": 1, "values": {"2": "0"}}}, film)
        saved = {**before, "status": "已完成",
                 "lab_data": {"template_revision": 1, "outcome": "measured", "values": {"0": "Si", "1": ["A", "B"], "2": 0}}}
        self.store.save(saved, film)
        latest = self.store.save_template({**payload, "revision": 1, "fields": [*fields[:2], {**fields[2], "unit": "µm"}]})
        self.assertEqual(latest["revision"], 2)
        row = self.store.list()[0]
        self.assertEqual(row["template"]["fields"][2]["unit"], "nm")
        self.assertEqual(row["lab_data"]["values"]["2"], 0)
        headers = next(csv.reader(io.StringIO(export_csv([row], "en").decode("utf-8-sig"))))
        self.assertEqual(headers[19:], ["Archived", "Solvents / ligands (JSON)"])
        batch_id = self.store.history(film)["batches"][0]["id"]
        change = self.store.undo_history(batch_id, {"preview": True})
        self.store.undo_history(batch_id, {"preview": False, "revisions": change["revisions"]})
        self.assertEqual(self.store.list()[0]["lab_data"], {"template_revision": 1})
        self.assertEqual(self.store.list()[0]["status"], before["status"])
        with self.assertRaises(Problem) as stale:
            self.store.save({"sample_id": "STALE", "lab_data": {"template_revision": 1}})
        self.assertEqual(stale.exception.status, 409)
        with self.assertRaises(Problem) as stale_without_template:
            self.store.save({"sample_id": "STALE", "lab_data": {"template_revision": 0}})
        self.assertEqual(stale_without_template.exception.status, 409)
        copied = self.store.save({"sample_id": "COPY", "copy_from": film,
                                  "lab_data": {"template_revision": 1, "values": {"0": "Si"}}})
        row = next(row for row in self.store.list() if row["id"] == copied)
        self.assertEqual(row["template"]["revision"], 1)
        current = self.store.save({"sample_id": "FRESH", "lab_data": {}})
        self.assertEqual(next(row for row in self.store.list() if row["id"] == current)["template"]["revision"], 2)

    def test_undo_template_value_preserves_later_result_and_rejects_conflict(self):
        self.store.save_template({"project_id": "default", "revision": 0, "name": "Films", "fields": [
            dict(label="Power", type="number", section="condition"),
            dict(label="Thickness", type="number", section="result"),
        ]})
        record_id = self.store.save({"sample_id": "FILM", "lab_data": {"template_revision": 1, "values": {"0": 0}}})
        row = self.store.list()[0]
        self.store.save({**row, "lab_data": {"template_revision": 1, "values": {"0": 50}}}, record_id)
        batch = self.store.history(record_id)["batches"][0]["id"]
        row = self.store.list()[0]
        self.store.save({**row, "lab_data": {"template_revision": 1, "values": {"0": 75, "1": 60}}}, record_id)
        with self.assertRaises(Problem):
            self.store.undo_history(batch, {"preview": True})
        row = self.store.list()[0]
        self.store.save({**row, "lab_data": {"template_revision": 1, "outcome": "measured", "values": {"0": 50, "1": 60}}}, record_id)
        preview = self.store.undo_history(batch, {"preview": True})
        self.store.undo_history(batch, {"preview": False, "revisions": preview["revisions"]})
        self.assertEqual(self.store.list()[0]["lab_data"], {"template_revision": 1, "outcome": "measured", "values": {"0": 0, "1": 60}})

    def test_key_field_reviews_keep_existing_dispositions_and_waive_results(self):
        legacy = self.store.save({"sample_id": "Legacy", "duration": 5, "solvent": "Water"})
        original = next(item for item in self.store.review_list()["items"] if item["kind"] == "missing_conditions")
        self.assertEqual(original["missing"], ["precursor", "temperature"])
        registered = self.store.add_review({"issue_id": original["id"]})
        self.store.decide_review(original["id"], {"preview": False, "status": "resolved",
                                 "revision": registered["revision"], "record_revision": original["record_revision"]})
        sample = self.store.save({"sample_id": "Legacy without built-ins"})
        fields = [dict(section="condition", label="Substrate", type="text"),
                  dict(section="result", label="Thickness", type="number", unit="nm"),
                  dict(section="condition", label="Comment", type="text")]
        self.store.save_template(dict(project_id="default", name="Film", revision=0, fields=fields))
        settings = {"builtin": {field: {"enabled": False} for field in ("duration", "materials")},
                    "key_fields": [{"section": field["section"], "label": field["label"], "check_missing": index < 2}
                                   for index, field in enumerate(fields)]}
        self.store.save_project_settings("default", {"settings": settings, "revision": 0})
        waived = [self.store.save({"sample_id": outcome, "lab_data": {"outcome": outcome}})
                  for outcome in ("not_measured", "measurement_failed", "no_target")]
        empty = self.store.save({"sample_id": "Measured", "lab_data": {"outcome": "measured"}})
        filled = self.store.save({"sample_id": "Zero", "lab_data": {"values": {"0": "Si", "1": 0}}})
        items = self.store.review_list()["items"]
        self.assertEqual([(item["id"], item["status"]) for item in items if item["record_id"] == legacy
                          and item["kind"] == "missing_conditions" and not item["field"]], [(original["id"], "resolved")])
        self.assertEqual([item["missing"] for item in items if item["record_id"] == sample
                          and item["kind"] == "missing_conditions" and not item["field"]], [["precursor", "temperature"]])
        for record_id in waived:
            self.assertEqual([item["field"] for item in items if item["record_id"] == record_id and item["field"]],
                             ["key:condition:Substrate"])
        self.assertFalse(any(item["record_id"] == filled and item["field"] for item in items))
        measured = [item for item in items if item["record_id"] == empty and item["field"]]
        self.assertEqual([(item["field"], item["title"], item["missing"]) for item in measured], [
            ("key:condition:Substrate", "缺少关键字段：Substrate", ["Substrate"]),
            ("key:result:Thickness", "缺少关键字段：Thickness", ["Thickness"]),
        ])
        self.store.add_review({"issue_id": measured[1]["id"]})
        stored = next(item for item in self.store.review_list()["items"] if item["id"] == measured[1]["id"])
        self.assertEqual((stored["generated"], stored["field"], stored["title"]),
                         (False, measured[1]["field"], measured[1]["title"]))

    def test_bulk_key_fields_edit_saved_versions_and_undo(self):
        fields = [dict(section="condition", label="Substrate", type="text"),
                  dict(section="result", label="Thickness", type="number", unit="nm"),
                  dict(section="condition", label="Process", type="single", options=["Cold", "Hot"]),
                  dict(section="condition", label="Dopants", type="multi", options=["A", "B", "C"]),
                  dict(section="result", label="Notes", type="text")]
        template = dict(project_id="default", name="Film", revision=0, fields=fields)
        self.store.save_template(template)
        original = {"0": "Si", "1": 0, "2": "Cold", "3": ["A"], "4": "Keep"}
        old = self.store.save({"sample_id": "Old", "lab_data": {"values": original, "outcome": "measured"}})
        latest = [{**fields[1], "unit": "µm"}, fields[3], fields[0], {**fields[2], "options": ["Cold", "Hot", "Warm"]}, fields[4]]
        self.store.save_template({**template, "revision": 1, "fields": latest})
        new = self.store.save({"sample_id": "New", "lab_data": {"values": {str(index): original[str(previous)]
                               for index, previous in enumerate((1, 3, 0, 2, 4))}}})
        keys = [{field: definition[field] for field in ("section", "label")} for definition in fields[:4]]
        self.store.save_project_settings("default", {"settings": {"key_fields": keys}, "revision": 0})

        def bulk(actions, preview=False, **builtins):
            revisions = {row["id"]: row["revision"] for row in self.store.list()}
            return self.store.bulk_update({"preview": preview, "changes": {"key_fields": actions, **builtins},
                                          "records": [{"id": record, "revision": revisions[record]} for record in (new, old)]})

        edits = [{**key, "mode": mode, "value": value} for key, mode, value in
                 zip(keys, ("set", "set", "set", "replace"), ("  Glass  ", 3.5, "Hot", ["B"]))]
        edits[0]["label"] = "SUBSTRATE"
        results = bulk(edits, preview=True, duration={"mode": "set", "value": 15})
        self.assertEqual(results["updated"], 2)
        for preview in results["rows"]:
            self.assertEqual(preview["changes"], [
                {"field": "duration", "before": None, "after": 15},
                {"field": "key:condition:Substrate", "before": "Si", "after": "Glass"},
                {"field": "key:result:Thickness", "before": 0, "after": 3.5},
                {"field": "key:condition:Process", "before": "Cold", "after": "Hot"},
                {"field": "key:condition:Dopants", "before": ["A"], "after": ["B"]},
            ])
        self.assertTrue(all(row["revision"] == 1 for row in self.store.list()))
        updated = bulk(edits, duration={"mode": "set", "value": 15})
        by_id = {row["id"]: row for row in updated["records"]}
        self.assertEqual(by_id[old]["lab_data"], {"template_revision": 1, "outcome": "measured",
                         "values": dict(zip("01234", ("Glass", 3.5, "Hot", ["B"], "Keep")))})
        self.assertEqual(by_id[new]["lab_data"], {"template_revision": 2,
                         "values": dict(zip("01234", (3.5, ["B"], "Glass", "Hot", "Keep")))})
        self.assertEqual(bulk(edits, duration={"mode": "set", "value": 15})["updated"], 0)
        self.assertEqual(self.store.list(), updated["records"])

        for edit in ({**edits[0], "value": "x" * 251}, {**edits[1], "value": float("inf")},
                     {**edits[1], "value": True}, {**edits[2], "value": "Warm"},
                     {**edits[3], "value": ["Unknown"]}, {**edits[3], "mode": "set"}):
            with self.subTest(edit=edit), self.assertRaises(Problem) as invalid:
                bulk([edit], duration={"mode": "set", "value": 90})
            self.assertEqual(invalid.exception.status, 400)
            self.assertEqual(self.store.list(), updated["records"])

        append = [{**keys[-1], "mode": "append", "value": ["B", "C"]}]
        appended = bulk(append)
        self.assertTrue(all(row["changes"][0]["after"] == ["B", "C"] for row in appended["rows"]))
        self.assertEqual(bulk(append)["updated"], 0)
        cleared = [{**key, "mode": "clear"} for key in keys]
        result = bulk(cleared)
        self.assertTrue(all(row["lab_data"]["values"] == {"4": "Keep"} for row in result["records"]))
        self.assertTrue(all(change["after"] is None for row in result["rows"] for change in row["changes"]))
        self.assertEqual(bulk(cleared)["updated"], 0)
        batch = self.store.history()["batches"][0]
        self.assertEqual(batch["action"], "bulk")
        preview = self.store.undo_history(batch["id"], {"preview": True})
        self.assertTrue(all(row["changes"][0]["field"] == "lab_data" for row in preview["rows"]))
        restored = self.store.undo_history(batch["id"], {"preview": False, "revisions": preview["revisions"]})
        self.assertEqual({row["id"]: row["lab_data"] for row in restored["records"]},
                         {row["id"]: row["lab_data"] for row in appended["records"]})

    def test_bulk_key_field_missing_samples_are_bounded_and_atomic(self):
        old_template = dict(project_id="default", name="Film", revision=0,
                            fields=[dict(section="condition", label="Power", type="text")])
        self.store.save_template(old_template)
        samples = [f"Legacy {index}" for index in range(11)]
        old_ids = [self.store.save({"sample_id": sample, "lab_data": {"values": {"0": "Old"}}}) for sample in samples]
        self.store.save_template({**old_template, "revision": 1,
                                  "fields": [{**old_template["fields"][0], "type": "number"}]})
        key = {"section": "condition", "label": "Power"}
        self.store.save_project_settings("default", {"settings": {"key_fields": [key]}, "revision": 0})
        new = self.store.save({"sample_id": "Current", "lab_data": {"values": {"0": 0}}})
        before = self.store.list()
        history = self.store.history()
        for preview in (True, False):
            with self.assertRaises(Problem) as invalid:
                self.store.bulk_update({"preview": preview, "records": [{"id": record, "revision": 1}
                                       for record in [new, *old_ids]],
                                       "changes": {"temperature": {"mode": "set", "value": 300},
                                                   "key_fields": [{**key, "mode": "set", "value": 50}]}})
            self.assertEqual((invalid.exception.status, str(invalid.exception)),
                             (400, "以下样品的模板没有字段 Power：" + "、".join(samples[:10])))
            self.assertEqual(self.store.list(), before)
            self.assertEqual(self.store.history(), history)

    def test_sample_lineage_refuses_cycles_and_cross_project_links(self):
        parent = self.store.save({"sample_id": "BATCH"})
        child = self.store.save({"sample_id": "SPLIT-A", "lab_data": {"parent_id": parent, "treatment": "Anneal"}})
        rows = {row["id"]: row for row in self.store.list()}
        with self.assertRaises(Problem):
            self.store.save({**rows[parent], "lab_data": {"parent_id": child}}, parent)
        other = self.store.add_catalog_item("projects", {"name": "Other lab"})["project"]["id"]
        with self.assertRaises(Problem):
            self.store.save({**rows[parent], "project_id": other}, parent)
        with self.assertRaises(Problem):
            self.store.save({**rows[child], "project_id": other}, child)
        self.store.archive(parent, {"archived": True, "revision": 1})
        row = next(row for row in self.store.list() if row["id"] == child)
        self.assertEqual(row["lab_data"]["parent_id"], parent)

    def test_undo_project_move_does_not_reinterpret_new_template_values(self):
        destination = self.store.add_catalog_item("projects", {"name": "Other lab"})["project"]["id"]
        record_id = self.store.save({"sample_id": "Legacy"})
        self.store.save({**self.store.list()[0], "project_id": destination}, record_id)
        move = self.store.history(record_id)["batches"][0]["id"]
        for project, unit in (("default", "µm"), (destination, "nm")):
            self.store.save_template({"project_id": project, "revision": 0, "name": "Films", "fields": [
                {"label": "Thickness", "type": "number", "section": "result", "unit": unit},
            ]})
        self.store.save({**self.store.list()[0], "lab_data": {"template_revision": 1, "values": {"0": 12}}}, record_id)
        with self.assertRaises(Problem) as conflict:
            self.store.undo_history(move, {"preview": True})
        self.assertEqual(conflict.exception.status, 409)
        row = self.store.list()[0]
        self.assertEqual(row["project_id"], destination)
        self.assertEqual(row["template"]["fields"][0]["unit"], "nm")

    def test_folder_plan_and_atomic_file_creation(self):
        sample_id = self.store.save({"sample_id": "EXISTING"})
        data = b"angle,intensity\n15,60\n16,8\n"
        seed = {"path": "Old/EXISTING/same.csv", "sample_id": "EXISTING", "kind": "XRD", "size": len(data)}
        new = {**seed, "path": "Old/NEW/ok.csv", "sample_id": "NEW"}
        unknown = {**seed, "path": "Old/unknown.jpg", "sample_id": ""}
        payload = {"project_id": "default", "experiment_no": "BATCH", "create": True,
                   "files": [seed, {**seed, "path": "Old/copy/same.csv"}, new, unknown]}
        before = self.store.list()
        rows = self.store.preview_folder(payload)["rows"]
        self.assertEqual([(row["action"], row["reason"]) for row in rows], [
            ("review", "duplicate"), ("review", "duplicate"), ("new", ""), ("review", "sample")])
        plan = self.store.preview_folder({**payload, "excluded": ["Old/copy/same.csv"]})
        self.assertEqual(plan["rows"][0]["action"], "attach")
        self.assertEqual(self.store.list(), before)
        with self.assertRaises(Problem):
            self.store.preview_folder({**payload, "files": [{**seed, "path": "Old/../outside.csv"}]})
        target = ("default", "NEW", "BATCH")
        receipt = "a" * 32
        with self.assertRaises(Problem):
            self.store.add_file("", "ok.csv", "XRD", io.BytesIO(data[:2]), len(data), folder_target=target, receipt=receipt)
        self.assertEqual(self.store.list(), before)
        self.assertFalse(list(self.store.files.iterdir()))
        with self.assertRaises(Problem) as absent:
            self.store.folder_receipt(receipt)
        self.assertEqual(absent.exception.status, 404)
        imported = self.store.add_file("", "ok.csv", "XRD", io.BytesIO(data), len(data),
                                       source=new["path"], folder_target=target, receipt=receipt)
        self.assertEqual(self.store.folder_receipt(receipt), imported)
        self.assertEqual(self.store.file(imported["id"])[0].read_bytes(), data)
        with self.assertRaises(Problem):
            self.store.add_file("", "ok.csv", "XRD", io.BytesIO(data), len(data), folder_target=target, receipt=receipt)
        self.assertEqual(len(list(self.store.files.iterdir())), 1)
        issue = {"project_id": "default", "batch_id": "b" * 32, "issues": [rows[-1]]}
        self.assertEqual(self.store.folder_issues(issue), {"created": 1, "pending": 1})
        self.assertEqual(self.store.folder_issues(issue), {"created": 0, "pending": 1})
        self.assertEqual(self.store.folder_issues({**issue, "batch_id": "c" * 32}), {"created": 1, "pending": 1})
        self.assertIn("folder_import", {item["kind"] for item in self.store.review_list()["items"]})
        self.assertEqual(len(self.store.list()), 2)
        self.assertNotEqual(imported["record_id"], sample_id)

    def test_folder_import_and_rename_can_reuse_trashed_names(self):
        sample = "Replace a folder attachment"
        record_id = self.store.save({"sample_id": sample})
        original = self.store.add_file(record_id, "same.csv", "NMR", io.BytesIO(b"old"), 3)
        self.store.change_file(original, "delete", {"record_revision": self.store.list()[0]["revision"]})
        path = "folder/same.csv"
        payload = {"project_id": "default", "create": False,
                   "files": [{"path": path, "sample_id": sample, "kind": "NMR", "size": 3}]}
        plan = self.store.preview_folder(payload)["rows"][0]
        self.assertEqual((plan["action"], plan["reason"]), ("attach", ""))
        imported = self.store.add_file(record_id, plan["name"], plan["kind"], io.BytesIO(b"new"), 3,
                                       source=path, folder_target=("default", sample, plan["experiment_no"]),
                                       receipt="a" * 32)
        plan = self.store.preview_folder(payload)["rows"][0]
        self.assertEqual((plan["action"], plan["reason"]), ("review", "duplicate"))
        self.store.change_file(imported["id"], "delete", {"record_revision": self.store.list()[0]["revision"]})
        other = self.store.add_file(record_id, "other.csv", "NMR", io.BytesIO(b"csv"), 3)
        renamed = self.store.change_file(other, "update",
                                         {"record_revision": self.store.list()[0]["revision"], "name": "same.csv"})
        self.assertEqual(renamed["records"][0]["files"], [renamed["file"]])
        self.assertEqual(renamed["file"]["name"], "same.csv")
        self.assertEqual({(item["id"], item["name"], item["name_conflict"]) for item in self.store.trash()["items"]},
                         {(original, "same.csv", True), (imported["id"], "same.csv", True)})

    def test_folder_import_groups_ascii_case_variants_of_a_new_sample(self):
        payload = {"project_id": "default", "create": True, "files": [
            {"path": "run/A01-XRD.csv", "size": 3, "sample_id": "A01", "kind": "XRD"},
            {"path": "run/a01-NMR.csv", "size": 3, "sample_id": "a01", "kind": "NMR"},
        ]}
        rows = self.store.preview_folder(payload)["rows"]
        self.assertEqual([(row["sample_id"], row["experiment_no"]) for row in rows], [("A01", "A01"), ("A01", "A01")])
        record_id = ""
        for row in rows:
            target = ("default", row["sample_id"], row["experiment_no"])
            saved = self.store.add_file(record_id, row["name"], row["kind"], io.BytesIO(b"1,2"), 3, folder_target=target)
            record_id = saved["record_id"]
        self.assertEqual(len(self.store.list()), 1)
        self.assertEqual(len(self.store.list()[0]["files"]), 2)

    def test_folder_process_exit_after_publish_rolls_back_database(self):
        initial = self.store.save({"sample_id": "COMMITTED"})
        file_id = self.store.add_file(initial, "existing.csv", "XRD", io.BytesIO(b"1,2"), 3)
        script = """
import io, os, sys
from server import Store
store = Store(sys.argv[1])
store.log_history = lambda *args, **kwargs: os._exit(23)
store.add_file("", "unfinished.csv", "XRD", io.BytesIO(b"1,2"), 3,
               folder_target=("default", "UNFINISHED", "UNFINISHED"), receipt="c" * 32)
"""
        crashed = subprocess.run([sys.executable, "-c", script, str(self.store.data)],
                                 cwd=Path(__file__).resolve().parent, timeout=10)
        self.assertEqual(crashed.returncode, 23)
        reopened = Store(self.store.data)
        self.assertEqual([row["id"] for row in reopened.list()], [initial])
        self.assertEqual(reopened.file(file_id)[0].read_bytes(), b"1,2")
        with self.assertRaises(Problem):
            reopened.folder_receipt("c" * 32)

    def test_folder_review_does_not_match_a_different_sample_by_experiment_number(self):
        sibling = self.store.save({"sample_id": "B", "experiment_no": "A"})
        self.store.folder_issues({"project_id": "default", "batch_id": "a" * 32, "issues": [
            {"path": "Run/A.csv", "size": 3, "sample_id": "A", "kind": "XRD", "reason": "sample"},
        ]})
        issue = next(item for item in self.store.review_list()["items"] if item["kind"] == "folder_import")
        self.assertEqual(issue["sample_id"], "A")
        self.assertIsNone(issue["record_id"])
        self.store.decide_review(issue["id"], {"status": "resolved", "preview": False, "revision": 1,
            "note": "Matched manually", "record_id": sibling})
        issue = next(item for item in self.store.review_list()["items"] if item["kind"] == "folder_import")
        self.assertIsNone(issue["record_id"])

    def test_share_package_scope_evidence_checksums_and_formula_safety(self):
        parent = self.store.save({"sample_id": "OUTSIDE-PARENT", "notes": "private"})
        child = self.store.save({"sample_id": "=SAMPLE", "experiment_no": "XY-1-279",
                                 "lab_data": {"parent_id": parent, "treatment": "Anneal"}})
        second = self.store.save({"sample_id": "RUN-B", "experiment_no": "XY-I-279"})
        archived = self.store.save({"sample_id": "ARCHIVED", "experiment_no": "XY-I-279"})
        self.store.archive(archived, {"archived": True, "revision": 1})
        other = self.store.add_catalog_item("projects", {"name": "Other lab"})["project"]["id"]
        self.store.save({"sample_id": "PRIVATE", "experiment_no": "XY-I-279", "project_id": other})
        data = b"10,20\n"
        file_id = self.store.add_file(child, "scan.csv", "XRD", io.BytesIO(data), len(data), source="private/path")
        original_name = "衍射" * 100 + ".csv"
        wide_file = self.store.add_file(second, original_name, "XRD", io.BytesIO(data), len(data))
        self.store.add_file(parent, "mother.csv", "XRD", io.BytesIO(data), len(data))
        row = next(row for row in self.store.list() if row["id"] == child)
        self.store.save({**row, "result_summary": {"evidence_ids": [file_id], "conclusion": "test result"}}, child)
        output = self.store.data / "share.zip"
        revisions = {row["id"]: row["revision"] for row in self.store.list()}
        current = [revisions[child], revisions[second]]
        self.store.share_experiments([child, second], current, output, "en")
        with zipfile.ZipFile(output) as zip_file:
            manifest = json.loads(zip_file.read("manifest.json"))
            self.assertEqual({row["id"] for row in manifest["samples"]}, {child, second})
            self.assertEqual(manifest["experiments"], 1)
            self.assertEqual([item["id"] for item in manifest["external_parents"]], [parent])
            sample = next(row for row in manifest["samples"] if row["id"] == child)
            file = sample["files"][0]
            self.assertEqual(sample["result_summary"]["evidence_ids"], [file_id])
            self.assertNotIn("source", file)
            self.assertNotIn("notes", sample)
            self.assertEqual(file["sha256"], hashlib.sha256(zip_file.read(file["path"])).hexdigest())
            wide = next(row["files"][0] for row in manifest["samples"] if row["id"] == second)
            self.assertEqual(wide["id"], wide_file)
            self.assertEqual(wide["name"], original_name)
            self.assertLess(len(wide["path"].split("/")[-1].encode("utf-8")), 255)
            self.assertEqual(len([name for name in zip_file.namelist() if name.startswith("files/")]), 2)
            csv_data = zip_file.read("samples.csv").decode("utf-8-sig")
            self.assertIn("'=SAMPLE", csv_data)
            self.assertEqual(next(csv.reader(io.StringIO(csv_data)))[-2:], ["Sample details (JSON)", "Template (JSON)"])
        with self.assertRaises(Problem) as stale:
            self.store.share_experiments([child, second], [1, 1], output, "en")
        self.assertEqual(stale.exception.status, 409)
        with self.assertRaises(Problem) as incomplete:
            self.store.share_experiments([child], [revisions[child]], output, "en")
        self.assertEqual(incomplete.exception.status, 409)
        self.store.file(file_id)[0].write_bytes(b"99,99\n")
        with self.assertRaises(Problem) as corrupt:
            self.store.share_experiments([child, second], current, output, "en")
        self.assertIn("scan.csv", str(corrupt.exception))

    def test_history_single_and_batch_undo_conflict_and_partial_undo(self):
        ids = [self.store.save({"sample_id": name, "temperature": 0, "solvents": ["ODE"], "notes": "original"}) for name in ("UNDO-A", "UNDO-B")]
        before = {row["id"]: row for row in self.store.list()}
        self.store.bulk_update({"preview": False, "records": [{"id": key, "revision": before[key]["revision"]} for key in ids], "changes": {"temperature": {"mode": "set", "value": 250}}})
        batch = self.store.history()["batches"][0]
        self.assertEqual((batch["action"], batch["count"]), ("bulk", 2))
        row = next(row for row in self.store.list() if row["id"] == ids[0])
        self.store.save({**row, "notes": "later unrelated notes"}, row["id"])
        digest = hashlib.sha256(self.store.db.read_bytes()).hexdigest()
        preview = self.store.undo_history(batch["id"], {"preview": True, "record_ids": [ids[0]]})
        self.assertEqual(hashlib.sha256(self.store.db.read_bytes()).hexdigest(), digest)
        self.assertEqual(preview["rows"][0]["changes"], [{"field": "temperature", "before": 250, "after": 0}])
        self.store.undo_history(batch["id"], {"preview": False, "record_ids": [ids[0]], "revisions": preview["revisions"]})
        row = next(row for row in self.store.list() if row["id"] == ids[0])
        self.assertEqual((row["temperature"], row["notes"]), (0, "later unrelated notes"))
        with self.assertRaises(Problem):
            self.store.undo_history(batch["id"], {"preview": True, "record_ids": [ids[0]]})
        preview = self.store.undo_history(batch["id"], {"preview": True})
        self.assertEqual([row["id"] for row in preview["rows"]], [ids[1]])
        row = next(row for row in self.store.list() if row["id"] == ids[1])
        self.store.save({**row, "temperature": 300}, row["id"])
        current = self.store.list()
        with self.assertRaises(Problem) as conflict:
            self.store.undo_history(batch["id"], {"preview": False, "revisions": preview["revisions"]})
        self.assertEqual(conflict.exception.status, 409)
        self.assertEqual(self.store.list(), current)
        with self.assertRaises(Problem):
            self.store.undo_history(batch["id"], {"preview": True})

    def test_history_material_dependencies_archive_and_revisions(self):
        record_id = self.store.save({"sample_id": "DEPENDENCY", "solvents": ["ODE"]})
        row = self.store.list()[0]
        self.store.bulk_update({"preview": False, "records": [{"id": record_id, "revision": row["revision"]}], "changes": {"solvents": {"mode": "append", "value": ["OA"]}}})
        batch = self.store.history()["batches"][0]["id"]
        row = self.store.list()[0]
        self.store.save({**row, "material_amounts": [{"name": "OA", "amount": 2, "unit": "mL"}]}, record_id)
        with self.assertRaises(Problem):
            self.store.undo_history(batch, {"preview": True})
        row = self.store.list()[0]
        self.store.archive(record_id, {"archived": True, "revision": row["revision"]})
        archive = self.store.history()["batches"][0]
        preview = self.store.undo_history(archive["id"], {"preview": True})
        self.store.undo_history(archive["id"], {"preview": False, "revisions": preview["revisions"]})
        self.assertFalse(self.store.list()[0]["archived"])
        self.assertEqual(self.store.list()[0]["material_amounts"], row["material_amounts"])
        creation = next(batch for batch in self.store.history()["batches"] if batch["action"] == "create")
        with self.assertRaises(Problem):
            self.store.undo_history(creation["id"], {"preview": True})

    def test_review_confirm_preview_history_undo_and_manual_resolution(self):
        record_id = self.store.save({"sample_id": "REVIEW", "temperature": 300})
        review_id = self.store.add_review({"record_id": record_id, "title": "250 or 300", "field": "temperature"})["id"]
        row = self.store.list()[0]
        payload = {"preview": True, "revision": 1, "record_revision": row["revision"], "status": "resolved", "apply_value": True, "value": 250}
        digest = hashlib.sha256(self.store.db.read_bytes()).hexdigest()
        preview = self.store.decide_review(review_id, payload)
        self.assertEqual(preview["changes"], [{"field": "temperature", "before": 300, "after": 250}])
        self.assertEqual(hashlib.sha256(self.store.db.read_bytes()).hexdigest(), digest)
        self.store.decide_review(review_id, {**payload, "preview": False})
        self.assertEqual(self.store.list()[0]["temperature"], 250)
        self.assertEqual(next(item for item in self.store.review_list()["items"] if item["id"] == review_id)["status"], "resolved")
        batch = self.store.history()["batches"][0]
        undo = self.store.undo_history(batch["id"], {"preview": True})
        self.store.undo_history(batch["id"], {"preview": False, "revisions": undo["revisions"]})
        self.assertEqual(self.store.list()[0]["temperature"], 300)
        item = next(item for item in self.store.review_list()["items"] if item["id"] == review_id)
        self.assertEqual(item["status"], "pending")
        with self.assertRaises(Problem):
            self.store.decide_review(review_id, payload)
        status_only = {"preview": False, "revision": item["revision"], "record_revision": item["record_revision"], "status": "resolved"}
        with self.assertRaises(Problem):
            self.store.decide_review(review_id, {**status_only, "status": "dismissed"})
        before = self.store.list()
        decision = self.store.decide_review(review_id, status_only)
        self.assertEqual(decision["changes"], [])
        self.assertEqual(self.store.list(), before)
        item = next(item for item in self.store.review_list()["items"] if item["id"] == review_id)
        self.assertEqual((item["status"], item["resolution"]), ("resolved", ""))
        self.store.decide_review(review_id, {**status_only, "revision": item["revision"], "status": "dismissed", "note": "Need the experimental page"})

    def test_generated_review_dismissal_refresh_and_source_backup(self):
        record_id = self.store.save({"sample_id": "MISSING", "temperature": 0, "duration": 0, "precursor": "PA12", "solvents": ["ODE"]})
        items = [item for item in self.store.review_list()["items"] if item["record_id"] == record_id]
        self.assertEqual([item["kind"] for item in items], ["missing_data"])
        item = items[0]
        stored = self.store.add_review({"issue_id": item["id"]})
        self.store.decide_review(item["id"], {"preview": False, "revision": stored["revision"], "record_revision": item["record_revision"], "status": "dismissed", "note": "No measurement was planned"})
        self.assertFalse(any(item["generated"] for item in self.store.review_list()["items"] if item["record_id"] == record_id))
        row = self.store.list()[0]
        self.store.save({**row, "notes": "unrelated notes"}, record_id)
        self.assertFalse(any(item["generated"] for item in self.store.review_list()["items"] if item["record_id"] == record_id))
        other_id = self.store.save({"sample_id": "TO-FILL"})
        issue = next(item for item in self.store.review_list()["items"] if item["record_id"] == other_id and item["kind"] == "missing_conditions")
        self.store.add_review({"issue_id": issue["id"]})
        self.assertTrue(any(item["id"] == issue["id"] for item in self.store.review_list()["items"]))
        row = next(row for row in self.store.list() if row["id"] == other_id)
        self.store.save({**row, "precursor": "PA12", "temperature": 0, "duration": 0, "extra_conditions": [{"name": "Reaction medium", "value": "Solvent-free", "unit": ""}]}, other_id)
        self.assertFalse(any(item["kind"] == "missing_conditions" for item in self.store.review_list()["items"] if item["record_id"] == other_id))
        source_id = "1" * 32
        folder = self.store.data / "review-sources"
        folder.mkdir()
        (folder / source_id).write_bytes(b"test source bytes")
        with self.store.connect() as db:
            db.execute("INSERT INTO review_sources VALUES (?,?,?,?)", (source_id, "notebook.jpg", "image/jpeg", "hash"))
        path, mime = self.store.review_source(source_id)
        self.assertEqual((path.read_bytes(), mime), (b"test source bytes", "image/jpeg"))
        destination = self.store.data / "backup.zip"
        self.store.backup(destination)
        with zipfile.ZipFile(destination) as archive:
            self.assertEqual(archive.read("data/review-sources/" + source_id), b"test source bytes")

    def test_notebook_missing_data_review_stays_visible_after_record_creation(self):
        review_id = "2" * 32
        with self.store.connect() as db:
            db.execute("INSERT INTO review_items(id,record_id,project_id,experiment_no,kind,field,title,sources,created_at,updated_at) VALUES (?,NULL,'default','XY-II-202','missing_data','','Notebook entry missing data','[]','2026-11-17','2026-11-17')", (review_id,))
        self.assertTrue(any(item["id"] == review_id for item in self.store.review_list()["items"]))
        record_id = self.store.save({"sample_id": "XY-II-202"})
        restarted = Store(self.store.data)
        item = next(item for item in restarted.review_list()["items"] if item["id"] == review_id)
        self.assertEqual((item["record_id"], item["status"]), (record_id, "pending"))
        restarted.decide_review(review_id, {"preview": False, "record_id": record_id, "record_revision": item["record_revision"], "revision": item["revision"], "status": "resolved", "note": "Data linked after checking notebook"})
        item = next(item for item in restarted.review_list()["items"] if item["id"] == review_id)
        self.assertEqual(item["status"], "resolved")

    def test_bulk_preview_patch_atomicity_and_preserved_data(self):
        ids = [self.store.save({"sample_id": name, "temperature": 0, "duration": 5, "solvents": ["ODE", "OA"],
                               "material_amounts": [{"name": "ODE", "amount": 2, "unit": "mL"}, {"name": "OA", "amount": 1, "unit": "mmol"}],
                               "notes": "Keep original notes", "extra_conditions": [{"name": "atmosphere", "value": "Ar", "unit": ""}]})
               for name in ("BULK-A", "BULK-B", "UNSELECTED")]
        file_id = self.store.add_file(ids[0], "pattern.csv", "XRD", io.BytesIO(b"1,2"), 3)
        first = next(row for row in self.store.list() if row["id"] == ids[0])
        self.store.save({**first, "result_summary": {"phases": ["Phase-A"], "evidence_ids": [file_id]}}, first["id"])
        original = {row["id"]: row for row in self.store.list()}
        payload = {"records": [{"id": key, "revision": original[key]["revision"]} for key in ids[:2]], "preview": True,
                   "changes": {"temperature": {"mode": "set", "value": 250}, "solvents": {"mode": "append", "value": ["OLAM"]},
                               "phases": {"mode": "append", "value": [" Phase-A2 ", "Phase-A2"]}}}
        digest = hashlib.sha256(self.store.db.read_bytes()).hexdigest()
        preview = self.store.bulk_update(payload)
        self.assertEqual(preview["updated"], 2)
        self.assertEqual({row["id"]: row for row in self.store.list()}, original)
        self.assertEqual(hashlib.sha256(self.store.db.read_bytes()).hexdigest(), digest, "Preview must not write the database")
        self.assertIn("2 mL", next(change["after"] for change in preview["rows"][0]["changes"] if change["field"] == "solvents"))
        result = self.store.bulk_update({**payload, "preview": False})
        self.assertEqual(result["rows"], preview["rows"], "Save and preview share normalization")
        rows = {row["id"]: row for row in self.store.list()}
        self.assertEqual(rows[ids[2]], original[ids[2]])
        for key in ids[:2]:
            self.assertEqual(rows[key]["temperature"], 250)
            self.assertEqual(rows[key]["solvents"], ["ODE", "OA", "OLAM"])
            self.assertEqual(rows[key]["material_amounts"], original[key]["material_amounts"])
            for field in ("sample_id", "experiment_no", "series", "experiment_date", "notes", "extra_conditions", "files", "project_id", "status"):
                self.assertEqual(rows[key][field], original[key][field], field)
            self.assertEqual(rows[key]["revision"], original[key]["revision"] + 1)
            self.assertEqual(rows[key]["result_summary"]["confirmation"], "pending")
        self.assertEqual(rows[ids[0]]["result_summary"]["evidence_ids"], [file_id])
        self.assertEqual(rows[ids[0]]["result_summary"]["phases"], ["Phase-A", "Phase-A2"])
        before_conflict = self.store.list()
        with self.assertRaises(Problem) as conflict:
            self.store.bulk_update({**payload, "preview": False})
        self.assertEqual(conflict.exception.status, 409)
        self.assertEqual(self.store.list(), before_conflict)
        same = {"records": [{"id": key, "revision": rows[key]["revision"]} for key in ids[:2]], "preview": False,
                "changes": {"temperature": {"mode": "set", "value": 250}}}
        self.assertEqual(self.store.bulk_update(same)["updated"], 0)
        self.assertEqual(self.store.list(), before_conflict, "No-op saves must not bump revisions or timestamps")
        replace = {**same, "changes": {"temperature": {"mode": "clear"}, "solvents": {"mode": "set", "value": ["OA"]}}}
        preview = self.store.bulk_update({**replace, "preview": True})
        solvent_change = next(change for change in preview["rows"][0]["changes"] if change["field"] == "solvents")
        self.assertIn("ODE (2 mL)", solvent_change["before"])
        self.assertEqual(solvent_change["after"], "OA (1 mmol)")
        self.store.bulk_update(replace)
        changed = next(row for row in self.store.list() if row["id"] == ids[0])
        self.assertIsNone(changed["temperature"])
        self.assertEqual(changed["material_amounts"], [{"name": "OA", "amount": 1, "unit": "mmol"}])
        zero = {"records": [{"id": changed["id"], "revision": changed["revision"]}], "preview": False,
                "changes": {"duration": {"mode": "set", "value": 0}}}
        self.store.bulk_update(zero)
        self.assertEqual(next(row for row in self.store.list() if row["id"] == ids[0])["duration"], 0)

    def test_bulk_rejects_invalid_archived_and_mixed_validity_without_writes(self):
        ids = [self.store.save({"sample_id": name}) for name in ("Known", "Unknown")]
        row = next(row for row in self.store.list() if row["id"] == ids[0])
        self.store.save({**row, "result_summary": {"phases": ["Phase-A"]}}, row["id"])
        rows = {row["id"]: row for row in self.store.list()}
        base = {"records": [{"id": key, "revision": rows[key]["revision"]} for key in ids], "preview": False}
        invalid = [{}, {"sample_id": {"mode": "set", "value": "relabel"}}, {"result_summary": {}},
                   {"solvents": {"mode": "set", "value": "ODE"}}, {"solvents": {"mode": "set", "value": []}},
                   {"phases": {"mode": "set", "value": ["x\ny"]}}, {"phases": {"mode": "set", "value": ["x" * 81]}},
                   {"duration": {"mode": "set", "value": -1}}, {"temperature": {"mode": "set", "value": True}},
                   {"temperature": {"mode": "set", "value": 10 ** 400}},
                   {"precursor": {"mode": [], "value": "Ni"}}, {"status": {"mode": "clear"}},
                   {"confirmation": {"mode": "set", "value": "confirmed"}, "temperature": {"mode": "set", "value": 300}}]
        before = self.store.list()
        options = self.store.catalog()
        for changes in invalid:
            with self.subTest(changes=changes), self.assertRaises(Problem):
                self.store.bulk_update({**base, "changes": changes})
            self.assertEqual(self.store.list(), before)
            self.assertEqual(self.store.catalog(), options)
        for items in ([], [base["records"][0]] * 2, [{"id": ids[0], "revision": True}], [{"id": "missing", "revision": 1}], base["records"] * 251):
            with self.subTest(items=len(items)), self.assertRaises(Problem):
                self.store.bulk_update({**base, "records": items, "changes": {"temperature": {"mode": "set", "value": 250}}})
            self.assertEqual(self.store.list(), before)
        self.store.archive(ids[1], {"archived": True, "revision": rows[ids[1]]["revision"]})
        before = self.store.list()
        with self.assertRaises(Problem):
            self.store.bulk_update({**base, "changes": {"temperature": {"mode": "set", "value": 300}}})
        self.assertEqual(self.store.list(), before)
        dataset = self.store.save({"sample_id": "资料集-test", "notes": "批量导入：local-qa"})
        with self.assertRaises(Problem):
            self.store.bulk_update({"records": [{"id": dataset, "revision": 1}], "preview": True, "changes": {"temperature": {"mode": "clear"}}})

    def test_result_summary_evidence_legacy_edit_csv_and_backup(self):
        record_id = self.store.save({"sample_id": "Result sample", "temperature": 0, "notes": "Original notes"})
        row = self.store.list()[0]
        empty = {"phases": [], "morphologies": [], "confirmation": "", "conclusion": "", "evidence_ids": []}
        self.assertEqual(row["result_summary"], empty, "Unknown results must not be inferred from conditions")
        file_id = self.store.add_file(record_id, "pattern.csv", "XRD", io.BytesIO(b"1,2\n"), 4)
        result = {"phases": [" Phase-A2 ", "Phase-A", "Phase-A2"], "morphologies": ["particles"],
                  "confirmation": "confirmed", "conclusion": " =SUM(A1)\nUnsuccessful target phase ", "evidence_ids": [file_id, file_id]}
        self.store.save({**self.store.list()[0], "result_summary": result}, record_id)
        saved = self.store.list()[0]
        expected = {**result, "phases": ["Phase-A2", "Phase-A"], "conclusion": result["conclusion"].strip(), "evidence_ids": [file_id]}
        self.assertEqual(saved["result_summary"], expected)
        self.assertEqual((saved["notes"], saved["status"], saved["temperature"]), ("Original notes", "待补全", 0))
        legacy = {key: value for key, value in saved.items() if key != "result_summary"}
        self.store.save({**legacy, "notes": "Edited by an older page"}, record_id)
        saved = self.store.list()[0]
        self.assertEqual(saved["result_summary"], expected, "Older pages must preserve results they do not know about")
        with self.assertRaises(Problem) as conflict:
            self.store.save({**saved, "revision": 1, "result_summary": {}}, record_id)
        self.assertEqual(conflict.exception.status, 409)
        for language, phase_column, state_column, conclusion_column, json_column in (
                ("zh", "物相", "结果确认", "结果结论", "结果摘要 (JSON)"),
                ("en", "Phases", "Result confirmation", "Result conclusion", "Result summary (JSON)")):
            exported = list(csv.DictReader(io.StringIO(export_csv([saved], language).decode("utf-8-sig"))))[0]
            self.assertEqual(exported[phase_column], "Phase-A2 / Phase-A")
            self.assertEqual(exported[state_column], "Confirmed" if language == "en" else "已确认")
            self.assertTrue(exported[conclusion_column].startswith("'=SUM"), "New CSV text columns must be formula safe")
            self.assertEqual(json.loads(exported[json_column]), expected)
        self.store.archive(record_id, {"archived": True, "revision": saved["revision"]})
        backup = Path(self.folder.name) / "results.zip"
        self.store.backup(backup)
        restored = Path(self.folder.name) / "results-restore"
        with zipfile.ZipFile(backup) as archive:
            archive.extractall(restored)
        recovered = Store(restored / "data")
        self.assertEqual(recovered.list(), self.store.list())
        self.assertEqual(recovered.file(file_id)[0].read_bytes(), b"1,2\n")

    def test_result_validation_and_evidence_ownership_are_atomic(self):
        first = self.store.save({"sample_id": "first"})
        second = self.store.save({"sample_id": "second"})
        foreign_file = self.store.add_file(second, "other.csv", "TEM", io.BytesIO(b"1,2"), 3)
        before = self.store.list()
        row = next(record for record in before if record["id"] == first)
        invalid = [None, [], "Phase-A2", {"unknown": "value"}, {"phases": "Phase-A2"}, {"phases": [""]},
                   {"phases": [None]}, {"phases": ["x\ny"]}, {"morphologies": ["x" * 81]},
                   {"phases": [str(i) for i in range(21)]}, {"evidence_ids": [str(i) for i in range(101)]},
                   {"confirmation": "complete"}, {"confirmation": "confirmed"}, {"conclusion": "x" * 2001},
                   {"conclusion": "bad\x00text"}, {"evidence_ids": [foreign_file]}, {"evidence_ids": ["missing"]}]
        for result in invalid:
            with self.subTest(result=result):
                with self.assertRaises(Problem):
                    self.store.save({**row, "notes": "Must not be saved", "result_summary": result}, first)
                self.assertEqual(self.store.list(), before)
        with self.assertRaises(Problem):
            self.store.save({"sample_id": "new", "result_summary": {"evidence_ids": [foreign_file]}})
        self.store.save({**row, "result_summary": {"phases": ["Co", "CO"]}}, first)
        saved = next(record for record in self.store.list() if record["id"] == first)
        self.assertEqual(saved["result_summary"]["confirmation"], "pending")
        self.assertEqual(saved["result_summary"]["phases"], ["Co", "CO"], "Chemical spelling must remain literal")
        self.store.save({**saved, "result_summary": {"conclusion": "No particles formed", "confirmation": "confirmed"}}, first)
        saved = next(record for record in self.store.list() if record["id"] == first)
        self.assertEqual(saved["result_summary"]["conclusion"], "No particles formed", "Negative outcomes can be recorded without guessing a phase")
        self.store.save({**saved, "result_summary": {}}, first)
        self.assertEqual(next(record for record in self.store.list() if record["id"] == first)["result_summary"]["confirmation"], "")

    def test_upload_checks_sample_identity_after_reading_the_body(self):
        record_id = self.store.save({"sample_id": "Before upload"})
        stream = io.BytesIO(b"1")
        read = stream.read

        def rename_during_upload(size):
            self.store.save({"sample_id": "Renamed during upload", "revision": 1}, record_id)
            return read(size)

        with patch.object(stream, "read", side_effect=rename_during_upload):
            with self.assertRaisesRegex(Problem, "目标样品已变化，请刷新后再上传。") as stale:
                self.store.add_file(record_id, "data.csv", "XRD", stream, 1, sample_id="Before upload")
        self.assertEqual(stale.exception.status, 409)
        row = self.store.list()[0]
        self.assertEqual((row["sample_id"], row["revision"], row["files"]), ("Renamed during upload", 2, []))
        self.assertEqual(list(self.store.files.iterdir()), [])

    def test_evidence_survives_move_and_unrelated_save_and_undo(self):
        owner = self.store.save({"sample_id": "Evidence owner"})
        target = self.store.save({"sample_id": "Evidence destination"})
        file_id = self.store.add_file(owner, "evidence.csv", "XRD", io.BytesIO(b"1,2"), 3)
        row = next(row for row in self.store.list() if row["id"] == owner)
        result = {"conclusion": "Measured", "evidence_ids": [file_id]}
        self.store.save({**row, "result_summary": result}, owner)
        row = next(row for row in self.store.list() if row["id"] == owner)
        self.store.save({**row, "notes": "Undo this edit"}, owner)
        batch_id = self.store.history(record_id=owner)["batches"][0]["id"]
        row = next(row for row in self.store.list() if row["id"] == owner)
        target_row = next(row for row in self.store.list() if row["id"] == target)
        moved = self.store.change_file(file_id, "update", {"record_revision": row["revision"],
                                      "target_record_id": target, "target_revision": target_row["revision"]})
        row, target_row = moved["records"]
        self.assertEqual(row["result_summary"]["evidence_ids"], [])
        with self.assertRaises(Problem):
            self.store.save({**row, "result_summary": {**result, "evidence_ids": ["unknown"]}}, owner)
        self.store.save({**row, "result_summary": result, "temperature": 10}, owner)
        row = next(row for row in self.store.list() if row["id"] == owner)
        self.store.save({**row, "temperature": 20}, owner)  # The browser submits the filtered result.
        preview = self.store.undo_history(batch_id, {"preview": True})
        undone = self.store.undo_history(batch_id, {"preview": False, "revisions": preview["revisions"]})["records"][0]
        self.assertEqual((undone["notes"], undone["temperature"], undone["result_summary"]["evidence_ids"]), ("", 20, []))
        returned = self.store.change_file(file_id, "update", {"record_revision": target_row["revision"],
                                          "target_record_id": owner, "target_revision": undone["revision"]})["records"][1]
        self.assertEqual(returned["result_summary"]["evidence_ids"], [file_id])

    def test_dormant_evidence_is_preserved_at_limit_and_removed_from_all_records_on_purge(self):
        owner = self.store.save({"sample_id": "Evidence owner"})
        original = [self.store.add_file(owner, f"scan-{i}.csv", "XRD", io.BytesIO(b"1"), 1) for i in range(100)]
        row = self.store.list()[0]
        self.store.save({**row, "result_summary": {"evidence_ids": original}}, owner)
        row = self.store.list()[0]
        dormant = original[-1]
        self.store.change_file(dormant, "delete", {"record_revision": row["revision"]})
        replacement = self.store.add_file(owner, "replacement.csv", "XRD", io.BytesIO(b"2"), 1)
        extra = self.store.add_file(owner, "extra.csv", "XRD", io.BytesIO(b"3"), 1)
        row = self.store.list()[0]
        visible = [*original[:-1], replacement]
        with self.assertRaises(Problem) as exceeded:
            self.store.save({**row, "result_summary": {"evidence_ids": [*visible, extra]}}, owner)
        self.assertEqual(str(exceeded.exception), server.RESULT_LIST_ERROR)
        self.store.save({**row, "result_summary": {"evidence_ids": visible}}, owner)
        row = self.store.list()[0]
        self.assertEqual(row["result_summary"]["evidence_ids"], visible)
        with self.store.connect() as db:
            stored = json.loads(db.execute("SELECT result_summary FROM experiments WHERE id=?", (owner,)).fetchone()[0])
        self.assertEqual(stored["evidence_ids"], [*visible, dormant])

        row = self.store.change_file(dormant, "restore", {"record_revision": row["revision"]})["records"][0]
        self.assertEqual(row["result_summary"]["evidence_ids"], [*visible, dormant])
        self.store.save({**row, "notes": "Preserve restored links"}, owner)
        row = self.store.list()[0]
        target = self.store.save({"sample_id": "Evidence destination"})
        _, destination = self.store.change_file(dormant, "update", {
            "record_revision": row["revision"], "target_record_id": target, "target_revision": 1})["records"]
        self.store.save({**destination, "result_summary": {"evidence_ids": [dormant]}}, target)
        self.store.change_file(dormant, "delete", {"record_revision": destination["revision"] + 1})
        self.store.purge_trash({"file_ids": [dormant], "confirm": "purge"})
        with self.store.connect() as db:
            evidence = {row["id"]: json.loads(row["result_summary"])["evidence_ids"]
                        for row in db.execute("SELECT id, result_summary FROM experiments")}
        self.assertEqual(evidence, {owner: visible, target: []})

    def test_undo_of_result_does_not_restore_a_purged_evidence_id(self):
        record_id = self.store.save({"sample_id": "Purged result"})
        file_id = self.store.add_file(record_id, "evidence.csv", "XRD", io.BytesIO(b"1,2"), 3)
        row = self.store.list()[0]
        result = {"conclusion": "Measured", "evidence_ids": [file_id]}
        self.store.save({**row, "result_summary": result}, record_id)
        row = self.store.list()[0]
        self.store.save({**row, "result_summary": {}}, record_id)
        batch_id = self.store.history()["batches"][0]["id"]
        row = self.store.list()[0]
        self.store.change_file(file_id, "delete", {"record_revision": row["revision"]})
        self.store.purge_trash({"file_ids": [file_id], "confirm": "purge"})
        preview = self.store.undo_history(batch_id, {"preview": True})
        undone = self.store.undo_history(batch_id, {"preview": False, "revisions": preview["revisions"]})["records"][0]
        self.assertEqual((undone["result_summary"]["conclusion"], undone["result_summary"]["evidence_ids"]), ("Measured", []))
        with self.store.connect() as db:
            stored = json.loads(db.execute("SELECT result_summary FROM experiments WHERE id=?", (record_id,)).fetchone()[0])
        self.assertEqual(stored["evidence_ids"], [])
        with self.assertRaisesRegex(Problem, "结果证据只能选择本样品已有的附件"):
            self.store.save({**undone, "result_summary": result}, record_id)

    def test_undo_conclusion_after_purge_preserves_active_and_trashed_evidence(self):
        record_id = self.store.save({"sample_id": "Conclusion with evidence"})
        evidence = [self.store.add_file(record_id, name, "XRD", io.BytesIO(b"1"), 1)
                    for name in ("active.csv", "trashed.csv", "purged.csv")]
        active, trashed, purged = evidence
        before = {"conclusion": "Original conclusion", "evidence_ids": evidence}
        self.store.save({**self.store.list()[0], "result_summary": before}, record_id)
        self.store.save({**self.store.list()[0], "result_summary": {**before, "conclusion": "Revised conclusion"}}, record_id)
        batch_id = self.store.history()["batches"][0]["id"]
        for file_id in (trashed, purged):
            self.store.change_file(file_id, "delete", {"record_revision": self.store.list()[0]["revision"]})
        self.store.purge_trash({"file_ids": [purged], "confirm": "purge"})

        preview = self.store.undo_history(batch_id, {"preview": True})
        change, = preview["rows"][0]["changes"]
        self.assertEqual(change["field"], "result_summary")
        self.assertEqual(change["before"]["evidence_ids"], [active, trashed])
        self.assertEqual(change["after"]["evidence_ids"], [active, trashed])
        result = self.store.undo_history(batch_id, {"preview": False, "revisions": preview["revisions"]})
        row = result["records"][0]
        self.assertEqual(row["result_summary"]["conclusion"], "Original conclusion")
        self.assertEqual(row["result_summary"]["evidence_ids"], [active])
        restored = self.store.change_file(trashed, "restore", {"record_revision": row["revision"]})["records"][0]
        self.assertEqual(restored["result_summary"]["evidence_ids"], [active, trashed])

    def test_undo_purged_evidence_only_edit_preserves_a_later_conclusion(self):
        record_id = self.store.save({"sample_id": "Evidence-only edit", "result_summary": {"conclusion": "Original"}})
        file_id = self.store.add_file(record_id, "evidence.csv", "XRD", io.BytesIO(b"1"), 1)
        row = self.store.list()[0]
        self.store.save({"sample_id": row["sample_id"], "revision": row["revision"],
                         "result_summary": {**row["result_summary"], "evidence_ids": [file_id]}}, record_id)
        batch_id = self.store.history()["batches"][0]["id"]
        self.store.change_file(file_id, "delete", {"record_revision": self.store.list()[0]["revision"]})
        self.store.purge_trash({"file_ids": [file_id], "confirm": "purge"})
        self.store.save({**self.store.list()[0], "result_summary": {"conclusion": "Later conclusion"}}, record_id)
        row = self.store.list()[0]

        preview = self.store.undo_history(batch_id, {"preview": True})
        self.assertEqual(preview["rows"][0]["changes"], [])
        result = self.store.undo_history(batch_id, {"preview": False, "revisions": preview["revisions"]})
        self.assertEqual(result["records"][0], row)
        self.assertTrue(self.store.history_detail(batch_id)["rows"][0]["reverted_by"])

    def test_multiple_solvents_roundtrip_legacy_options_and_backup(self):
        legacy = self.store.save({"sample_id": "legacy mixture", "solvent": "ODE + octadecane"})
        before = next(row for row in self.store.list() if row["id"] == legacy)
        self.assertEqual(before["solvents"], ["ODE + octadecane"], "Legacy names must not be split by punctuation")
        record_id = self.store.save({"sample_id": "multiple", "solvents": ["ODE", " OA ", "ODE"]})
        row = next(row for row in self.store.list() if row["id"] == record_id)
        self.assertEqual(row["solvents"], ["ODE", "OA"])
        self.assertEqual(row["solvent"], "ODE + OA")
        options = self.store.catalog()["condition_options"]["solvent"]
        self.assertIn("ODE", options)
        self.assertIn("OA", options)
        self.assertNotIn("ODE + OA", options)
        legacy_client = {key: value for key, value in row.items() if key != "solvents"}
        self.store.save(legacy_client, record_id)
        row = next(row for row in self.store.list() if row["id"] == record_id)
        self.assertEqual(row["solvents"], ["ODE", "OA"], "Older clients preserving the summary retain component choices")
        self.assertNotIn("ODE + OA", self.store.catalog()["condition_options"]["solvent"], "An older client must not create a combined-name option for preserved selections")
        for language in ("zh", "en"):
            csv_rows = list(csv.reader(io.StringIO(export_csv([row], language).decode("utf-8-sig"))))
            self.assertEqual(json.loads(csv_rows[1][-1]), ["ODE", "OA"])
        legacy_client.update(solvent="water + ethanol", revision=row["revision"])
        self.store.save(legacy_client, record_id)
        row = next(row for row in self.store.list() if row["id"] == record_id)
        self.assertEqual(row["solvents"], ["water + ethanol"], "Changed legacy summaries replace old selections without guessing components")
        self.store.save({**row, "solvents": []}, record_id)
        row = next(row for row in self.store.list() if row["id"] == record_id)
        self.assertEqual((row["solvents"], row["solvent"]), ([], ""))
        for invalid in (None, "ODE", [""], ["x\ny"], [3], ["x" * 251], [str(i) for i in range(21)]):
            with self.assertRaises(Problem):
                self.store.save({"sample_id": "bad", "solvents": invalid})
        self.assertEqual(next(row for row in Store(self.store.data).list() if row["id"] == legacy), before)
        backup = Path(self.folder.name) / "solvents.zip"
        self.store.backup(backup)
        restored = Path(self.folder.name) / "solvent-restore"
        with zipfile.ZipFile(backup) as archive:
            archive.extractall(restored)
        self.assertEqual(Store(restored / "data").list(), self.store.list())

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.folder.name) / "data")

    def tearDown(self):
        self.folder.cleanup()

    def test_deleted_condition_options_stay_deleted_without_changing_records(self):
        record_id = self.store.save({"sample_id": "Preserved", "solvents": ["ODE", "OA"], "ligand": "OA", "temperature": 250, "duration": 60,
                                     "material_amounts": [{"name": "OA", "amount": 0.25, "unit": "mmol"}]})
        before = self.store.list()
        for field, name in (("solvent", "OA"), ("temperature", "250.0"), ("duration", "60")):
            self.store.delete_condition_option({"field": field, "name": name})
        self.assertEqual(self.store.list(), before, "Removing saved options must not change records or revisions")
        self.store = Store(self.store.data)
        for field, name in (("solvent", "OA"), ("ligand", "OA"), ("temperature", "250"), ("duration", "60")):
            self.assertNotIn(name, self.store.catalog()["condition_options"][field])
        self.store.save({**before[0], "notes": "Still use the deleted conditions"}, record_id)
        self.store = Store(self.store.data)
        self.assertEqual(self.store.list()[0]["material_amounts"], before[0]["material_amounts"])
        self.assertNotIn("OA", self.store.catalog()["condition_options"]["solvent"])
        self.assertNotIn("250", self.store.catalog()["condition_options"]["temperature"])
        self.store.delete_condition_option({"field": "solvent", "name": "OA"})
        backup = Path(self.folder.name) / "hidden-options.zip"
        self.store.backup(backup)
        restored = Path(self.folder.name) / "hidden-restore"
        with zipfile.ZipFile(backup) as archive:
            archive.extractall(restored)
        self.assertEqual(Store(restored / "data").catalog(), self.store.catalog())
        for field, name in (("solvent", "OA"), ("temperature", "250"), ("duration", "60")):
            self.store.add_catalog_item("condition-options", {"field": field, "name": name})
            self.assertIn(name, self.store.catalog()["condition_options"][field])
        for payload in (None, {}, {"field": "status", "name": "OA"}, {"field": "solvent", "name": ""}, {"field": "temperature", "name": "nan"}):
            with self.assertRaises(Problem):
                self.store.delete_condition_option(payload)

    def test_material_amounts_validation_roundtrip_legacy_csv_and_backup(self):
        amounts = [{"name": "ODE", "amount": 5.5, "unit": "mL"}, {"name": "OA", "amount": 0.125, "unit": "g"}]
        payload = {"sample_id": "Amounts", "solvents": [" ODE ", "OA"], "material_amounts": amounts}
        record_id = self.store.save(payload)
        row = self.store.list()[0]
        self.assertEqual(row["material_amounts"], amounts)
        for language, column, json_column in (("zh", "溶剂 / 配体", "添加量 (JSON)"), ("en", "Solvents / ligands", "Material amounts (JSON)")):
            exported = list(csv.DictReader(io.StringIO(export_csv([row], language).decode("utf-8-sig"))))[0]
            self.assertEqual(exported[column], "ODE (5.5 mL) + OA (0.125 g)")
            self.assertEqual(json.loads(exported[json_column]), amounts)
        for bad in (None, "5 mL", {}, [{"name": "missing", "amount": 1, "unit": "mL"}], [amounts[0], amounts[0]],
                    *[[{"name": "ODE", "amount": value, "unit": "mL"}] for value in (-1, True, "5", None, float("nan"), float("inf"), 10 ** 1000)],
                    [{"name": "ODE", "amount": 1, "unit": "ml"}], [{"name": "ODE", "amount": 1, "unit": "kg"}], [None]):
            with self.subTest(bad=bad):
                with self.assertRaises(Problem):
                    self.store.save({**payload, "material_amounts": bad})
        self.assertEqual(self.store.list()[0], row, "Invalid requests must leave existing data intact")
        legacy_client = {key: value for key, value in row.items() if key not in ("solvents", "material_amounts")}
        self.store.save(legacy_client, record_id)
        row = self.store.list()[0]
        self.assertEqual(row["material_amounts"], amounts, "An older client retains amounts when it omits the field")
        without_amounts = {key: value for key, value in row.items() if key != "material_amounts"}
        self.store.save({**without_amounts, "solvents": ["OA"]}, record_id)
        row = self.store.list()[0]
        self.assertEqual(row["material_amounts"], [amounts[1]], "Removing a material clears only its own amount")
        backup = Path(self.folder.name) / "amounts.zip"
        self.store.backup(backup)
        restored = Path(self.folder.name) / "amounts-restore"
        with zipfile.ZipFile(backup) as archive:
            archive.extractall(restored)
        self.assertEqual(Store(restored / "data").list(), self.store.list())
        self.store.save({**row, "material_amounts": []}, record_id)
        self.assertEqual(self.store.list()[0]["material_amounts"], [], "Unknown amounts are stored as an empty list")

    def test_numeric_presets_migrate_and_preserve_legacy_materials(self):
        self.store.save({"sample_id": "Legacy conditions", "solvent": "ODE + octadecane", "ligand": "OA", "temperature": 0, "duration": 0})
        before = self.store.list()
        with self.store.connect() as db:
            db.execute("ALTER TABLE condition_options RENAME TO newer_options")
            db.execute("CREATE TABLE condition_options (field TEXT NOT NULL CHECK(field IN ('precursor','solvent','ligand')), name TEXT NOT NULL, PRIMARY KEY(field,name))")
            db.execute("INSERT INTO condition_options(field,name) SELECT field,name FROM newer_options WHERE field IN ('precursor','solvent','ligand')")
            db.execute("DROP TABLE newer_options")
        self.store = Store(self.store.data)
        self.assertEqual(self.store.list(), before, "Preset migration must not rewrite experiments")
        choices = self.store.catalog()["condition_options"]
        self.assertEqual(choices["temperature"], ["0"])
        self.assertEqual(choices["duration"], ["0"])
        self.assertIn("OA", choices["ligand"])
        self.assertEqual(self.store.add_catalog_item("condition-options", {"field": "temperature", "name": "275.0"}), {"field": "temperature", "name": "275"})
        self.store.add_catalog_item("condition-options", {"field": "duration", "name": "2.5"})
        for field, name in (("temperature", "275"), ("temperature", "-274"), ("temperature", "2501"), ("duration", "-1"), ("duration", "100001"), ("duration", "NaN"), ("temperature", "inf"), ("duration", "abc")):
            with self.subTest(field=field, name=name), self.assertRaises(Problem):
                self.store.add_catalog_item("condition-options", {"field": field, "name": name})
        self.assertEqual(Store(self.store.data).catalog(), self.store.catalog())
        for language in ("zh", "en"):
            rows = list(csv.reader(io.StringIO(export_csv(before, language).decode("utf-8-sig"))))
            self.assertEqual(rows[1][6], "ODE + octadecane + OA")
            self.assertEqual(json.loads(rows[1][-1]), ["ODE + octadecane", "OA"])
            self.assertNotIn("Ligand" if language == "en" else "配体", rows[0])
        self.assertEqual(self.store.list(), before)

    def test_unknown_zero_and_validation(self):
        unknown = self.store.save({"sample_id": "未记录温度"})
        zero = self.store.save({"sample_id": "零分钟样品", "temperature": 0, "duration": 0})
        rows = {r["id"]: r for r in self.store.list()}
        self.assertIsNone(rows[unknown]["temperature"])
        self.assertEqual(rows[zero]["duration"], 0)
        for invalid in ({"sample_id": ""}, {"sample_id": "x", "duration": -1},
                        {"sample_id": "x", "temperature": float("nan")},
                        {"sample_id": "x", "temperature": True},
                        {"sample_id": "x", "experiment_date": "2026-02-30"},
                        {"sample_id": "x", "experiment_no": "x" * 121},
                        {"sample_id": "x", "experiment_no": "x\x00"},
                        {"sample_id": "x", "extra_conditions": [{"name": "OA"}, {"name": "oa"}]}):
            with self.assertRaises(Problem):
                validate(invalid)

    def test_experiment_number_inference_override_and_legacy_migration(self):
        examples = {"XY-III-352-01": "XY-III-352", "XY-II-322_1": "XY-II-322", "XY-II-322 2nd": "XY-II-322",
                    "XY-III-350-redo-5min": "XY-III-350", "XY-I-279": "XY-I-279", "XY-1-279": "XY-1-279",
                    "XY-1-261(2)": "XY-1-261", "AB-III-249": "AB-III-249", "XY-160-202": "XY-160-202",
                    "XY-III-352x": "XY-III-352x", "Octadecane-check-Jul-2-26": "Octadecane-check-Jul-2-26"}
        for sample, expected in examples.items():
            self.assertEqual(experiment_number(sample), expected)
        record_id = self.store.save({"sample_id": "XY-III-352-01"})
        payload = self.store.list()[0]
        self.assertEqual(payload["experiment_no"], "XY-III-352")
        data = b"spectrum"
        file_id = self.store.add_file(record_id, "spectrum.txt", "NMR", io.BytesIO(data), len(data))
        self.store.save({**self.store.list()[0], "experiment_no": "Separate redo"}, record_id)
        row = Store(self.store.data).list()[0]
        self.assertEqual(row["experiment_no"], "Separate redo")
        self.assertEqual(row["sample_id"], "XY-III-352-01")
        self.assertEqual(self.store.file(file_id)[0].read_bytes(), data)
        self.assertEqual(row["files"][0]["experiment_id"], record_id)

        legacy = Path(self.folder.name) / "legacy"
        legacy.mkdir()
        with sqlite3.connect(legacy / "experiments.sqlite3") as db:
            db.execute("""CREATE TABLE experiments (
                id TEXT PRIMARY KEY, sample_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
                series TEXT NOT NULL, experiment_date TEXT NOT NULL, precursor TEXT NOT NULL,
                temperature REAL, duration REAL, solvent TEXT NOT NULL, ligand TEXT NOT NULL,
                status TEXT NOT NULL, notes TEXT NOT NULL, extra_conditions TEXT NOT NULL,
                archived INTEGER NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
            db.execute("INSERT INTO experiments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       ("old", "XY-III-352-01", "NMR", "", "", None, 0, "", "", "待补全", "Original", "[]", 0, 4, "date", "date"))
            db.execute("""CREATE TABLE files (id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id),
                       name TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
                       source TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(experiment_id, name, kind))""")
            db.execute("INSERT INTO files VALUES (?,?,?,?,?,?,?,?)", ("old-file", "old", "raw.txt", "NMR", 3, hashlib.sha256(b"raw").hexdigest(), "original path", "date"))
        (legacy / "files").mkdir()
        (legacy / "files/old-file").write_bytes(b"raw")
        migrated = Store(legacy).list()[0]
        self.assertEqual(migrated["experiment_no"], "XY-III-352")
        self.assertEqual((migrated["id"], migrated["sample_id"], migrated["notes"], migrated["duration"], migrated["revision"]),
                         ("old", "XY-III-352-01", "Original", 0, 4))
        self.assertEqual(Store(legacy).list(), [migrated], "Migration is repeatable")
        self.assertEqual(migrated["project_id"], "default")
        self.assertEqual(migrated["result_summary"], {"phases": [], "morphologies": [], "confirmation": "", "conclusion": "", "evidence_ids": []})
        self.assertEqual(Store(legacy).file("old-file")[0].read_bytes(), b"raw")
        with Store(legacy).connect() as db:
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
        other = Store(legacy).add_catalog_item("projects", {"name": "Second project"})["project"]
        Store(legacy).save({"sample_id": "XY-III-352-01", "project_id": other["id"]})

    def test_projects_scope_duplicates_moves_and_legacy_updates(self):
        first = self.store.save({"sample_id": "S-01", "experiment_no": "EXP-1"})
        project = self.store.add_catalog_item("projects", {"name": "Catalysis"})["project"]
        second = self.store.save({"sample_id": "S-01", "experiment_no": "EXP-1", "project_id": project["id"]})
        rows = {r["id"]: r for r in self.store.list()}
        self.assertEqual(rows[first]["project_id"], "default")
        self.assertEqual(rows[second]["project_name"], "Catalysis")
        with self.assertRaises(Problem) as conflict:
            self.store.save({**rows[second], "project_id": "default"}, second)
        self.assertEqual(conflict.exception.status, 409)
        with self.assertRaises(Problem):
            self.store.save({"sample_id": "s-01", "project_id": project["id"]})
        for invalid in ("missing", "", None, [], 1):
            with self.assertRaises(Problem):
                self.store.save({"sample_id": "valid", "project_id": invalid})
        self.store.save({"sample_id": "S-02", "revision": 1}, second)
        row = next(r for r in self.store.list() if r["id"] == second)
        self.assertEqual(row["project_id"], project["id"], "Older clients must preserve project membership")
        file_id = self.store.add_file(second, "data.csv", "XRD", io.BytesIO(b"data"), 4)
        row = next(r for r in self.store.list() if r["id"] == second)
        self.store.save({**row, "project_id": "default"}, second)
        moved = next(r for r in self.store.list() if r["id"] == second)
        self.assertEqual(moved["project_id"], "default")
        self.assertEqual(moved["files"][0]["id"], file_id)
        self.assertEqual(self.store.file(file_id)[0].read_bytes(), b"data")

    def test_categories_validation_persistence_and_backup(self):
        for collection in ("projects", "categories"):
            for invalid in (None, [], {}, {"name": 4}, {"name": " "}, {"name": "x" * 81}, {"name": "x\x00"}, {"name": "a\nb"}):
                with self.assertRaises(Problem):
                    self.store.add_catalog_item(collection, invalid)
        self.assertEqual(self.store.add_catalog_item("categories", {"name": " Raman "}), {"kind": "Raman"})
        for duplicate in ("raman", "XRD"):
            with self.assertRaises(Problem):
                self.store.add_catalog_item("categories", {"name": duplicate})
        with self.assertRaises(Problem):
            self.store.add_catalog_item("categories", {"name": "none"})
        project = self.store.add_catalog_item("projects", {"name": "=CUSTOM"})["project"]
        with self.assertRaises(Problem):
            self.store.add_catalog_item("projects", {"name": "=custom"})
        record_id = self.store.save({"sample_id": "S-01", "project_id": project["id"]})
        for invalid_kind in ("unknown", "raman", None, []):
            with self.assertRaises(Problem):
                self.store.add_file(record_id, "data.txt", invalid_kind, io.BytesIO(b"data"), 4)
        file_id = self.store.add_file(record_id, "data.txt", "Raman", io.BytesIO(b"data"), 4)
        backup = Path(self.folder.name) / "custom.zip"
        self.store.backup(backup)
        restored = Path(self.folder.name) / "custom-restored"
        with zipfile.ZipFile(backup) as archive:
            archive.extractall(restored)
        recovered = Store(restored / "data")
        self.assertEqual(recovered.catalog(), self.store.catalog())
        self.assertEqual(recovered.list(), self.store.list())
        self.assertEqual(recovered.file(file_id)[0].read_bytes(), b"data")
        rows = list(csv.DictReader(io.StringIO(export_csv(recovered.list(), "en").decode("utf-8-sig"))))
        self.assertEqual(rows[0]["Project"], "'=CUSTOM")

    def test_condition_options_migration_validation_and_persistence(self):
        record_id = self.store.save({"sample_id": "Conditions", "precursor": "Co", "solvent": "ODE", "ligand": "OA"})
        before = self.store.list()
        with self.store.connect() as db:
            db.execute("DROP TABLE condition_options")
        self.store = Store(self.store.data)
        self.assertEqual(self.store.list(), before, "Migration preserves existing experiment fields and revisions")
        self.assertEqual(self.store.catalog()["condition_options"]["precursor"], ["Co"])
        self.store.add_catalog_item("condition-options", {"field": "precursor", "name": " CO "})
        self.store.add_catalog_item("condition-options", {"field": "ligand", "name": "CO"})
        self.assertEqual(self.store.catalog()["condition_options"]["precursor"], ["CO", "Co"], "Chemical names keep letter case")
        for invalid in (None, [], {}, {"field": "notes", "name": "x"}, {"field": "precursor", "name": " "},
                        {"field": "ligand", "name": "x" * 251}, {"field": "solvent", "name": "a\nb"}, {"field": "solvent", "name": 4}):
            with self.assertRaises(Problem):
                self.store.add_catalog_item("condition-options", invalid)
        with self.assertRaises(Problem):
            self.store.add_catalog_item("condition-options", {"field": "precursor", "name": "CO"})
        self.store.save({**before[0], "precursor": "PA12"}, record_id)
        self.assertIn("PA12", self.store.catalog()["condition_options"]["precursor"])
        backup = Path(self.folder.name) / "conditions.zip"
        self.store.backup(backup)
        restored = Path(self.folder.name) / "conditions-restored"
        with zipfile.ZipFile(backup) as archive:
            archive.extractall(restored)
        self.assertEqual(Store(restored / "data").catalog(), self.store.catalog())

    def test_atomic_status_update_and_conflicts(self):
        first = self.store.save({"sample_id": "State-1", "notes": "Keep notes", "temperature": 0})
        second = self.store.save({"sample_id": "State-2", "status": "待表征"})
        file_id = self.store.add_file(first, "kept.csv", "XRD", io.BytesIO(b"1,2"), 3)
        rows = {r["id"]: r for r in self.store.list()}
        items = [{"id": key, "revision": rows[key]["revision"]} for key in (first, second)]
        stale = [{**items[0]}, {**items[1], "revision": 999}]
        with self.assertRaises(Problem):
            self.store.update_status({"records": stale, "status": "已完成"})
        self.assertEqual({r["id"]: r for r in self.store.list()}, rows, "A conflict must leave every record unchanged")
        for invalid in ({"status": "bad", "records": items}, {"status": "已完成", "records": []},
                        {"status": "已完成", "records": [items[0], items[0]]},
                        {"status": "已完成", "records": [{"id": first, "revision": True}]},
                        {"status": "已完成", "records": [None]}):
            with self.assertRaises(Problem):
                self.store.update_status(invalid)
        self.assertEqual(self.store.update_status({"records": items, "status": "已完成"})["updated"], 2)
        after = {r["id"]: r for r in self.store.list()}
        for key in (first, second):
            self.assertEqual(after[key]["status"], "已完成")
            self.assertEqual(after[key]["revision"], rows[key]["revision"] + 1)
            for field in rows[key].keys() - {"status", "revision", "updated_at"}:
                self.assertEqual(after[key][field], rows[key][field])
        self.assertEqual(self.store.file(file_id)[0].read_bytes(), b"1,2")
        self.store.archive(second, {"archived": True, "revision": after[second]["revision"]})
        with self.assertRaises(Problem):
            self.store.update_status({"records": [{"id": second, "revision": after[second]["revision"] + 1}], "status": "已记录"})

    def test_conflicting_edits_and_archive_preserve_data(self):
        record_id = self.store.save({"sample_id": "XY-001", "notes": "original"})
        self.store.save({"sample_id": "XY-001", "notes": "updated", "revision": 1}, record_id)
        with self.assertRaises(Problem) as conflict:
            self.store.save({"sample_id": "XY-001", "notes": "stale", "revision": 1}, record_id)
        self.assertEqual(conflict.exception.status, 409)
        self.store.archive(record_id, {"archived": True, "revision": 2})
        row = self.store.list()[0]
        self.assertEqual(row["notes"], "updated")
        self.assertTrue(row["archived"])
        with self.assertRaises(Problem):
            self.store.save({"sample_id": "xy-001"})
        self.store.archive(record_id, {"archived": False, "revision": 3})
        self.assertFalse(self.store.list()[0]["archived"])
        self.assertEqual(Store(self.store.data).list()[0]["notes"], "updated")

    def test_category_deletion_migrates_files_atomically_and_survives_restart(self):
        self.store.delete_category({"name": "XPS"})
        self.store = Store(self.store.data)
        self.assertNotIn("XPS", self.store.catalog()["kinds"])
        project = self.store.add_catalog_item("projects", {"name": "Second"})["project"]
        ids = [self.store.save({"sample_id": "A"}), self.store.save({"sample_id": "A", "project_id": project["id"]})]
        files = [self.store.add_file(record, "pattern.csv", "XRD", io.BytesIO(b"1,2\n"), 4) for record in ids]
        attached = next(row for row in self.store.list() if row["id"] == ids[1])
        self.store.archive(ids[1], {"archived": True, "revision": attached["revision"]})
        before = {row["id"]: row for row in self.store.list()}
        with self.assertRaises(Problem):
            self.store.delete_category({"name": "XRD"})
        result = self.store.delete_category({"name": "XRD", "replacement": "NMR"})
        self.assertEqual(result["moved"], 2)
        for row in self.store.list():
            old = before[row["id"]]
            self.assertEqual(row["revision"], old["revision"] + 1)
            self.assertEqual(row["archived"], old["archived"])
            self.assertEqual(row["files"][0], dict(old["files"][0], kind="NMR"))
            self.assertEqual(self.store.file(row["files"][0]["id"])[0].read_bytes(), b"1,2\n")
        self.assertEqual({row["files"][0]["id"] for row in self.store.list()}, set(files))
        events = [event for event in self.store.history()["file_events"] if event["action"] == "recategorize"]
        self.assertCountEqual([event["file_id"] for event in events], files)
        self.assertTrue(all(event["before"]["kind"] == "XRD" and event["after"]["kind"] == "NMR" for event in events))
        self.assertNotIn("XRD", Store(self.store.data).catalog()["kinds"])
        # A merge that would violate file uniqueness must roll back revisions and every file update.
        self.store.add_file(ids[0], "pattern.csv", "TEM", io.BytesIO(b"3,4\n"), 4)
        unchanged = self.store.list(), self.store.catalog()
        with self.assertRaises(Problem) as conflict:
            self.store.delete_category({"name": "NMR", "replacement": "TEM"})
        self.assertEqual(conflict.exception.status, 409)
        self.assertEqual((self.store.list(), self.store.catalog()), unchanged)
        for payload in (None, [], {}, {"name": []}, {"name": "missing"}, {"name": "NMR", "replacement": []},
                        {"name": "NMR", "replacement": "NMR"}, {"name": "NMR", "replacement": "missing"}):
            with self.assertRaises(Problem):
                self.store.delete_category(payload)
        self.store.delete_category({"name": "TEM", "replacement": "SEM"})
        for kind in ("DFT", "其他"):
            self.store.delete_category({"name": kind})
        backup = Path(self.folder.name) / "deleted-categories.zip"
        self.store.backup(backup)
        restored = Path(self.folder.name) / "restored"
        with zipfile.ZipFile(backup) as archive:
            archive.extractall(restored)
        self.assertEqual(Store(restored / "data").catalog(), self.store.catalog())
        empty = Store(Path(self.folder.name) / "one-category")
        for kind in empty.catalog()["kinds"][:-1]:
            empty.delete_category({"name": kind})
        with self.assertRaises(Problem):
            empty.delete_category({"name": empty.catalog()["kinds"][0]})

    def test_category_deletion_can_reassign_a_trashed_file_to_an_active_name(self):
        record_id = self.store.save({"sample_id": "Category merge with trash"})
        self.store.add_file(record_id, "spectrum.csv", "XRD", io.BytesIO(b"new"), 3)
        file_id = self.store.add_file(record_id, "spectrum.csv", "NMR", io.BytesIO(b"old"), 3)
        before = self.store.change_file(file_id, "delete", {"record_revision": self.store.list()[0]["revision"]})
        trashed, = self.store.trash()["items"]
        self.assertEqual(self.store.delete_category({"name": "NMR", "replacement": "XRD"}), {"ok": True, "moved": 1})
        self.assertNotIn("NMR", self.store.catalog()["kinds"])
        self.assertEqual(self.store.list()[0]["files"], before["records"][0]["files"])
        self.assertEqual(self.store.trash()["items"], [dict(trashed, kind="XRD", name_conflict=True)])

    def test_bounded_csv_and_safe_image_previews(self):
        record = self.store.save({"sample_id": "Preview"})
        def preview(name, content):
            file_id = self.store.add_file(record, name, "XRD", io.BytesIO(content), len(content))
            return self.store.preview(file_id)
        data = preview("header.csv", b'angle,intensity\n10,0\n11,42\n')
        self.assertEqual(data["labels"], ["angle", "intensity"])
        self.assertEqual(data["points"], [[10, 0], [11, 42]])
        self.assertFalse(data["truncated"])
        self.assertEqual(preview("raw.csv", b"1,2\n3,4\n")["points"], [[1, 2], [3, 4]])
        self.assertEqual(preview("invalid.csv", b"x,y\n1,2\n3,NaN\n")["points"], [])
        self.assertEqual(preview("invalid-first.csv", b"NaN,1\n1,2\n3,4\n")["points"], [])
        self.assertEqual(preview("multiple.csv", b'a,b,c\n1,2,3\n')["points"], [])
        multicolumn = preview("xrd.csv", b'#twotheta, yobs, ycal, bkg, diff\n10,7453,7279,7222,174\n10.1,7428,7327,,101\n')
        self.assertEqual(multicolumn["points"], [[10, 7453], [10.1, 7428]])
        self.assertEqual(multicolumn["labels"], ["twotheta", "yobs"])
        self.assertEqual(len(multicolumn["rows"][0]), 5, "The table retains every source column")
        self.assertEqual(multicolumn["background"], [], "An incomplete bkg column is not used")
        fitted = preview("fitted.csv", b'#twotheta, yobs, ycal, bkg, diff\n10,7453,7279,7222,174\n10.1,7428,7327,7200,101\n10.2,7400,7300,7190,100\n')
        self.assertEqual(fitted["background"], [7222, 7200, 7190], "bkg column is returned aligned with points")
        self.assertEqual(preview("nobkg.csv", b'two_theta_deg,observed_intensity\n10,1\n11,2\n')["background"], [])
        self.assertEqual(preview("bkg-as-y.csv", b'x,bkg\n10,1\n11,2\n')["background"], [], "The y column itself is never treated as background")
        self.assertEqual(preview("bad-x.csv", b'x,y,extra\n10,3,0\nbad,5,1\n')["points"], [])
        self.assertEqual(preview("quote.csv", b'"line 1\nline 2","<script>"\n')["rows"], [["line 1\nline 2", "<script>"]])
        limited = preview("long.csv", b"x,y\n" + b"1,2\n" * 55)
        self.assertEqual(len(limited["rows"]), 51)
        self.assertEqual(len(limited["points"]), 55)
        self.assertTrue(limited["truncated"])
        for name, content in (("too-many.csv", b"1,2\n" * 20001), ("too-big.csv", b"x" * (5 * 1024 * 1024 + 1)),
                              ("encoding.csv", b"\xff\xfe1,2"), ("malicious.png", b"<html>not an image</html>"),
                              ("active.svg", b'<svg onload="alert(1)"/>'), ("archive.zip", b"PK")):
            with self.assertRaises(Problem):
                preview(name, content)
        path, mime = preview("image.png", b"\x89PNG\r\n\x1a\nmore bytes")
        self.assertEqual(mime, "image/png")
        self.assertTrue(path.is_file())

    def test_attachment_integrity_and_backup_restore(self):
        record_id = self.store.save({"sample_id": "XY-附件"})
        data = "two_theta,intensity\n10,24\n".encode()
        file_id = self.store.add_file(record_id, "衍射.csv", "XRD", io.BytesIO(data), len(data))
        with self.assertRaises(Problem):
            self.store.add_file(record_id, "衍射.csv", "XRD", io.BytesIO(b"different"), 9)
        with self.assertRaises(Problem):
            self.store.add_file(record_id, "../escape", "XRD", io.BytesIO(data), len(data))
        with self.assertRaises(Problem):
            self.store.add_file(record_id, "incomplete.csv", "NMR", io.BytesIO(data), len(data) + 1)
        self.assertEqual(list(self.store.files.iterdir()), [self.store.files / file_id])
        self.assertEqual(self.store.file(file_id)[0].read_bytes(), data)
        archive_path = Path(self.folder.name) / "backup.zip"
        self.store.backup(archive_path)
        restored = Path(self.folder.name) / "restored"
        with zipfile.ZipFile(archive_path) as archive:
            self.assertIsNone(archive.testzip())
            archive.extractall(restored)
        recovered = Store(restored / "data")
        row = recovered.list()[0]
        self.assertEqual(row["sample_id"], "XY-附件")
        self.assertEqual(row["files"][0]["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(recovered.file(file_id)[0].read_bytes(), data)
        with recovered.connect() as connection:
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_csv_is_excel_readable_and_formula_safe(self):
        record_id = self.store.save({"sample_id": "=1+1", "notes": " +SUM(A1)\n记录", "temperature": -10,
                                     "duration": 0, "status": "待表征", "series": "示例系列",
                                     "extra_conditions": [{"name": "气氛", "value": "氮气", "unit": ""}]})
        for language in ("zh", "en"):
            with self.subTest(language=language):
                data = export_csv(self.store.list(), language)
                self.assertTrue(data.startswith(b"\xef\xbb\xbf"))
                rows = list(csv.reader(io.StringIO(data.decode("utf-8-sig"))))
                self.assertEqual(rows[0][0], "Sample ID" if language == "en" else "样品编号")
                self.assertEqual(rows[1][:2], ["'=1+1", "示例系列"])
                self.assertEqual(rows[1][4:6], ["-10.0", "0.0"])
                self.assertEqual(rows[1][7], "Awaiting analysis" if language == "en" else "待表征")
                self.assertEqual(rows[1][8], "'+SUM(A1)\n记录")
                self.assertEqual(rows[1][9], "'=1+1")
                self.assertEqual(rows[1][10], "默认项目")
                self.assertEqual(json.loads(rows[1][11])[0]["value"], "氮气")
                self.assertEqual(rows[1][-2], "No" if language == "en" else "否")
        self.store.archive(record_id, {"archived": True, "revision": 1})
        rows = list(csv.reader(io.StringIO(export_csv(self.store.list(), "en").decode("utf-8-sig"))))
        self.assertEqual(rows[1][-2], "Yes")


class HTTPTests(unittest.TestCase):
    def test_shared_conditions_http_update_and_received_batch(self):
        key = "HTTP shared"
        a = self.server.store.save({"sample_id": "HTTP shared A", "experiment_no": key})
        b = self.server.store.save({"sample_id": "HTTP shared B", "experiment_no": key, "duration": 12})
        route = "/api/experiment-defaults?" + urlencode({"project_id": "default", "experiment_no": key})
        status, data, _ = self.request(route)
        self.assertEqual(status, 200)
        group = json.loads(data)
        payload = {"sample_id": "HTTP shared A", "experiment_no": key, "shared_token": group["token"], "temperature": 50, "revision": 1}
        self.assertEqual(self.request("/api/experiments/" + a, payload, "PUT", "https://example.com")[0], 403)
        status, data, _ = self.request("/api/experiments/" + a, payload, "PUT")
        self.assertEqual(status, 200)
        updated = {row["id"]: row for row in json.loads(data)["records"]}
        self.assertEqual(set(updated), {a, b})
        self.assertEqual((updated[b]["temperature"], updated[b]["duration"]), (50, 12))
        latest = json.loads(self.request(route)[1])
        self.assertEqual(latest["last_save"], group["token"] + ":" + a)

    def request_json(self, path, body=None, method="GET", status=200):
        code, data, _ = self.request(path, body, method)
        self.assertEqual(code, status, data.decode())
        return json.loads(data)

    def test_attachment_update_checks_revisions_projects_names_and_history(self):
        store = self.server.store
        external_project = store.add_catalog_item("projects", {"name": "Attachment test project"})["project"]["id"]
        owner = store.save({"sample_id": "Attachment owner"})
        target = store.save({"sample_id": "Attachment target"})
        external = store.save({"sample_id": "Attachment external", "project_id": external_project})
        file_id = store.add_file(owner, "scan.csv", "XRD", io.BytesIO(b"1,2"), 3)
        store.add_file(owner, "taken.csv", "XRD", io.BytesIO(b"3,4"), 3)
        store.add_file(target, "scan.csv", "XRD", io.BytesIO(b"5,6"), 3)
        rows = {row["id"]: row for row in store.list()}
        before = rows[owner]
        file = next(item for item in before["files"] if item["id"] == file_id)
        route = f"/api/files/{file_id}/update"
        current = {"record_revision": before["revision"]}
        move = {**current, "target_record_id": target, "target_revision": rows[target]["revision"]}
        stale = "这条记录已在其他窗口更新。请保留当前内容，关闭编辑窗口后刷新再编辑。"
        cases = [
            ({**current, "record_revision": before["revision"] - 1, "name": "other.csv"}, 409, stale),
            ({**move, "target_revision": 0}, 409, stale),
            ({**current, "name": "scan.csv", "kind": "XRD"}, 400, "没有需要保存的修改。"),
            ({**current, "name": "../scan.csv"}, 400, "文件名无效，请使用不含路径的文件名。"),
            ({**current, "kind": "invalid"}, 400, "请选择有效的数据类型。"),
            ({**current, "name": "taken.csv"}, 409, "同类型附件 taken.csv 已存在，未覆盖。请重命名后再上传。"),
            (move, 409, "同类型附件 scan.csv 已存在，未覆盖。请重命名后再上传。"),
            ({**move, "target_record_id": external, "target_revision": rows[external]["revision"]},
             400, "附件只能移到同一项目的样品。"),
        ]
        for payload, status, message in cases:
            with self.subTest(payload=payload):
                self.assertEqual(self.request_json(route, payload, "POST", status), {"error": message})
        self.assertEqual({row["id"]: row for row in store.list()}, rows)
        store.archive(target, {"archived": True, "revision": rows[target]["revision"]})
        archived = "已归档的记录不能修改附件，请先恢复记录。"
        self.assertEqual(self.request_json(route, move, "POST", 409), {"error": archived})
        target_revision = next(row["revision"] for row in store.list() if row["id"] == target)
        store.archive(target, {"archived": False, "revision": target_revision})
        rows = {row["id"]: row for row in store.list()}
        result = self.request_json(route, {**move, "target_revision": rows[target]["revision"], "name": "unique.csv", "kind": "TEM"}, "POST")
        self.assertEqual(set(result), {"file", "records"})
        self.assertEqual(result["file"], dict(file, name="unique.csv", kind="TEM", experiment_id=target))
        self.assertEqual([row["id"] for row in result["records"]], [owner, target])
        for row in result["records"]:
            self.assertEqual(row["revision"], rows[row["id"]]["revision"] + 1)
            self.assertGreater(row["updated_at"], rows[row["id"]]["updated_at"])
        self.assertNotIn(file_id, {item["id"] for item in result["records"][0]["files"]})
        self.assertIn(result["file"], result["records"][1]["files"])
        self.assertEqual(self.request(f"/api/files/{file_id}")[1], b"1,2")
        events = self.request_json(f"/api/history?record_id={owner}")["file_events"]
        changes = [event for event in events if event["file_id"] == file_id]
        self.assertEqual([event["action"] for event in changes], ["move", "recategorize", "rename", "upload"])
        moved = changes[0]
        self.assertEqual(set(moved), {"id", "file_id", "record_id", "action", "before", "after", "created_at", "sample_id"})
        self.assertEqual(moved["before"], {"record_id": owner, "name": "scan.csv", "kind": "XRD"})
        self.assertEqual(moved["after"], {"record_id": target, "name": "unique.csv", "kind": "TEM"})
        self.assertEqual(moved["sample_id"], before["sample_id"])
        self.assertIn(moved, self.request_json(f"/api/history?record_id={target}")["file_events"])
        self.assertEqual(self.request_json(f"/api/history?project_id={external_project}")["file_events"], [])

    def test_trash_visibility_restore_and_archived_owner(self):
        store = self.server.store
        record_id = store.save({"sample_id": "Trash visibility"})
        content = b"1,2\n3,4\n"
        file_id = store.add_file(record_id, "trace.csv", "XRD", io.BytesIO(content), len(content))
        row = next(row for row in store.list() if row["id"] == record_id)
        original_file = row["files"][0]
        store.save({**row, "result_summary": {"conclusion": "Measured", "evidence_ids": [file_id]}}, record_id)
        row = next(row for row in store.list() if row["id"] == record_id)
        self.assertFalse(any(item["record_id"] == record_id and item["kind"] == "missing_data"
                             for item in self.request_json("/api/reviews")["items"]))
        base_count = self.request_json("/api/experiments")["trash_count"]
        delete = f"/api/files/{file_id}/delete"
        restore = f"/api/trash/{file_id}/restore"
        stale = "这条记录已在其他窗口更新。请保留当前内容，关闭编辑窗口后刷新再编辑。"
        self.assertEqual(self.request_json(delete, {"record_revision": row["revision"] - 1}, "POST", 409), {"error": stale})
        deleted = self.request_json(delete, {"record_revision": row["revision"]}, "POST")
        self.assertEqual(set(deleted), {"records", "trash_count"})
        self.assertEqual(deleted["trash_count"], base_count + 1)
        trashed = deleted["records"][0]
        self.assertEqual(trashed["revision"], row["revision"] + 1)
        self.assertGreater(trashed["updated_at"], row["updated_at"])
        self.assertEqual(trashed["files"], [])
        self.assertEqual(trashed["result_summary"]["evidence_ids"], [])
        catalog = self.request_json("/api/experiments")
        self.assertEqual(catalog["trash_count"], base_count + 1)
        self.assertEqual(next(row for row in catalog["experiments"] if row["id"] == record_id), trashed)
        trash = self.request_json("/api/trash?project_id=default")
        item = trash["items"][0]
        self.assertEqual(item, dict(original_file, record_id=record_id, sample_id=row["sample_id"],
                                   experiment_no=row["experiment_no"], project_id="default", record_archived=False,
                                   deleted_at=trashed["updated_at"], name_conflict=False))
        self.assertEqual(trash["total_bytes"], sum(entry["size"] for entry in trash["items"]))
        self.assertEqual(self.request_json("/api/trash?project_id=unknown"), {"items": [], "total_bytes": 0})
        self.assertEqual(self.request(f"/api/files/{file_id}")[:2], (200, content))
        self.assertEqual(self.request_json(f"/api/files/{file_id}/preview")["points"], [[1, 2], [3, 4]])
        csv_data = self.request(f"/api/export.csv?lang=en&ids={record_id}")[1].decode("utf-8-sig")
        csv_row = next(csv.DictReader(io.StringIO(csv_data)))
        self.assertEqual(json.loads(csv_row["Attachments (JSON)"]), [])
        self.assertEqual(json.loads(csv_row["Result summary (JSON)"])["evidence_ids"], [])
        status, data, _ = self.request(f"/api/experiments/share.zip?ids={record_id}&revisions={trashed['revision']}")
        self.assertEqual(status, 200)
        with zipfile.ZipFile(io.BytesIO(data)) as share:
            shared = json.loads(share.read("manifest.json"))["samples"][0]
            self.assertEqual(shared["files"], [])
            self.assertEqual(shared["result_summary"]["evidence_ids"], [])
            self.assertFalse(any(name.startswith("files/") for name in share.namelist()))
        self.assertTrue(any(item["record_id"] == record_id and item["kind"] == "missing_data"
                             for item in self.request_json("/api/reviews")["items"]))
        self.assertEqual(self.request_json(restore, {"record_revision": row["revision"]}, "POST", 409), {"error": stale})
        store.archive(record_id, {"archived": True, "revision": trashed["revision"]})
        latest = trashed["revision"] + 1
        locked = self.request_json(restore, {"record_revision": latest}, "POST", 409)
        self.assertEqual(locked["error"], "已归档的记录不能修改附件，请先恢复记录。")
        self.assertIs(self.request_json("/api/trash")["items"][0]["record_archived"], True)
        store.archive(record_id, {"archived": False, "revision": latest})
        occupied = store.add_file(record_id, "occupied.csv", "XRD", io.BytesIO(content), len(content))
        upload = f"/api/experiments/{record_id}/files?" + urlencode({"name": "trace.csv", "kind": "XRD"})
        status, data, _ = self.request(upload, b"5,6\n", "POST", headers={"Content-Type": "application/octet-stream"})
        self.assertEqual(status, 201, data.decode())
        replacement = json.loads(data)["id"]
        item = next(item for item in self.request_json("/api/trash")["items"] if item["id"] == file_id)
        self.assertIs(item["name_conflict"], True)
        current = {"record_revision": latest + 3}
        self.assertEqual(self.request_json(restore, current, "POST", 409),
                         {"error": "同名同类附件已存在，请为恢复的附件输入新名称。"})
        self.assertEqual(self.request_json(restore, {**current, "name": "occupied.csv"}, "POST", 409)["error"],
                         "同类型附件 occupied.csv 已存在，未覆盖。请重命名后再上传。")
        restored = self.request_json(restore, {**current, "name": "recovered.csv"}, "POST")
        self.assertEqual(restored["trash_count"], base_count)
        self.assertEqual(restored["file"], dict(original_file, name="recovered.csv"))
        active = restored["records"][0]
        self.assertEqual({item["id"]: item["name"] for item in active["files"]},
                         {replacement: "trace.csv", file_id: "recovered.csv", occupied: "occupied.csv"})
        self.assertEqual(active["revision"], current["record_revision"] + 1)
        self.assertEqual(active["result_summary"]["evidence_ids"], [file_id])
        events = self.request_json(f"/api/history?record_id={record_id}")["file_events"]
        self.assertEqual([entry["action"] for entry in events if entry["file_id"] == file_id], ["restore", "delete", "upload"])
        store.archive(record_id, {"archived": True, "revision": active["revision"]})
        self.assertEqual(self.request_json(delete, {"record_revision": active["revision"] + 1}, "POST", 409), locked)

    def test_purge_is_atomic_and_unlinks_after_commit(self):
        store = self.server.store
        owner = store.save({"sample_id": "Purge test"})
        receipt = "e" * 32
        active = store.add_file(owner, "active.csv", "XRD", io.BytesIO(b"1,2"), 3)
        first = store.add_file(owner, "a.csv", "XRD", io.BytesIO(b"2,3"), 3, receipt=receipt,
                               folder_target=("default", "Purge test", "Purge test"))["id"]
        second = store.add_file(owner, "b.csv", "XRD", io.BytesIO(b"3,4"), 3)
        self.assertEqual(store.folder_receipt(receipt), {"id": first, "record_id": owner})
        row = next(row for row in store.list() if row["id"] == owner)
        base_count = self.request_json("/api/experiments")["trash_count"]
        for file_id in (first, second):
            row = self.request_json(f"/api/files/{file_id}/delete", {"record_revision": row["revision"]}, "POST")["records"][0]
        trash = self.request_json("/api/trash")
        self.assertEqual([item["id"] for item in trash["items"][:2]], [second, first])
        route = "/api/trash/purge"
        payload = {"confirm": "purge", "file_ids": [first, second]}
        self.assertEqual(self.request(route, {**payload, "confirm": "wrong"}, "POST")[0], 400)
        mixed = self.request_json(route, {**payload, "file_ids": [first, active, second]}, "POST", 409)
        self.assertEqual(mixed["error"], "回收站内容已变化，请刷新后再清空。")
        self.assertEqual(self.request_json("/api/trash"), trash)
        self.assertTrue(all((store.files / file_id).is_file() for file_id in (first, second)))

        unlink = Path.unlink
        attempted = []

        def verify_committed(path, *, missing_ok=False):
            if path.parent == store.files:
                with store.connect() as db:
                    self.assertIsNone(db.execute("SELECT id FROM files WHERE id=?", (path.name,)).fetchone())
                    self.assertIsNone(db.execute("SELECT id FROM folder_import_receipts WHERE id=?", (receipt,)).fetchone())
                    self.assertEqual(db.execute("SELECT count(*) FROM file_events WHERE action='purge' AND record_id=?",
                                                (owner,)).fetchone()[0], 2)
                attempted.append(path.name)
                if path.name == second:
                    raise PermissionError("fixture holds this attachment open")
            return unlink(path, missing_ok=missing_ok)

        with patch.object(Path, "unlink", verify_committed), self.assertLogs("server", "WARNING") as logged:
            result = self.request_json(route, payload, "POST")
        self.assertEqual(result, {"purged": 2, "bytes": 3, "pending_bytes": 3, "trash_count": base_count})
        self.assertEqual(attempted, [first, second])
        self.assertIn(second, logged.output[0])
        self.assertFalse((store.files / first).exists())
        self.assertTrue((store.files / second).exists())
        self.assertEqual(self.request(f"/api/files/{second}")[0], 404)
        self.assertEqual(self.request(route, payload, "POST")[0], 409)
        events = self.request_json(f"/api/history?record_id={owner}")["file_events"]
        self.assertEqual([event["action"] for event in events if event["file_id"] == first], ["purge", "delete", "upload"])

    def test_purge_project_scope_rejects_mixed_projects_atomically(self):
        store = self.server.store
        foreign_project = store.add_catalog_item("projects", {"name": "Separate purge scope"})["project"]["id"]
        files = []
        for project_id in ("default", foreign_project):
            owner = store.save({"sample_id": "Scoped purge", "project_id": project_id})
            file_id = store.add_file(owner, "purge.csv", "XRD", io.BytesIO(b"123"), 3)
            store.change_file(file_id, "delete", {"record_revision": 2})
            files.append(file_id)
        trash = self.request_json("/api/trash")
        route = "/api/trash/purge"
        payload = {"file_ids": files, "confirm": "purge"}
        self.assertEqual(self.request_json(route, {**payload, "project_id": "default"}, "POST", 409),
                         {"error": "回收站内容已变化，请刷新后再清空。"})
        self.assertEqual(self.request_json("/api/trash"), trash)
        self.assertTrue(all((store.files / file_id).is_file() for file_id in files))
        self.assertEqual(self.request_json(route, {**payload, "file_ids": files[:1], "project_id": "default"}, "POST")["purged"], 1)
        self.assertEqual(self.request_json(route, {**payload, "file_ids": files[1:]}, "POST")["purged"], 1)

    def test_experiment_zip_browser_navigation_and_stale_message(self):
        record_id = self.server.store.save({"sample_id": "ZIP-HTTP"})
        route = "/api/experiments/share.zip?" + urlencode({"ids": record_id, "revisions": "1", "lang": "en"})
        status, body, headers = self.request(route, headers={"Accept": "text/html"})
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers["Content-Disposition"])
        self.assertTrue(body.startswith(b"PK"))
        self.server.store.archive(record_id, {"archived": True, "revision": 1})
        status, body, headers = self.request(route, headers={"Accept": "text/html"})
        self.assertEqual(status, 409)
        self.assertEqual(headers.get_content_type(), "text/plain")
        self.assertIn(b"refresh", body)

    def test_history_and_review_http_preview_commit_and_boundaries(self):
        _, body, _ = self.request("/api/experiments", {"sample_id": "WORKFLOW", "temperature": 0}, "POST")
        row = json.loads(body)["record"]
        _, body, _ = self.request("/api/experiments/" + row["id"], {**row, "temperature": 250}, "PUT")
        batches = json.loads(self.request("/api/history")[1])["batches"]
        batch_id = batches[0]["id"]
        path = "/api/history/" + batch_id + "/undo"
        self.assertEqual(self.request(path, {"preview": True}, "POST", origin="https://evil.example")[0], 403)
        self.assertEqual(self.request(path, {"preview": False}, "POST")[0], 400)
        self.assertEqual(self.request("/api/history?offset=-1")[0], 400)
        preview = json.loads(self.request(path, {"preview": True}, "POST")[1])
        self.assertEqual(self.request(path, {"preview": False, "revisions": preview["revisions"]}, "POST")[0], 200)
        status, body, _ = self.request("/api/reviews", {"record_id": row["id"], "title": "Temperature check", "field": "temperature"}, "POST")
        self.assertEqual(status, 201)
        review_id = json.loads(body)["id"]
        row = next(item for item in json.loads(self.request("/api/experiments")[1])["experiments"] if item["sample_id"] == "WORKFLOW")
        payload = {"preview": True, "revision": 1, "record_revision": row["revision"], "status": "resolved", "apply_value": True, "value": 200}
        path = "/api/reviews/" + review_id + "/decide"
        self.assertEqual(self.request(path, payload, "POST", origin="https://evil.example")[0], 403)
        self.assertEqual(self.request(path, payload, "POST")[0], 200)
        for invalid in ({**payload, "status": []}, {**payload, "value": None}, {**payload, "value": 5000}, {**payload, "revision": 0}):
            self.assertIn(self.request(path, invalid, "POST")[0], (400, 409))
        self.assertEqual(self.request(path, {**payload, "preview": False}, "POST")[0], 200)
        self.assertEqual(self.request(path, {**payload, "preview": False}, "POST")[0], 409)
        self.assertEqual(self.request("/api/reviews", {"record_id": [], "title": "bad"}, "POST")[0], 400)
        self.assertEqual(self.request("/api/reviews", {"record_id": row["id"], "title": "bad", "field": []}, "POST")[0], 400)
        self.assertEqual(self.request("/api/review-sources/" + "1" * 32)[0], 404)

    def test_bulk_http_preview_commit_and_boundaries(self):
        record_id = self.server.store.save({"sample_id": "HTTP-bulk", "temperature": 0})
        payload = {"records": [{"id": record_id, "revision": 1}], "changes": {"temperature": {"mode": "set", "value": 275}}, "preview": True}
        path = "/api/experiments/bulk"
        self.assertEqual(self.request(path, payload, "POST", origin="https://example.com")[0], 403)
        self.assertEqual(self.request(path, payload, "POST", headers={"X-Catalog-Local": ""})[0], 403)
        status, body, _ = self.request(path, payload, "POST")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["rows"][0]["changes"], [{"field": "temperature", "before": 0, "after": 275}])
        self.assertEqual(next(row for row in self.server.store.list() if row["id"] == record_id)["temperature"], 0)
        status, body, _ = self.request(path, {**payload, "preview": False}, "POST")
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertEqual(result["records"][0]["temperature"], 275)
        self.assertEqual(result["records"][0]["revision"], 2)
        self.assertIn("275", result["condition_options"]["temperature"])
        self.assertEqual(self.request(path, {**payload, "preview": False}, "POST")[0], 409)

    def test_project_settings_http_defaults_normalize_validate_and_track_availability(self):
        store = self.server.store
        project = store.add_catalog_item("projects", {"name": "Project settings"})["project"]["id"]
        path = f"/api/projects/{project}/settings"

        def request(body=None, expected=200, **kwargs):
            status, data, _ = self.request(path, body, "PUT" if body is not None else "GET", **kwargs)
            self.assertEqual(status, expected, data)
            return json.loads(data)

        self.assertEqual(set(request()), {"settings", "revision", "fields"})
        defaults = request()
        self.assertEqual(defaults, {"settings": {"builtin": {
            field: {"enabled": True, "label": {"zh": "", "en": ""}}
            for field in ("precursor", "temperature", "duration", "materials")},
            "key_fields": [], "phase_presets": []}, "fields": [], "revision": 0})
        with store.connect() as db:
            self.assertIsNone(db.execute("SELECT 1 FROM project_settings WHERE project_id=?", (project,)).fetchone())
        for method, body in (("GET", None), ("PUT", {"revision": 0, "settings": {}})):
            status, data, _ = self.request("/api/projects/unknown/settings", body, method)
            self.assertEqual((status, json.loads(data)), (404, {"error": "找不到该项目。"}))
        request(expected=401, authenticate=False)
        request({"revision": 0, "settings": {}}, expected=403, origin="https://example.com")

        fields = [dict(section="condition", label="Straße", type="single", options=["A", "B"])]
        fields += [dict(section="condition", label=f"Field {index}", type="text") for index in range(8)]
        template = dict(project_id=project, name="Settings test", revision=0, fields=fields)
        store.save_template(template)
        key = {"section": "condition", "label": "  STRASSE ", "check_missing": True}
        payload = {"revision": 0, "settings": {"builtin": {"temperature": {"enabled": False, "label": {"en": "  Heater "}},
                                                           "materials": {"label": {"zh": "材料"}}},
                                             "phase_presets": ["  Phase I ", "Phase II"], "key_fields": [key]}}
        saved = request(payload)
        self.assertEqual(saved, request())
        expected = defaults["settings"]
        expected["builtin"]["temperature"] = {"enabled": False, "label": {"zh": "", "en": "Heater"}}
        expected["builtin"]["materials"]["label"]["zh"] = "材料"
        expected["key_fields"] = [{"section": "condition", "label": "Straße", "check_missing": True}]
        expected["phase_presets"] = ["Phase I", "Phase II"]
        self.assertEqual(saved, {"settings": expected, "revision": 1,
                                 "fields": [{**expected["key_fields"][0], "available": True, "type": "single",
                                             "unit": "", "options": ["A", "B"]}]})
        self.assertEqual(request(payload, expected=409), {"error": "项目设置已在其他窗口修改，请刷新后再保存。"})
        invalid_settings = [
            {"builtin": {"precursor": {"label": {"zh": label}}}} for label in ("x" * 41, "a\x7fb", "b\n")
        ] + [
            {"key_fields": [{"section": field["section"], "label": field["label"]} for field in fields]},
            {"key_fields": [key, {**key, "label": "Straße"}]},
            {"phase_presets": ["Phase", " phase "]}, {"phase_presets": ["x" * 81]},
            {"phase_presets": [str(index) for index in range(21)]},
        ]
        for settings in invalid_settings:
            with self.subTest(settings=settings):
                request({"revision": 1, "settings": settings}, expected=400)
        for invalid in ({**key, "label": "Unlisted"}, {**key, "section": "result"}):
            self.assertEqual(request({"revision": 1, "settings": {"key_fields": [invalid]}}, expected=400),
                             {"error": "关键字段必须来自当前实验模板。"})
        store.save_template({**template, "revision": 1, "fields": fields[1:]})
        unavailable = request()
        self.assertEqual(unavailable["fields"], [{**expected["key_fields"][0], "available": False, "type": "",
                                                  "unit": "", "options": []}])
        self.assertEqual(unavailable["revision"], 1)
        experiments = json.loads(self.request("/api/experiments")[1])
        self.assertEqual(set(experiments["project_settings"]), {entry["id"] for entry in experiments["projects"]})
        self.assertEqual(experiments["project_settings"][project], unavailable)
        self.assertEqual(experiments["conventions"]["phase_presets"][project], ["Phase I", "Phase II"])
        self.assertEqual(store.history(project_id=project)["batches"], [])

    def test_csv_key_fields_use_each_samples_template_version_and_project(self):
        store = self.server.store
        first = store.add_catalog_item("projects", {"name": "CSV thin films"})["project"]["id"]
        second = store.add_catalog_item("projects", {"name": "CSV coatings"})["project"]["id"]
        thickness = dict(section="result", label="Thickness", type="number", unit="nm")
        formula = dict(section="condition", label="=Formula", type="text")
        factor = dict(section="condition", label="Factor", type="text")
        tags = dict(section="condition", label="Tags", type="multi", options=["@A", "B"])
        store.save_template(dict(project_id=first, name="Film", revision=0, fields=[thickness, formula, factor, tags]))
        old = store.save({"project_id": first, "sample_id": "Old film",
                          "lab_data": {"values": {"0": 8.25, "1": "=2+2", "2": "Different type", "3": ["@A", "B"]}}})
        thickness_um = {**thickness, "unit": "µm"}
        current_factor = {**factor, "type": "number"}
        store.save_template(dict(project_id=first, name="Film", revision=1, fields=[tags, thickness_um, current_factor, formula]))
        new = store.save({"project_id": first, "sample_id": "New film",
                          "lab_data": {"values": {"1": 0, "2": 4, "3": "ordinary"}}})
        other_thickness = {**thickness, "label": "thICKness", "unit": "Å"}
        other = dict(section="condition", label="Comment", type="text")
        store.save_template(dict(project_id=second, name="Coating", revision=0, fields=[other, other_thickness]))
        coat = store.save({"project_id": second, "sample_id": "Coating", "lab_data": {"values": {"0": "+note", "1": 45}}})
        for project, fields in [(first, [thickness_um, formula, current_factor, tags]), (second, [other_thickness, other])]:
            keys = [{"section": field["section"], "label": field["label"]} for field in fields]
            store.save_project_settings(project, {"revision": 0, "settings": {"key_fields": keys}})
        status, body, _ = self.request("/api/export.csv?" + urlencode({"ids": ",".join([old, new, coat]), "lang": "en"}))
        self.assertEqual(status, 200)
        headers, *rows = csv.reader(io.StringIO(body.decode("utf-8-sig")))
        self.assertEqual(headers[21:], ["Thickness (µm)", "'=Formula", "Factor", "Tags", "Comment"])
        self.assertEqual({row[0]: row[21:] for row in rows}, {
            "Old film": ["8.25 nm", "'=2+2", "", "'@A / B", ""],
            "New film": ["0", "ordinary", "4", "", ""],
            "Coating": ["45 Å", "", "", "", "'+note"],
        })
        _, body, _ = self.request(f"/api/export.csv?ids={coat}&lang=en")
        headers, row = csv.reader(io.StringIO(body.decode("utf-8-sig")))
        self.assertEqual((headers[21:], row[21:]), (["thICKness (Å)", "Comment"], ["45", "'+note"]))

    def test_results_http_roundtrip_and_ownership(self):
        status, body, _ = self.request("/api/experiments", {"sample_id": "HTTP-result", "result_summary": {"phases": ["Phase-A2"]}}, "POST")
        self.assertEqual(status, 201)
        row = json.loads(body)["record"]
        self.assertEqual(row["result_summary"]["confirmation"], "pending")
        file_id = self.server.store.add_file(row["id"], "evidence.csv", "XRD", io.BytesIO(b"1,2"), 3)
        row = next(item for item in self.server.store.list() if item["id"] == row["id"])
        payload = {**row, "result_summary": {**row["result_summary"], "confirmation": "confirmed", "evidence_ids": [file_id]}}
        path = "/api/experiments/" + row["id"]
        status, _, _ = self.request(path, payload, "PUT", origin="https://example.com")
        self.assertEqual(status, 403)
        status, body, _ = self.request(path, payload, "PUT")
        self.assertEqual(status, 200)
        saved = json.loads(body)["record"]
        self.assertEqual(saved["result_summary"]["evidence_ids"], [file_id])
        self.assertEqual(saved["revision"], row["revision"] + 1)
        status, _, _ = self.request(path, {**saved, "result_summary": {"evidence_ids": ["missing"]}}, "PUT")
        self.assertEqual(status, 400)
        status, body, _ = self.request("/api/experiments")
        self.assertEqual(next(item for item in json.loads(body)["experiments"] if item["id"] == row["id"]), saved)

    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        cls.server = make_server(Path(cls.folder.name), 0)
        cls.address = f"http://127.0.0.1:{cls.server.server_port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.cookie = session_cookie(cls.server)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.folder.cleanup()

    def request(self, path, body=None, method="GET", origin=None, headers=None, *, authenticate=True, scoped=True):
        request_headers = {"Content-Type": "application/json", "X-Catalog-Local": "1",
                           "Origin": origin or self.address}
        if authenticate:
            request_headers["Cookie"] = self.cookie
        request_headers.update(headers or {})
        data = json.dumps(body).encode() if body is not None and not isinstance(body, bytes) else body
        if scoped:
            path = self.server.session_prefix + path[1:]
        request = Request(self.address + path, data=data, headers=request_headers, method=method)
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, response.read(), response.headers
        except HTTPError as exc:
            return exc.code, exc.read(), exc.headers

    def test_session_redirect_cookie_health_header_and_locked_page(self):
        message = {"error": "会话已失效，请从启动入口重新打开实验数据目录。"}
        for method in ("GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "PROPFIND"):
            status, body, _ = self.request("/api/experiments", method=method, authenticate=False,
                                           headers={"Origin": "", "X-Catalog-Local": ""})
            self.assertEqual(status, 401)
            self.assertEqual(json.loads(body), message)
        self.assertEqual(self.request("/api/experiments", method="HEAD", authenticate=False)[0], 401)
        for headers in ({"X-Catalog-Token": "wrong"}, {"X-Catalog-Token": "invalid-é"}, {"Cookie": "catalog_session=wrong"},
                        {"Accept": "text/html"}):
            status, body, headers = self.request("/api/backup.zip", headers=headers, authenticate=False)
            self.assertEqual(status, 401)
            self.assertEqual(headers.get_content_type(), "application/json")
            self.assertEqual(json.loads(body), message)

        token = self.server.session_token
        header_auth = {"X-Catalog-Token": token}
        self.assertEqual(self.request("/api/experiments?token=" + token, authenticate=False)[0], 401)
        self.assertEqual(self.request("/api/experiments", scoped=False)[0], 401)
        self.assertEqual(self.request("/api/experiments", method="PROPFIND", scoped=False)[0], 401)
        self.assertEqual(self.request("/api/experiments", headers=header_auth, authenticate=False, scoped=False)[0], 200)
        self.assertEqual(self.request("/api/experiments", headers=header_auth, authenticate=False)[0], 401)
        self.assertEqual(self.request("/api/experiments", {"sample_id": "Rejected"}, "POST",
                                      "https://example.com", header_auth, authenticate=False, scoped=False)[0], 403)
        self.assertEqual(self.request("/api/experiments", {"sample_id": "Rejected"}, "POST",
                                      headers={**header_auth, "X-Catalog-Local": ""}, authenticate=False, scoped=False)[0], 403)
        public = {"app": "experiment-data-catalog", "version": 1}
        self.assertEqual(json.loads(self.request("/api/health", scoped=False)[1]), public)
        self.assertEqual(json.loads(self.request("/api/health", headers={"X-Catalog-Token": "wrong"},
                                                 authenticate=False, scoped=False)[1]), public)
        self.assertEqual(self.request("/api/health", authenticate=False)[0], 401)
        full = {**public, "workspace": str(self.server.store.data.resolve())}
        self.assertEqual(json.loads(self.request("/api/health", headers=header_auth, authenticate=False, scoped=False)[1]), full)
        self.assertEqual(self.request_json("/api/health"), full)

        status, page, _ = self.request("/", scoped=False)
        self.assertEqual(status, 401)
        self.assertIn(b"/locked.css", page)
        self.assertNotIn(b"<script", page)
        self.assertEqual(self.request("/", authenticate=False)[:2], (401, page))
        self.assertEqual(self.request("/index.html", scoped=False)[:2], (401, page))
        self.assertEqual(self.request("/locked.html", authenticate=False, scoped=False)[:2], (200, page))
        status, _, headers = self.request("/locked.css", authenticate=False, scoped=False)
        self.assertEqual((status, headers.get_content_type()), (200, "text/css"))
        status, _, headers = launch_request(self.server, token="wrong")
        self.assertEqual(status, 401)
        self.assertNotIn("Set-Cookie", headers)
        for path, content_type in (("/app.js", "text/javascript"), ("/i18n.js", "text/javascript"),
                                   ("/style.css", "text/css"),
                                   ("/notices.txt", "text/plain"), ("/license.txt", "text/plain")):
            status, _, headers = self.request(path)
            self.assertEqual(status, 200)
            self.assertEqual(headers.get_content_type(), content_type)
            self.assertEqual(self.request(path, scoped=False)[0], 404)
        with patch.object(server.Handler, "log_message") as log:
            status, page, headers = launch_request(self.server, desktop=1, token=token, blank="")
        prefix = f"/s/{self.server.instance}/"
        self.assertEqual((status, page, headers["Location"]), (303, b"", prefix + "?desktop=1&blank="))
        self.assertEqual(headers["Set-Cookie"], self.cookie + "; HttpOnly; SameSite=Strict; Path=" + prefix)
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        self.assertNotIn(token, repr(log.call_args_list))
        self.assertEqual(self.request(headers["Location"], scoped=False)[0], 200)
        legacy_cookie = {"Cookie": self.cookie + "; catalog_session=legacy-root-cookie"}
        self.assertEqual(self.request("/api/experiments", headers=legacy_cookie)[0], 200)
        self.assertEqual(self.request("/api/experiments", headers=legacy_cookie, scoped=False)[0], 401)

    def test_request_logs_redact_the_token_and_instance(self):
        token, instance = self.server.session_token, self.server.instance
        with patch("sys.stderr", new_callable=io.StringIO) as logs:
            self.assertEqual(launch_request(self.server, token=token)[0], 303)
            self.assertEqual(self.request("/api/health?token=" + token)[0], 200)
            client = HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
            try:
                malformed = f"GET /s/{instance}/?token={token} extra HTTP/1.1\r\n\r\n"
                client.send(malformed.encode("ascii"))
                with client.sock.makefile("rb") as response:
                    self.assertIn(b"400", response.readline())
            finally:
                client.close()
        log = logs.getvalue()
        self.assertFalse(token in log, "The launch token appeared in the log")
        self.assertFalse(instance in log, "The session instance appeared in the log")
        self.assertIn('"GET / HTTP/1.1" 303', log)
        self.assertIn('"GET /api/health HTTP/1.1" 200', log)
        self.assertIn("Bad request syntax", log)

    def test_browser_cookies_are_isolated_across_ports(self):
        with tempfile.TemporaryDirectory() as folder, make_server(Path(folder), 0) as other, serving(other):
            other_address = f"http://127.0.0.1:{other.server_port}"
            jar = CookieJar()
            browser = build_opener(HTTPCookieProcessor(jar))
            for address, service in ((self.address, self.server), (other_address, other)):
                with browser.open(address + "/?token=" + service.session_token, timeout=3) as response:
                    self.assertEqual(response.geturl(), address + service.session_prefix)
            self.assertEqual({cookie.path: cookie.value for cookie in jar},
                             {self.server.session_prefix: self.server.session_token, other.session_prefix: other.session_token})
            for address, service in ((self.address, self.server), (other_address, other)):
                with browser.open(address + service.session_prefix + "api/health", timeout=3) as response:
                    self.assertEqual(json.load(response)["workspace"], str(service.store.data.resolve()))
            with self.assertRaises(HTTPError) as rejected:
                browser.open(other_address + self.server.session_prefix, timeout=3)
            with rejected.exception as response:
                self.assertEqual(response.code, 401)
                self.assertIn(b"/locked.css", response.read())
            with self.assertRaises(HTTPError) as rejected:
                browser.open(other_address + self.server.session_prefix + "api/experiments", timeout=3)
            with rejected.exception as response:
                self.assertEqual(response.code, 401)
                self.assertEqual(response.headers.get_content_type(), "application/json")

    def test_browser_api_round_trip_and_origin_boundary(self):
        status, data, _ = self.request("/api/experiments", {"sample_id": "HTTP-01"}, "POST")
        self.assertEqual(status, 201)
        record_id = json.loads(data)["id"]
        self.assertEqual(json.loads(data)["record"]["revision"], 1)
        self.assertEqual(json.loads(data)["record"]["id"], record_id)
        status, data, _ = self.request("/api/experiments")
        self.assertTrue(any(row["id"] == record_id for row in json.loads(data)["experiments"]))
        status, data, _ = self.request("/api/experiments/" + record_id,
                                    {"sample_id": "HTTP-01", "temperature": 220, "revision": 1}, "PUT")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["record"]["temperature"], 220)
        self.assertEqual(json.loads(data)["record"]["revision"], 2)
        attachment = b"angle,intensity\n20,42\n"
        file_request = Request(self.address + self.server.session_prefix + "api/experiments/" + record_id + "/files?" +
                               urlencode({"name": "HTTP 衍射.csv", "kind": "XRD"}), data=attachment,
                               headers={"Origin": self.address, "X-Catalog-Local": "1", "Content-Type": "application/octet-stream",
                                        "Cookie": self.cookie})
        with urlopen(file_request, timeout=3) as response:
            self.assertEqual(response.status, 201)
            file_id = json.load(response)["id"]
        status, downloaded, headers = self.request("/api/files/" + file_id)
        self.assertEqual(downloaded, attachment)
        self.assertIn("filename*=UTF-8''", headers["Content-Disposition"])
        status, exported, headers = self.request("/api/export.csv?" + urlencode({"lang": "en", "ids": record_id}))
        self.assertEqual(status, 200)
        self.assertIn("text/csv", headers["Content-Type"])
        rows = list(csv.DictReader(io.StringIO(exported.decode("utf-8-sig"))))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["Sample ID"], "HTTP-01")
        self.assertEqual(rows[0]["Record status"], "Incomplete")
        self.assertIn("HTTP 衍射.csv", rows[0]["Attachments (JSON)"])
        status, _, _ = self.request("/api/experiments", {"sample_id": "EVIL"}, "POST", "https://example.com")
        self.assertEqual(status, 403)
        status, _, _ = self.request("/api/experiments", headers={"Host": "example.com"})
        self.assertEqual(status, 403)
        self.assertEqual(self.request("/../server.py")[0], 404)
        self.assertEqual(self.request("/api/experiments", {"sample_id": "HTTP-01"}, "POST")[0], 409)
        status, page, headers = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn("实验数据目录", page.decode())
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        status, archive, _ = self.request("/api/backup.zip")
        self.assertEqual(status, 200)
        with zipfile.ZipFile(io.BytesIO(archive)) as backup:
            self.assertIn("data/experiments.sqlite3", backup.namelist())

    def test_console_assets_and_source_distribution(self):
        from package_app import FILES, PACKAGE_NAME
        for path, content, mime in (("/i18n.js", b"CatalogI18n", "text/javascript"),
                                    ("/newapi-theme.css", b"QuantumNous", "text/css"),
                                    ("/notices.txt", b"AGPL", "text/plain"),
                                    ("/license.txt", b"GNU AFFERO GENERAL PUBLIC LICENSE", "text/plain")):
            with self.subTest(path=path):
                status, data, headers = self.request(path)
                self.assertEqual(status, 200)
                self.assertIn(content, data)
                self.assertIn(mime, headers["Content-Type"])
        status, data, headers = self.request("/api/source.zip")
        self.assertEqual(status, 200)
        self.assertIn("application/zip", headers["Content-Type"])
        with zipfile.ZipFile(io.BytesIO(data)) as source:
            self.assertIsNone(source.testzip())
            self.assertEqual(set(source.namelist()), {PACKAGE_NAME + "/" + name for name in FILES})
            for name in ("web/i18n.js", "web/newapi-theme.css", "web/locked.html", "web/locked.css",
                         "LICENSE", "LICENSE-MIT", "THIRD_PARTY_NOTICES.txt"):
                self.assertIn(PACKAGE_NAME + "/" + name, source.namelist())
            self.assertFalse(any(part in name for name in source.namelist()
                                 for part in ("/data/", "/research/", "/.test-tools/", ".log")))

    def test_custom_catalog_endpoints_and_origin_boundary(self):
        for endpoint, name, key in (("projects", "HTTP project", "project"), ("categories", "UV-Vis", "kind")):
            self.assertEqual(self.request("/api/" + endpoint, {"name": name}, "POST", "https://example.com")[0], 403)
            status, data, _ = self.request("/api/" + endpoint, {"name": name}, "POST")
            self.assertEqual(status, 201)
            self.assertIn(key, json.loads(data))
            self.assertEqual(self.request("/api/" + endpoint, {"name": name}, "POST")[0], 409)
        catalog = json.loads(self.request("/api/experiments")[1])
        self.assertIn("UV-Vis", catalog["kinds"])
        self.assertTrue(any(p["name"] == "HTTP project" for p in catalog["projects"]))

    def test_upload_checks_optional_project_and_sample_identity(self):
        store = self.server.store
        original_name = "HTTP upload + original"
        record_id = store.save({"sample_id": original_name})
        project_id = store.add_catalog_item("projects", {"name": "Upload destination"})["project"]["id"]
        path = f"/api/experiments/{record_id}/files?"
        content = b"1,2"

        def upload(**identity):
            query = urlencode({"name": "guarded.csv", "kind": "XRD", **identity})
            status, body, _ = self.request(path + query, content, "POST")
            return status, json.loads(body)

        stale = (409, {"error": "目标样品已变化，请刷新后再上传。"})
        store.save({"revision": 1, "sample_id": original_name, "project_id": project_id}, record_id)
        self.assertEqual(upload(project_id="default", sample_id=original_name), stale)
        store.save({"revision": 2, "sample_id": "HTTP upload + renamed"}, record_id)
        self.assertEqual(upload(project_id=project_id, sample_id=original_name), stale)
        self.assertEqual(upload(project_id=""), stale)
        self.assertEqual(upload(sample_id=""), stale)
        row = next(row for row in store.list() if row["id"] == record_id)
        self.assertEqual((row["revision"], row["files"]), (3, []))
        self.assertEqual(store.history(record_id=record_id)["file_events"], [])

        status, body = upload(project_id=project_id, sample_id=row["sample_id"])
        self.assertEqual(status, 201)
        row = next(row for row in store.list() if row["id"] == record_id)
        self.assertEqual((row["revision"], row["files"][0]["id"]), (4, body["id"]))
        self.assertEqual(store.file(body["id"])[0].read_bytes(), content)

    def test_condition_options_and_status_http_boundaries(self):
        payload = {"field": "precursor", "name": "HTTP precursor"}
        for endpoint, body in (("condition-options", payload), ("experiments/status", {"status": "已完成", "records": []})):
            self.assertEqual(self.request("/api/" + endpoint, body, "POST", "https://example.com")[0], 403)
            self.assertEqual(self.request("/api/" + endpoint, body, "POST", headers={"X-Catalog-Local": ""})[0], 403)
        self.assertEqual(self.request("/api/condition-options", payload, "POST")[0], 201)
        option_catalog = json.loads(self.request("/api/condition-options")[1])
        self.assertIn("HTTP precursor", option_catalog["condition_options"]["precursor"])
        catalog = json.loads(self.request("/api/experiments")[1])
        self.assertIn("HTTP precursor", catalog["condition_options"]["precursor"])
        record_id = self.server.store.save({"sample_id": "HTTP status"})
        status, data, _ = self.request("/api/experiments/status", {"records": [{"id": record_id, "revision": 1}], "status": "已完成"}, "POST")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["updated"], 1)
        self.assertEqual(next(r for r in self.server.store.list() if r["id"] == record_id)["status"], "已完成")

    def test_amounts_and_condition_deletion_http_boundaries(self):
        payload = {"sample_id": "HTTP amounts", "solvents": ["HTTP solvent"], "temperature": 123,
                   "material_amounts": [{"name": "HTTP solvent", "amount": 0.125, "unit": "g"}]}
        status, data, _ = self.request("/api/experiments", payload, "POST")
        self.assertEqual(status, 201)
        result = json.loads(data)
        self.assertEqual(result["record"]["material_amounts"], payload["material_amounts"])
        self.assertIn("123", result["condition_options"]["temperature"])
        deletion = {"field": "solvent", "name": "HTTP solvent"}
        self.assertEqual(self.request("/api/condition-options", deletion, "DELETE", "https://example.com")[0], 403)
        self.assertEqual(self.request("/api/condition-options", deletion, "DELETE", headers={"X-Catalog-Local": ""})[0], 403)
        self.assertEqual(self.request("/api/condition-options", {"field": "solvent", "name": ""}, "DELETE")[0], 400)
        for _ in range(2):
            self.assertEqual(self.request("/api/condition-options", deletion, "DELETE")[0], 200)
        status, data, _ = self.request("/api/experiments/" + result["id"], {**result["record"], "notes": "Keep amounts"}, "PUT")
        self.assertEqual(status, 200)
        saved = json.loads(data)
        self.assertEqual(saved["record"]["material_amounts"], payload["material_amounts"])
        self.assertNotIn("HTTP solvent", saved["condition_options"]["solvent"])

    def test_delete_category_and_preview_http_boundaries(self):
        self.request("/api/categories", {"name": "Disposable"}, "POST")
        self.assertEqual(self.request("/api/categories", {"name": "Disposable"}, "DELETE", "https://example.com")[0], 403)
        self.assertEqual(self.request("/api/categories", {"name": "Disposable"}, "DELETE", headers={"X-Catalog-Local": ""})[0], 403)
        self.assertEqual(self.request("/api/categories", {"name": "Disposable"}, "DELETE")[0], 200)
        self.assertEqual(self.request("/api/categories", {"name": "Disposable"}, "DELETE")[0], 409)
        record = self.server.store.save({"sample_id": "HTTP-preview"})
        file_id = self.server.store.add_file(record, "preview.csv", "XRD", io.BytesIO(b"1,2\n3,4"), 7)
        status, data, headers = self.request(f"/api/files/{file_id}/preview")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["points"], [[1, 2], [3, 4]])
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(self.request(f"/api/files/{file_id}/preview", headers={"Host": "evil.example"})[0], 403)
        image_id = self.server.store.add_file(record, "p.png", "XRD", io.BytesIO(b"\x89PNG\r\n\x1a\n"), 8)
        status, _, headers = self.request(f"/api/files/{image_id}/preview")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertNotIn("Content-Disposition", headers)
        self.assertIn("attachment", self.request(f"/api/files/{image_id}")[2]["Content-Disposition"])

    def test_category_counts_and_reassignment_of_an_archived_trashed_attachment(self):
        store = self.server.store
        retired, replacement = "Retired scan type", "Current scan type"
        for name in (retired, replacement):
            self.request_json("/api/categories", {"name": name}, "POST", 201)
        project = store.add_catalog_item("projects", {"name": "Second scan project"})["project"]["id"]
        owner, archived = [store.save({"sample_id": "Categorized sample", "project_id": project_id})
                           for project_id in ("default", project)]
        for record_id in (owner, archived):
            store.add_file(record_id, "active.csv", replacement, io.BytesIO(b"1"), 1)
        trashed = store.add_file(archived, "old.csv", retired, io.BytesIO(b"2"), 1)
        row = store.change_file(trashed, "delete", {"record_revision": 3})["records"][0]
        store.archive(archived, {"archived": True, "revision": row["revision"]})
        counts = self.request_json("/api/experiments")["category_counts"]
        self.assertEqual(counts[retired], {"active": 0, "trashed": 1})
        self.assertEqual(counts[replacement], {"active": 2, "trashed": 0})
        self.assertEqual(self.request_json("/api/categories", {"name": retired}, "DELETE", 400),
                         {"error": "请选择其他类别接收附件。"})
        self.assertEqual(self.request_json("/api/categories", {"name": retired, "replacement": replacement}, "DELETE"),
                         {"ok": True, "moved": 1})
        counts = self.request_json("/api/experiments")["category_counts"]
        self.assertNotIn(retired, counts)
        self.assertEqual(counts[replacement], {"active": 2, "trashed": 1})
        events = self.request_json(f"/api/history?record_id={archived}")["file_events"]
        event, = [event for event in events if event["action"] == "recategorize"]
        self.assertEqual(event["file_id"], trashed)
        self.assertEqual(event["before"], {"name": "old.csv", "kind": retired, "record_id": archived})
        self.assertEqual(event["after"], {**event["before"], "kind": replacement})

    def test_shutdown_is_local_and_graceful(self):
        with tempfile.TemporaryDirectory() as folder:
            server = make_server(Path(folder), 0)
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            address = f"http://127.0.0.1:{server.server_port}"
            try:
                token = session_cookie(server)
                request = Request(address + server.session_prefix + "api/shutdown", data=b"", method="POST",
                                  headers={"Origin": address, "X-Catalog-Local": "1", "Cookie": token})
                with urlopen(request, timeout=3) as response:
                    self.assertTrue(json.load(response)["ok"])
                thread.join(timeout=3)
                self.assertFalse(thread.is_alive())
            finally:
                if thread.is_alive():
                    server.shutdown()
                server.server_close()
                thread.join()


class DataSafetyTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.store = Store(self.root / "data")

    def tearDown(self):
        self.folder.cleanup()

    def version(self, path):
        db = sqlite3.connect(path)
        try:
            return db.execute("PRAGMA user_version").fetchone()[0]
        finally:
            db.close()

    def set_version(self, path, value):
        db = sqlite3.connect(path)
        try:
            db.execute(f"PRAGMA user_version={value}")
            db.commit()
        finally:
            db.close()

    def add(self, sample, name, content, kind="XRD"):
        record = self.store.save({"sample_id": sample})
        return record, self.store.add_file(record, name, kind, io.BytesIO(content), len(content))

    def test_schema_version_is_written_guarded_and_snapshotted_before_migration(self):
        from server import SCHEMA_VERSION, CatalogUnavailable
        database = self.store.db
        self.assertEqual(self.version(database), SCHEMA_VERSION)
        self.assertFalse((self.store.data / "migration-backups").exists(), "A new catalog needs no migration snapshot")
        self.store.save({"sample_id": "Kept before migration"})
        self.set_version(database, 0)  # Model a catalog from a program without schema versions.
        Store(self.store.data)
        snapshots = list((self.store.data / "migration-backups").glob("experiments-schema0-*.sqlite3"))
        self.assertEqual(len(snapshots), 1)
        copy =sqlite3.connect(snapshots[0])
        self.assertEqual(copy.execute("SELECT sample_id FROM experiments").fetchall(), [("Kept before migration",)])
        copy.close()
        self.assertEqual(self.version(database), SCHEMA_VERSION)
        Store(self.store.data)
        self.assertEqual(len(list((self.store.data / "migration-backups").iterdir())), 1, "Current catalogs are not snapshotted again")
        self.set_version(database, SCHEMA_VERSION + 1)
        before = database.read_bytes()
        with self.assertRaises(CatalogUnavailable):
            Store(self.store.data)
        self.assertEqual(database.read_bytes(), before, "A newer catalog is left untouched")

    def test_schema_two_migration_snapshots_before_adding_project_settings(self):
        record = self.store.save({"sample_id": "From schema 2"})
        with self.store.connect() as db:
            db.execute("DROP TABLE project_settings")
            db.execute("PRAGMA user_version=2")
        upgraded = Store(self.store.data)
        self.assertEqual(self.version(upgraded.db), 3)
        self.assertEqual(upgraded.get_project_settings("default")["revision"], 0)
        self.assertEqual(upgraded.list()[0]["id"], record)
        snapshot, = (self.store.data / "migration-backups").glob("experiments-schema2-*.sqlite3")
        self.assertEqual(self.version(snapshot), 2)
        original = sqlite3.connect(snapshot)
        try:
            self.assertIsNone(original.execute("SELECT 1 FROM sqlite_master WHERE name='project_settings'").fetchone())
            self.assertEqual(original.execute("SELECT id FROM experiments").fetchone()[0], record)
        finally:
            original.close()

    def test_legacy_attachment_migration_keeps_files_and_receipts(self):
        for version in (1, 2):
            with self.subTest(version=version):
                self.check_attachment_migration(version)

    def check_attachment_migration(self, version):
        original = Store(self.root / f"schema-{version}")
        content = b"old contents"
        receipt = "d" * 32
        target = ("default", "Legacy sample", "Legacy sample")
        imported = original.add_file("", "spectrum.csv", "XRD", io.BytesIO(content), len(content),
                                     source="old/spectrum.csv", folder_target=target, receipt=receipt)
        columns = ",".join(server.FILE_FIELDS)
        deleted_column = ""
        if version == 2:
            trashed = original.add_file(imported["record_id"], "trashed.csv", "XRD", io.BytesIO(b"old"), 3,
                                        source="old/trashed.csv", folder_target=target, receipt="e" * 32)
            original.change_file(trashed["id"], "delete", {"record_revision": original.list()[0]["revision"]})
            columns += ",deleted_at"
            deleted_column = "deleted_at TEXT,"
        expected_records = original.list()
        expected_trash = original.trash()
        expected_events = original.history()["file_events"] if version == 2 else []
        # Recreate the files table written by the original schema 1 or early schema 2.
        with original.connect() as db:
            expected_files = [tuple(row) for row in db.execute("SELECT rowid,* FROM files ORDER BY rowid")]
            expected_receipts = [tuple(row) for row in db.execute("SELECT * FROM folder_import_receipts ORDER BY id")]
            db.executescript(f"""PRAGMA foreign_keys=OFF;
                BEGIN IMMEDIATE;
                CREATE TABLE files_legacy (
                    id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id),
                    name TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL,
                    sha256 TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
                    {deleted_column} UNIQUE(experiment_id, name, kind)
                );
                INSERT INTO files_legacy (rowid,{columns}) SELECT rowid,{columns} FROM files;
                DROP TABLE files;
                ALTER TABLE files_legacy RENAME TO files;
                PRAGMA user_version={version};
            """)
            if version == 1:
                db.execute("DROP TABLE file_events")
        migrated = Store(original.data)
        snapshot, = (migrated.data / "migration-backups").glob(f"experiments-schema{version}-*.sqlite3")
        self.assertEqual(self.version(snapshot), version)
        copy = sqlite3.connect(snapshot)
        try:
            self.assertEqual("deleted_at" in {column[1] for column in copy.execute("PRAGMA table_info(files)")}, version == 2)
            self.assertIn("u", {index[3] for index in copy.execute("PRAGMA index_list(files)")})
            self.assertEqual(copy.execute("SELECT id, sha256 FROM files").fetchone(),
                             (imported["id"], hashlib.sha256(content).hexdigest()))
        finally:
            copy.close()
        self.assertEqual(self.version(migrated.db), server.SCHEMA_VERSION)
        self.assertEqual(migrated.list(), expected_records)
        self.assertEqual(migrated.trash(), expected_trash)
        self.assertEqual(migrated.folder_receipt(receipt), imported)
        self.assertEqual(migrated.file(imported["id"])[0].read_bytes(), content)
        self.assertEqual(migrated.history()["file_events"], expected_events)
        with migrated.connect() as db:
            self.assertEqual([tuple(row) for row in db.execute("SELECT rowid,* FROM files ORDER BY rowid")], expected_files)
            self.assertEqual([tuple(row) for row in db.execute("SELECT * FROM folder_import_receipts ORDER BY id")],
                             expected_receipts)
            indexes = {row["name"]: (row["origin"], row["unique"], row["partial"]) for row in db.execute("PRAGMA index_list(files)")}
            self.assertNotIn("u", {origin for origin, _, _ in indexes.values()})
            self.assertEqual(indexes["files_active_name"], ("c", 1, 1))
            self.assertEqual([row["name"] for row in db.execute("PRAGMA index_info(files_active_name)")],
                             ["experiment_id", "name", "kind"])
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_full_backups_include_trashed_files_and_events(self):
        content = b"irreplaceable"
        record_id, file_id = self.add("Back up trash", "test.csv", content)
        row = self.store.list()[0]
        self.store.change_file(file_id, "delete", {"record_revision": row["revision"]})
        expected = self.store.trash()
        events = self.store.history(record_id=record_id)["file_events"]
        destination = self.root / "backup.zip"
        self.store.backup(destination)
        extracted = self.root / "extracted"
        with zipfile.ZipFile(destination) as archive:
            archive.extractall(extracted)
        mirror = self.root / "mirror"
        self.store.folder_backup(mirror)
        for copied in (extracted, mirror):
            with self.subTest(backup=copied.name):
                restored = Store(copied / "data")
                self.assertEqual(restored.trash(), expected)
                self.assertEqual(restored.history(record_id=record_id)["file_events"], events)
                self.assertEqual(restored.file(file_id)[0].read_bytes(), content)
                self.assertEqual(restored.list()[0]["files"], [])

    def test_purge_waits_for_backup_to_copy_trashed_file(self):
        _, file_id = self.add("Concurrent backup", "data.csv", b"1,2")
        row = self.store.list()[0]
        self.store.change_file(file_id, "delete", {"record_revision": row["revision"]})
        ready, resume, purging = threading.Event(), threading.Event(), threading.Event()
        original_write = zipfile.ZipFile.write
        destination = self.root / "concurrent.zip"

        def pause_compression(archive, *args, **kwargs):
            ready.set()
            if not resume.wait(5):
                raise TimeoutError("Backup fixture did not resume")
            return original_write(archive, *args, **kwargs)

        def purge():
            purging.set()
            return self.store.purge_trash({"file_ids": [file_id], "confirm": "purge"})

        with patch.object(zipfile.ZipFile, "write", pause_compression), ThreadPoolExecutor(max_workers=2) as workers:
            backup = workers.submit(self.store.backup, destination)
            try:
                self.assertTrue(ready.wait(3))
                purge_result = workers.submit(purge)
                self.assertTrue(purging.wait(3))
                with self.assertRaises(FutureTimeout):
                    purge_result.result(timeout=0.2)
            finally:
                resume.set()
            self.assertEqual(backup.result(timeout=3)["files"], 1)
            self.assertEqual(purge_result.result(timeout=3)["purged"], 1)
        with zipfile.ZipFile(destination) as archive:
            self.assertEqual(archive.read("data/files/" + file_id), b"1,2")
        self.assertFalse((self.store.files / file_id).exists())

    def test_data_folder_lock_allows_one_service(self):
        from server import CatalogUnavailable
        session_path = self.store.data / ".catalog-session.json"
        self.assertFalse(session_path.exists())
        with make_server(self.store.data, 0) as first:
            session = json.loads(session_path.read_text(encoding="utf-8"))
            self.assertEqual(set(session), {"port", "token", "instance", "pid", "started_at"})
            self.assertEqual((session["port"], session["pid"]), (first.server_port, os.getpid()))
            self.assertRegex(session["token"], r"^[A-Za-z0-9_-]{43}$")
            self.assertRegex(session["instance"], r"^[0-9a-f]{32}$")
            self.assertEqual(session["instance"], first.instance)
            self.assertTrue(session["started_at"])
            self.assertEqual(session["token"], first.session_token)
            with self.assertRaises(CatalogUnavailable):
                make_server(self.store.data, 0)
            self.assertEqual(json.loads(session_path.read_text(encoding="utf-8")), session)
            backup = self.root / "session.zip"
            first.store.backup(backup)
            with zipfile.ZipFile(backup) as archive:
                self.assertNotIn("data/.catalog-session.json", archive.namelist())
            mirror = self.root / "session-mirror"
            first.store.folder_backup(mirror)
            self.assertFalse((mirror / "data" / session_path.name).exists())
        self.assertFalse(session_path.exists())
        with make_server(self.store.data, 0) as again:
            first.server_close()
            self.assertNotEqual(again.session_token, first.session_token)
            self.assertNotEqual(again.instance, first.instance)
            self.assertEqual(json.loads(session_path.read_text(encoding="utf-8"))["token"], again.session_token)
        self.assertFalse(session_path.exists())

    def test_open_reuses_busy_local_port_and_stop_reads_session_file(self):
        data = self.store.data
        with make_server(data, 0) as running:
            thread = threading.Thread(target=running.serve_forever)
            thread.start()
            try:
                cookie = session_cookie(running)
                with self.assertRaises(OSError):
                    with make_server(self.root / "other", running.server_port):
                        self.fail("A second server bound the same address and port")
                argv = ["server.py", "--data-dir", str(data), "--port", str(running.server_port), "--open"]
                with patch.object(sys, "argv", argv), patch.object(server.webbrowser, "open") as launch:
                    server.main()
                launch.assert_called_once_with(f"http://127.0.0.1:{running.server_port}/?token={running.session_token}")
                stopped = subprocess.run([sys.executable, "-X", "utf8", "server.py", "--data-dir", str(data), "--stop"],
                                         cwd=Path(__file__).resolve().parent, capture_output=True, timeout=10)
                self.assertEqual(stopped.returncode, 0, stopped.stderr.decode("utf-8"))
                self.assertIn(b"Experiment Data Catalog is stopping", stopped.stdout)
                thread.join(timeout=3)
                self.assertFalse(thread.is_alive())
            finally:
                if thread.is_alive():
                    running.shutdown()
                thread.join()
        self.assertFalse((data / server.SESSION_FILE).exists())
        with make_server(data, running.server_port) as restarted, serving(restarted):
            self.assertNotEqual(running.session_token, restarted.session_token)
            address = f"http://127.0.0.1:{restarted.server_port}"
            for suffix, mime in (("", "text/html"), ("api/experiments", "application/json")):
                request = Request(address + running.session_prefix + suffix, headers={"Cookie": cookie})
                with self.assertRaises(HTTPError) as rejected:
                    urlopen(request, timeout=3)
                with rejected.exception as response:
                    self.assertEqual(response.code, 401)
                    self.assertEqual(response.headers.get_content_type(), mime)

    def test_open_starts_with_actual_port_and_session_token(self):
        data = self.store.data
        path = data / server.SESSION_FILE

        def verify_launch(url):
            session = json.loads(path.read_text(encoding="utf-8"))
            self.assertNotEqual(session["port"], 0)
            self.assertEqual(url, f"http://127.0.0.1:{session['port']}/?token={session['token']}")

        argv = ["server.py", "--data-dir", str(data), "--port", "0", "--open"]
        with patch.object(sys, "argv", argv), patch.object(server.LocalHTTPServer, "serve_forever"), \
                patch.object(server.webbrowser, "open", side_effect=verify_launch) as launch:
            server.main()
        self.assertEqual(launch.call_count, 1)
        self.assertFalse(path.exists())

    def test_startup_keeps_orphans_and_retries_a_committed_purge(self):
        owner, pending = self.add("Held purge", "held.csv", b"held")
        _, active = self.add("Keep active", "active.csv", b"active")
        self.store.change_file(pending, "delete", {"record_revision": 2})
        with patch.object(Path, "unlink", side_effect=PermissionError("fixture holds the file open")), \
                self.assertLogs("server", "WARNING"):
            result = self.store.purge_trash({"file_ids": [pending], "confirm": "purge"})
        self.assertEqual(result, {"purged": 1, "bytes": 0, "pending_bytes": 4, "trash_count": 0})
        self.assertTrue((self.store.files / pending).exists())
        orphan, partial = "a" * 32, ".part-interrupted"
        (self.store.files / orphan).write_bytes(b"orphan")
        (self.store.files / partial).write_bytes(b"partial")
        ignored = ("notes.txt", "B" * 32, "c" * 31, "d" * 32 + ".csv", ".part")
        for name in ignored:
            (self.store.files / name).write_bytes(b"keep")
        orphaned = self.store.data / "orphaned"
        orphaned.mkdir()
        (orphaned / orphan).write_bytes(b"previous orphan")
        with make_server(self.store.data, 0) as restarted:
            self.assertEqual(restarted.store.trash()["items"], [])
            self.assertCountEqual([path.name for path in restarted.store.files.iterdir()], [active, *ignored])
            self.assertEqual((orphaned / orphan).read_bytes(), b"previous orphan")
            self.assertEqual((orphaned / partial).read_bytes(), b"partial")
            self.assertCountEqual([path.read_bytes() for path in orphaned.iterdir()], [b"orphan", b"partial", b"previous orphan"])
            self.assertEqual(restarted.store.history(record_id=owner)["file_events"][0]["action"], "purge")
            with restarted.store.connect() as db:
                self.assertIsNone(restarted.store.setting(db, server.PENDING_PURGE_PREFIX + pending))

    def test_startup_keeps_case_variants_of_referenced_ids(self):
        record_id = self.store.save({"sample_id": "Case-variant attachments"})
        upper_on_disk, upper_in_db = "a1" * 16, "b2" * 16
        for file_id in (upper_on_disk, upper_in_db):
            with patch.object(server.uuid, "uuid4", return_value=server.uuid.UUID(hex=file_id)):
                self.store.add_file(record_id, file_id + ".csv", "XRD", io.BytesIO(b"1"), 1)
        # An intermediate rename changes the directory entry even on a case-insensitive filesystem.
        files = self.store.files
        (files / upper_on_disk).rename(files / "rename-fixture").rename(files / upper_on_disk.upper())
        with self.store.connect() as db:
            db.execute("UPDATE files SET id=? WHERE id=?", (upper_in_db.upper(), upper_in_db))
        with make_server(self.store.data, 0) as restarted:
            self.assertCountEqual([path.name for path in restarted.store.files.iterdir()],
                                  [upper_on_disk.upper(), upper_in_db])
            self.assertFalse((restarted.store.data / "orphaned").exists())

    def test_zip_backup_stores_compressed_attachments_without_recompressing(self):
        self.add("Z-1", "raw.zip", b"PK" + b"x" * 500)
        self.add("Z-2", "trace.csv", b"1,2\n" * 200)
        destination = self.root / "backup.zip"
        summary = self.store.backup(destination)
        self.assertEqual((summary["records"], summary["files"]), (2, 2))
        names = {row["id"]: row["name"] for record in self.store.list() for row in record["files"]}
        with zipfile.ZipFile(destination) as archive:
            self.assertIsNone(archive.testzip())
            types = {names[info.filename.rsplit("/", 1)[-1]]: info.compress_type for info in archive.infolist() if info.filename.startswith("data/files/")}
        self.assertEqual(types, {"raw.zip": zipfile.ZIP_STORED, "trace.csv": zipfile.ZIP_DEFLATED})

    def test_folder_backup_blocks_reconciliation_in_another_process(self):
        self.add("Previous snapshot", "first.csv", b"1,2")
        target = self.root / "mirror"
        self.store.folder_backup(target)
        target = self.store.backup_target(str(target))
        content = b"3,4"
        _, file_id = self.add("New since previous snapshot", "second.csv", content)
        mirror = target / "data"
        ready, resume = threading.Event(), threading.Event()
        original_copy = Store.copy_verified

        def pause_after_copy(*args):
            original_copy(*args)
            ready.set()
            if not resume.wait(15):
                raise TimeoutError("Backup fixture did not resume")

        open_catalog = "import sys\nfrom server import make_server\nwith make_server(sys.argv[1], 0): pass"
        with patch.object(Store, "copy_verified", side_effect=pause_after_copy):
            self.assertEqual(self.store.start_folder_backup({"path": str(target)})["state"], "running")
            try:
                self.assertTrue(ready.wait(5))
                self.assertEqual((mirror / "files" / file_id).read_bytes(), content)
                started = subprocess.run([sys.executable, "-X", "utf8", "-B", "-c", open_catalog, str(mirror)],
                                         cwd=server.ROOT, capture_output=True, encoding="utf-8", timeout=8)
                self.assertNotEqual(started.returncode, 0)
                self.assertIn("This data folder is already open", started.stderr)
                with self.assertRaisesRegex(Problem, "目标文件夹是一个正在使用的实验库"):
                    self.store.backup_target(str(target))
                with self.assertRaisesRegex(Problem, "已有备份正在进行") as busy:
                    self.store.start_folder_backup({"path": str(target)})
                self.assertEqual(busy.exception.status, 409)
            finally:
                resume.set()
                self.assertTrue(self.store.backup_guard.acquire(timeout=5))
                self.store.backup_guard.release()
            progress = self.store.backup_status()
            self.assertEqual((progress["state"], progress["copied_files"]), ("done", 1), progress["error"])
        with make_server(mirror, 0) as restored:
            self.assertEqual(restored.store.list(), self.store.list())
            self.assertEqual(restored.store.file(file_id)[0].read_bytes(), content)
            self.assertFalse((mirror / "orphaned").exists())
        self.assertEqual(self.store.folder_backup(self.store.backup_target(str(target)))["copied_files"], 0)

    def test_folder_backup_is_incremental_verified_and_restorable(self):
        _, first = self.add("F-1", "a.csv", b"1,2\n")
        self.add("F-2", "b.zip", b"PK-data")
        target = self.root / "mirror"
        self.assertEqual(self.store.folder_backup(self.store.backup_target(str(target))), {"copied_files": 2, "copied_bytes": 11})
        restored = Store(target / "data")
        self.assertEqual(restored.list(), self.store.list())
        self.assertEqual(restored.file(first)[0].read_bytes(), b"1,2\n")
        self.assertEqual(self.store.folder_backup(target)["copied_files"], 0, "Unchanged attachments are not copied again")
        self.add("F-3", "c.csv", b"3,4\n")
        self.assertEqual(self.store.folder_backup(target)["copied_files"], 1)
        self.assertEqual(len(Store(target / "data").list()), 3)
        # Same-size corruption is only caught by the explicit verification pass.
        (target / "data" / "files" / first).write_bytes(b"9,9\n")
        self.assertEqual(self.store.folder_backup(target)["copied_files"], 0)
        self.assertEqual(self.store.folder_backup(target, verify=True)["copied_files"], 1)
        self.assertEqual((target / "data" / "files" / first).read_bytes(), b"1,2\n")
        info = json.loads((target / "backup-info.json").read_text(encoding="utf-8"))
        self.assertEqual((info["records"], info["files"]), (3, 3))
        self.assertTrue((target / "RESTORE.txt").is_file())
        self.assertTrue(list((target / "db-history").glob("experiments-*.sqlite3")))
        self.assertFalse(list(target.rglob(".part-*")))
        last = self.store.backup_status()["last"]
        self.assertEqual((last["kind"], last["path"], last["files"]), ("folder", str(target.resolve()), 3))
        self.assertEqual(self.store.backup_status()["folder"], str(target.resolve()))

    def test_local_catalog_file_configures_labels_prefixes_and_travels_with_backups(self):
        import server as module
        local = {"notebook_prefixes": ["qz", "bad prefix", 7], "translations": {"categories": {"系列": "Series"}},
                 "precursor_aliases": [{"label": " Compound A ", "aliases": ["CA", "", 3]}, {"label": ""}, "bad"],
                 "phase_presets": {"default": ["Phase-A", " ", None], "other": "not a list"}}
        (self.store.data / "local-catalog.json").write_text(json.dumps(local, ensure_ascii=False), encoding="utf-8")
        before = set(module.NOTEBOOK_PREFIXES)
        try:
            store = Store(self.store.data)
            self.assertEqual(store.notebook_prefixes(), ["QZ"], "Only plain letter prefixes are accepted")
            self.assertEqual(store.local_translations(), local["translations"])
            self.assertEqual(store.conventions(), {"precursor_aliases": [{"label": "Compound A", "aliases": ["CA"]}],
                                                   "phase_presets": {"default": ["Phase-A"]},
                                                   "notebook_prefixes": sorted(module.NOTEBOOK_PREFIXES)},
                             "Invalid convention entries are dropped")
            first =store.save({"sample_id": "QZ-1-005_a"})
            second = store.save({"sample_id": "QZ-I-005_b"})
            self.assertEqual(store.shared_defaults("default", "QZ-1-005")["count"], 2, "Configured prefixes merge book 1 and I")
            self.assertEqual(module.experiment_key("default", "OTHER-1-005"), "other-1-005", "Unlisted prefixes stay separate")
            backup = self.root / "local.zip"
            store.backup(backup)
            with zipfile.ZipFile(backup) as archive:
                self.assertEqual(json.loads(archive.read("data/local-catalog.json")), local)
            store.folder_backup(self.root / "mirror")
            self.assertEqual(json.loads((self.root / "mirror" / "data" / "local-catalog.json").read_text(encoding="utf-8")), local)
            self.assertTrue(first and second)
        finally:
            module.NOTEBOOK_PREFIXES.clear()
            module.NOTEBOOK_PREFIXES.update(before)
        (self.store.data / "local-catalog.json").write_text("not json", encoding="utf-8")
        self.assertEqual((self.store.local_translations(), self.store.notebook_prefixes()), ({}, []), "A damaged file is ignored")

    def test_interrupted_folder_backup_keeps_previous_consistent_snapshot(self):
        self.add("I-1", "a.csv", b"1,2\n")
        target = self.root / "mirror"
        self.store.folder_backup(target)
        previous = (target / "data" / "experiments.sqlite3").read_bytes()
        self.add("I-2", "b.csv", b"3,4\n")
        with patch.object(Store, "copy_verified", side_effect=OSError("disk removed")):
            with self.assertRaises(OSError):
                self.store.folder_backup(target)
        self.assertEqual((target / "data" / "experiments.sqlite3").read_bytes(), previous)
        self.assertEqual(len(Store(target / "data").list()), 1)
        self.assertFalse(list(target.rglob(".part-*")))

    def test_folder_backup_rejects_live_catalogs_and_foreign_backups(self):
        live = self.store.data
        for value in ("", "relative/folder", str(live), str(live / "inside"), str(live.parent)):
            with self.assertRaises(Problem, msg=value):
                self.store.backup_target(value)
        other = Store(self.root / "other" / "data")
        other.folder_backup(self.root / "other-backup")
        with self.assertRaises(Problem) as foreign:
            self.store.backup_target(str(self.root / "other-backup"))
        self.assertEqual(foreign.exception.status, 409)
        unrelated = self.root / "unrelated"
        (unrelated / "data").mkdir(parents=True)
        (unrelated / "data" / "experiments.sqlite3").write_bytes(b"")
        with self.assertRaises(Problem):
            self.store.backup_target(str(unrelated))
        self.assertEqual(self.store.backup_target(str(self.root / "fresh")), (self.root / "fresh").resolve())

    def test_backup_http_reports_progress_and_allows_one_backup_at_a_time(self):
        self.add("H-1", "a.csv", b"1,2\n")
        server =make_server(self.root / "data", 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        address = f"http://127.0.0.1:{server.server_port}"

        def call(path, body=None, method="GET"):
            data = json.dumps(body).encode() if body is not None else None
            request = Request(address + path, data=data, method=method,
                              headers={"Content-Type": "application/json", "X-Catalog-Local": "1", "Origin": address,
                                       "X-Catalog-Token": server.session_token})
            try:
                with urlopen(request, timeout=5) as response:
                    return response.status, response.read()
            except HTTPError as exc:
                return exc.code, exc.read()
        try:
            status, body = call("/api/experiments")
            self.assertEqual(json.loads(body)["backup"]["last"], None)
            server.store.backup_guard.acquire()
            try:
                self.assertEqual(call("/api/backup.zip")[0], 409)
                self.assertEqual(call("/api/backup/folder", {"path": str(self.root / "mirror")}, "POST")[0], 409)
            finally:
                server.store.backup_guard.release()
            self.assertEqual(call("/api/backup/folder", {"path": "relative"}, "POST")[0], 400)
            status, body = call("/api/backup/folder", {"path": str(self.root / "mirror")}, "POST")
            self.assertEqual(status, 202)
            for _ in range(100):
                progress = json.loads(call("/api/backup/status")[1])
                if progress["state"] != "running":
                    break
                threading.Event().wait(0.05)
            self.assertEqual((progress["state"], progress["copied_files"], progress["last"]["kind"]), ("done", 1, "folder"))
            status, body = call("/api/backup.zip")
            self.assertEqual(status, 200)
            with zipfile.ZipFile(io.BytesIO(body)) as archive:
                self.assertIn("data/experiments.sqlite3", archive.namelist())
            for _ in range(100):  # Recorded after the last byte is sent, so allow the handler to finish.
                last = json.loads(call("/api/backup/status")[1])["last"]
                if last["kind"] == "zip":
                    break
                threading.Event().wait(0.05)
            self.assertEqual(last["kind"], "zip")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
