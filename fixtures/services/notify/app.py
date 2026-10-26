import smtplib
from flask import Flask, request

app = Flask(__name__)


@app.route("/notify", methods=["POST"])
def notify():
    send_email(request.json["user"])
    return "ok"


def send_email(user):
    smtplib.SMTP("mail").sendmail("shop@example.com", user, "updated")
