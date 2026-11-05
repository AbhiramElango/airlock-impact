from settings import TAX_PERCENT


def sales_tax(amount):
    """Sales tax for an amount."""
    return amount * (1 + TAX_PERCENT / 100)
