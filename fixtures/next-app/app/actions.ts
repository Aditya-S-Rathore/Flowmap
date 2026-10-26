"use server";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { chargeSetupFee } from "@/lib/payments";
import { sendWelcome } from "@/lib/mail";

export async function createProject(name: string) {
  const session = await auth();
  const project = await prisma.$transaction(async (tx) => {
    const created = await tx.project.create({ data: { name, ownerId: session.user.id } });
    await chargeSetupFee(session.user.id);
    return created;
  });
  await sendWelcome("owner@example.com");
  return project;
}
