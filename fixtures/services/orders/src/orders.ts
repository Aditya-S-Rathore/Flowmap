import axios from "axios";

export async function createOrder(userId: string, items: string[]) {
  await axios.post(`${process.env.BILLING_URL}/payments/charge`, { userId, amount: items.length });
  return { userId, items };
}

export async function getOrder(id: string) {
  return axios.get(`${process.env.ACCOUNTS_URL}/profiles/${id}/`);
}
