"""Catering invoices: order amount with tax, plus delivery."""
from tax import sales_tax

DELIVERY_FEE = 5.00


def invoice_total(subtotal):
    return round(sales_tax(subtotal) + DELIVERY_FEE, 2)
