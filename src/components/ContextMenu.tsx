import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";

export type ContextMenuAction = {
  id: string;
  label: string;
  icon?: LucideIcon;
  destructive?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
};

export type ContextMenuState = {
  x: number;
  y: number;
  actions: ContextMenuAction[];
} | null;

export function ContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu?.x ?? 0, top: menu?.y ?? 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const padding = 8;
    setPosition({
      left: Math.min(menu.x, window.innerWidth - rect.width - padding),
      top: Math.min(menu.y, window.innerHeight - rect.height - padding),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;

    function handlePointerDown(event: PointerEvent) {
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: position.left, top: position.top }}
    >
      {menu.actions.map((action) => {
        const Icon = action.icon;
        return (
          <button
            key={action.id}
            className={`${action.separatorBefore ? " has-separator" : ""}${action.destructive ? " is-destructive" : ""}`}
            role="menuitem"
            onClick={() => {
              onClose();
              action.onSelect();
            }}
          >
            {Icon ? <Icon size={15} /> : <span className="context-menu-icon-spacer" />}
            <span>{action.label}</span>
          </button>
        );
      })}
    </div>
  );
}
