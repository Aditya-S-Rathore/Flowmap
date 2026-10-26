import express from "express";
import { requireAuth } from "./auth";
import { createOrder, getOrder } from "./orders";

const app = express();

app.post("/orders", requireAuth, async (req, res) => {
  res.json(await createOrder(req.user.id, req.body.items));
});

app.get("/orders/:orderId", async (req, res) => {
  res.json(await getOrder(req.params.orderId));
});

export default app;
