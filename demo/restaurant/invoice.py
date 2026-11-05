"""Catering invoices: order amount with tax, plus delivery."""
from tax import sales_tax

DELIVERY_FEE = 5.00


def invoice_total(subtotal):
    return round(sales_tax(subtotal) + DELIVERY_FEE, 2)


if __name__ == "__main__":
    order = 100.00
    print(f"{'Catering order':<16}$ {order:>8.2f}")
    print(f"{'Delivery':<16}$ {DELIVERY_FEE:>8.2f}")
    print(f"{'Invoice total':<16}$ {invoice_total(order):>8.2f}  (incl. tax)")
