from fastapi import FastAPI
from app.routes import payments

app = FastAPI()
app.include_router(payments.router)
