"use client";
import { KeyboardEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { filterTransactions, hasReliableTransactionStructure, isTransactionRequest, parseTransactions, transactionAnswer, transactionConsistency } from "./transaction-utils";
type PageResult = {
    page: number;
    text: string;
    method: "embedded text" | "OCR" | "unreadable";
    status: "read" | "review";
    verification?: string;
    message?: string;
    approved?: boolean;
};
type PaddleItem = {
    poly: Array<[
        number,
        number
    ]>;
    text: string;
    score: number;
};
type PaddleEngine = {
    predict: (input: HTMLCanvasElement) => Promise<Array<{
        items: PaddleItem[];
    }>>;
    dispose: () => Promise<void>;
};
type ScanMode = "fast" | "maximum";
type DocumentResult = {
    id: string;
    name: string;
    size: string;
    pages: PageResult[];
    totalPages: number;
    processedPages: number;
    status: "Processing" | "Paused" | "Ready" | "Review" | "Approved" | "Cancelled" | "Failed";
    startedAt?: number;
    etaSeconds?: number;
    mode: ScanMode;
    uploadNumber: number;
};
type ChatMessage = {
    id: string;
    role: "assistant" | "user";
    text: string;
};
const specialists = [["01", "Page Guard", "Accounts for every page"], ["02", "Dual Local OCR", "Two engines read difficult scans"], ["03", "Financial Guard", "Checks critical values before acceptance"], ["04", "DeepSeek Analyst", "Answers only from PDF evidence"], ["05", "Excel Studio", "Creates a page-audit workbook"]];
const welcome: ChatMessage = { id: "welcome", role: "assistant", text: "Welcome. Upload a PDF, then ask me anything about it. I will cite page numbers and tell you when evidence is unclear." };
function inlineFormat(text: string): ReactNode[] { return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) => part.startsWith("**") && part.endsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : part); }
function AssistantContent({ text }: {
    text: string;
}) { const lines = text.replace(/\r/g, "").split("\n"), content: ReactNode[] = []; for (let i = 0; i < lines.length;) {
    const line = lines[i].trim();
    if (line.startsWith("|") && line.endsWith("|")) {
        const table: string[][] = [];
        while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
            const cells = lines[i].trim().split("|").slice(1, -1).map(cell => cell.trim());
            if (!cells.every(cell => /^:?-{3,}:?$/.test(cell)))
                table.push(cells);
            i++;
        }
        if (table.length) {
            content.push(<div className="assistantTableWrap" key={`table-${i}`}><table className="assistantTable"><thead><tr>{table[0].map((cell, column) => <th key={column}>{inlineFormat(cell)}</th>)}</tr></thead><tbody>{table.slice(1).map((row, rowIndex) => <tr key={rowIndex}>{table[0].map((_, column) => <td key={column}>{inlineFormat(row[column] ?? "")}</td>)}</tr>)}</tbody></table></div>);
        }
        continue;
    }
    if (/^[-*]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
            items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
            i++;
        }
        content.push(<ul key={`list-${i}`}>{items.map((item, index) => <li key={index}>{inlineFormat(item)}</li>)}</ul>);
        continue;
    }
    if (/^#{1,3}\s+/.test(line)) {
        content.push(<h3 key={`heading-${i}`}>{inlineFormat(line.replace(/^#{1,3}\s+/, ""))}</h3>);
        i++;
        continue;
    }
    if (line)
        content.push(<p key={`paragraph-${i}`}>{inlineFormat(line)}</p>);
    i++;
} return <div className="assistantContent">{content}</div>; }
export default function Home() {
    const [showSplash, setShowSplash] = useState(true), [documents, setDocuments] = useState<DocumentResult[]>([]), [activeId, setActiveId] = useState<string | null>(null), [question, setQuestion] = useState(""), [messages, setMessages] = useState<ChatMessage[]>([welcome]), [asking, setAsking] = useState(false), [analysisProgress, setAnalysisProgress] = useState(""), [isDragging, setIsDragging] = useState(false), [scanMode, setScanMode] = useState<ScanMode>("fast"), [batchNotice, setBatchNotice] = useState("");
    const inputRef = useRef<HTMLInputElement>(null), topRef = useRef<HTMLElement>(null), documentsRef = useRef<HTMLElement>(null), reviewRef = useRef<HTMLElement>(null), exportRef = useRef<HTMLElement>(null), chatEndRef = useRef<HTMLDivElement>(null);
    const controlRef = useRef<Record<string, "running" | "paused" | "cancelled">>({}), uploadCounterRef = useRef(0);
    const active = documents.find(doc => doc.id === activeId) ?? documents[0];
    useEffect(() => { const timer = window.setTimeout(() => setShowSplash(false), 5000); return () => window.clearTimeout(timer); }, []);
    useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [messages, asking]);
    const totals = useMemo(() => ({ pages: documents.reduce((s, d) => s + d.totalPages, 0), processed: documents.reduce((s, d) => s + d.processedPages, 0), review: documents.reduce((s, d) => s + d.pages.filter(p => p.status === "review").length, 0) }), [documents]);
    const scrollTo = (ref: React.RefObject<HTMLElement | null>) => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    async function processFiles(files: FileList | File[]) { const pdfs = Array.from(files).filter(file => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")).slice(0, 20); if (!pdfs.length) {
        setBatchNotice("Please choose PDF files only.");
        return;
    } setBatchNotice(pdfs.length > 1 ? `${pdfs.length} PDFs queued. They will be read safely one at a time.` : ""); for (let index = 0; index < pdfs.length; index++) {
        setBatchNotice(pdfs.length > 1 ? `Reading PDF ${index + 1} of ${pdfs.length}: ${pdfs[index].name}` : "");
        await processPdf(pdfs[index]);
    } const notice = pdfs.length > 1 ? `All ${pdfs.length} PDFs finished. Open any document to review its result.` : "PDF processing finished."; setBatchNotice(notice); if (typeof Notification !== "undefined" && Notification.permission === "granted")
        new Notification("A Harish Co", { body: notice }); }
    function updateDocument(id: string, patch: Partial<DocumentResult>) { setDocuments(current => current.map(doc => doc.id === id ? { ...doc, ...patch } : doc)); }
    function persistDocument(doc: DocumentResult) { try {
        localStorage.setItem(`ah-progress:${doc.name}:${doc.size}`, JSON.stringify(doc));
    }
    catch { /* Storage can be unavailable in private mode. */ } }
    function setControl(id: string, control: "running" | "paused" | "cancelled") { controlRef.current[id] = control; updateDocument(id, { status: control === "paused" ? "Paused" : control === "cancelled" ? "Cancelled" : "Processing" }); }
    function deleteDocument(id: string) { const target = documents.find(document => document.id === id); if (!target || !window.confirm(`Delete ${target.name}? Processing will stop and its saved results will be removed from this browser.`))
        return; controlRef.current[id] = "cancelled"; try {
        localStorage.removeItem(`ah-progress:${target.name}:${target.size}`);
    }
    catch { /* Deletion still succeeds when browser storage is unavailable. */ } setDocuments(current => { const remaining = current.filter(document => document.id !== id); if (activeId === id)
        setActiveId(remaining[0]?.id ?? null); return remaining; }); setMessages([welcome]); setBatchNotice(`${target.name} was deleted.`); }
    async function waitWhilePaused(id: string) { while (controlRef.current[id] === "paused")
        await new Promise(resolve => window.setTimeout(resolve, 250)); return controlRef.current[id] !== "cancelled"; }
    function wasCancelled(id: string) { return String(controlRef.current[id]) === "cancelled"; }
    function formatEta(seconds?: number) { if (!seconds || !Number.isFinite(seconds))
        return "Calculating…"; if (seconds < 60)
        return `about ${Math.max(1, Math.round(seconds))} sec`; const minutes = Math.ceil(seconds / 60); return `about ${minutes} min`; }
    function cleanOcrText(text: string) { return text.replace(/\s+/g, " ").trim(); }
    function financialTokens(text: string) { return text.toUpperCase().match(/\b(?:\d{1,4}[-/.]){1,2}\d{1,4}\b|\b\d[\d,]*(?:\.\d{1,2})?(?:\s*\(?(?:CR|DR)\)?)?\b|\b[A-Z]*\d[A-Z0-9]{4,}\b/g) ?? []; }
    function tokenAgreement(left: string, right: string) { const a = financialTokens(left), b = financialTokens(right), counts = new Map<string, number>(); for (const token of b)
        counts.set(token, (counts.get(token) ?? 0) + 1); let matched = 0; for (const token of a) {
        const count = counts.get(token) ?? 0;
        if (count) {
            matched++;
            counts.set(token, count - 1);
        }
    } return Math.max(a.length, b.length) ? matched / Math.max(a.length, b.length) : 0; }
    function normalizePaddleResult(items: PaddleItem[]) { const sorted = [...items].sort((a, b) => { const ay = Math.min(...a.poly.map(p => p[1])), by = Math.min(...b.poly.map(p => p[1])); if (Math.abs(ay - by) > 18)
        return ay - by; return Math.min(...a.poly.map(p => p[0])) - Math.min(...b.poly.map(p => p[0])); }); const text = cleanOcrText(sorted.map(item => item.text).join(" ")); const confidence = sorted.length ? sorted.reduce((sum, item) => sum + item.score, 0) / sorted.length * 100 : 0; return { text, confidence }; }
    function financialSanity(text: string) { const markers = text.match(/\b\d[\d,]*\.\d{2}\s*\(?(?:CR|DR)\)?\b/gi) ?? []; const impossible = markers.some(value => !Number.isFinite(Number(value.replace(/\(?(?:cr|dr)\)?/ig, "").replace(/,/g, "").trim()))); return { checked: markers.length, passed: !impossible }; }
    async function renderOcrCanvas(page: Awaited<ReturnType<Awaited<ReturnType<(typeof import("pdfjs-dist"))["getDocument"]>["promise"]>["getPage"]>>, scale: number, enhance: boolean) { const viewport = page.getViewport({ scale }), canvas = document.createElement("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height); const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context)
        throw new Error("Canvas unavailable"); await page.render({ canvas, canvasContext: context, viewport }).promise; if (enhance) {
        const image = context.getImageData(0, 0, canvas.width, canvas.height), data = image.data;
        for (let i = 0; i < data.length; i += 4) {
            const gray = .299 * data[i] + .587 * data[i + 1] + .114 * data[i + 2], value = Math.max(0, Math.min(255, (gray - 128) * 1.45 + 128));
            data[i] = value;
            data[i + 1] = value;
            data[i + 2] = value;
        }
        context.putImageData(image, 0, 0);
    } return canvas; }
    async function processPdf(file: File) {
        const id = `${Date.now()}-${file.name}`, size = `${(file.size / 1024 / 1024).toFixed(1)} MB`;
        let saved: DocumentResult | undefined;
        try {
            const raw = localStorage.getItem(`ah-progress:${file.name}:${size}`);
            if (raw)
                saved = JSON.parse(raw) as DocumentResult;
        }
        catch { /* Start safely when stored progress is damaged. */ }
        const resumable = saved && saved.processedPages < saved.totalPages && saved.status !== "Cancelled" ? saved : undefined, uploadNumber = resumable?.uploadNumber ?? ++uploadCounterRef.current;
        uploadCounterRef.current = Math.max(uploadCounterRef.current, uploadNumber);
        const initial: DocumentResult = { id, name: file.name, size, pages: resumable?.pages ?? [], totalPages: resumable?.totalPages ?? 0, processedPages: resumable?.processedPages ?? 0, status: "Processing", startedAt: Date.now(), mode: resumable?.mode ?? scanMode, uploadNumber };
        controlRef.current[id] = "running";
        setDocuments(current => [initial, ...current]);
        setActiveId(id);
        setMessages([{ id: `${id}-welcome`, role: "assistant", text: `I am reading ${file.name}. Every page will be counted before questions are enabled.` }]);
        try {
            const pdfjs = await import("pdfjs-dist");
            pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
            const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
            updateDocument(id, { totalPages: pdf.numPages });
            let worker: Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>> | null = null, paddle: PaddleEngine | null = null, paddleUnavailable = false;
            const results: PageResult[] = [...(resumable?.pages ?? [])];
            for (let n = results.length + 1; n <= pdf.numPages; n++) {
                if (!await waitWhilePaused(id))
                    break;
                const page = await pdf.getPage(n), content = await page.getTextContent(), embedded = content.items.map(item => "str" in item ? item.str : "").join(" ").replace(/\s+/g, " ").trim();
                let result: PageResult;
                if (embedded.length >= 20)
                    result = { page: n, text: embedded, method: "embedded text", status: "read", verification: "Source text layer" };
                else
                    try {
                        if (!worker) {
                            const { createWorker } = await import("tesseract.js");
                            worker = await createWorker("eng");
                            await worker.setParameters({ preserve_interword_spaces: "1" });
                        }
                        const firstScale = initial.mode === "fast" ? 1.55 : 2.0, firstCanvas = await renderOcrCanvas(page, firstScale, false), first = await worker.recognize(firstCanvas), firstText = cleanOcrText(first.data.text);
                        const sanity = financialSanity(firstText), structured = hasReliableTransactionStructure(firstText), firstConsistency = transactionConsistency(firstText), fastAccepted = firstText.length >= 20 && sanity.passed && (initial.mode === "fast" ? (first.data.confidence >= 72 || (structured && first.data.confidence >= 45 && firstConsistency >= .97)) : first.data.confidence >= 88);
                        if (fastAccepted) {
                            result = { page: n, text: firstText, method: "OCR", status: "read", verification: `Fast OCR confidence ${Math.round(first.data.confidence)}%; ${sanity.checked} financial values checked` };
                            firstCanvas.width = 0;
                            firstCanvas.height = 0;
                            page.cleanup();
                            results.push(result);
                            const elapsed = (Date.now() - (initial.startedAt ?? Date.now())) / 1000, completedThisRun = Math.max(1, n - (resumable?.processedPages ?? 0)), remaining = pdf.numPages - n, eta = (elapsed / completedThisRun) * remaining;
                            const snapshot = { ...initial, pages: [...results], totalPages: pdf.numPages, processedPages: n, status: "Processing" as const, etaSeconds: eta };
                            updateDocument(id, snapshot);
                            if (n % 5 === 0 || n === pdf.numPages)
                                persistDocument(snapshot);
                            continue;
                        }
                        let paddleText = "", paddleConfidence = 0;
                        if (!paddle && !paddleUnavailable)
                            try {
                                const loadPaddle = new Function("return import('https://esm.sh/@paddleocr/paddleocr-js@0.4.2?bundle')") as () => Promise<{
                                    PaddleOCR: {
                                        create: (options: Record<string, unknown>) => Promise<PaddleEngine>;
                                    };
                                }>, { PaddleOCR } = await loadPaddle();
                                paddle = await PaddleOCR.create({ lang: "en", ocrVersion: "PP-OCRv5", worker: true, textRecognitionBatchSize: 6, ortOptions: { backend: "wasm", wasmPaths: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/", numThreads: 2, simd: true } });
                            }
                            catch {
                                paddleUnavailable = true;
                            }
                        if (paddle)
                            try {
                                const [paddleResult] = await paddle.predict(firstCanvas), normalized = normalizePaddleResult(paddleResult?.items ?? []);
                                paddleText = normalized.text;
                                paddleConfidence = normalized.confidence;
                            }
                            catch {
                                paddleUnavailable = true;
                                await paddle.dispose().catch(() => undefined);
                                paddle = null;
                            }
                        const crossAgreement = tokenAgreement(firstText, paddleText), dualAccepted = firstText.length >= 20 && paddleText.length >= 20 && first.data.confidence >= 58 && paddleConfidence >= 72 && crossAgreement >= (initial.mode === "fast" ? .91 : .96) && sanity.passed;
                        firstCanvas.width = 0;
                        firstCanvas.height = 0;
                        if (dualAccepted)
                            result = { page: n, text: firstText, method: "OCR", status: "read", verification: `Dual OCR agreement ${Math.round(crossAgreement * 100)}%; ${sanity.checked} financial values checked` };
                        else {
                            await worker.setParameters({ tessedit_pageseg_mode: "6" as never, preserve_interword_spaces: "1" });
                            const enhancedCanvas = await renderOcrCanvas(page, initial.mode === "fast" ? 1.8 : 2.35, true), second = await worker.recognize(enhancedCanvas);
                            enhancedCanvas.width = 0;
                            enhancedCanvas.height = 0;
                            const secondText = cleanOcrText(second.data.text), retryAgreement = tokenAgreement(firstText, secondText), paddleRetryAgreement = Math.max(tokenAgreement(firstText, paddleText), tokenAgreement(secondText, paddleText)), secondConsistency = transactionConsistency(secondText), preferSecond = secondConsistency > firstConsistency || (secondConsistency === firstConsistency && second.data.confidence >= first.data.confidence), best = preferSecond ? second : first, bestText = cleanOcrText(best.data.text), bestSanity = financialSanity(bestText), bestStructured = hasReliableTransactionStructure(bestText), bestConsistency = Math.max(firstConsistency, secondConsistency), legacyAccepted = firstText.length >= 20 && first.data.confidence >= 62 && (!structured || firstConsistency >= .97), retryAccepted = bestText.length >= 20 && ((bestStructured && bestConsistency >= .97 && Math.max(first.data.confidence, second.data.confidence) >= 40) || (Math.max(first.data.confidence, second.data.confidence) >= 55 && retryAgreement >= (bestStructured ? .82 : .9))), verifiedRetry = paddleText.length >= 20 && paddleConfidence >= 68 && paddleRetryAgreement >= .82 && bestSanity.passed, accepted = legacyAccepted || retryAccepted || verifiedRetry;
                            result = accepted ? { page: n, text: bestText, method: "OCR", status: "read", verification: verifiedRetry ? `Dual OCR retry agreement ${Math.round(paddleRetryAgreement * 100)}%; ${bestSanity.checked} financial values checked` : legacyAccepted ? "Tesseract confidence gate" : "Tesseract retry agreement" } : { page: n, text: bestText, method: "unreadable", status: "review", verification: paddleUnavailable ? "Second OCR unavailable; conservative review" : "OCR engines did not agree on critical values", message: `Sorry, I could not verify the financial values on page ${n}. Please review this page.` };
                        }
                    }
                    catch {
                        result = { page: n, text: "", method: "unreadable", status: "review", message: `Sorry, I could not clearly read page ${n}. Please review this page.` };
                    }
                page.cleanup();
                results.push(result);
                const elapsed = (Date.now() - (initial.startedAt ?? Date.now())) / 1000, completedThisRun = Math.max(1, n - (resumable?.processedPages ?? 0)), eta = (elapsed / completedThisRun) * (pdf.numPages - n), snapshot = { ...initial, pages: [...results], totalPages: pdf.numPages, processedPages: n, status: "Processing" as const, etaSeconds: eta };
                updateDocument(id, snapshot);
                if (n % 5 === 0 || n === pdf.numPages)
                    persistDocument(snapshot);
            }
            await worker?.terminate();
            await paddle?.dispose();
            if (wasCancelled(id))
                return;
            const accounted = new Set(results.map(page => page.page)), missing = Array.from({ length: pdf.numPages }, (_, index) => index + 1).filter(page => !accounted.has(page));
            if (missing.length) {
                updateDocument(id, { pages: results, processedPages: results.length, status: "Failed" });
                setMessages(current => [...current, { id: `${id}-missing`, role: "assistant", text: `Processing stopped safely because page${missing.length === 1 ? "" : "s"} ${missing.join(", ")} were not accounted for. Please upload the PDF again.` }]);
                return;
            }
            const review = results.filter(p => p.status === "review").length, complete = { ...initial, pages: results, totalPages: pdf.numPages, processedPages: results.length, status: (review ? "Review" : "Ready") as DocumentResult["status"], etaSeconds: 0 };
            updateDocument(id, complete);
            persistDocument(complete);
            setMessages(current => [...current, { id: `${id}-ready`, role: "assistant", text: review ? `Reading complete. Every page was accounted for. ${review} page${review === 1 ? "" : "s"} need human review: ${results.filter(page => page.status === "review").map(page => page.page).join(", ")}. I will exclude unclear evidence.` : `Reading complete. All ${pdf.numPages} pages were accounted for and produced readable text. What would you like to know?` }]);
        }
        catch (error) {
            if (wasCancelled(id))
                return;
            updateDocument(id, { status: "Failed" });
            setMessages(current => [...current, { id: `${id}-failed`, role: "assistant", text: error instanceof Error ? error.message : "The PDF could not be processed." }]);
        }
    }
    function isWholeDocumentQuestion(prompt: string) { return /summari|overview|\bevery\b|\ball\b|whole|entire|complete document|excel|export/i.test(prompt); }
    function resolveDocument(prompt: string) { const number = prompt.match(/\b(?:pdf|document|file)\s*#?\s*(\d+)\b/i)?.[1], byNumber = number ? documents.find(document => document.uploadNumber === Number(number)) : undefined, lower = prompt.toLowerCase(), byName = documents.find(document => lower.includes(document.name.toLowerCase()) || lower.includes(document.name.replace(/\.pdf$/i, "").toLowerCase())); return byName ?? byNumber ?? active; }
    function relevantPages(prompt: string, document = active) { if (!document)
        return []; const readable = document.pages.filter(p => p.status === "read" && p.text.trim()); if (isWholeDocumentQuestion(prompt))
        return readable; const lower = prompt.toLowerCase(), stop = new Set(["show", "give", "make", "from", "with", "that", "this", "details", "detail", "transaction", "transactions", "entry", "entries", "table", "please", "payment", "payments", "total", "today"]), terms = (lower.match(/[a-z0-9]{3,}/g) ?? []).filter(term => !stop.has(term)), months: Record<string, string> = { january: "01", february: "02", march: "03", april: "04", may: "05", june: "06", july: "07", august: "08", september: "09", october: "10", november: "11", december: "12" }, month = Object.keys(months).find(name => lower.includes(name)), monthNumber = month ? months[month] : undefined, today = lower.includes("today") ? new Date().toISOString().slice(0, 10) : undefined, ranked = readable.map(p => { const text = p.text.toLowerCase(), termScore = terms.reduce((score, term) => score + (text.includes(term) ? 3 : 0), 0), monthScore = month && monthNumber && (text.includes(month) || new RegExp(`\\b\\d{1,2}[-/.]${monthNumber}[-/.]\\d{2,4}\\b`).test(text) || new RegExp(`\\b\\d{1,2}[-/.](?:${month.slice(0, 3)})[-/.]\\d{2,4}\\b`, "i").test(text)) ? 20 : 0, todayScore = today && (text.includes(today) || text.includes(today.split("-").reverse().join("-")) || text.includes(today.split("-").reverse().join("/"))) ? 20 : 0; return { p, score: termScore + monthScore + todayScore }; }).filter(item => item.score > 0).sort((a, b) => b.score - a.score); if (ranked.length)
        return ranked.slice(0, 30).map(item => item.p).sort((a, b) => a.page - b.page); return readable.length <= 45 ? readable : readable.slice(0, 45); }
    function evidenceBatches(pages: PageResult[]) { const batches: PageResult[][] = []; let batch: PageResult[] = [], characters = 0; for (const page of pages) {
        const size = page.text.length + 40;
        if (batch.length && (batch.length >= 8 || characters + size > 36000)) {
            batches.push(batch);
            batch = [];
            characters = 0;
        }
        batch.push(page);
        characters += size;
    } if (batch.length)
        batches.push(batch); return batches; }
    async function requestAnswer(prompt: string, pages: PageResult[], unreadable: number[], batch?: {
        current: number;
        total: number;
    }, synthesis = false, document = active) { const response = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify({ documentName: document?.name, question: prompt, pages: pages.map(({ page, text, status }) => ({ page, text, status })), unreadable, totalPages: document?.totalPages, batch, synthesis, allowedPages: document?.pages.filter(page => page.status === "read").map(page => page.page), today: new Date().toISOString().slice(0, 10) }) }), raw = await response.text(); let data: {
        answer?: string;
        error?: string;
    }; try {
        data = JSON.parse(raw) as typeof data;
    }
    catch {
        throw new Error(response.status === 504 || response.status === 502 ? "The document assistant took too long to answer. Please try again; your PDF progress is safe." : "The document assistant is temporarily unavailable. Please try again in a moment.");
    } if (!response.ok || !data.answer?.trim())
        throw new Error(data.error ?? "The assistant did not receive a complete answer. Please try again."); return data.answer.trim(); }
    async function askQuestion(prompt = question) { const clean = prompt.trim(), document = resolveDocument(clean); if (!document || !clean || ["Processing", "Paused"].includes(document.status) || asking)
        return; const wantsExcel = /\b(?:excel|xlsx|spreadsheet)\b/i.test(clean), wantsTable = wantsExcel || /\btable\b/i.test(clean), wantsTotal = /\b(?:total|sum|how much|payments?|credits?|debits?)\b/i.test(clean), formatRule = wantsTable ? `\nReturn exactly one complete Markdown table with clear column headings and a source PDF page in every row. Do not omit supported rows, duplicate rows, or invent missing values.` : "", totalRule = wantsTotal ? `\nFor a total, first identify the exact requested date or month. List every included entry with its date, description, amount and source page; then show the arithmetic and final total. Keep debit, credit and net totals separate where applicable. If the date, direction or evidence is ambiguous, explain what needs clarification instead of guessing.` : "", analysisPrompt = `${clean}${formatRule}${totalRule}\nTarget document: ${document.name}. Today is ${new Date().toISOString().slice(0, 10)}.`, unreadable = document.pages.filter(p => p.status === "review").map(p => p.page), selected = relevantPages(clean, document), batches = evidenceBatches(selected); setActiveId(document.id); setQuestion(""); setAsking(true); setAnalysisProgress(""); setMessages(c => [...c, { id: `${Date.now()}-u`, role: "user", text: clean }]); try {
        const parsed = document.pages.filter(page => page.status === "read").flatMap(page => parseTransactions(page.text, page.page));
        if (isTransactionRequest(clean) && parsed.length) {
            const answer = transactionAnswer(parsed, clean, unreadable);
            setMessages(c => [...c, { id: `${Date.now()}-a`, role: "assistant", text: `Document: ${document.name}\n\n${answer}${wantsExcel ? "\n\nSelect Table to Excel to download all matching rows." : ""}` }]);
            return;
        }
        const answers: string[] = [];
        for (let i = 0; i < batches.length; i++) {
            setAnalysisProgress(batches.length > 1 ? `Checking ${document.name}, section ${i + 1} of ${batches.length}` : `Checking ${document.name}`);
            answers.push(await requestAnswer(analysisPrompt, batches[i], unreadable, { current: i + 1, total: batches.length }, false, document));
        }
        let answer = answers.join("\n\n");
        if (answers.length > 1) {
            setAnalysisProgress("Merging duplicates and verifying totals");
            const synthesisPages = answers.map((text, index) => ({ page: index + 1, text, method: "embedded text" as const, status: "read" as const }));
            answer = await requestAnswer(`Original request: ${analysisPrompt}\n\nCombine and verify the partial findings below. Recalculate totals from the listed rows and report any disagreement.`, synthesisPages, unreadable, undefined, true, document);
        }
        if (wantsExcel && /^\|.+\|/m.test(answer))
            answer += `\n\nYour table is ready. Select Table to Excel above to download the Excel file.`;
        setMessages(c => [...c, { id: `${Date.now()}-a`, role: "assistant", text: `Document: ${document.name}\n\n${answer}` }]);
    }
    catch (error) {
        setMessages(c => [...c, { id: `${Date.now()}-e`, role: "assistant", text: error instanceof Error ? error.message : "The document assistant is temporarily unavailable. Please try again. Your PDF progress is safe." }]);
    }
    finally {
        setAsking(false);
        setAnalysisProgress("");
    } }
    function handleQuestionKey(e: KeyboardEvent<HTMLTextAreaElement>) { if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        askQuestion();
    } }
    async function exportLegacyExcel() { if (!active || active.status === "Processing")
        return; const XLSX = await import("xlsx"), rows = active.pages.map(p => ({ Document: active.name, Page: p.page, "Reading method": p.method, "Verification status": p.status === "read" ? "Read" : "Human review required", "Extracted text": p.text, "System message": p.message ?? "" })), amounts = active.pages.flatMap(p => (p.text.match(/(?:₹|Rs\.?|INR\s*)?\s*\(?-?\d[\d,]*(?:\.\d{1,2})?\)?/gi) ?? []).filter(v => /[₹,\.]|Rs|INR/i.test(v)).map(v => ({ Document: active.name, Page: p.page, "Candidate amount": v.trim(), Status: "Verify against source PDF" }))), book = XLSX.utils.book_new(), sheet = XLSX.utils.json_to_sheet(rows), amountSheet = XLSX.utils.json_to_sheet(amounts); sheet["!cols"] = [{ wch: 35 }, { wch: 8 }, { wch: 18 }, { wch: 24 }, { wch: 90 }, { wch: 55 }]; amountSheet["!cols"] = [{ wch: 35 }, { wch: 8 }, { wch: 24 }, { wch: 30 }]; XLSX.utils.book_append_sheet(book, sheet, "Page Audit"); XLSX.utils.book_append_sheet(book, amountSheet, "Candidate Amounts"); XLSX.writeFile(book, `${active.name.replace(/\.pdf$/i, "")}-audit.xlsx`); }
    void exportLegacyExcel;
    async function exportExcel() {
        if (!active || active.status === "Processing")
            return;
        const XLSX = await import("xlsx");
        const rows = active.pages.map(p => ({ Document: active.name, Page: p.page, "Reading method": p.method, "Verification status": p.status === "read" ? "Read" : "Human review required", "Extracted text": p.text, "System message": p.message ?? "" }));
        const transactions = active.pages.filter(page => page.status === "read").flatMap(page => parseTransactions(page.text, page.page)).map(row => ({ Date: row.date, "Transaction ID": row.transactionId, Description: row.description, Debit: row.direction === "Dr" ? row.amount : null, Credit: row.direction === "Cr" ? row.amount : null, Balance: row.balance, "Balance direction": row.balanceDirection, "Source page": row.page }));
        const book = XLSX.utils.book_new(), auditSheet = XLSX.utils.json_to_sheet(rows), transactionSheet = XLSX.utils.json_to_sheet(transactions);
        auditSheet["!cols"] = [{ wch: 28 }, { wch: 8 }, { wch: 18 }, { wch: 24 }, { wch: 60 }, { wch: 45 }];
        transactionSheet["!cols"] = [{ wch: 12 }, { wch: 18 }, { wch: 55 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 12 }];
        XLSX.utils.book_append_sheet(book, auditSheet, "Page Audit");
        XLSX.utils.book_append_sheet(book, transactionSheet, "Transactions");
        XLSX.writeFile(book, `${active.name.replace(/\.pdf$/i, "")}-audit-and-transactions.xlsx`);
    }
    async function exportLastTable() {
        if (!active)
            return;
        const lastPrompt = [...messages].reverse().find(message => message.role === "user")?.text ?? "all transactions";
        const parsed = active.pages.filter(page => page.status === "read").flatMap(page => parseTransactions(page.text, page.page));
        const matching = filterTransactions(parsed, lastPrompt);
        if (matching.length) {
            const XLSX = await import("xlsx"), book = XLSX.utils.book_new(), sheet = XLSX.utils.json_to_sheet(matching.map(row => ({ Date: row.date, "Transaction ID": row.transactionId, Description: row.description, Debit: row.direction === "Dr" ? row.amount : null, Credit: row.direction === "Cr" ? row.amount : null, Balance: row.balance, "Balance direction": row.balanceDirection, "Source page": row.page })));
            sheet["!cols"] = [{ wch: 12 }, { wch: 18 }, { wch: 55 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 12 }];
            XLSX.utils.book_append_sheet(book, sheet, "Requested Transactions");
            XLSX.writeFile(book, `${active.name.replace(/\.pdf$/i, "")}-requested-transactions.xlsx`);
            return;
        }
        const answer = [...messages].reverse().find(message => message.role === "assistant" && /^\|.+\|/m.test(message.text));
        if (!answer)
            return;
        const lines = answer.text.split("\n").filter(line => /^\|.+\|$/.test(line.trim())), rows = lines.filter((line, index) => index !== 1 && !/^\|[\s:|-]+\|$/.test(line.trim())).map(line => line.split("|").slice(1, -1).map(cell => cell.trim()));
        if (rows.length < 2)
            return;
        const [headers, ...values] = rows, objects = values.map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]))), XLSX = await import("xlsx"), book = XLSX.utils.book_new(), sheet = XLSX.utils.json_to_sheet(objects);
        sheet["!cols"] = headers.map((header, index) => ({ wch: Math.min(45, Math.max(header.length + 2, ...values.map(row => (row[index] ?? "").length + 2))) }));
        XLSX.utils.book_append_sheet(book, sheet, "Requested Table");
        XLSX.writeFile(book, `${active.name.replace(/\.pdf$/i, "")}-requested-table.xlsx`);
    }
    function approveReviewedPages() { if (!active || !active.pages.some(page => page.status === "review"))
        return; if (!window.confirm("Confirm that the CA checked every flagged page against the original PDF and verified all critical totals."))
        return; const pages = active.pages.map(page => page.status === "review" ? { ...page, approved: true } : page), next = { ...active, pages, status: "Approved" as const }; updateDocument(active.id, next); persistDocument(next); }
    const hasChatTable = messages.some(message => message.role === "assistant" && /^\|.+\|/m.test(message.text));
    const progress = active?.totalPages ? Math.round(active.processedPages / active.totalPages * 100) : 0;
    if (showSplash)
        return <main className="splash"><div className="splashGlow"/><div className="splashSeal">AH</div><p>A HARISH CO</p><h1>Clarity for every page.</h1><span>Preparing your private document workspace</span><div className="loadingTrack"><i /></div><small>Documents deserve care. Numbers deserve certainty.</small></main>;
    return <main className="shell" ref={topRef}>
    <div className="scanControls"><div><strong>Reading mode</strong><span>Fast uses heavy OCR only for doubtful pages.</span></div><button className={scanMode === "fast" ? "active" : ""} onClick={() => setScanMode("fast")}>Fast scan</button><button className={scanMode === "maximum" ? "active" : ""} onClick={() => setScanMode("maximum")}>Maximum verification</button>{active?.status === "Processing" && <button onClick={() => setControl(active.id, "paused")}>Pause</button>}{active?.status === "Paused" && <button onClick={() => setControl(active.id, "running")}>Resume</button>}{active && ["Processing", "Paused"].includes(active.status) && <button className="danger" onClick={() => setControl(active.id, "cancelled")}>Cancel</button>}{active && ["Processing", "Paused"].includes(active.status) && <small>Remaining: {formatEta(active.etaSeconds)}</small>}{analysisProgress && <small>{analysisProgress}</small>}{hasChatTable && <button onClick={exportLastTable}>Table to Excel</button>}{active?.status === "Review" && <button onClick={approveReviewedPages}>CA approve reviewed pages</button>}{active && <button className="danger" onClick={() => deleteDocument(active.id)}>Delete PDF</button>}</div>
    {batchNotice && <div className="batchNotice" role="status">{batchNotice}<button onClick={() => setBatchNotice("")} aria-label="Dismiss notification">Close</button></div>}
    <aside className="sidebar"><div className="brand"><span className="brandMark">AH</span><div><strong>A Harish Co</strong><small>Chartered Accountants</small></div></div><nav aria-label="Workspace navigation"><button className="navItem active" onClick={() => scrollTo(topRef)}><span>⌂</span> Workspace</button><button className="navItem" onClick={() => scrollTo(documentsRef)}><span>▤</span> Documents <em>{documents.length}</em></button><button className="navItem" onClick={() => scrollTo(reviewRef)}><span>✓</span> Review queue <em>{totals.review}</em></button><button className="navItem" onClick={() => scrollTo(exportRef)}><span>⇩</span> Exports</button></nav><div className="sidebarMessage"><span>“</span><p>Good accounting begins with evidence you can trace.</p></div><div className="sidebarFoot"><div className="secure"><span>◆</span><div><strong>Local-first reading</strong><small>PDF reading stays in this browser</small></div></div><div className="profile"><span>AH</span><div><strong>A Harish Co</strong><small>Private workspace</small></div></div></div></aside>
    <section className="content"><header className="topbar"><div><p className="eyebrow">A HARISH CO · DOCUMENT INTELLIGENCE</p><h1>Every page, treated with care.</h1><p>Upload, review, ask questions and export a traceable page audit from one calm workspace.</p></div><button className="primary" onClick={() => inputRef.current?.click()}>＋ Add PDF</button><input ref={inputRef} type="file" accept="application/pdf" multiple hidden onChange={e => e.target.files && processFiles(e.target.files)}/></header>
      <div className="welcomeBanner"><div className="welcomeIcon">AH</div><div><strong>Welcome to your private document desk.</strong><p>Nothing unclear is silently accepted. Review flags remain visible before any professional decision.</p></div><span>Private workspace</span></div>
      <section className="metrics"><article><span>PDF pages</span><strong>{totals.pages}</strong><small>Received</small></article><article><span>Pages processed</span><strong>{totals.processed}</strong><small className="good">Tracked one by one</small></article><article><span>Needs review</span><strong>{totals.review}</strong><small className={totals.review ? "warn" : "good"}>{totals.review ? "Never guessed" : "Nothing flagged"}</small></article><article><span>Active progress</span><strong>{progress}%</strong><small>{active?.status ?? "Waiting for PDF"}</small></article></section>
      <section className="workspaceGrid"><div className="mainColumn"><div className={`dropzone ${isDragging ? "dragging" : ""}`} role="button" tabIndex={0} onKeyDown={e => { if (e.key === "Enter" || e.key === " ")
        inputRef.current?.click(); }} onDragOver={e => { e.preventDefault(); setIsDragging(true); }} onDragLeave={() => setIsDragging(false)} onDrop={e => { e.preventDefault(); setIsDragging(false); processFiles(e.dataTransfer.files); }} onClick={() => inputRef.current?.click()}><span className="uploadIcon">↑</span><div><strong>Bring a PDF into the workspace</strong><p>Digital or scanned · every processed page counted · OCR used when needed</p></div><button type="button">Browse files</button></div>
        <section className="panel anchorSection" ref={documentsRef}><div className="panelHead"><div><span className="sectionTag">DOCUMENT DESK</span><h2>Documents</h2><p>Each upload receives a permanent PDF number. Select one, use its filename, or ask about “PDF 1”.</p></div><button className="miniAction" onClick={() => inputRef.current?.click()}>Add another</button></div><div>{documents.length === 0 && <button className="emptyState" onClick={() => inputRef.current?.click()}><strong>No documents yet</strong><span>Choose a PDF to begin real page processing.</span></button>}{documents.map(doc => { const pct = doc.totalPages ? Math.round(doc.processedPages / doc.totalPages * 100) : 0; return <button key={doc.id} className={`documentRow ${active?.id === doc.id ? "selected" : ""}`} onClick={() => { setActiveId(doc.id); setMessages([welcome]); }}><span className="pdfIcon">{doc.uploadNumber}</span><span className="docInfo"><strong>PDF {doc.uploadNumber} · {doc.name}</strong><small>{doc.processedPages} of {doc.totalPages || "?"} pages · {doc.size}</small></span><span className="progressWrap"><span><i style={{ width: `${pct}%` }}/></span><small>{pct}%</small></span><span className={`status ${doc.status === "Ready" ? "verified" : doc.status === "Review" ? "review" : "processing"}`}>{doc.status}</span><span className="chevron">›</span></button>; })}</div></section>
        <section className="panel chatPanel"><div className="chatHead"><div><span className="botAvatar">A</span><div><span className="sectionTag">DOCUMENT ASSISTANT</span><h2>Ask A Harish Assistant</h2></div></div><span className="online"><i /> {active ? active.status : "Waiting"}</span></div><div className="chatMessages">{messages.map(m => <div key={m.id} className={`message ${m.role}`}><span>{m.role === "assistant" ? "AH" : "You"}</span>{m.role === "assistant" ? <AssistantContent text={m.text}/> : <p>{m.text}</p>}</div>)}{asking && <div className="message assistant"><span>AH</span><p className="typing"><i /><i /><i /></p></div>}<div ref={chatEndRef}/></div>{active?.pages.some(p => p.status === "review") && <div className="warningBanner"><strong>{active.pages.filter(p => p.status === "review").length} pages need review:</strong> {active.pages.filter(p => p.status === "review").map(p => p.page).join(", ")}. These pages are excluded from answers until the CA checks them.</div>}<div className="suggestions"><button onClick={() => askQuestion("Summarise this document with page references")}>Summarise with sources</button><button onClick={() => askQuestion("Create one clean table of the important entries, with a source page in every row")}>Create a table</button><button onClick={() => askQuestion("Identify possible inconsistencies without guessing")}>Find inconsistencies</button></div><div className="questionBox"><textarea aria-label="Ask a question about the PDF" value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={handleQuestionKey} placeholder={active ? "Ask anything about this PDF…" : "Upload and select a PDF first…"}/><button disabled={!active || asking || ["Processing", "Paused"].includes(active.status) || !question.trim()} onClick={() => askQuestion()} aria-label="Send question">Send</button></div><p className="chatNote">Answers use extracted evidence. Verify flagged pages and important totals before approval.</p></section>
      </div><aside className="rightColumn"><section className="panel"><div className="panelHead"><div><span className="sectionTag">CONTROLLED WORKFLOW</span><h2>Five careful stages</h2></div></div><div className="specialists">{specialists.map(([n, name, desc]) => <div className="specialist" key={n}><span>{n}</span><div><strong>{name}</strong><p>{desc}</p><small>✓ Evidence preserved</small></div></div>)}</div></section>
        <section className="panel anchorSection" ref={reviewRef}><div className="panelHead"><div><span className="sectionTag amber">REVIEW QUEUE</span><h2>{active ? `${active.pages.filter(p => p.status === "review").length} pages flagged` : "No document selected"}</h2><p>Uncertain values are never guessed or silently accepted.</p></div></div>{!active && <button className="reviewEmpty" onClick={() => inputRef.current?.click()}>Add a PDF to create a review queue</button>}{active?.pages.filter(p => p.status === "review").slice(0, 8).map(p => <div className="reviewItem" key={p.page}><span>PAGE {p.page}</span><strong>CA review required</strong><p>Open this page in the original PDF and verify its important values. It remains excluded from answers.</p></div>)}{active?.status === "Review" && <div className="reviewHelp"><strong>Want another automatic attempt?</strong><p>Select Maximum Verification above and upload the same PDF again. The CA must still check any page that remains flagged.</p></div>}{active && active.pages.every(p => p.status === "read") && active.status !== "Processing" && <div className="reviewItem complete"><span>COMPLETE</span><strong>All pages produced readable text</strong><p>Important values still need professional approval.</p></div>}</section>
        <section className={`exportCard anchorSection ${!active || active.status === "Processing" ? "disabled" : ""}`} ref={exportRef} role="button" tabIndex={active && active.status !== "Processing" ? 0 : -1} onClick={exportExcel} onKeyDown={e => { if (e.key === "Enter")
        exportExcel(); }}><div><span>EXCEL EXPORT STUDIO</span><h2>Page audit workbook</h2><p>Document, page, reading method, extracted text and every review message.</p></div><button disabled={!active || active.status === "Processing"} onClick={e => { e.stopPropagation(); exportExcel(); }}>{active ? "Download .xlsx" : "Select a PDF first"}</button></section>
      </aside></section>
    </section>
  </main>;
}
