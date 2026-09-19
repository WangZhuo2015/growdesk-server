"""Pure validation tests for the legacy care materializer.

The owned PostgreSQL test lives separately; these checks never connect to a
database and cover archive mapping/SQL invariants quickly.
"""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile


def load_module():
    path = Path(__file__).with_name("materialize_care.py")
    spec = importlib.util.spec_from_file_location("materialize_care_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


m = load_module()


def load_snapshot_module():
    path = Path(__file__).with_name("snapshot.py")
    spec = importlib.util.spec_from_file_location("snapshot_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


snapshot = load_snapshot_module()


def archive():
    stamp = "2026-09-12T08:00:00+08:00"
    return {
        "formatVersion": 1,
        "timeZone": "Asia/Shanghai",
        "capturedAt": stamp,
        "sourceId": "legacy_web",
        "sourceSha256": "source-snapshot",
        "excluded": [],
        "tables": {
            "User": [
                {"id": "test_user_1", "username": "test_user_1", "passwordHash": "$2b$10$" + "a" * 53, "displayName": "test_user", "createdAt": stamp, "updatedAt": stamp},
            ],
            "Family": [
                {"id": "test_family_1", "name": "test_family", "createdAt": stamp, "updatedAt": stamp},
            ],
            "FamilyMember": [
                {"id": "test_member_1", "familyId": "test_family_1", "userId": "test_user_1", "role": "admin", "createdAt": stamp, "updatedAt": stamp},
            ],
            "Baby": [
                {"id": "test_baby_1", "familyId": "test_family_1", "nickname": "test_baby", "gender": "female", "birthDate": "2026-01-01", "createdAt": stamp, "updatedAt": stamp},
            ],
            "FormulaProduct": [
                {
                    "id": "test_formula_1", "familyId": "test_family_1", "brand": "", "name": "test_formula",
                    "stage": 1, "scoopWeightG": 4.3, "waterPerScoopMl": 30, "reconstitutionRatio": 0.1433,
                    "servingSizeUnit": "per_100g",
                    "nutrientsJson": "{\"protein\":{\"amount\":0.12345678901234567890,\"unit\":\"g\"}}",
                    "notes": "test_formula_notes", "isActive": 0, "isDefault": 1,
                    "createdAt": stamp, "updatedAt": stamp,
                },
            ],
            "FeedingRecord": [
                {
                    "id": "test_feeding_1", "babyId": "test_baby_1", "clientId": "test_client_feed_1", "recordedById": "test_user_1",
                    "source": "ui_manual", "sourceAgent": "legacy-agent", "timestamp": "2026-09-12T08:30:00",
                    "type": "bottle_breast", "amountMl": 90, "leftMinutes": None, "rightMinutes": None,
                    "spitUp": False, "formulaProductId": None, "notes": "test_note", "createdAt": stamp, "updatedAt": stamp,
                },
            ],
            "SleepRecord": [
                {
                    "id": "test_sleep_1", "babyId": "test_baby_1", "clientId": "test_client_sleep_1", "recordedById": "test_user_1",
                    "source": "ui_manual", "sourceAgent": None, "startTime": "2026-09-12T10:00:00", "endTime": "2026-09-12T11:00:00",
                    "type": "day", "nightWakingCount": 0, "notes": None, "createdAt": stamp, "updatedAt": stamp,
                },
            ],
            "DiaperRecord": [
                {
                    "id": "test_diaper_1", "babyId": "test_baby_1", "clientId": "test_client_diaper_1", "recordedById": "test_user_1",
                    "source": "ui_manual", "sourceAgent": None, "timestamp": "2026-09-12T12:00:00", "type": "both",
                    "poopColor": "yellow", "poopConsistency": "paste", "notes": "test_diaper", "createdAt": stamp, "updatedAt": stamp,
                },
            ],
        },
    }


def test_sqlite_snapshot_integer_boolean_round_trip():
    """Exercise the real sqlite3.Row -> dict -> mapper path in a temp DB."""

    stamp = "2026-09-12T08:00:00+08:00"
    with tempfile.TemporaryDirectory(prefix="test_care_snapshot_") as root:
        root_path = Path(root)
        source_dir = root_path / "source"
        source_dir.mkdir()
        database = source_dir / "fixture.sqlite"
        db = sqlite3.connect(database)
        db.executescript(
            """
            CREATE TABLE User (id TEXT PRIMARY KEY, username TEXT, passwordHash TEXT, displayName TEXT, createdAt TEXT, updatedAt TEXT);
            CREATE TABLE Family (id TEXT PRIMARY KEY, name TEXT, createdAt TEXT, updatedAt TEXT);
            CREATE TABLE FamilyMember (id TEXT PRIMARY KEY, familyId TEXT, userId TEXT, role TEXT, createdAt TEXT, updatedAt TEXT);
            CREATE TABLE Baby (id TEXT PRIMARY KEY, familyId TEXT, nickname TEXT, gender TEXT, birthDate TEXT, createdAt TEXT, updatedAt TEXT);
            CREATE TABLE FeedingRecord (
              id TEXT PRIMARY KEY, babyId TEXT, familyId TEXT, clientId TEXT, recordedById TEXT,
              source TEXT, sourceAgent TEXT, timestamp TEXT, type TEXT, amountMl INTEGER,
              leftMinutes INTEGER, rightMinutes INTEGER, durationMinutes INTEGER, spitUp INTEGER,
              formulaProductId TEXT, notes TEXT, createdAt TEXT, updatedAt TEXT
            );
            CREATE TABLE SleepRecord (
              id TEXT PRIMARY KEY, babyId TEXT, clientId TEXT, recordedById TEXT,
              source TEXT, sourceAgent TEXT, startTime TEXT, endTime TEXT, type TEXT,
              nightWakingCount INTEGER, notes TEXT, createdAt TEXT, updatedAt TEXT
            );
            CREATE TABLE DiaperRecord (
              id TEXT PRIMARY KEY, babyId TEXT, clientId TEXT, recordedById TEXT,
              source TEXT, sourceAgent TEXT, timestamp TEXT, type TEXT,
              poopColor TEXT, poopConsistency TEXT, notes TEXT, createdAt TEXT, updatedAt TEXT
            );
            """
        )
        db.execute(
            "INSERT INTO User VALUES (?, ?, ?, ?, ?, ?)",
            ("test_snapshot_user", "test_snapshot_user", "test_hash", "test_snapshot_user", stamp, stamp),
        )
        db.execute(
            "INSERT INTO Family VALUES (?, ?, ?, ?)",
            ("test_snapshot_family", "test_snapshot_family", stamp, stamp),
        )
        db.execute(
            "INSERT INTO FamilyMember VALUES (?, ?, ?, ?, ?, ?)",
            ("test_snapshot_member", "test_snapshot_family", "test_snapshot_user", "admin", stamp, stamp),
        )
        db.execute(
            "INSERT INTO Baby VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("test_snapshot_baby", "test_snapshot_family", "test_snapshot_baby", "female", "2026-01-01", stamp, stamp),
        )
        db.execute(
            "INSERT INTO FeedingRecord VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "test_snapshot_feeding", "test_snapshot_baby", None, "test_snapshot_client", "test_snapshot_user",
                "ui_manual", None, "2026-09-12T08:30:00", "bottle_breast", 90, None, None, None, 0,
                None, "test_snapshot_note", stamp, stamp,
            ),
        )
        db.execute(
            "INSERT INTO SleepRecord VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "test_snapshot_sleep", "test_snapshot_baby", "test_snapshot_sleep_client", "test_snapshot_user",
                "ui_manual", None, "2026-09-12T10:00:00", "2026-09-12T11:00:00", "day", 0, None, stamp, stamp,
            ),
        )
        db.execute(
            "INSERT INTO DiaperRecord VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "test_snapshot_diaper", "test_snapshot_baby", "test_snapshot_diaper_client", "test_snapshot_user",
                "ui_manual", None, "2026-09-12T12:00:00", "both", "yellow", "paste", None, stamp, stamp,
            ),
        )
        db.commit()
        db.close()

        destination = root_path / "snapshot"
        snapshot.capture(database, destination, "test_snapshot_source")
        archive_path = destination / "legacy.json"
        data = json.loads(archive_path.read_text())
        checksum = hashlib.sha256(archive_path.read_bytes()).hexdigest()
        rows = m.prepare_records(data, checksum)
        assert rows[0]["row"]["spitUp"] == 0
        assert rows[0]["spit_up"] == "false"
        assert len(rows) == 3
        assert "BEGIN;" in m.render_materialization(data, checksum)


