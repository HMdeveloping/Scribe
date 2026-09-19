import { useCallback, useState } from "react";

export function useProjectRecordingSelection() {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  return { selectedIds, setSelectedIds, clearSelection };
}
