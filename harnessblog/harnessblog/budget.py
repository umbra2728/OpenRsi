from __future__ import annotations

from dataclasses import dataclass


class BudgetExhausted(RuntimeError):
    pass


@dataclass
class BudgetLedger:
    limit: float
    reserve: float
    spent: float = 0.0

    @property
    def available(self) -> float:
        return max(0.0, self.limit - self.reserve - self.spent)

    def admit(self, run_cap: float) -> None:
        if run_cap > self.available + 1e-9:
            raise BudgetExhausted(
                f"run cap ${run_cap:.2f} exceeds campaign availability ${self.available:.2f}"
            )

    def charge(self, amount: float) -> None:
        if amount < 0:
            raise ValueError("charge cannot be negative")
        self.spent += amount
        if self.spent > self.limit + 1e-9:
            raise BudgetExhausted("campaign hard budget exceeded")

