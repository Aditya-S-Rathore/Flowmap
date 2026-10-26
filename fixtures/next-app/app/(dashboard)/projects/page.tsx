import Link from "next/link";
import { prisma } from "@/lib/db";
import { NewProject } from "./new-project";

export default async function ProjectsPage() {
  const projects = await prisma.project.findMany();
  return (
    <div>
      {projects.map((p) => <Link key={p.id} href={`/projects/${p.id}`}>{p.name}</Link>)}
      <NewProject />
    </div>
  );
}
