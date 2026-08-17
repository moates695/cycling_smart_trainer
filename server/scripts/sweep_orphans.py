#!/usr/bin/env python3
"""Reconcile the activities table against the FIT objects in Spaces.

Dry run by default — it will not delete anything unless told to:

    uv run python scripts/sweep_orphans.py
    uv run python scripts/sweep_orphans.py --apply

Intended as a weekly cron on the droplet. Orphans are a background chore, never
a correctness problem: the app is fully consistent whether or not this ever runs.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import get_settings  # noqa: E402
from app.database import session_factory  # noqa: E402
from app.sweep import apply_plan, build_plan  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="actually delete the orphans")
    args = parser.parse_args()

    settings = get_settings()
    if not settings.spaces_configured:
        print("Spaces is not configured; nothing to sweep.")
        return 0

    with session_factory() as db:
        plan = build_plan(db)

    print(f"kept:          {plan.kept}")
    print(f"orphans:       {len(plan.orphans)}")
    print(f"missing blobs: {len(plan.missing_blobs)}")

    for activity_id in plan.missing_blobs:
        # Reported, never repaired here — the client retries these by itself on
        # its next launch, and the bytes only exist on the device that recorded them.
        print(f"  missing blob for activity {activity_id}")

    if not args.apply:
        for key in plan.orphans[:20]:
            print(f"  would delete {key}")
        if len(plan.orphans) > 20:
            print(f"  ... and {len(plan.orphans) - 20} more")
        print("\nDry run. Pass --apply to delete.")
        return 0

    deleted = apply_plan(plan)
    print(f"deleted {deleted} orphaned objects")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
