import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DesignPreview } from "./DesignPreview";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {import.meta.env.DEV ? <DesignPreview><App /></DesignPreview> : <App />}
  </StrictMode>,
);
