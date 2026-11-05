from pytest import approx

from invoice import invoice_total


def test_invoice_includes_tax_and_delivery():
    assert invoice_total(100) == approx(113.00)
