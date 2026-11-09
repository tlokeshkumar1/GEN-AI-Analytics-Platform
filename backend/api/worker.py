"""Dedicated worker entry point: python -m api.worker [--once]."""
import argparse
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    from api.platform.jobs import job_service
    while True:
        job_service.run_next()
        if args.once:
            return
        time.sleep(2)


if __name__ == "__main__":
    main()
