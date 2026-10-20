// Utilidades de texto deterministas: normalizar, validar y formatear.

/** "  Menú!! " -> "menu" */
export function normalize(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[¡!¿?.,;:*_~"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Entero positivo escrito como "3", "x3" o "3 unidades". */
export function parseQuantity(input: string): number | null {
  const m = normalize(input).match(/^x?\s*(\d{1,3})\s*(x|unidad|unidades|und|uds?)?$/);
  return m ? Number(m[1]) : null;
}

/** Número de pedido escrito como "#123", "pedido 123" o "123". */
export function parseOrderNumber(input: string): { value: number; explicit: boolean } | null {
  const raw = input.trim();
  const explicit = raw.match(/^(?:pedido\s*)?(?:n[°ºo.]?\s*)?#\s*(\d{1,9})$/i) ??
    normalize(raw).match(/^pedido (?:n |nro |numero )?(\d{1,9})$/);
  if (explicit) return { value: Number(explicit[1]), explicit: true };
  const plain = raw.match(/^(\d{1,9})$/);
  return plain ? { value: Number(plain[1]), explicit: false } : null;
}

/** Valida y limpia un nombre de persona (2 a 40 letras). */
export function cleanName(input: string): string | null {
  const name = input.replace(/\s+/g, " ").trim();
  if (!/^\p{L}[\p{L} .'-]{1,39}$/u.test(name)) return null;
  return name.replace(/(^|\s)\p{Ll}/gu, (c) => c.toUpperCase());
}

/** Valida y limpia la descripción del puesto ("Puesto 45, pasillo B"). */
export function cleanStall(input: string): string | null {
  // deno-lint-ignore no-control-regex
  const stall = input.replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim();
  if (stall.length < 1 || stall.length > 40) return null;
  if (!/[\p{L}\p{N}]/u.test(stall)) return null;
  return stall;
}

/**
 * Teléfono peruano de contacto: acepta "987654321", "+51 987 654 321",
 * "51987654321". Devuelve solo dígitos con código de país (51987654321).
 */
export function cleanPeruvianMobile(input: string): string | null {
  const digits = input.replace(/[\s\-().+]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  if (/^9\d{8}$/.test(digits)) return `51${digits}`;
  if (/^519\d{8}$/.test(digits)) return digits;
  return null;
}

/** 51987654321 -> "+51 987 654 321" */
export function formatPhone(digits: string): string {
  const m = digits.match(/^51(\d{3})(\d{3})(\d{3})$/);
  return m ? `+51 ${m[1]} ${m[2]} ${m[3]}` : `+${digits}`;
}

/** 350 -> "S/ 3.50" */
export function formatSoles(cents: number): string {
  return `S/ ${(cents / 100).toFixed(2)}`;
}

/** Recorta respetando los límites de WhatsApp. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}

export function formatLimaTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-PE", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
