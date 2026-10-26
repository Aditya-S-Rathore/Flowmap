import Stripe from "stripe";

const stripe = new Stripe("sk_test");

export async function chargeSetupFee(ownerId: number) {
  return stripe.charges.create({ amount: 500, currency: "usd", description: String(ownerId) });
}
