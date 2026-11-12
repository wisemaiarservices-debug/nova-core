const MAX_RESPONSE_BYTES = 64 * 1024;
export function error(code, status) {
  return new Response(JSON.stringify({ error: code }), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  }});
}
export async function boundedJsonResponse(response, requestId) {
  const type = response.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;|\s*$)/i.test(type) || !response.body) return error("tenant_api_invalid_response", 502);
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body.cancel();
    return error("tenant_api_response_too_large", 502);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return error("tenant_api_response_too_large", 502);
      }
      chunks.push(value);
    }
  } catch {
    return error("tenant_api_unavailable", 503);
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch { return error("tenant_api_invalid_response", 502); }
  return new Response(body, { status: response.status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "x-request-id": requestId,
  }});
}
