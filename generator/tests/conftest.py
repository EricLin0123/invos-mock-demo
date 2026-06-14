# conftest.py — shared test fixtures/helpers for the generator test suite.
import copy
import os

import yaml

_CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config.yaml")


def load_config():
    """Load the real config.yaml as a fresh dict."""
    with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def small_config():
    """A scaled-down config so tests run fast."""
    cfg = copy.deepcopy(load_config())
    cfg["count"] = 2000
    cfg["days"] = 30
    return cfg
