from pydantic import BaseModel


class ChargeIn(BaseModel):
    amount: int
