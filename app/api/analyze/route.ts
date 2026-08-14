import { deduplicateTransactions, isTransactionRequest, parseTransactions, parseTransactionTable, transactionAnswer } from "../../transaction-utils";

type PageInput = { page: number; text: string; status: "read" | "review" };

export async function POST(request: Request) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return Response.json({ error: "DeepSeek is not connected yet. Add DEEPSEEK_API_KEY in Netlify." }, { status: 503 });
  let body: { documentName?: string; question?: string; pages?: PageInput[]; unreadable?: number[]; totalPages?: number; batch?: { current?: number; total?: number }; synthesis?: boolean; allowedPages?: number[]; today?: string };
  try { body = await request.json() as typeof body; } catch { return Response.json({ error: "The question request was incomplete. Please try again." }, { status: 400 }); }
  if (!body.question?.trim() || !Array.isArray(body.pages)) return Response.json({ error: "A question and processed pages are required." }, { status: 400 });
  const readable = body.pages.filter((page) => page.status === "read" && page.text.trim());
  const unreadable = Array.isArray(body.unreadable) ? body.unreadable : [];
  const deterministicRows = deduplicateTransactions(readable.flatMap(page => body.synthesis ? parseTransactionTable(page.text) : parseTransactions(page.text, page.page)));
  if (isTransactionRequest(body.question) && deterministicRows.length) {
    return Response.json({ answer: transactionAnswer(deterministicRows, body.question, unreadable) });
  }
  const evidence = readable.map((page) => `--- PAGE ${page.page} ---\n${page.text}`).join("\n").slice(0, 180_000);
  const batchNote = body.batch?.total && body.batch.total > 1 ? ` This is evidence batch ${body.batch.current} of ${body.batch.total}. Report only findings supported by this batch and retain the true PDF page citations.` : "";
  const system = body.synthesis
    ? `You are the final verification editor for Harish Acharya & Co. The supplied evidence contains partial answers from one target PDF whose [Page N] references are original PDF pages. Produce one answer to the original request. Merge and deduplicate rows and findings, obey any requested row limit across the entire answer, preserve original citations, and never create new citations. For totals, recompute the arithmetic from the deduplicated rows, preserve debit/credit direction, and report any disagreement instead of silently choosing a value. Resolve other contradictions only when cited evidence clearly supports one result; otherwise require review. For tables, return exactly one Markdown table. Unreadable PDF pages: ${unreadable.join(", ") || "none"}. Never claim accounting, tax, or legal approval.`
    : `You are the evidence analyst for Harish Acharya & Co, Chartered Accountants. Answer only from the supplied target PDF evidence; never mix documents. Today is ${body.today ?? "not supplied"}. Cite every factual statement with [Page N]. When asked for a table or list, use clear Markdown and include the source page in every row. For totals, list every included entry, preserve its sign and debit/credit direction, show the arithmetic, independently recalculate the result, and state separate debit, credit and net totals when applicable. Never invent, estimate, repair, or infer an unclear value. Preserve names, dates and amounts exactly as written. If evidence is absent, say it was not found. If an unreadable page may contain the answer, say: Sorry, I could not clearly read page N. Please review this page. Unreadable pages: ${unreadable.join(", ") || "none"}. The document has ${body.totalPages ?? "an unknown number of"} pages.${batchNote} Never claim accounting, tax, or legal approval.`;
  const payload = { model: "deepseek-chat", temperature: 0, max_tokens: 4000, messages: [{ role: "system", content: system }, { role: "user", content: `Document: ${body.documentName ?? "Uploaded PDF"}\nQuestion: ${body.question}\n\nEvidence:\n${evidence}` }] };
  let answer = "", lastStatus = 502;
  for (let attempt = 0; attempt < 2 && !answer; attempt++) {
    try {
      const response = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(22_000) });
      lastStatus = response.status;
      if (!response.ok) { if (![429, 500, 502, 503].includes(response.status)) break; continue; }
      const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      answer = result.choices?.[0]?.message?.content?.trim() ?? "";
    } catch { /* Retry once; a clean JSON error is returned below. */ }
  }
  if (!answer) return Response.json({ error: lastStatus === 402 ? "The DeepSeek balance is empty. Please recharge the API account." : "The document assistant could not complete this answer. Please try again; your PDF and progress are safe." }, { status: 502 });
  const allowed = new Set((body.synthesis && body.allowedPages?.length ? body.allowedPages : readable.map(page => page.page)).filter(page => !unreadable.includes(page)));
  const cited = [...answer.matchAll(/\[Page\s+(\d+)\]/gi)].map(match => Number(match[1]));
  const invalid = [...new Set(cited.filter(page => !allowed.has(page)))];
  if (invalid.length) return Response.json({ answer: `I withheld the generated answer because its page-citation verification failed for page${invalid.length === 1 ? "" : "s"} ${invalid.join(", ")}. Please ask again or review the source PDF.` });
  return Response.json({ answer });
}
