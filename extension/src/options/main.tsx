import "../styles.css";
import { applySystemTheme } from "@ext/shared/hooks";
import { createRoot } from "react-dom/client";

import { Options } from "./options";

applySystemTheme();
createRoot(document.getElementById("root")!).render(<Options />);
