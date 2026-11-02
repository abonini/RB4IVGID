import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import { Widget } from "./Widget";
import "./styles.css";

const layout = new URLSearchParams(window.location.search).get("layout") === "compact" ? "compact" : "standard";
const root = document.getElementById("root");
if (!root) {
  throw new Error("Widget root is missing");
}

createRoot(root).render(
  <StrictMode>
    <Widget layout={layout} />
  </StrictMode>,
);
