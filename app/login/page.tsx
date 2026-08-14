"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const response = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    const data = await response.json() as { error?: string };
    if (!response.ok) { setError(data.error ?? "Sign-in failed."); setBusy(false); return; }
    const next = new URLSearchParams(window.location.search).get("next");
    router.replace(next?.startsWith("/") ? next : "/"); router.refresh();
  }
  return <main className="loginPage"><section className="loginCard"><div className="loginSeal">AH</div><p>A HARISH CO</p><h1>Private document workspace</h1><span>Enter the private access password to continue.</span><form onSubmit={submit}><label htmlFor="password">Workspace password</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required/><button disabled={busy}>{busy ? "Checking…" : "Enter workspace"}</button>{error && <strong className="loginError">{error}</strong>}</form><small>PDF reading happens on this device. Never share the password.</small></section></main>;
}
