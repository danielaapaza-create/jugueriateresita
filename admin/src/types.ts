export type OrderStatus = "pending" | "confirmed" | "preparing" | "ready" | "delivered" | "cancelled";
export type Category = "desayunos" | "jugos" | "extras";

export interface OrderItem {
  product_name: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
}

export interface Order {
  id: string;
  order_number: number;
  customer_name: string;
  contact_phone: string;
  customer_wa_id: string;
  delivery_method: "pickup" | "delivery";
  stall: string | null;
  status: OrderStatus;
  total_cents: number;
  cancel_reason: string | null;
  cancelled_by: string | null;
  last_notified_status: OrderStatus | null;
  last_notification_error: string | null;
  created_at: string;
  order_items: OrderItem[];
}

export interface Product {
  id: string;
  category: Category;
  name: string;
  description: string | null;
  price_cents: number;
  is_available: boolean;
  is_active: boolean;
  sort_order: number;
}

export interface BusinessSettings {
  id: number;
  business_name: string;
  orders_paused: boolean;
  pause_message: string;
  delivery_enabled: boolean;
  auto_accept_orders: boolean;
  customer_can_cancel_confirmed: boolean;
  max_quantity_per_item: number;
  max_open_orders_per_customer: number;
}
