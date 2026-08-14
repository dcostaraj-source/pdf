import { NextRequest, NextResponse } from "next/server";

async function sessionToken(password: string) {
  const bytes = new TextEncoder().encode(`${password}:a-harish-co-session-v1`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function proxy(request: NextRequest) {
  const password = process.env.APP_ACCESS_PASSWORD;
  if (!password) return new NextResponse("Private access is not configured. Add APP_ACCESS_PASSWORD in Netlify.", { status: 503 });
  const expected = await sessionToken(password);
  if (request.cookies.get("a_harish_session")?.value === expected) return NextResponse.next();
  const login = new URL("/login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = { matcher: ["/((?!login|api/login|_next/static|_next/image|favicon.ico|og.png).*)"] };