def main():
    data = archive()
    checksum = "c" * 64
    items = m.prepare_records(data, checksum)
    formula_items = m.prepare_formula_products(data, checksum)
    assert [item["id"] for item in items] == ["test_feeding_1", "test_sleep_1", "test_diaper_1"]
    assert [item["id"] for item in formula_items] == ["test_formula_1"]
    assert formula_items[0]["brand"] == ""
    assert formula_items[0]["nutrients_json"].endswith("0.12345678901234567890,\"unit\":\"g\"}}")
    assert items[0]["feeding_type"] == "bottle_breast_milk"
    assert items[1]["sleep_type"] == "nap"
    assert items[0]["occurred_at"] == "2026-09-12T00:30:00.000Z"
    assert items[0]["actor_id"] == "test_user_1"
    assert items[0]["client_id"] == "test_client_feed_1"
    assert items[0]["metadata"]["sourceBatchId"] == checksum

    sqlite_style = copy.deepcopy(data)
    sqlite_style["tables"]["FeedingRecord"][0]["spitUp"] = 0
    assert m.prepare_records(sqlite_style, checksum)[0]["spit_up"] == "false"
    json_style = copy.deepcopy(data)
    json_style["tables"]["FeedingRecord"][0]["spitUp"] = True
    assert m.prepare_records(json_style, checksum)[0]["spit_up"] == "true"
    for invalid in (2, -1, 1.0, "0", None):
        invalid_value = copy.deepcopy(data)
        invalid_value["tables"]["FeedingRecord"][0]["spitUp"] = invalid
        try:
            m.prepare_records(invalid_value, checksum)
        except ValueError as error:
            assert "spitUp" in str(error)
        else:
            raise AssertionError(f"invalid spitUp value was accepted: {invalid!r}")
    sql = m.render_materialization(data, checksum)
    for required in (
        "BEGIN;", "COMMIT;", "legacy_client_id", "legacy_metadata", "source_hash",
        "mapping_version", "targetSnapshot", "Legacy source row hash mismatch or missing",
        "Legacy promotion receipt conflict", "pg_advisory_xact_lock",
    ):
        assert required in sql, required
    assert "INSERT INTO public.formula_products" in sql
    assert "::jsonb" in sql
    assert sql.index("INSERT INTO public.formula_products") < sql.index("INSERT INTO public.feeding_records")
    assert sql.count("DO $care_") == 5  # one batch guard, one formula, three record promotions

    cross_family = copy.deepcopy(data)
    cross_family["tables"]["FeedingRecord"][0]["familyId"] = "test_family_other"
    try:
        m.prepare_records(cross_family, checksum)
    except ValueError as error:
        assert "crosses baby family" in str(error)
    else:
        raise AssertionError("cross-family row was accepted")

    duplicate_client = copy.deepcopy(data)
    duplicate_client["tables"]["FeedingRecord"].append(copy.deepcopy(duplicate_client["tables"]["FeedingRecord"][0]))
    duplicate_client["tables"]["FeedingRecord"][1]["id"] = "test_feeding_2"
    try:
        m.prepare_records(duplicate_client, checksum)
    except ValueError as error:
        assert "Duplicate clientId" in str(error)
    else:
        raise AssertionError("duplicate clientId was accepted")
    test_sqlite_snapshot_integer_boolean_round_trip()
    print("Care materializer pure tests PASS")


if __name__ == "__main__":
    main()
