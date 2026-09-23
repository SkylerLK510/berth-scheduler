import type { ReactNode } from "react";
import { DispatcherOnly } from "@/components/Dispatcher";

// Imports (even the preview) change or read raw uploads, so the whole page is for dispatchers.
export default function ImportLayout({ children }: { children: ReactNode }) {
  return <DispatcherOnly what="import a spreadsheet">{children}</DispatcherOnly>;
}
