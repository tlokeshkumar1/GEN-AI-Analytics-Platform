"""Run recoverable ingestion/indexing jobs independently of the API process."""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from api.platform.jobs import job_service


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="Claim and execute at most one available job")
    args = parser.parse_args()
    while True:
        job_service.run_next()
        if args.once:
            return
        time.sleep(2)


if __name__ == "__main__":
    main()
