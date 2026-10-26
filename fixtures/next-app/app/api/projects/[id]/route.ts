import { prisma } from "@/lib/db";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  return Response.json(await prisma.project.findUnique({ where: { id: Number(params.id) } }));
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  await prisma.project.delete({ where: { id: Number(params.id) } });
  return new Response(null, { status: 204 });
}
