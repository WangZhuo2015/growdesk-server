"""Make only the fresh, owned legacy seed's generated metadata reproducible."""
import json
import pathlib
import re
import sqlite3
import sys
import tempfile
import uuid

target = pathlib.Path(sys.argv[1]).resolve()
fixture_path = pathlib.Path(sys.argv[2]).resolve()
assert target.name == "dev_test.db"
assert target.parent.parent == pathlib.Path(tempfile.gettempdir()).resolve()
assert target.parent.name.startswith("growdesk-integration-")
assert fixture_path.parent == target.parent
fixture = json.loads(fixture_path.read_text())
protected = set(fixture["legacy"])
# PrismaLibSql uses ISO-8601 text with +00:00 for DateTime predicates.
# Numeric milliseconds deserialize, but fail its SQL range comparisons.
stamp = "2026-09-19T00:00:00.000+00:00"


def quote(name):
    return '"' + name.replace('"', '""') + '"'


with sqlite3.connect(target) as connection:
    tables = [row[0] for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )]
    foreign_keys = [(table, row[2], row[3], row[4]) for table in tables
                    for row in connection.execute(f"PRAGMA foreign_key_list({quote(table)})")]
    connection.execute("PRAGMA foreign_keys=OFF")
    for table in tables:
        if table in protected:
            continue
        columns = {row[1] for row in connection.execute(f"PRAGMA table_info({quote(table)})")}
        if "id" in columns:
            for index, (old_id,) in enumerate(connection.execute(
                f"SELECT id FROM {quote(table)} ORDER BY rowid").fetchall()):
                if not isinstance(old_id, str) or not re.fullmatch(
                        r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", old_id):
                    continue
                stable_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"growdesk-test-golden/{table}/{index}"))
                connection.execute(f"UPDATE {quote(table)} SET id=? WHERE id=?", (stable_id, old_id))
                for child, parent, column, parent_column in foreign_keys:
                    if parent == table and parent_column == "id":
                        connection.execute(f"UPDATE {quote(child)} SET {quote(column)}=? WHERE {quote(column)}=?",
                                           (stable_id, old_id))
        for column in ("createdAt", "updatedAt"):
            if column in columns:
                connection.execute(f"UPDATE {quote(table)} SET {quote(column)}=?", (stamp,))
    violations = connection.execute("PRAGMA foreign_key_check").fetchall()
    assert not violations, f"Synthetic reference fixture broke {len(violations)} foreign keys"
