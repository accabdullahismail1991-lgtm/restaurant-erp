import { useMemo, useState } from 'react';
import { MenuItem } from '../api/types';

interface Props {
  items: MenuItem[];
  makeableCount: (item: MenuItem) => number;
  qtyInCart: (itemId: string) => number;
  onAdd: (item: MenuItem) => void;
}

export default function MenuGrid({ items, makeableCount, qtyInCart, onAdd }: Props) {
  const categories = useMemo(() => {
    const set = ['الكل'];
    for (const it of items) if (!set.includes(it.category)) set.push(it.category);
    return set;
  }, [items]);
  const [activeCategory, setActiveCategory] = useState('الكل');

  const visible = activeCategory === 'الكل' ? items : items.filter((i) => i.category === activeCategory);

  return (
    <div>
      <div className="cat-row">
        {categories.map((c) => (
          <button key={c} className={c === activeCategory ? 'active' : ''} onClick={() => setActiveCategory(c)}>
            {c}
          </button>
        ))}
      </div>
      <div className="menu-grid">
        {visible.map((item) => {
          const makeable = makeableCount(item) - qtyInCart(item.id);
          const outOfStock = makeable <= 0;
          return (
            <div
              key={item.id}
              className={`item-card${outOfStock ? ' out-of-stock' : ''}`}
              onClick={() => (outOfStock ? undefined : onAdd(item))}
            >
              {outOfStock ? (
                <span className="warn">نفذ المخزون</span>
              ) : makeable <= 3 ? (
                <span className="warn">آخر {makeable}</span>
              ) : null}
              <span className="name">{item.name}</span>
              <span className="price">{Number(item.price).toFixed(2)} ر.س</span>
            </div>
          );
        })}
        {!visible.length && <div className="empty-state">لا توجد أصناف في هذا القسم</div>}
      </div>
    </div>
  );
}
