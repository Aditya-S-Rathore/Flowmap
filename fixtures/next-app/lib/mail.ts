import { Resend } from "resend";

const resend = new Resend("re_test");

export async function sendWelcome(to: string) {
  await resend.emails.send({ to, from: "hi@example.com", subject: "Welcome", html: "" });
}
