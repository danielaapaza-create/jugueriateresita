// Registro estructurado (JSON) sin datos sensibles.
// * Nunca registra tokens, secretos ni el contenido de los mensajes.
// * Los teléfonos se enmascaran: 51987654321 -> 51*******321
type Level = "info" | "warn" | "error";

const SENSITIVE_KEY = /token|secret|authorization|apikey|api_key|password|body|text/i;

export function maskPhone(phone: string | undefined | null): string {
  if (!phone) return "-";
  return phone.length <= 5 ? "***" : `${phone.slice(0, 2)}${"*".repeat(phone.length - 5)}${phone.slice(-3)}`;
}

/** Mensaje de error seguro para registrar (sin pila ni datos del usuario). */
export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // Elimina cualquier cosa parecida a un token Bearer o un número de teléfono.
  return msg
    .replace(/Bearer\s+[\w.\-]+/gi, "Bearer [oculto]")
    .replace(/EAA[\w]{20,}/g, "[token oculto]")
    .replace(/\b\d{9,15}\b/g, (m) => maskPhone(m))
    .slice(0, 300);
}

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    safe[k] = SENSITIVE_KEY.test(k) ? "[oculto]" : v;
  }
  const line = JSON.stringify({ level, event, ...safe });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
