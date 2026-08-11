import sys
from typing import Any

import structlog
from structlog.typing import EventDict, WrappedLogger

ColorName = str

_RESET = "\x1b[0m"
_COLORS: dict[ColorName, str] = {
    'blue': '\x1b[34m',
    'cyan': '\x1b[36m',
    'green': '\x1b[32m',
    'magenta': '\x1b[35m',
    'red': '\x1b[31m',
    'yellow': '\x1b[33m',
    'bold blue': '\x1b[1;34m',
    'bold cyan': '\x1b[1;36m',
    'bold green': '\x1b[1;32m',
    'bold magenta': '\x1b[1;35m',
    'bold red': '\x1b[1;31m',
    'bold yellow': '\x1b[1;33m',
}


def _render_cli_event(_logger: WrappedLogger, _method_name: str, event_dict: EventDict) -> str:
    event = str(event_dict.pop('event'))
    color = event_dict.pop('color', None)
    prefix = _COLORS.get(str(color), '') if color else ''
    return f'{prefix}{event}{_RESET}' if prefix else event


def create_cli_logger() -> structlog.BoundLogger:
    """Return a structlog logger that writes colored CLI lines to current stdout."""
    structlog.configure(
        processors=[_render_cli_event],
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        wrapper_class=structlog.make_filtering_bound_logger(0),
        cache_logger_on_first_use=False,
    )
    return structlog.get_logger('mad_atc')


def labeled_line(label: str, value: Any) -> str:
    """Build a label with untrusted text appended literally."""
    return f'{label}{value}'


def log_colored(logger: structlog.BoundLogger, label: str, value: Any, color: ColorName) -> None:
    logger.info(labeled_line(label, value), color=color)
