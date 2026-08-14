import { NextResponse } from "next/server";

async function sessionToken(password: string) {
  const bytes = new TextEncoder().encode(`${password}:a-harish-co-session-v1`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function POST(request: Request) {
  const configured = process.env.APP_ACCESS_PASSWORD;
  if (!configured) return NextResponse.json({ error: "Private access is not configured." }, { status: 503 });
  const body = await request.json() as { password?: string };
  if (body.password !== configured) return NextResponse.json({ error: "That password is incorrect." }, { status: 401 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set("a_harish_session", await sessionToken(configured), { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 12 });
  return response;
}
