export type ParsedTransaction = {
  page: number;
  date: string;
  transactionId: string;
  description: string;
  amount: number;
  direction: "Dr" | "Cr";
  balance: number;
  balanceDirection: "Dr" | "Cr";
};

const rowPattern = /(\d{2}[-/.]\d{2}[-/.]\d{4})\s+(\S+)\s+(.+?)\s+(\d[\d,]*\.\d{2})\s*\(?(Dr|Cr)\)?\s+(\d[\d,]*\.\d{2})\s*\(?(Dr|Cr)\)?(?=\s+\d{2}[-/.]\d{2}[-/.]\d{4}|\s*$)/gi;

// Fallback for the very common bank-statement layout where Debit and Credit are two
// separate columns (a value in one, a dash/blank in the other) with no Dr/Cr label on
// the amount itself - only the running balance carries that label. Tried only when the
// primary pattern above finds nothing, so it never changes behavior for text that
// already parses correctly.
const splitColumnPattern = /(\d{2}[-/.]\d{2}[-/.]\d{2,4})\s+(.+?)\s+(\d[\d,]*\.\d{2}|[-–—]+)\s+(\d[\d,]*\.\d{2}|[-–—]+)\s+(\d[\d,]*\.\d{2})\s*\(?(Dr|Cr)\)?(?=\s+\d{2}[-/.]\d{2}[-/.]\d{2,4}|\s*$)/gi;

function amount(value: string) {
  return Number(value.replace(/,/g, ""));
}

function isBlankCell(value: string) {
  return /^[-–—]+$/.test(value.trim());
}

function referenceToken(description: string) {
  return description.match(/\S+/)?.[0] ?? "";
}

function parseTransactionsSplitColumns(text: string, page: number): ParsedTransaction[] {
  const rows: ParsedTransaction[] = [];
  const normalized = text.replace(/\s+/g, " ").trim();
  for (const match of normalized.matchAll(splitColumnPattern)) {
    const debitBlank = isBlankCell(match[3]), creditBlank = isBlankCell(match[4]);
    if (debitBlank === creditBlank) continue; // both filled or both blank: can't tell direction, skip rather than guess
    const parsedAmount = amount(debitBlank ? match[4] : match[3]);
    const parsedBalance = amount(match[5]);
    if (!Number.isFinite(parsedAmount) || !Number.isFinite(parsedBalance)) continue;
    const description = match[2].trim();
    rows.push({
      page,
      date: match[1].replace(/[/.]/g, "-"),
      transactionId: referenceToken(description),
      description,
      amount: parsedAmount,
      direction: debitBlank ? "Cr" : "Dr",
      balance: parsedBalance,
      balanceDirection: match[6].toLowerCase() === "dr" ? "Dr" : "Cr",
    });
  }
  return rows;
}

export function parseTransactions(text: string, page: number): ParsedTransaction[] {
  const rows: ParsedTransaction[] = [];
  const normalized = text.replace(/\s+/g, " ").trim();
  for (const match of normalized.matchAll(rowPattern)) {
    const parsedAmount = amount(match[4]);
    const parsedBalance = amount(match[6]);
    if (!Number.isFinite(parsedAmount) || !Number.isFinite(parsedBalance)) continue;
    rows.push({
      page,
      date: match[1].replace(/[/.]/g, "-"),
      transactionId: match[2],
      description: match[3].trim(),
      amount: parsedAmount,
      direction: match[5].toLowerCase() === "dr" ? "Dr" : "Cr",
      balance: parsedBalance,
      balanceDirection: match[7].toLowerCase() === "dr" ? "Dr" : "Cr",
    });
  }
  return rows.length ? rows : parseTransactionsSplitColumns(text, page);
}

export function parseTransactionTable(text: string): ParsedTransaction[] {
  const rows: ParsedTransaction[] = [];
  for (const line of text.split("\n")) {
    if (!/^\|\s*\d{2}-\d{2}-\d{4}\s*\|/.test(line.trim())) continue;
    const cells = line.trim().split("|").slice(1, -1).map(cell => cell.trim());
    if (cells.length < 7) continue;
    const debit = amount(cells[3] || "0");
    const credit = amount(cells[4] || "0");
    const balanceMatch = cells[5].match(/([\d,]+\.\d{2})\s*\((Dr|Cr)\)/i);
    const page = Number(cells[6].match(/Page\s+(\d+)/i)?.[1]);
    if (!balanceMatch || !Number.isFinite(page)) continue;
    const direction = debit > 0 ? "Dr" : "Cr";
    rows.push({
      page,
      date: cells[0],
      transactionId: cells[1],
      description: cells[2],
      amount: direction === "Dr" ? debit : credit,
      direction,
      balance: amount(balanceMatch[1]),
      balanceDirection: balanceMatch[2].toLowerCase() === "dr" ? "Dr" : "Cr",
    });
  }
  return rows;
}

