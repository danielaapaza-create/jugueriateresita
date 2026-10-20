import type { Category, OrderStatus } from "./types";

export const soles = (cents: number) => `S/ ${(cents / 100).toFixed(2)}`;

/** "3.50" o "3,5" -> 350. null si no es válido. */
export function parseSoles(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return cents > 0 && cents <= 100000 ? cents : null;
}

export const limaTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit", hour12: false });

export function minutesAgo(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return min < 60 ? `hace ${min} min` : `hace ${Math.floor(min / 60)} h ${min % 60} min`;
}

export function phoneLabel(digits: string): string {
  const m = digits.match(/^51(\d{3})(\d{3})(\d{3})$/);
  return m ? `${m[1]} ${m[2]} ${m[3]}` : `+${digits}`;
}

export const STATUS_TABS: { status: OrderStatus; label: string }[] = [
  { status: "pending", label: "Por aceptar" },
  { status: "confirmed", label: "Aceptados" },
  { status: "preparing", label: "Preparando" },
  { status: "ready", label: "Listos" },
  { status: "delivered", label: "Entregados" },
  { status: "cancelled", label: "Cancelados" },
];

export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: "Recibido (por aceptar)",
  confirmed: "Aceptado",
  preparing: "En preparación",
  ready: "Listo",
  delivered: "Entregado",
  cancelled: "Cancelado",
};

/** Acciones que ofrece el panel según el estado (igual que en la BD). */
export const NEXT_ACTIONS: Record<OrderStatus, { to: OrderStatus; label: string; kind: "primary" | "danger" | "normal" }[]> = {
  pending: [
    { to: "confirmed", label: "✅ Aceptar", kind: "primary" },
    { to: "cancelled", label: "Rechazar", kind: "danger" },
  ],
  confirmed: [
    { to: "preparing", label: "👩‍🍳 Preparando", kind: "normal" },
    { to: "ready", label: "🥤 Listo", kind: "primary" },
    { to: "cancelled", label: "Cancelar", kind: "danger" },
  ],
  preparing: [
    { to: "ready", label: "🥤 Listo", kind: "primary" },
    { to: "cancelled", label: "Cancelar", kind: "danger" },
  ],
  ready: [
    { to: "delivered", label: "📦 Entregado", kind: "primary" },
    { to: "cancelled", label: "Cancelar", kind: "danger" },
  ],
  delivered: [],
  cancelled: [],
};

export const CATEGORY_LABEL: Record<Category, string> = {
  desayunos: "🍳 Desayunos",
  jugos: "🥤 Jugos",
  extras: "🥪 Extras",
};
