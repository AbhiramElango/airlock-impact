from pytest import approx

from tax import sales_tax


def test_sales_tax():
    assert sales_tax(100) == approx(108.0)