export function deduplicateTransactions(rows: ParsedTransaction[]) {
  const seen = new Set<string>();
  return rows.filter(row => {
    const key = [row.page, row.date, row.transactionId, row.amount, row.direction, row.balance].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function hasReliableTransactionStructure(text: string) {
  const rows = parseTransactions(text, 0);
  if (rows.length >= 2) return true;
  const dates = text.match(/\b\d{2}[-/.]\d{2}[-/.]\d{4}\b/g)?.length ?? 0;
  const directedAmounts = text.match(/\b\d[\d,]*\.\d{2}\s*\(?(?:Dr|Cr)\)?\b/gi)?.length ?? 0;
  return dates >= 2 && directedAmounts >= 4;
}

export function transactionConsistency(text: string) {
  const rows = parseTransactions(text, 0);
  if (rows.length < 2) return rows.length === 1 ? 0.8 : 0;
  let matches = 0;
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1];
    const current = rows[index];
    const expected = previous.balance + (current.direction === "Cr" ? current.amount : -current.amount);
    if (Math.abs(expected - current.balance) < 0.011) matches++;
  }
  return matches / (rows.length - 1);
}

export function filterTransactions(rows: ParsedTransaction[], prompt: string) {
  const lower = prompt.toLowerCase();
  const months: Record<string, string> = {
    january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
    july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
  };
  const monthName = Object.keys(months).find(name => lower.includes(name));
  const explicitDate = lower.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  let filtered = rows;
  if (explicitDate) {
    const target = `${explicitDate[1].padStart(2, "0")}-${explicitDate[2].padStart(2, "0")}-${explicitDate[3]}`;
    filtered = filtered.filter(row => row.date === target);
  } else if (monthName) {
    const month = months[monthName];
    const year = lower.match(/\b(20\d{2})\b/)?.[1];
    filtered = filtered.filter(row => {
      const [, rowMonth, rowYear] = row.date.split("-");
      return rowMonth === month && (!year || rowYear === year);
    });
  }
  const direction = /\bdebits?|money out|paid|payments? made\b/i.test(prompt) ? "Dr" : /\bcredits?|money in|received\b/i.test(prompt) ? "Cr" : undefined;
  if (direction) filtered = filtered.filter(row => row.direction === direction);
  return filtered;
}

export function isTransactionRequest(prompt: string) {
  return /\b(?:transactions?|entries|payments?|debits?|credits?|money in|money out|total|sum|how much|excel|xlsx|spreadsheet|table)\b/i.test(prompt);
}

export function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function formatSignedCurrency(value: number) {
  return `${value >= 0 ? "+" : "-"}${formatCurrency(Math.abs(value))}`;
}

export type GroupedTotal = {
  key: string;
  debit: number;
  credit: number;
  net: number;
  count: number;
  pages: number[];
};

function normalizeNarration(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

const NARRATION_STOPWORDS = new Set([
  "UPI", "NEFT", "IMPS", "RTGS", "POS", "CHQ", "CHEQUE", "ECS", "NACH",
  "TRANSFER", "PAYMENT", "TO", "FROM", "A/C", "ACCT", "ACCOUNT", "IFSC", "REF", "TXN",
]);

/**
 * Extracts a human-readable counterparty/"head" name from a bank narration.
 * Indian bank statements follow a handful of common conventions (UPI/NEFT/IMPS/RTGS
 * references, POS/ATM entries, cheques). Anything that doesn't match a known shape
 * falls back to a cleaned version of the narration itself, so a transaction is never
 * dropped from the head-wise table — at worst it is grouped under a broader label
 * that a CA can rename after a quick look.
 */
export function extractHead(description: string): string {
  const text = normalizeNarration(description);
  const upper = text.toUpperCase();

  if (/\bATM\b/.test(upper)) return "ATM Withdrawal";
  if (/\bSALARY\b/.test(upper)) return "Salary";
  if (/\bINTEREST\b/.test(upper)) return "Interest";
  if (/\bGST\b/.test(upper) && /\bREFUND\b/.test(upper)) return "Tax Refund";

  if (/[/-]/.test(text)) {
    const segments = text.split(/[/-]/).map(s => s.trim()).filter(Boolean);
    const candidates = segments.filter(segment => {
      const letters = (segment.match(/[A-Za-z]/g) ?? []).length;
      const digits = (segment.match(/[0-9]/g) ?? []).length;
      if (letters < 3) return false;
      if (digits > letters) return false;
      if (NARRATION_STOPWORDS.has(segment.toUpperCase())) return false;
      if (segment.includes("@")) return false;
      return true;
    });
    if (candidates.length) {
      const best = candidates.reduce((longest, current) => (current.length > longest.length ? current : longest));
      return best.replace(/\s{2,}/g, " ").trim();
    }
  }

  const cleaned = text.replace(/\b\d{6,}\b/g, "").replace(/\s+/g, " ").trim();
  return cleaned.length >= 3 ? cleaned.slice(0, 60) : "Other / Unidentified";
}

function groupRows(rows: ParsedTransaction[], keyFn: (row: ParsedTransaction) => string): GroupedTotal[] {
  const groups = new Map<string, GroupedTotal>();
  for (const row of rows) {
    const key = keyFn(row) || "Other / Unidentified";
    const existing = groups.get(key) ?? { key, debit: 0, credit: 0, net: 0, count: 0, pages: [] };
    if (row.direction === "Dr") existing.debit += row.amount;
    else existing.credit += row.amount;
    existing.net = existing.credit - existing.debit;
    existing.count++;
    if (!existing.pages.includes(row.page)) existing.pages.push(row.page);
    groups.set(key, existing);
  }
  return [...groups.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
}

export function groupByHead(rows: ParsedTransaction[]): GroupedTotal[] {
  return groupRows(rows, row => extractHead(row.description));
}

export function groupByNarration(rows: ParsedTransaction[]): GroupedTotal[] {
  return groupRows(rows, row => normalizeNarration(row.description));
}

export function groupedTotalsAnswer(groups: GroupedTotal[], columnTitle: string, unreadable: number[]) {
  if (!groups.length) return "No matching readable transactions were found. If the answer may be on a flagged page, review that page before relying on this result.";
  const totalDebit = groups.reduce((sum, g) => sum + g.debit, 0);
  const totalCredit = groups.reduce((sum, g) => sum + g.credit, 0);
  const lines = [
    `| ${columnTitle} | Debit ₹ | Credit ₹ | Net ₹ |`,
    "|---|---:|---:|---:|",
    ...groups.map(g => `| ${g.key.replace(/\|/g, "/")} | ${g.debit ? formatCurrency(g.debit) : "—"} | ${g.credit ? formatCurrency(g.credit) : "—"} | ${formatSignedCurrency(g.net)} |`),
    `| **TOTAL** | **${formatCurrency(totalDebit)}** | **${formatCurrency(totalCredit)}** | **${formatSignedCurrency(totalCredit - totalDebit)}** |`,
  ];
  const summary = [`Grouped into ${groups.length} row${groups.length === 1 ? "" : "s"} from every readable page — nothing sampled or left out.`];
  if (unreadable.length) summary.push(`Important limitation: ${unreadable.length} page(s) are still flagged and excluded: ${unreadable.join(", ")}.`);
  return [...lines, "", ...summary].join("\n");
}

export function transactionAnswer(rows: ParsedTransaction[], prompt: string, unreadable: number[]) {
  const filtered = filterTransactions(rows, prompt);
  if (!filtered.length) return "No matching readable transactions were found. If the answer may be on a flagged page, review that page before relying on this result.";
  const debit = filtered.filter(row => row.direction === "Dr").reduce((sum, row) => sum + row.amount, 0);
  const credit = filtered.filter(row => row.direction === "Cr").reduce((sum, row) => sum + row.amount, 0);
  const wantsTable = /\b(?:table|transactions?|entries|excel|xlsx|spreadsheet)\b/i.test(prompt);
  const visible = filtered.slice(0, 500);
  const lines = wantsTable ? [
    "| Date | Transaction ID | Description | Debit | Credit | Balance | Source |",
    "|---|---|---|---:|---:|---:|---|",
    ...visible.map(row => `| ${row.date} | ${row.transactionId.replace(/\|/g, "/")} | ${row.description.replace(/\|/g, "/")} | ${row.direction === "Dr" ? formatCurrency(row.amount) : ""} | ${row.direction === "Cr" ? formatCurrency(row.amount) : ""} | ${formatCurrency(row.balance)} (${row.balanceDirection}) | [Page ${row.page}] |`),
  ] : [];
  const summary = [
    `Matched transactions: ${filtered.length}.`,
    `Total debits: INR ${formatCurrency(debit)}.`,
    `Total credits: INR ${formatCurrency(credit)}.`,
    `Net movement (credits minus debits): INR ${formatCurrency(credit - debit)}.`,
  ];
  if (filtered.length > visible.length) summary.push(`Only the first ${visible.length} of ${filtered.length} matching rows are shown here. Ask a narrower question (a specific date or month) to see the rest.`);
  if (unreadable.length) summary.push(`Important limitation: ${unreadable.length} page(s) are still flagged and excluded: ${unreadable.join(", ")}.`);
  return [...lines, ...(lines.length ? [""] : []), ...summary].join("\n");
}
