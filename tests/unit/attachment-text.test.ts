import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { extractAttachmentText } from "../../src/mime/attachment-text.js";

describe("extractAttachmentText", () => {
  it("extracts text from a spreadsheet", async () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Name", "Amount"],
      ["Alice", 42],
      ["Bob", 7]
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
    const content = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const result = await extractAttachmentText(
      content,
      "report.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    expect(result.extractor).toBe("xlsx");
    expect(result.text).toContain("Alice");
    expect(result.text).toContain("42");
  });

  it("extracts plain text and rejects unsupported binary content", async () => {
    const text = await extractAttachmentText(
      Buffer.from("hello", "utf8"),
      "note.txt",
      "text/plain"
    );

    expect(text).toEqual({
      text: "hello",
      extractor: "text"
    });

    await expect(
      extractAttachmentText(Buffer.from([0, 1, 2]), "image.png", "image/png")
    ).rejects.toMatchObject({ code: "UNSUPPORTED_ATTACHMENT" });
  });

  it("reports unsupported formats without executing them", async () => {
    await expect(
      extractAttachmentText(Buffer.from("MZ..."), "program.exe", "application/octet-stream")
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_ATTACHMENT"
    });
  });

  it("extracts text and speaker notes from a PPTX presentation", async () => {
    const archive = new JSZip();
    archive.file(
      "ppt/slides/slide1.xml",
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"',
        ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
        "<p:cSld><p:spTree><p:sp><p:txBody>",
        "<a:p><a:r><a:t>Quarterly review</a:t></a:r></a:p>",
        "<a:p><a:r><a:t>Revenue up 12%</a:t></a:r></a:p>",
        "</p:txBody></p:sp></p:spTree></p:cSld></p:sld>"
      ].join("")
    );
    archive.file(
      "ppt/notesSlides/notesSlide1.xml",
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"',
        ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
        "<p:cSld><p:spTree><p:sp><p:txBody>",
        "<a:p><a:r><a:t>Follow up with finance</a:t></a:r></a:p>",
        "</p:txBody></p:sp></p:spTree></p:cSld></p:notes>"
      ].join("")
    );
    const content = await archive.generateAsync({ type: "nodebuffer" });

    const result = await extractAttachmentText(
      content,
      "review.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );

    expect(result.extractor).toBe("pptx");
    expect(result.text).toContain("Slide 1");
    expect(result.text).toContain("Quarterly review");
    expect(result.text).toContain("Revenue up 12%");
    expect(result.text).toContain("Follow up with finance");
  });

  it("rejects PPTX archives whose decompressed XML exceeds the safety limit", async () => {
    const archive = new JSZip();
    const padding = "A".repeat(17 * 1024 * 1024);
    archive.file(
      "ppt/slides/slide1.xml",
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"',
        ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
        `<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${padding}</a:t></a:r></a:p>`,
        "</p:txBody></p:sp></p:spTree></p:cSld></p:sld>"
      ].join("")
    );
    const content = await archive.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 }
    });

    await expect(
      extractAttachmentText(
        content,
        "huge.pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      )
    ).rejects.toMatchObject({
      code: "ATTACHMENT_TOO_LARGE"
    });
  });
});
