export async function load({ params, fetch }) {
  const res = await fetch(`/api/items/${params.id}`);
  return { item: await res.json() };
}
