import pytest

from harnessblog.budget import BudgetExhausted, BudgetLedger


def test_budget_reserves_and_charges():
    ledger = BudgetLedger(100, 10)
    ledger.admit(4.5)
    ledger.charge(4)
    assert ledger.available == 86
    with pytest.raises(BudgetExhausted):
        ledger.admit(87)

