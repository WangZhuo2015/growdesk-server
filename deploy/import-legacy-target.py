"""Run the complete legacy import against the explicitly owned GrowDesk PG.

The source snapshot and manifest are mandatory inputs. This wrapper builds a
revision-pinned migration image and delegates the ordered, fail-closed work to
``scripts/legacy-import/cutover_runner.py``. It never writes the old SQLite
database and never uses a default snapshot path.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import subprocess
import tempfile


ROOT = Path("/home/ubuntu/growdesk")
REVISION = re.compile(r"^[0-9a-f]{40}$")


def run(args: list[str], *, env: dict[str, str] | None = None) -> None:
    subprocess.run(args, check=True, env=env)


def main(args: argparse.Namespace) -> int:
    if REVISION.fullmatch(args.revision) is None:
        raise ValueError("Invalid revision")
    release = (ROOT / "releases" / args.revision).resolve()
    if not release.is_dir() or release.is_symlink():
        raise ValueError("Release directory is missing")
    snapshot = Path(args.snapshot).expanduser().resolve()
    manifest = Path(args.manifest).expanduser().resolve()
    if not snapshot.is_dir() or snapshot.is_symlink() or not manifest.is_file() or manifest.is_symlink():
        raise ValueError("Explicit snapshot or manifest is invalid")
    runtime_env = Path(args.runtime_env_file).expanduser().resolve()
    if not runtime_env.is_file() or runtime_env.is_symlink():
        raise ValueError("Runtime env file is missing")
    image = args.migration_image or f"growdesk-migration:{args.revision}"
    environment = {**os.environ, "DOCKER_CONFIG": str(ROOT / "docker-config")}
    run(["docker", "build", "-f", str(release / "deploy/Cutover.Dockerfile"), "-t", image, str(release)], env=environment)

    receipt_dir = args.receipt_dir
    if receipt_dir is None:
        receipt_dir = str(Path(tempfile.mkdtemp(prefix="legacy-cutover-", dir=ROOT / "shared")))
        Path(receipt_dir).chmod(0o700)
    runner = release / "scripts/legacy-import/cutover_runner.py"
    if not runner.is_file():
        raise ValueError("Release does not contain the committed cutover runner")
    command = [
        "python3", str(runner),
        "--snapshot", str(snapshot),
        "--manifest", str(manifest),
        "--receipt-dir", str(Path(receipt_dir).expanduser().resolve()),
        "--target-container", args.target_container,
        "--migration-image", image,
        "--runtime-env-file", str(runtime_env),
    ]
    run(command, env=environment)
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--snapshot", required=True, help="private immutable snapshot directory")
    parser.add_argument("--manifest", required=True, help="manifest.json belonging to --snapshot")
    parser.add_argument("--receipt-dir", help="private output directory; defaults to a new directory under shared/")
    parser.add_argument("--target-container", default="growdesk-postgres-1")
    parser.add_argument("--migration-image")
    parser.add_argument("--runtime-env-file", default=str(ROOT / "shared/runtime.env"))
    try:
        raise SystemExit(main(parser.parse_args()))
    except Exception as error:
        print('{"error":"' + type(error).__name__ + '"}')
        raise SystemExit(1)
