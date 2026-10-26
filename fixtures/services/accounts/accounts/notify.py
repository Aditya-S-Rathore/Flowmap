import requests


def notify_changed(user_id):
    requests.post("http://notify:5000/notify", json={"user": user_id})
