import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "./style.css";

const queryClient = new QueryClient();

const Root = () => {
  const [key, setKey] = useState(0);

  useEffect(() => {
    const cleanup = window.api.on("renderer:reload", () => {
      setKey((prev) => prev + 1);
    });
    return cleanup;
  }, []);

  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App key={key} />
      </QueryClientProvider>
    </StrictMode>
  );
};

const rootElement = document.getElementById("root")!;
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(<Root />);
}
