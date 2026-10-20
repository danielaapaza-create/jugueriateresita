import { type FormEvent, useCallback, useEffect, useState } from "react";
import { CATEGORY_LABEL, parseSoles, soles } from "../format";
import { supabase } from "../supabase";
import type { Category, Product } from "../types";

const CATEGORIES = Object.keys(CATEGORY_LABEL) as Category[];

interface Draft {
  id?: string;
  category: Category;
  name: string;
  description: string;
  price: string;
  sort_order: string;
}

const emptyDraft = (): Draft => ({ category: "jugos", name: "", description: "", price: "", sort_order: "0" });

export default function ProductsView() {
  const [products, setProducts] = useState<Product[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .order("category")
      .order("sort_order")
      .order("name");
    if (error) setError("No se pudieron cargar los productos.");
    else setProducts(data as Product[]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function update(id: string, patch: Partial<Product>) {
    setError(null);
    const { error } = await supabase.from("products").update(patch).eq("id", id);
    if (error) setError("No se pudo guardar el cambio.");
    load();
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const price_cents = parseSoles(draft.price);
    const name = draft.name.trim();
    if (name.length < 2 || name.length > 60) return setError("El nombre debe tener entre 2 y 60 caracteres.");
    if (price_cents === null) return setError("Precio inválido. Escribe por ejemplo 3.50");
    const row = {
      category: draft.category,
      name,
      description: draft.description.trim().slice(0, 140) || null,
      price_cents,
      sort_order: Number.parseInt(draft.sort_order, 10) || 0,
    };
    const { error } = draft.id
      ? await supabase.from("products").update(row).eq("id", draft.id)
      : await supabase.from("products").insert(row);
    if (error) return setError("No se pudo guardar el producto.");
    setDraft(null);
    setError(null);
    load();
  }

  const edit = (p: Product) =>
    setDraft({
      id: p.id,
      category: p.category,
      name: p.name,
      description: p.description ?? "",
      price: (p.price_cents / 100).toFixed(2),
      sort_order: String(p.sort_order),
    });

  const active = products.filter((p) => p.is_active);
  const archived = products.filter((p) => !p.is_active);

  return (
    <section>
      <header className="topbar">
        <h1>Productos</h1>
        <button className="primary" onClick={() => setDraft(emptyDraft())}>+ Nuevo</button>
      </header>
      {error && <p className="banner error">{error}</p>}

      {draft && (
        <form className="card form" onSubmit={save}>
          <h2>{draft.id ? "Editar producto" : "Nuevo producto"}</h2>
          <label>
            Categoría
            <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as Category })}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
            </select>
          </label>
          <label>
            Nombre
            <input value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />
          </label>
          <label>
            Descripción (opcional)
            <input value={draft.description} maxLength={140} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </label>
          <label>
            Precio (S/)
            <input inputMode="decimal" placeholder="3.50" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} required />
          </label>
          <label>
            Orden en la lista (menor = primero)
            <input inputMode="numeric" value={draft.sort_order} onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })} />
          </label>
          <p className="muted small">Cambiar el precio no afecta los pedidos ya registrados.</p>
          <div className="actions">
            <button type="button" onClick={() => setDraft(null)}>Cancelar</button>
            <button className="primary">Guardar</button>
          </div>
        </form>
      )}

      {active.length === 0 && <p className="empty">Aún no hay productos. Toca “+ Nuevo” para agregar la carta.</p>}
      {CATEGORIES.map((cat) => {
        const list = active.filter((p) => p.category === cat);
        if (!list.length) return null;
        return (
          <div key={cat}>
            <h2 className="group">{CATEGORY_LABEL[cat]}</h2>
            {list.map((p) => (
              <article key={p.id} className={`card product ${p.is_available ? "" : "soldout"}`}>
                <div className="product-info" onClick={() => edit(p)}>
                  <b>{p.name}</b>
                  <span>{soles(p.price_cents)}</span>
                  {p.description && <span className="muted small">{p.description}</span>}
                </div>
                <div className="product-actions">
                  <button
                    className={p.is_available ? "ok" : "danger"}
                    onClick={() => update(p.id, { is_available: !p.is_available })}
                  >
                    {p.is_available ? "Disponible" : "AGOTADO"}
                  </button>
                  <button className="link" onClick={() => {
                    if (window.confirm(`¿Archivar “${p.name}”? Ya no aparecerá en WhatsApp.`)) update(p.id, { is_active: false });
                  }}>
                    Archivar
                  </button>
                </div>
              </article>
            ))}
          </div>
        );
      })}

      {archived.length > 0 && (
        <>
          <button className="link" onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? "Ocultar" : "Ver"} archivados ({archived.length})
          </button>
          {showArchived && archived.map((p) => (
            <article key={p.id} className="card product soldout">
              <div className="product-info">
                <b>{p.name}</b>
                <span>{soles(p.price_cents)}</span>
              </div>
              <button onClick={() => update(p.id, { is_active: true })}>Reactivar</button>
            </article>
          ))}
        </>
      )}
    </section>
  );
}
