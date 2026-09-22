import { extname } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import * as XLSX from "xlsx";
import { AppError } from "../errors.js";

export interface ExtractedText {
  text: string;
  extractor: string;
}

const DEFAULT_EXTRACTION_TIMEOUT_MS = 30_000;

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs = DEFAULT_EXTRACTION_TIMEOUT_MS
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new AppError(
              "EXTRACTION_TIMEOUT",
              `Attachment extraction exceeded ${timeoutMs} ms`
            )
          );
        }, timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function wrapExtractionError(error: unknown, message: string): AppError {
  if (
    error instanceof AppError &&
    (error.code === "EXTRACTION_TIMEOUT" ||
      error.code === "ATTACHMENT_TOO_LARGE")
  ) {
    return error;
  }

  return new AppError("UNSUPPORTED_ATTACHMENT", message, {
    cause: error
  });
}

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".csv",
  ".tsv",
  ".json",
  ".xml",
  ".html",
  ".htm",
  ".md",
  ".log",
  ".eml"
]);

const TEXT_CONTENT_TYPES = [
  "text/",
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/csv"
];

const SPREADSHEET_EXTENSIONS = new Set([".xlsx", ".xls", ".ods"]);
const PRESENTATION_EXTENSIONS = new Set([".pptx"]);
const MAX_PPTX_XML_BYTES = 16 * 1024 * 1024;
const MAX_SPREADSHEET_ROWS = 100_000;

function canTreatAsText(filename: string, contentType: string): boolean {
  return (
    TEXT_EXTENSIONS.has(extname(filename).toLowerCase()) ||
    TEXT_CONTENT_TYPES.some((prefix) => contentType.toLowerCase().startsWith(prefix))
  );
}

export async function extractAttachmentText(
  content: Buffer,
  filename: string,
  contentType: string
): Promise<ExtractedText> {
  const normalizedType = contentType.toLowerCase();
  const extension = extname(filename).toLowerCase();

  if (
    PRESENTATION_EXTENSIONS.has(extension) ||
    normalizedType ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    try {
      const sections = await withTimeout(extractPresentationText(content));
      return {
        text: sections,
        extractor: "pptx"
      };
    } catch (error) {
      throw wrapExtractionError(error, "Unable to extract text from PPTX");
    }
  }

  if (
    SPREADSHEET_EXTENSIONS.has(extension) ||
    normalizedType.includes("spreadsheet") ||
    normalizedType === "application/vnd.ms-excel"
  ) {
    try {
      const workbook = XLSX.read(content, {
        type: "buffer",
        sheetRows: MAX_SPREADSHEET_ROWS
      });
      const sections = workbook.SheetNames.map((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        const values = sheet ? XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 }) : [];
        const rows = values
          .map((row) =>
            row
              .map((value) => (value === null || value === undefined ? "" : String(value)))
              .join("\t")
          )
          .filter((row) => row.trim().length > 0);
        return rows.length > 0 ? `${sheetName}\n${rows.join("\n")}` : sheetName;
      });
      return {
        text: sections.join("\n\n").trim(),
        extractor: "xlsx"
      };
    } catch (error) {
      throw wrapExtractionError(error, "Unable to extract text from spreadsheet");
    }
  }

  if (
    extension === ".docx" ||
    normalizedType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    try {
      const result = await withTimeout(mammoth.extractRawText({ buffer: content }));
      return {
        text: result.value.trim(),
        extractor: "docx"
      };
    } catch (error) {
      throw wrapExtractionError(error, "Unable to extract text from DOCX");
    }
  }

  if (normalizedType === "application/pdf") {
    try {
      const result = await withTimeout(pdfParse(content));
      return {
        text: result.text.trim(),
        extractor: "pdf"
      };
    } catch (error) {
      throw wrapExtractionError(error, "Unable to extract text from PDF");
    }
  }

  if (canTreatAsText(filename, normalizedType)) {
    return {
      text: content.toString("utf8").replace(/\u0000/g, "").trim(),
      extractor: normalizedType === "text/html" ? "html" : "text"
    };
  }

  throw new AppError(
    "UNSUPPORTED_ATTACHMENT",
    `Text extraction is not supported for ${contentType || "this attachment"}`
  );
}

async function extractPresentationText(content: Buffer): Promise<string> {
      const archive = await JSZip.loadAsync(content);
      const slideEntries = Object.keys(archive.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
        .sort((left, right) => {
          const leftNumber = Number(left.match(/slide(\d+)\.xml$/i)?.[1] ?? 0);
          const rightNumber = Number(right.match(/slide(\d+)\.xml$/i)?.[1] ?? 0);
          return leftNumber - rightNumber;
        });
      const notesEntries = Object.keys(archive.files)
        .filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(name))
        .sort((left, right) => {
          const leftNumber = Number(left.match(/notesSlide(\d+)\.xml$/i)?.[1] ?? 0);
          const rightNumber = Number(right.match(/notesSlide(\d+)\.xml$/i)?.[1] ?? 0);
          return leftNumber - rightNumber;
        });

      let totalXmlBytes = 0;
      const slides = await Promise.all(
        slideEntries.map(async (entry, index) => {
          const xml = await archive.file(entry)?.async("text");
          totalXmlBytes += Buffer.byteLength(xml ?? "", "utf8");
          if (totalXmlBytes > MAX_PPTX_XML_BYTES) {
            throw new AppError(
              "ATTACHMENT_TOO_LARGE",
              "PPTX decompressed XML exceeds the configured safety limit"
            );
          }
          const text = extractPresentationXmlText(xml ?? "");
          return text ? `Slide ${index + 1}\n${text}` : null;
        })
      );
      const notes = await Promise.all(
        notesEntries.map(async (entry, index) => {
          const xml = await archive.file(entry)?.async("text");
          totalXmlBytes += Buffer.byteLength(xml ?? "", "utf8");
          if (totalXmlBytes > MAX_PPTX_XML_BYTES) {
            throw new AppError(
              "ATTACHMENT_TOO_LARGE",
              "PPTX decompressed XML exceeds the configured safety limit"
            );
          }
          const text = extractPresentationXmlText(xml ?? "");
          return text ? `Notes ${index + 1}\n${text}` : null;
        })
      );
      const sections = [...slides, ...notes].filter(
        (section): section is string => Boolean(section)
      );

      return sections.join("\n\n").trim();
}

function extractPresentationXmlText(xml: string): string {
  if (!xml.trim()) {
    return "";
  }

  const document = new DOMParser().parseFromString(xml, "text/xml");
  const paragraphs = Array.from(document.getElementsByTagNameNS(
    "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p"
  ));
  const lines = paragraphs
    .map((paragraph) =>
      Array.from(paragraph.getElementsByTagNameNS(
        "http://schemas.openxmlformats.org/drawingml/2006/main",
        "t"
      ))
        .map((node) => node.textContent ?? "")
        .join("")
        .trim()
    )
    .filter(Boolean);

  return lines.join("\n").trim();
}
