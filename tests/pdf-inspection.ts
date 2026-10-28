// Independent reader used only in tests; never bundled into the application.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
export async function inspectPdf(bytes: Uint8Array) {
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    disableFontFace: true,
  });
  const pdf = await task.promise;
  try {
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i),
        viewport = page.getViewport({ scale: 1 }),
        content = await page.getTextContent();
      const items = content.items.filter((i) => "str" in i);
      pages.push({
        text: items.map((i) => i.str).join(" "),
        width: viewport.width,
        height: viewport.height,
        items: items.map((i) => ({
          text: i.str,
          x: i.transform[4],
          y: i.transform[5],
          width: i.width,
          height: i.height,
        })),
        annotations: await page.getAnnotations(),
      });
    }
    return {
      pages,
      text: pages.map((p) => p.text).join("\n"),
      actions: await pdf.getJSActions(),
      attachments: await pdf.getAttachments(),
    };
  } finally {
    await task.destroy();
  }
}
