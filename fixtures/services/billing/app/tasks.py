import requests
from celery import shared_task


@shared_task
def send_receipt(user_id):
    requests.post("http://notify:5000/notify", json={"user": user_id})
