from fastapi import APIRouter, Depends
from app.auth import current_user
from app.schemas import ChargeIn
from app.services.charges import create_charge, find_payment, refund_payment

router = APIRouter(prefix="/payments")


@router.post("/charge")
def charge(body: ChargeIn, user=Depends(current_user)):
    return create_charge(user.id, body.amount)


@router.get("/{payment_id}")
def get_payment(payment_id: int):
    return find_payment(payment_id)


@router.post("/refund")
def refund(data: dict, user=Depends(current_user)):
    return refund_payment(data["payment_id"])
