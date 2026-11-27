"""Dedicated worker entry point: python -m api.worker [--once]."""

import argparse
import time
import logging
import os
import sys
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        stream=sys.stdout,
    )
    logger = logging.getLogger("api.worker")
    logger.info("Initializing worker (pid=%s)...", os.getpid())
    from api.platform.jobs import job_service

    worker_id = uuid.uuid4().hex
    workspace = os.getenv("PLATFORM_WORKSPACE_ID", "default")
    next_heartbeat = 0
    next_idle_log = 0
    logger.info(
        "Worker ready | id=%s | workspace=%s | concurrency=1 (one job at a time) | poll=2s",
        worker_id,
        workspace,
    )
    while True:
        try:
            if time.monotonic() >= next_heartbeat:
                job_service.heartbeat(worker_id, workspace)
                next_heartbeat = time.monotonic() + 30
            job_id = job_service.run_next(workspace)
            if job_id:
                next_idle_log = 0
            elif time.monotonic() >= next_idle_log:
                logger.info(
                    "Waiting for runnable jobs | active=0 | workspace=%s", workspace
                )
                next_idle_log = time.monotonic() + 30
        except KeyboardInterrupt:
            logger.info("Worker stopped by user")
            return
        except Exception:
            logger.exception(
                "Worker iteration failed; will retry in 2s"
                if not args.once
                else "Worker iteration failed"
            )
            if args.once:
                raise
        if args.once:
            logger.info("Single poll complete; worker exiting")
            return
        try:
            time.sleep(2)
        except KeyboardInterrupt:
            logger.info("Worker stopped by user")
            return


if __name__ == "__main__":
    main()
