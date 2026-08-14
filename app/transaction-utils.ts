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

function amount(value: string) {
  return Number(value.replace(/,/g, ""));
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
  return rows;
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
  if (filtered.length > visible.length) summary.push(`The on-screen table shows the first ${visible.length} rows; the Excel export includes all ${filtered.length} rows.`);
  if (unreadable.length) summary.push(`Important limitation: ${unreadable.length} page(s) are still flagged and excluded: ${unreadable.join(", ")}.`);
  return [...lines, ...(lines.length ? [""] : []), ...summary].join("\n");
}
