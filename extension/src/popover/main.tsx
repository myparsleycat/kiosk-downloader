import "../styles.css";
import { applySystemTheme } from "@ext/shared/hooks";
import { createRoot } from "react-dom/client";

import { Popover } from "./popover";

applySystemTheme();
document.body.className = "m-0 overflow-hidden bg-popover text-popover-foreground";
createRoot(document.getElementById("root")!).render(<Popover />);
