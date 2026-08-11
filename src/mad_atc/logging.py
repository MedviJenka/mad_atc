import logging
import sys

LOGGER_NAME = "mad_atc"


def configure_cli_logging() -> logging.Logger:
    """Route CLI log records to stdout without logger metadata."""
    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(logging.INFO)
    logger.propagate = False

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.handlers[:] = [handler]
    return logger
