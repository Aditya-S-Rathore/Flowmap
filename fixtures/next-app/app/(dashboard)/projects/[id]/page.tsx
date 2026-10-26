"use client";
import { useEffect, useState } from "react";

export default function ProjectPage({ params }: { params: { id: string } }) {
  const [project, setProject] = useState(null);
  useEffect(() => { fetch(`/api/projects/${params.id}`).then((r) => r.json()).then(setProject); }, [params.id]);
  return <button onClick={() => fetch(`/api/projects/${params.id}`, { method: "DELETE" })}>Delete {String(project)}</button>;
}
