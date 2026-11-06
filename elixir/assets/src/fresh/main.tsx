import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import "./fresh.css";

// A fragment is never sent in an HTTP request. Remove it before exchanging the one-time code.
const signIn = new URLSearchParams(window.location.hash.slice(1)).get("sympp-code");
if (signIn) {
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  void fetch("/api/v1/sympp/board-session", {
    method: "POST",
    headers: { authorization: `Board ${signIn}` },
  }).then((response) => {
    if (response.ok) window.location.reload();
    else document.getElementById("root")!.textContent = "Sign-in failed. Run sympp board again.";
  }, () => { document.getElementById("root")!.textContent = "Could not sign in. Run sympp board again."; });
} else ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
