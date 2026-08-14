# A Harish Co — private document workspace

This is a private, Netlify-ready Next.js application for reading PDFs, marking unreadable pages, asking DeepSeek questions with page citations, and exporting an Excel review workbook.

## What you need

1. A free private GitHub repository.
2. A Netlify account connected to GitHub.
3. A DeepSeek API key with credit.
4. One strong password that only Hari knows.

Do not paste either secret into any file in this folder.

## Deploy on Netlify

1. Upload this complete folder to a **private** GitHub repository.
2. In Netlify choose **Add new project → Import an existing project → GitHub**.
3. Select the private repository. Netlify reads `netlify.toml`; keep the shown build settings.
4. In **Project configuration → Environment variables**, add:
   - `DEEPSEEK_API_KEY` = the DeepSeek key
   - `APP_ACCESS_PASSWORD` = a new long private password
5. Deploy the project.
6. Open the Netlify address and sign in with `APP_ACCESS_PASSWORD`.

A custom domain is optional. The free `*.netlify.app` address works.

## Before selling or using real client records

- Test on Hari's actual phone, tablet, and computer.
- Use anonymized sample PDFs first: digital, scanned, faint, invoice, bank statement, GST, and a long PDF.
- Check every page shown in the page audit.
- Reconcile known totals manually.
- Confirm unreadable figures are marked for review and never guessed.
- Confirm answers cite the correct PDF pages.
- Confirm the Excel output against the source.

The “Candidate Amounts” sheet is a review aid, not finished accounting data. A CA must verify it against the PDF.

## Important limits

- A browser can slow down or run out of memory on hundreds of scanned/OCR pages, especially on a low-memory phone.
- DeepSeek charges by usage. A ₹600 balance may be enough for initial demonstrations or moderate use, but no fixed number of documents or questions can be guaranteed.
- Netlify's free plan has usage limits and can pause the site when they are reached.
- This password gate is suitable for a one-person private trial. It is not a substitute for enterprise identity management, audit logs, backups, or a professional security review.
- Never promise 100% accuracy for OCR, AI answers, tax, banking, or accounting work. The app deliberately marks uncertainty for human review.

## Local commands for a developer

```text
npm install
npm run build
npm start
```

The uploaded PDF is parsed and OCR-read in the user's browser. Relevant extracted text is sent to DeepSeek only when the user asks a question.

## Dual-OCR verification

- Scanned pages are read by Tesseract first and independently checked by PaddleOCR PP-OCRv5.
- Dates, amounts, debit/credit markers, and identifier-like values must strongly agree before the second engine can clear a doubtful page.
- A second enhanced Tesseract pass is used when the first readings disagree.
- The Excel Page Audit records which verification gate accepted each page.
- PaddleOCR is loaded from `esm.sh` on first scanned-PDF use and its model/runtime files are downloaded from the official package/CDN sources. An internet connection is therefore required for the second OCR engine. If it is unavailable, the app keeps the conservative Tesseract review behavior.

Dual OCR reduces risk but does not prove accounting accuracy. Hari must still review flagged pages and reconcile totals before filing or relying on the output.
