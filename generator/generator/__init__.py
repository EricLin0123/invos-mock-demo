# generator package — deterministic mock e-invoice data generation.
# Public entry points live in pipeline-style modules: population, campaign, invoices.
from .invoices import generate

__all__ = ["generate"]
