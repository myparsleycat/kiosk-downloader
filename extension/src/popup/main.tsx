import "../styles.css";
import { applySystemTheme } from "@ext/shared/hooks";
import { createRoot } from "react-dom/client";

import { Popup } from "./popup";

applySystemTheme();
createRoot(document.getElementById("root")!).render(<Popup />);
