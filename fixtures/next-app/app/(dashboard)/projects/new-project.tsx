"use client";
import { createProject } from "@/app/actions";

export function NewProject() {
  return <form action={async (f) => { await createProject(String(f.get("name"))); }}><button>Create</button></form>;
}
