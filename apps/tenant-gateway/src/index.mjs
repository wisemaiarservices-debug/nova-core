import {
  assertNoDuplicateJsonMembers,
  createInternalAssertion,
  verifyCloudflareAccessJwt,
} from "./internal-assertion.mjs";

const RESOURCE_PATH =
  /^\/api\/v1\/tenants\/[A-Za-z0-9._~-]{1,120}\/(?:sites|assets|sources|observations|audit-events)\/[A-Za-z0-9._~-]{1,160}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function response(status, message, extraHeaders = {}) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function configured(env) {
  return (
    typeof env.NOVA_ACCESS_TEAM_DOMAIN === "string" &&
    env.NOVA_ACCESS_TEAM_DOMAIN.length > 0 &&
    typeof env.NOVA_ACCESS_AUDIENCE === "string" &&
    env.NOVA_ACCESS_AUDIENCE.length > 0 &&
    typeof env.NOVA_INTERNAL_KEY_ID === "string" &&
    typeof env.NOVA_INTERNAL_HMAC_KEY === "string" &&
    typeof env.NOVA_INTERNAL_ISSUER === "string" &&
    typeof env.NOVA_INTERNAL_AUDIENCE === "string"
  );
}

function cancelUpstreamBody(upstreamResponse) {
  try {
    const cancellation = upstreamResponse.body?.cancel();
    if (cancellation && typeof cancellation.catch === "function") {
      void cancellation.catch(() => {});
    }
  } catch {
    // Cancellation is best-effort; preserve the generic upstream response.
  }
}

async function readBoundedUpstreamBody(upstreamResponse) {
  if (!upstreamResponse.body) {
    throw new TypeError("upstream response body is unavailable");
  }
  const contentLength = upstreamResponse.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES) {
      throw new RangeError("upstream response exceeds the size limit");
    }
  }

  const reader = upstreamResponse.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel("upstream response exceeds size limit");
        } catch {
          // Preserve the bounded-size rejection if cancellation itself fails.
        }
        throw new RangeError("upstream response exceeds the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET") {
      return response(405, JSON.stringify({ detail: "method not allowed" }), {
        allow: "GET",
      });
    }

    const url = new URL(request.url);
    if (url.search || url.hash || !RESOURCE_PATH.test(url.pathname)) {
      return response(404, JSON.stringify({ detail: "not found" }));
    }

    if (!configured(env)) {
      return response(503, JSON.stringify({ detail: "gateway unavailable" }));
    }

    const accessToken = request.headers.get("cf-access-jwt-assertion");
    if (!accessToken || accessToken.includes(",")) {
      return response(401, JSON.stringify({ detail: "unauthorized" }));
    }

    let identity;
    try {
      identity = await verifyCloudflareAccessJwt(accessToken, {
        teamDomain: env.NOVA_ACCESS_TEAM_DOMAIN,
        audience: env.NOVA_ACCESS_AUDIENCE,
      });
    } catch {
      return response(401, JSON.stringify({ detail: "unauthorized" }));
    }

    if (!env.TENANT_API || typeof env.TENANT_API.fetch !== "function") {
      return response(503, JSON.stringify({ detail: "gateway unavailable" }));
    }

    let assertion;
    try {
      assertion = await createInternalAssertion({
        verifiedAccessIdentity: identity,
        method: "GET",
        path: url.pathname,
        keyId: env.NOVA_INTERNAL_KEY_ID,
        secret: env.NOVA_INTERNAL_HMAC_KEY,
        issuer: env.NOVA_INTERNAL_ISSUER,
        audience: env.NOVA_INTERNAL_AUDIENCE,
      });
    } catch {
      return response(503, JSON.stringify({ detail: "gateway unavailable" }));
    }

    try {
      // The fixed internal origin and Service Binding prevent client-controlled
      // destination selection. Query strings and request bodies are not forwarded.
      if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") {
        throw new TypeError("private tenant request timeout is unavailable");
      }
      const internalRequest = new Request(
        `https://tenant-api.internal${url.pathname}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${assertion}`,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(5000),
        },
      );
      const internalResponse = await env.TENANT_API.fetch(internalRequest);
      if (internalResponse.status === 404) {
        cancelUpstreamBody(internalResponse);
        return response(404, JSON.stringify({ detail: "not found" }));
      }
      const upstreamContentType = internalResponse.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (
        internalResponse.status !== 200 ||
        upstreamContentType !== "application/json"
      ) {
        await cancelUpstreamBody(internalResponse);
        return response(503, JSON.stringify({ detail: "gateway unavailable" }));
      }

      let body;
      try {
        body = await readBoundedUpstreamBody(internalResponse);
        const source = new TextDecoder("utf-8", { fatal: true }).decode(body);
        assertNoDuplicateJsonMembers(source);
        const payload = JSON.parse(source);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return response(502, JSON.stringify({ detail: "upstream response rejected" }));
        }
      } catch {
        return response(502, JSON.stringify({ detail: "upstream response rejected" }));
      }
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return response(503, JSON.stringify({ detail: "gateway unavailable" }));
    }
  },
};
