export async function GET({ params }) {
  return new Response(JSON.stringify({ id: params.id }));
}
