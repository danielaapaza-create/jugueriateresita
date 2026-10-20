// Validación de autenticidad de webhooks de Meta.
// Meta firma el cuerpo EXACTO de cada POST con HMAC-SHA256 usando el
// "App Secret" y envía la firma en el encabezado X-Hub-Signature-256:
//   X-Hub-Signature-256: sha256=<hex>
// https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads

const encoder = new TextEncoder();

export async function computeSignature(appSecret: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Comparación en tiempo constante para no filtrar información por tiempos. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function isValidSignature(
  appSecret: string,
  rawBody: string,
  header: string | null,
): Promise<boolean> {
  if (!appSecret || !header) return false;
  const match = header.trim().match(/^sha256=([0-9a-fA-F]{64})$/);
  if (!match) return false;
  const expected = await computeSignature(appSecret, rawBody);
  return timingSafeEqual(expected, match[1].toLowerCase());
}
