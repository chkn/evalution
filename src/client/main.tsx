// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./theme";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
