import { useEffect, useState } from "react";
import { supabase } from "../supabase";
import type { BusinessSettings } from "../types";

export default function SettingsView({ email }: { email: string }) {
  const [settings, setSettings] = useState<BusinessSettings | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("business_settings").select("*").eq("id", 1).single().then(({ data, error }) => {
      if (error) setError("No se pudo cargar la configuración.");
      else setSettings(data as BusinessSettings);
    });
  }, []);

  async function save(patch: Partial<BusinessSettings>) {
    if (!settings) return;
    setError(null);
    setSaved(null);
    const { data, error } = await supabase.from("business_settings").update(patch).eq("id", 1).select().single();
    if (error) {
      setError("No se pudo guardar. Revisa los valores.");
      return;
    }
    setSettings(data as BusinessSettings);
    setSaved("Guardado ✔");
  }

  if (!settings) return <section>{error ? <p className="banner error">{error}</p> : <p>Cargando…</p>}</section>;

  return (
    <section>
      <header className="topbar">
        <h1>Ajustes</h1>
      </header>
      {error && <p className="banner error">{error}</p>}
      {saved && <p className="banner ok">{saved}</p>}

      <div className={`card big-toggle ${settings.orders_paused ? "paused" : "open"}`}>
        <p>{settings.orders_paused ? "⏸️ Pedidos PAUSADOS" : "🟢 Recibiendo pedidos"}</p>
        <button
          className={settings.orders_paused ? "primary big" : "danger big"}
          onClick={() => save({ orders_paused: !settings.orders_paused })}
        >
          {settings.orders_paused ? "Reanudar pedidos" : "Pausar pedidos"}
        </button>
      </div>

      <div className="card form">
        <label>
          Mensaje cuando está en pausa
          <textarea
            rows={3}
            maxLength={500}
            value={settings.pause_message}
            onChange={(e) => setSettings({ ...settings, pause_message: e.target.value })}
            onBlur={() => save({ pause_message: settings.pause_message })}
          />
        </label>
        <label>
          Nombre del negocio (aparece en WhatsApp)
          <input
            value={settings.business_name}
            maxLength={60}
            onChange={(e) => setSettings({ ...settings, business_name: e.target.value })}
            onBlur={() => save({ business_name: settings.business_name })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.delivery_enabled}
            onChange={(e) => save({ delivery_enabled: e.target.checked })}
          />
          Ofrecer entrega en el puesto del cliente
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.customer_can_cancel_confirmed}
            onChange={(e) => save({ customer_can_cancel_confirmed: e.target.checked })}
          />
          El cliente puede anular pedidos ya aceptados
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.auto_accept_orders}
            onChange={(e) => {
              if (
                e.target.checked &&
                !window.confirm("Con esto, cada pedido quedará ACEPTADO automáticamente sin que lo revises. ¿Activar?")
              ) return;
              save({ auto_accept_orders: e.target.checked });
            }}
          />
          Aceptar pedidos automáticamente (no recomendado)
        </label>
        <label>
          Máximo de unidades por producto
          <input
            type="number"
            min={1}
            max={99}
            value={settings.max_quantity_per_item}
            onChange={(e) => setSettings({ ...settings, max_quantity_per_item: Number(e.target.value) })}
            onBlur={() => save({ max_quantity_per_item: settings.max_quantity_per_item })}
          />
        </label>
      </div>

      <div className="card">
        <p className="muted small">Sesión: {email}</p>
        <button onClick={() => supabase.auth.signOut()}>Cerrar sesión</button>
      </div>
    </section>
  );
}
