import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import Login from "./components/Login";
import OrdersView from "./components/OrdersView";
import ProductsView from "./components/ProductsView";
import SettingsView from "./components/SettingsView";
import { isConfigured, supabase } from "./supabase";

type Tab = "orders" | "products" | "settings";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>("orders");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecking(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  // ¿Está en la tabla admins? (RLS solo deja ver la propia fila)
  useEffect(() => {
    if (!session) {
      setIsAdmin(null);
      return;
    }
    supabase
      .from("admins")
      .select("user_id")
      .eq("user_id", session.user.id)
      .maybeSingle()
      .then(({ data, error }) => setIsAdmin(!error && Boolean(data)));
  }, [session]);

  if (!isConfigured) {
    return (
      <main className="center">
        <h1>Falta configuración</h1>
        <p>Crea el archivo <code>admin/.env.local</code> con VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY (ver README).</p>
      </main>
    );
  }
  if (checking) return <main className="center">Cargando…</main>;
  if (!session) return <Login />;
  if (isAdmin === null) return <main className="center">Verificando permisos…</main>;
  if (!isAdmin) {
    return (
      <main className="center">
        <h1>Sin autorización</h1>
        <p>Esta cuenta no es administradora de la juguería.</p>
        <button onClick={() => supabase.auth.signOut()}>Cerrar sesión</button>
      </main>
    );
  }

  return (
    <div className="app">
      <main className="content">
        {tab === "orders" && <OrdersView />}
        {tab === "products" && <ProductsView />}
        {tab === "settings" && <SettingsView email={session.user.email ?? ""} />}
      </main>
      <nav className="tabbar">
        <button className={tab === "orders" ? "active" : ""} onClick={() => setTab("orders")}>
          🧾<span>Pedidos</span>
        </button>
        <button className={tab === "products" ? "active" : ""} onClick={() => setTab("products")}>
          🥤<span>Productos</span>
        </button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
          ⚙️<span>Ajustes</span>
        </button>
      </nav>
    </div>
  );
}
