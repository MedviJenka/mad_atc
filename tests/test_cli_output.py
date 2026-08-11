import subprocess
import sys
from pathlib import Path

from src.cli_output import create_cli_logger, labeled_line, log_colored


def test_log_colored_line_keeps_dynamic_text_literal(capsys):
    logger = create_cli_logger()

    log_colored(logger, 'you:   ', '[not markup]', 'bold green')

    out = capsys.readouterr().out
    assert 'you:   [not markup]' in out
    assert '\x1b[1;32m' in out


def test_uncolored_machine_marker_stays_parseable(capsys):
    logger = create_cli_logger()

    logger.info(labeled_line('result -> ', '{\"transcript\":\"ok\",\"roast\":\"ok\"}'))

    assert capsys.readouterr().out.startswith('result -> ')


def test_src_directory_does_not_shadow_stdlib_logging():
    result = subprocess.run(
        [sys.executable, '-c', 'import logging; print(logging.__file__)'],
        cwd='src',
        capture_output=True,
        text=True,
        check=True,
    )

    imported_path = Path(result.stdout.strip()).resolve()
    src_dir = Path('src').resolve()
    assert not imported_path.is_relative_to(src_dir)
    assert imported_path.name == '__init__.py'
