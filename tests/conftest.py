import sys
from pathlib import Path

# Root-level main.py lives outside the mad_atc package (repo_root/main.py) and
# isn't installed, so make sure the repo root is importable as `main`.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
