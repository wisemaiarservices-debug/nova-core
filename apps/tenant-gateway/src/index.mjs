/**
 * Deliberately inert until Cloudflare Access, the private API Service Binding,
 * runtime secrets and route isolation have been provisioned and validated.
 * No public or workers.dev route is exposed by this Worker.
 */
export default {
  async fetch() {
    return new Response("Not Found", { status: 404 });
  },
};
