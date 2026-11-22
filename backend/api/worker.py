"""Dedicated worker entry point: python -m api.worker [--once]."""
import argparse
import time
import logging
import os
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    from api.platform.jobs import job_service
    worker_id = uuid.uuid4().hex
    workspace = os.getenv("PLATFORM_WORKSPACE_ID", "default")
    next_heartbeat = 0
    while True:
        try:
            if time.monotonic() >= next_heartbeat:
                job_service.heartbeat(worker_id, workspace)
                next_heartbeat = time.monotonic() + 30
            job_service.run_next(workspace)
        except Exception:
            logging.getLogger(__name__).exception("Worker iteration failed")
            if args.once:
                raise
        if args.once:
            return
        time.sleep(2)


if __name__ == "__main__":
    main()
