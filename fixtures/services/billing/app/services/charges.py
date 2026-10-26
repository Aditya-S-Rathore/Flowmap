import stripe
from app.db import session
from app.models import Payment
from app.tasks import send_receipt


def create_charge(user_id, amount):
    with session.begin():
        session.add(Payment(user_id=user_id, amount=amount))
        stripe.Charge.create(amount=amount, currency="usd")
    send_receipt.delay(user_id)


def find_payment(payment_id):
    return session.get(Payment, payment_id)


def refund_payment(payment_id):
    payment = session.get(Payment, payment_id)
    session.delete(payment)


def settle_all(ids):
    for i in ids:
        session.query(Payment).filter(Payment.id == i).first()
