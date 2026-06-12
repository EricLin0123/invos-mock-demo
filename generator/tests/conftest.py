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
    """A scaled-down config so tests run fast while staying statistically meaningful.

    Fewer households/days than the default, but with the same behavioral knobs so
    the campaign effect remains detectable.
    """
    cfg = copy.deepcopy(load_config())
    cfg["population"]["households"] = 2500
    cfg["simulation"]["days"] = 60
    cfg["campaign"]["start_day"] = 20
    return cfg
