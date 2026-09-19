import { useLayoutEffect } from "react";

export function WebviewContextMenuGuard() {
  useLayoutEffect(() => {
    function preventDevelopmentContextMenu(event: globalThis.MouseEvent) {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
    }

    document.addEventListener("contextmenu", preventDevelopmentContextMenu);
    return () => document.removeEventListener("contextmenu", preventDevelopmentContextMenu);
  }, []);

  return null;
}
