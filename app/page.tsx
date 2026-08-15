"use client";
import { KeyboardEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { GroupedTotal, formatCurrency, groupByHead, groupByNarration, groupedTotalsAnswer, hasReliableTransactionStructure, isTransactionRequest, parseTransactions, transactionAnswer, transactionConsistency } from "./transaction-utils";
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
    exportData?: { groups: GroupedTotal[]; title: string; documentName: string };
};
const specialists = [["01", "Page Guard", "Accounts for every page"], ["02", "Dual Local OCR", "Two engines read difficult scans"], ["03", "Financial Guard", "Checks critical values before acceptance"], ["04", "DeepSeek Analyst", "Answers only from PDF evidence"], ["05", "Total Reports", "Head-wise and narration-wise tables, computed from every page"]];
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
    const [showSplash, setShowSplash] = useState(true), [documents, setDocuments] = useState<DocumentResult[]>([]), [activeId, setActiveId] = useState<string | null>(null), [question, setQuestion] = useState(""), [messages, setMessages] = useState<ChatMessage[]>([welcome]), [asking, setAsking] = useState(false), [analysisProgress, setAnalysisProgress] = useState(""), [scanMode, setScanMode] = useState<ScanMode>("fast"), [batchNotice, setBatchNotice] = useState("");
    const inputRef = useRef<HTMLInputElement>(null), topRef = useRef<HTMLElement>(null), documentsRef = useRef<HTMLElement>(null), reviewRef = useRef<HTMLElement>(null), chatEndRef = useRef<HTMLDivElement>(null);
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
        new Notification("Harish Acharya & Co", { body: notice }); }
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
    // A stuck OCR call (a pathological image, a CDN hiccup for PaddleOCR, a dead
    // worker) must never block the whole document forever. Any page whose work
    // doesn't finish within this window is treated the same as a normal OCR
    // failure: sent to CA review, never silently skipped.
    const PAGE_TIMEOUT_MS = 45_000;
    function withPageTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
        return new Promise((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error(`${label} timed out`)), PAGE_TIMEOUT_MS);
            promise.then(value => { window.clearTimeout(timer); resolve(value); }, error => { window.clearTimeout(timer); reject(error); });
        });
    }
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

            // Several pages are OCR'd at once through their own Tesseract worker instead of
            // one page at a time. Pool size is kept small and capped by both CPU cores and
            // approximate device memory so this stays safe on modest laptops/phones.
            const nav = typeof navigator !== "undefined" ? navigator as Navigator & { deviceMemory?: number } : undefined;
            const cores = nav?.hardwareConcurrency ?? 4, memoryGb = nav?.deviceMemory ?? 8;
            const poolSize = Math.max(1, Math.min(3, Math.floor(cores / 2), Math.floor(memoryGb / 2)));
            const workerPool: Array<Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>> | null> = new Array(poolSize).fill(null);
            const freeSlots: number[] = Array.from({ length: poolSize }, (_, i) => i);
            async function getSlotWorker(slot: number) {
                if (!workerPool[slot]) {
                    const { createWorker } = await import("tesseract.js");
                    const created = await createWorker("eng");
                    await created.setParameters({ preserve_interword_spaces: "1" });
                    workerPool[slot] = created;
                }
                return workerPool[slot]!;
            }

            // PaddleOCR is a single shared engine (its own model session), so calls to it
            // are serialized through paddleChain even though Tesseract runs in parallel.
            const paddleState: { engine: PaddleEngine | null; unavailable: boolean; init: Promise<void> | null; chain: Promise<unknown> } = { engine: null, unavailable: false, init: null, chain: Promise.resolve() };
            function ensurePaddle() {
                if (paddleState.engine || paddleState.unavailable)
                    return Promise.resolve();
                if (!paddleState.init)
                    paddleState.init = withPageTimeout((async () => {
                        try {
                            const loadPaddle = new Function("return import('https://esm.sh/@paddleocr/paddleocr-js@0.4.2?bundle')") as () => Promise<{
                                PaddleOCR: {
                                    create: (options: Record<string, unknown>) => Promise<PaddleEngine>;
                                };
                            }>, { PaddleOCR } = await loadPaddle();
                            paddleState.engine = await PaddleOCR.create({ lang: "en", ocrVersion: "PP-OCRv5", worker: true, textRecognitionBatchSize: 6, ortOptions: { backend: "wasm", wasmPaths: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/", numThreads: 2, simd: true } });
                        }
                        catch {
                            paddleState.unavailable = true;
                        }
                    })(), "PaddleOCR init").catch(() => { paddleState.unavailable = true; });
                return paddleState.init;
            }
            async function runPaddle(canvas: HTMLCanvasElement) {
                await ensurePaddle();
                if (!paddleState.engine)
                    return { text: "", confidence: 0 };
                const task = paddleState.chain.then(async () => {
                    const engine = paddleState.engine;
                    if (!engine)
                        return { text: "", confidence: 0 };
                    try {
                        const [paddleResult] = await withPageTimeout(engine.predict(canvas), "PaddleOCR predict");
                        return normalizePaddleResult(paddleResult?.items ?? []);
                    }
                    catch {
                        paddleState.unavailable = true;
                        paddleState.engine = null;
                        await engine.dispose().catch(() => undefined);
                        return { text: "", confidence: 0 };
                    }
                });
                paddleState.chain = task.then(() => undefined, () => undefined);
                return task;
            }

            // Completed pages land here (possibly out of order); emit() only advances the
            // persisted/visible results by the longest unbroken prefix from page 1, so resume
            // and the final missing-page check never see a gap.
            const resultsMap = new Map<number, PageResult>();
            (resumable?.pages ?? []).forEach(p => resultsMap.set(p.page, p));
            const results: PageResult[] = [...(resumable?.pages ?? [])];
            let emittedThrough = results.length, lastPersisted = emittedThrough;
            function emit() {
                let advanced = false;
                while (resultsMap.has(emittedThrough + 1)) {
                    results.push(resultsMap.get(emittedThrough + 1)!);
                    emittedThrough++;
                    advanced = true;
                }
                if (!advanced)
                    return;
                const elapsed = (Date.now() - (initial.startedAt ?? Date.now())) / 1000, completedThisRun = Math.max(1, emittedThrough - (resumable?.processedPages ?? 0)), eta = (elapsed / completedThisRun) * (pdf.numPages - emittedThrough);
                const snapshot = { ...initial, pages: [...results], totalPages: pdf.numPages, processedPages: emittedThrough, status: "Processing" as const, etaSeconds: eta };
                updateDocument(id, snapshot);
                if (emittedThrough - lastPersisted >= 5 || emittedThrough === pdf.numPages) {
                    persistDocument(snapshot);
                    lastPersisted = emittedThrough;
                }
            }

            async function readPage(n: number, slot: number) {
                const page = await pdf.getPage(n), content = await page.getTextContent(), embedded = content.items.map(item => "str" in item ? item.str : "").join(" ").replace(/\s+/g, " ").trim();
                let result: PageResult;
                if (embedded.length >= 20) {
                    result = { page: n, text: embedded, method: "embedded text", status: "read", verification: "Source text layer" };
                }
                else {
                    try {
                        result = await withPageTimeout((async (): Promise<PageResult> => {
                            const worker = await getSlotWorker(slot);
                            const firstScale = initial.mode === "fast" ? 1.7 : 2.2, firstCanvas = await renderOcrCanvas(page, firstScale, false), first = await worker.recognize(firstCanvas), firstText = cleanOcrText(first.data.text);
                            const sanity = financialSanity(firstText), structured = hasReliableTransactionStructure(firstText), firstConsistency = transactionConsistency(firstText), fastAccepted = firstText.length >= 20 && sanity.passed && (initial.mode === "fast" ? (first.data.confidence >= 72 || (structured && first.data.confidence >= 45 && firstConsistency >= .97)) : first.data.confidence >= 88);
                            if (fastAccepted) {
                                firstCanvas.width = 0;
                                firstCanvas.height = 0;
                                return { page: n, text: firstText, method: "OCR", status: "read", verification: `Fast OCR confidence ${Math.round(first.data.confidence)}%; ${sanity.checked} financial values checked` };
                            }
                            const paddleOutcome = await runPaddle(firstCanvas), paddleText = paddleOutcome.text, paddleConfidence = paddleOutcome.confidence;
                            const crossAgreement = tokenAgreement(firstText, paddleText), dualAccepted = firstText.length >= 20 && paddleText.length >= 20 && first.data.confidence >= 58 && paddleConfidence >= 72 && crossAgreement >= (initial.mode === "fast" ? .91 : .96) && sanity.passed;
                            firstCanvas.width = 0;
                            firstCanvas.height = 0;
                            if (dualAccepted)
                                return { page: n, text: firstText, method: "OCR", status: "read", verification: `Dual OCR agreement ${Math.round(crossAgreement * 100)}%; ${sanity.checked} financial values checked` };
                            await worker.setParameters({ tessedit_pageseg_mode: "6" as never, preserve_interword_spaces: "1" });
                            const enhancedCanvas = await renderOcrCanvas(page, initial.mode === "fast" ? 2.1 : 2.6, true), second = await worker.recognize(enhancedCanvas);
                            enhancedCanvas.width = 0;
                            enhancedCanvas.height = 0;
                            const secondText = cleanOcrText(second.data.text), retryAgreement = tokenAgreement(firstText, secondText), paddleRetryAgreement = Math.max(tokenAgreement(firstText, paddleText), tokenAgreement(secondText, paddleText)), secondConsistency = transactionConsistency(secondText), preferSecond = secondConsistency > firstConsistency || (secondConsistency === firstConsistency && second.data.confidence >= first.data.confidence), best = preferSecond ? second : first, bestText = cleanOcrText(best.data.text), bestSanity = financialSanity(bestText), bestStructured = hasReliableTransactionStructure(bestText), bestConsistency = Math.max(firstConsistency, secondConsistency), legacyAccepted = firstText.length >= 20 && first.data.confidence >= 62 && (!structured || firstConsistency >= .97), retryAccepted = bestText.length >= 20 && ((bestStructured && bestConsistency >= .97 && Math.max(first.data.confidence, second.data.confidence) >= 40) || (Math.max(first.data.confidence, second.data.confidence) >= 55 && retryAgreement >= (bestStructured ? .82 : .9))), verifiedRetry = paddleText.length >= 20 && paddleConfidence >= 68 && paddleRetryAgreement >= .82 && bestSanity.passed, accepted = legacyAccepted || retryAccepted || verifiedRetry;
                            return accepted ? { page: n, text: bestText, method: "OCR", status: "read", verification: verifiedRetry ? `Dual OCR retry agreement ${Math.round(paddleRetryAgreement * 100)}%; ${bestSanity.checked} financial values checked` : legacyAccepted ? "Tesseract confidence gate" : "Tesseract retry agreement" } : { page: n, text: bestText, method: "unreadable", status: "review", verification: paddleState.unavailable ? "Second OCR unavailable; conservative review" : "OCR engines did not agree on critical values", message: `Sorry, I could not verify the financial values on page ${n}. Please review this page.` };
                        })(), `Page ${n} OCR`);
                    }
                    catch {
                        // A slot's worker that hung or errored is not trusted again — replace it
                        // so a single bad page can never jam every future page routed to this slot.
                        const badWorker = workerPool[slot];
                        workerPool[slot] = null;
                        if (badWorker)
                            badWorker.terminate().catch(() => undefined);
                        result = { page: n, text: "", method: "unreadable", status: "review", message: `Sorry, I could not clearly read page ${n}. Please review this page.` };
                    }
                }
                page.cleanup();
                resultsMap.set(n, result);
                emit();
            }

            let cursor = results.length + 1, firstError: unknown = null;
            const inFlight = new Map<number, Promise<void>>();
            while ((cursor <= pdf.numPages || inFlight.size) && !firstError) {
                if (!await waitWhilePaused(id))
                    break;
                while (inFlight.size < poolSize && cursor <= pdf.numPages && freeSlots.length && !firstError) {
                    const n = cursor++, slot = freeSlots.pop()!;
                    const task = readPage(n, slot).catch(err => { firstError = firstError ?? err; }).finally(() => { inFlight.delete(n); freeSlots.push(slot); });
                    inFlight.set(n, task);
                }
                if (!inFlight.size)
                    break;
                await Promise.race(inFlight.values());
            }
            await Promise.allSettled(inFlight.values());
            for (const worker of workerPool)
                await worker?.terminate();
            await paddleState.engine?.dispose();
            if (firstError)
                throw firstError;
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
    function explicitlyReferencedPages(prompt: string) { const lower = prompt.toLowerCase(), pages = new Set<number>(); for (const match of lower.matchAll(/\b(?:page|pg\.?|p\.)\s*#?\s*(\d{1,4})\b/g))
        pages.add(Number(match[1])); const ordinals: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 }; for (const [word, n] of Object.entries(ordinals))
        if (new RegExp(`\\b${word}\\s+page\\b`).test(lower))
            pages.add(n); return pages; }
    function relevantPages(prompt: string, document = active) { if (!document)
        return []; const readable = document.pages.filter(p => p.status === "read" && p.text.trim()); if (isWholeDocumentQuestion(prompt))
        return readable;
    // A question can name a specific page ("what is on page 2", "the second page")
    // that the keyword scoring below has no way to match against page content. Any
    // such page, if it was actually read, is guaranteed to be included below rather
    // than risk a false "could not read" answer for a page that reads fine.
    const explicitPages = explicitlyReferencedPages(prompt), explicitMatches = readable.filter(p => explicitPages.has(p.page));
    const lower = prompt.toLowerCase(), stop = new Set(["show", "give", "make", "from", "with", "that", "this", "details", "detail", "transaction", "transactions", "entry", "entries", "table", "please", "payment", "payments", "total", "today"]), terms = (lower.match(/[a-z0-9]{3,}/g) ?? []).filter(term => !stop.has(term)), months: Record<string, string> = { january: "01", february: "02", march: "03", april: "04", may: "05", june: "06", july: "07", august: "08", september: "09", october: "10", november: "11", december: "12" }, month = Object.keys(months).find(name => lower.includes(name)), monthNumber = month ? months[month] : undefined, today = lower.includes("today") ? new Date().toISOString().slice(0, 10) : undefined, ranked = readable.map(p => { const text = p.text.toLowerCase(), termScore = terms.reduce((score, term) => score + (text.includes(term) ? 3 : 0), 0), monthScore = month && monthNumber && (text.includes(month) || new RegExp(`\\b\\d{1,2}[-/.]${monthNumber}[-/.]\\d{2,4}\\b`).test(text) || new RegExp(`\\b\\d{1,2}[-/.](?:${month.slice(0, 3)})[-/.]\\d{2,4}\\b`, "i").test(text)) ? 20 : 0, todayScore = today && (text.includes(today) || text.includes(today.split("-").reverse().join("-")) || text.includes(today.split("-").reverse().join("/"))) ? 20 : 0; return { p, score: termScore + monthScore + todayScore }; }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    if (ranked.length || explicitMatches.length) { const merged = ranked.map(item => item.p); for (const p of explicitMatches)
        if (!merged.includes(p))
            merged.push(p); return merged.sort((a, b) => a.page - b.page); }
    // Never silently restrict an unclassified question to the beginning of a
    // document. evidenceBatches() already keeps each API request small, so all
    // readable pages can be checked without losing the later pages.
    return readable; }
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
            setMessages(c => [...c, { id: `${Date.now()}-a`, role: "assistant", text: `Document: ${document.name}\n\n${answer}` }]);
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
    function approveReviewedPages() { if (!active || !active.pages.some(page => page.status === "review"))
        return; if (!window.confirm("Confirm that the CA checked every flagged page against the original PDF and verified all critical totals."))
        return; const pages = active.pages.map(page => page.status === "review" ? { ...page, approved: true } : page), next = { ...active, pages, status: "Approved" as const }; updateDocument(active.id, next); persistDocument(next); }
    // Head-wise and narration-wise totals are computed entirely client-side from the
    // already-extracted, already-verified page text (the same parseTransactions() rows
    // used for date/total answers elsewhere) — no DeepSeek call, so coverage can never
    // depend on page-relevance filtering or batching: every read page is always included.
    function groupedTotalsMessage(kind: "head" | "narration") {
        if (!active || ["Processing", "Paused"].includes(active.status))
            return;
        const unreadable = active.pages.filter(p => p.status === "review").map(p => p.page);
        const parsed = active.pages.filter(page => page.status === "read").flatMap(page => parseTransactions(page.text, page.page));
        const groups = kind === "head" ? groupByHead(parsed) : groupByNarration(parsed);
        const title = kind === "head" ? "Head / Party" : "Narration";
        const answer = groupedTotalsAnswer(groups, title, unreadable);
        const label = kind === "head" ? "Head-wise total" : "Narration-wise total";
        setMessages(c => [...c, { id: `${Date.now()}-u`, role: "user", text: label }, { id: `${Date.now()}-a`, role: "assistant", text: `Document: ${active.name}\n\n${answer}`, exportData: { groups, title, documentName: active.name } }]);
    }
    function downloadCanvas(canvas: HTMLCanvasElement, filename: string) {
        canvas.toBlob(blob => {
            if (!blob)
                return;
            const url = URL.createObjectURL(blob), link = document.createElement("a");
            link.href = url;
            link.download = filename;
            link.click();
            URL.revokeObjectURL(url);
        }, "image/png");
    }
    function fitText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
        if (context.measureText(text).width <= maxWidth)
            return text;
        let low = 0, high = text.length;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (context.measureText(`${text.slice(0, mid)}…`).width <= maxWidth)
                low = mid;
            else
                high = mid - 1;
        }
        return `${text.slice(0, low)}…`;
    }
    function exportGroupedImage(groups: GroupedTotal[], title: string, documentName: string) {
        if (!groups.length)
            return;
        const scale = 2, width = 900 * scale, rowHeight = 46 * scale, headerHeight = 92 * scale, colHeadHeight = 42 * scale, footerHeight = 56 * scale;
        const height = headerHeight + colHeadHeight + groups.length * rowHeight + rowHeight + footerHeight;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx)
            return;
        const colors = { bg: "#0b1220", headBg: "#101c30", line: "#1f2b40", text: "#e7ecf3", muted: "#8a97ab", gold: "#d5b06c", green: "#3ecf8e", red: "#f2685c", rowAlt: "#0e1728" };
        ctx.fillStyle = colors.bg;
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = colors.text;
        ctx.font = `700 ${26 * scale}px Georgia, serif`;
        ctx.textBaseline = "alphabetic";
        ctx.fillText(`${title} Report`, 26 * scale, 40 * scale);
        ctx.fillStyle = colors.muted;
        ctx.font = `${13 * scale}px Inter, sans-serif`;
        ctx.fillText(`${documentName} · Harish Acharya & Co · ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" })}`, 26 * scale, 62 * scale);
        ctx.strokeStyle = colors.gold;
        ctx.lineWidth = 2 * scale;
        ctx.beginPath();
        ctx.moveTo(26 * scale, 74 * scale);
        ctx.lineTo(width - 26 * scale, 74 * scale);
        ctx.stroke();
        const labelX = 26 * scale, labelMaxWidth = width * 0.46 - labelX - 10 * scale, debitX = width * 0.63, creditX = width * 0.81, netX = width - 26 * scale;
        let y = headerHeight;
        ctx.fillStyle = colors.headBg;
        ctx.fillRect(0, y, width, colHeadHeight);
        ctx.fillStyle = colors.muted;
        ctx.font = `700 ${13 * scale}px Inter, sans-serif`;
        ctx.textAlign = "left";
        ctx.fillText(title.toUpperCase(), labelX, y + colHeadHeight / 2 + 5 * scale);
        ctx.textAlign = "right";
        ctx.fillText("DEBIT ₹", debitX, y + colHeadHeight / 2 + 5 * scale);
        ctx.fillText("CREDIT ₹", creditX, y + colHeadHeight / 2 + 5 * scale);
        ctx.fillText("NET ₹", netX, y + colHeadHeight / 2 + 5 * scale);
        y += colHeadHeight;
        groups.forEach((g, i) => {
            if (i % 2 === 1) {
                ctx.fillStyle = colors.rowAlt;
                ctx.fillRect(0, y, width, rowHeight);
            }
            ctx.fillStyle = colors.text;
            ctx.font = `${14 * scale}px Inter, sans-serif`;
            ctx.textAlign = "left";
            ctx.fillText(fitText(ctx, g.key, labelMaxWidth), labelX, y + rowHeight / 2 + 5 * scale);
            ctx.textAlign = "right";
            ctx.fillStyle = colors.muted;
            ctx.fillText(g.debit ? formatCurrency(g.debit) : "—", debitX, y + rowHeight / 2 + 5 * scale);
            ctx.fillText(g.credit ? formatCurrency(g.credit) : "—", creditX, y + rowHeight / 2 + 5 * scale);
            ctx.fillStyle = g.net >= 0 ? colors.green : colors.red;
            ctx.font = `700 ${14 * scale}px Inter, sans-serif`;
            ctx.fillText(`${g.net >= 0 ? "+" : "-"}${formatCurrency(Math.abs(g.net))}`, netX, y + rowHeight / 2 + 5 * scale);
            y += rowHeight;
        });
        const totalDebit = groups.reduce((s, g) => s + g.debit, 0), totalCredit = groups.reduce((s, g) => s + g.credit, 0), totalNet = totalCredit - totalDebit;
        ctx.strokeStyle = colors.gold;
        ctx.lineWidth = 1.5 * scale;
        ctx.beginPath();
        ctx.moveTo(labelX, y);
        ctx.lineTo(width - labelX, y);
        ctx.stroke();
        ctx.font = `700 ${15 * scale}px Inter, sans-serif`;
        ctx.textAlign = "left";
        ctx.fillStyle = colors.text;
        ctx.fillText("TOTAL", labelX, y + rowHeight / 2 + 5 * scale);
        ctx.textAlign = "right";
        ctx.fillText(formatCurrency(totalDebit), debitX, y + rowHeight / 2 + 5 * scale);
        ctx.fillText(formatCurrency(totalCredit), creditX, y + rowHeight / 2 + 5 * scale);
        ctx.fillStyle = totalNet >= 0 ? colors.green : colors.red;
        ctx.fillText(`${totalNet >= 0 ? "+" : "-"}${formatCurrency(Math.abs(totalNet))}`, netX, y + rowHeight / 2 + 5 * scale);
        y += rowHeight;
        ctx.fillStyle = colors.muted;
        ctx.font = `${11 * scale}px Inter, sans-serif`;
        ctx.textAlign = "left";
        ctx.fillText("Computed locally from every readable page. This is a review aid — verify against the source PDF.", labelX, y + 24 * scale);
        downloadCanvas(canvas, `${documentName.replace(/\.pdf$/i, "")}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-report.png`);
    }
    function exportGroupedChart(groups: GroupedTotal[], title: string, documentName: string) {
        if (!groups.length)
            return;
        const shown = groups.slice(0, 12), truncated = groups.length > shown.length;
        const scale = 2, width = 1000 * scale, rowHeight = 50 * scale, headerHeight = 92 * scale, footerHeight = truncated ? 70 * scale : 50 * scale;
        const height = headerHeight + shown.length * rowHeight + footerHeight;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx)
            return;
        const colors = { bg: "#0b1220", text: "#e7ecf3", muted: "#8a97ab", gold: "#d5b06c", green: "#3ecf8e", red: "#f2685c", zero: "#33415a" };
        ctx.fillStyle = colors.bg;
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = colors.text;
        ctx.font = `700 ${26 * scale}px Georgia, serif`;
        ctx.textAlign = "left";
        ctx.fillText(`${title} — Net by ${title.split(" ")[0]}`, 26 * scale, 40 * scale);
        ctx.fillStyle = colors.muted;
        ctx.font = `${13 * scale}px Inter, sans-serif`;
        ctx.fillText(`${documentName} · Harish Acharya & Co · ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" })}`, 26 * scale, 62 * scale);
        ctx.strokeStyle = colors.gold;
        ctx.lineWidth = 2 * scale;
        ctx.beginPath();
        ctx.moveTo(26 * scale, 74 * scale);
        ctx.lineTo(width - 26 * scale, 74 * scale);
        ctx.stroke();
        const labelColW = 250 * scale, valueColW = 160 * scale, barAreaX0 = 26 * scale + labelColW, barAreaX1 = width - 26 * scale - valueColW, barCenter = barAreaX0 + (barAreaX1 - barAreaX0) * 0.5, barHalfWidth = Math.min(barCenter - barAreaX0, barAreaX1 - barCenter);
        const maxAbs = Math.max(...shown.map(g => Math.abs(g.net)), 1);
        ctx.strokeStyle = colors.zero;
        ctx.lineWidth = 1 * scale;
        ctx.beginPath();
        ctx.moveTo(barCenter, headerHeight);
        ctx.lineTo(barCenter, headerHeight + shown.length * rowHeight);
        ctx.stroke();
        let y = headerHeight;
        shown.forEach(g => {
            const barLen = (Math.abs(g.net) / maxAbs) * (barHalfWidth - 8 * scale), positive = g.net >= 0, barY = y + rowHeight * 0.32, barH = rowHeight * 0.36;
            ctx.fillStyle = colors.text;
            ctx.font = `${13 * scale}px Inter, sans-serif`;
            ctx.textAlign = "left";
            ctx.fillText(fitText(ctx, g.key, labelColW - 14 * scale), 26 * scale, y + rowHeight / 2 + 5 * scale);
            ctx.fillStyle = positive ? colors.green : colors.red;
            ctx.fillRect(positive ? barCenter : barCenter - barLen, barY, barLen, barH);
            ctx.font = `700 ${13 * scale}px Inter, sans-serif`;
            ctx.textAlign = "right";
            ctx.fillText(`${positive ? "+" : "-"}${formatCurrency(Math.abs(g.net))}`, width - 26 * scale, y + rowHeight / 2 + 5 * scale);
            y += rowHeight;
        });
        ctx.fillStyle = colors.muted;
        ctx.font = `${11 * scale}px Inter, sans-serif`;
        ctx.textAlign = "left";
        let footY = y + 24 * scale;
        if (truncated) {
            ctx.fillText(`Showing the ${shown.length} largest of ${groups.length} rows by size — export the table view above for every row.`, 26 * scale, footY);
            footY += 18 * scale;
        }
        ctx.fillText("Computed locally from every readable page. This is a review aid — verify against the source PDF.", 26 * scale, footY);
        downloadCanvas(canvas, `${documentName.replace(/\.pdf$/i, "")}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-chart.png`);
    }
    const progress = active?.totalPages ? Math.round(active.processedPages / active.totalPages * 100) : 0;
    if (showSplash)
        return <main className="splash"><div className="splashGlow"/><div className="splashSeal">HA</div><p>HARISH ACHARYA & CO</p><h1>Clarity for every page.</h1><span>Preparing your private document workspace</span><div className="loadingTrack"><i /></div><small>Documents deserve care. Numbers deserve certainty.</small></main>;
    return <main className="shell" ref={topRef}>
    {batchNotice && <div className="batchNotice" role="status">{batchNotice}<button onClick={() => setBatchNotice("")} aria-label="Dismiss notification">Close</button></div>}
    <aside className="sidebar"><div className="brand"><span className="brandMark">HA</span><div><strong>Harish Acharya &amp; Co</strong><small>Chartered Accountants</small></div></div><nav aria-label="Workspace navigation"><button className="navItem active" onClick={() => scrollTo(topRef)}><span>⌂</span> Workspace</button><button className="navItem" onClick={() => scrollTo(documentsRef)}><span>▤</span> Documents <em>{documents.length}</em></button><button className="navItem" onClick={() => scrollTo(reviewRef)}><span>✓</span> Review queue <em>{totals.review}</em></button></nav><div className="sidebarMessage"><span>“</span><p>Good accounting begins with evidence you can trace.</p></div><div className="sidebarFoot"><div className="secure"><span>◆</span><div><strong>Local-first reading</strong><small>PDF reading stays in this browser</small></div></div><div className="profile"><span>HA</span><div><strong>Harish Acharya &amp; Co</strong><small>Private workspace</small></div></div></div></aside>
    <section className="content">
    <div className="scanControls"><div><strong>Reading mode</strong><span>Fast uses heavy OCR only for doubtful pages.</span></div><button className={scanMode === "fast" ? "active" : ""} onClick={() => setScanMode("fast")}>Fast scan</button><button className={scanMode === "maximum" ? "active" : ""} onClick={() => setScanMode("maximum")}>Maximum verification</button>{active?.status === "Processing" && <button onClick={() => setControl(active.id, "paused")}>Pause</button>}{active?.status === "Paused" && <button onClick={() => setControl(active.id, "running")}>Resume</button>}{active && ["Processing", "Paused"].includes(active.status) && <button className="danger" onClick={() => setControl(active.id, "cancelled")}>Cancel</button>}{active && ["Processing", "Paused"].includes(active.status) && <small>Remaining: {formatEta(active.etaSeconds)}</small>}{analysisProgress && <small>{analysisProgress}</small>}{active?.status === "Review" && <button onClick={approveReviewedPages}>CA approve reviewed pages</button>}{active && <button className="danger" onClick={() => deleteDocument(active.id)}>Delete PDF</button>}</div>
    <header className="topbar"><div><p className="eyebrow">HARISH ACHARYA &amp; CO · DOCUMENT INTELLIGENCE</p></div><button className="primary" onClick={() => inputRef.current?.click()}>＋ Add PDF</button><input ref={inputRef} type="file" accept="application/pdf" multiple hidden onChange={e => e.target.files && processFiles(e.target.files)}/></header>
      <section className="metrics"><article><span>PDF pages</span><strong>{totals.pages}</strong><small>Received</small></article><article><span>Pages processed</span><strong>{totals.processed}</strong><small className="good">Tracked one by one</small></article><article><span>Needs review</span><strong>{totals.review}</strong><small className={totals.review ? "warn" : "good"}>{totals.review ? "Never guessed" : "Nothing flagged"}</small></article><article><span>Active progress</span><strong>{progress}%</strong><small>{active?.status ?? "Waiting for PDF"}</small></article></section>
      <section className="workspaceGrid"><div className="mainColumn">
        <section className="panel anchorSection" ref={documentsRef}><div className="panelHead"><div><span className="sectionTag">DOCUMENT DESK</span><h2>Documents</h2><p>Each upload receives a permanent PDF number. Select one, use its filename, or ask about “PDF 1”.</p></div><button className="miniAction" onClick={() => inputRef.current?.click()}>Add another</button></div><div>{documents.length === 0 && <button className="emptyState" onClick={() => inputRef.current?.click()}><strong>No documents yet</strong><span>Choose a PDF to begin real page processing.</span></button>}{documents.map(doc => { const pct = doc.totalPages ? Math.round(doc.processedPages / doc.totalPages * 100) : 0; return <button key={doc.id} className={`documentRow ${active?.id === doc.id ? "selected" : ""}`} onClick={() => { setActiveId(doc.id); setMessages([welcome]); }}><span className="pdfIcon">{doc.uploadNumber}</span><span className="docInfo"><strong>PDF {doc.uploadNumber} · {doc.name}</strong><small>{doc.processedPages} of {doc.totalPages || "?"} pages · {doc.size}</small></span><span className="progressWrap"><span><i style={{ width: `${pct}%` }}/></span><small>{pct}%</small></span><span className={`status ${doc.status === "Ready" ? "verified" : doc.status === "Review" ? "review" : "processing"}`}>{doc.status}</span><span className="chevron">›</span></button>; })}</div></section>
        <section className="panel chatPanel"><div className="chatHead"><div><span className="botAvatar">HA</span><div><span className="sectionTag">DOCUMENT ASSISTANT</span><h2>Ask Harish Acharya Assistant</h2></div></div><span className="online"><i /> {active ? active.status : "Waiting"}</span></div><div className="chatMessages">{messages.map(m => <div key={m.id} className={`message ${m.role}`}><span>{m.role === "assistant" ? "HA" : "You"}</span><div>{m.role === "assistant" ? <AssistantContent text={m.text}/> : <p>{m.text}</p>}{m.exportData && <div className="exportRow"><button onClick={() => exportGroupedImage(m.exportData!.groups, m.exportData!.title, m.exportData!.documentName)}>⬇ Save as image</button><button onClick={() => exportGroupedChart(m.exportData!.groups, m.exportData!.title, m.exportData!.documentName)}>⬇ Save as chart</button></div>}</div></div>)}{asking && <div className="message assistant"><span>HA</span><p className="typing"><i /><i /><i /></p></div>}<div ref={chatEndRef}/></div>{active?.pages.some(p => p.status === "review") && <div className="warningBanner"><strong>{active.pages.filter(p => p.status === "review").length} pages need review:</strong> {active.pages.filter(p => p.status === "review").map(p => p.page).join(", ")}. These pages are excluded from answers until the CA checks them.</div>}<div className="suggestions"><button onClick={() => askQuestion("Summarise this document with page references")}>Summarise with sources</button><button onClick={() => askQuestion("Create one clean table of the important entries, with a source page in every row")}>Create a table</button><button onClick={() => askQuestion("Identify possible inconsistencies without guessing")}>Find inconsistencies</button><button disabled={!active || ["Processing", "Paused"].includes(active.status)} onClick={() => groupedTotalsMessage("head")}>Head-wise total</button><button disabled={!active || ["Processing", "Paused"].includes(active.status)} onClick={() => groupedTotalsMessage("narration")}>Narration-wise total</button></div><div className="questionBox"><textarea aria-label="Ask a question about the PDF" value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={handleQuestionKey} placeholder={active ? "Ask anything about this PDF…" : "Upload and select a PDF first…"}/><button disabled={!active || asking || ["Processing", "Paused"].includes(active.status) || !question.trim()} onClick={() => askQuestion()} aria-label="Send question">Send</button></div><p className="chatNote">Answers use extracted evidence. Verify flagged pages and important totals before approval.</p></section>
      </div><aside className="rightColumn"><section className="panel"><div className="panelHead"><div><span className="sectionTag">CONTROLLED WORKFLOW</span><h2>Five careful stages</h2></div></div><div className="specialists">{specialists.map(([n, name, desc]) => <div className="specialist" key={n}><span>{n}</span><div><strong>{name}</strong><p>{desc}</p><small>✓ Evidence preserved</small></div></div>)}</div></section>
        <section className="panel anchorSection" ref={reviewRef}><div className="panelHead"><div><span className="sectionTag amber">REVIEW QUEUE</span><h2>{active ? `${active.pages.filter(p => p.status === "review").length} pages flagged` : "No document selected"}</h2><p>Uncertain values are never guessed or silently accepted.</p></div></div>{!active && <button className="reviewEmpty" onClick={() => inputRef.current?.click()}>Add a PDF to create a review queue</button>}{active?.pages.filter(p => p.status === "review").slice(0, 8).map(p => <div className="reviewItem" key={p.page}><span>PAGE {p.page}</span><strong>CA review required</strong><p>Open this page in the original PDF and verify its important values. It remains excluded from answers.</p></div>)}{active?.status === "Review" && <div className="reviewHelp"><strong>Want another automatic attempt?</strong><p>Select Maximum Verification above and upload the same PDF again. The CA must still check any page that remains flagged.</p></div>}{active && active.pages.every(p => p.status === "read") && active.status !== "Processing" && <div className="reviewItem complete"><span>COMPLETE</span><strong>All pages produced readable text</strong><p>Important values still need professional approval.</p></div>}</section>
      </aside></section>
    </section>
  </main>;
}
