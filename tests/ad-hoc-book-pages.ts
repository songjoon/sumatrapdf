import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assemblePdf, runStandalone, tmpPath } from "./util.ts";
import { ControlClient, ControlCommand } from "./control.ts";
import { launchControlled, waitForExit } from "./win-automation.ts";
import {
  captureWindowToPng,
  enumChildWindows,
  findChildWindow,
  getClassName,
  getControlText,
  getWindowRect,
  isWindowVisible,
  killAndWait,
  sendMessage,
  sendText,
  WM_CHAR,
} from "./winapi.ts";

function bookPdf(): string {
  const pages = 20;
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /PageLabels << /Nums [0 << /S /r >> 4 << /S /D /St 1 >>] >> >>",
    `<< /Type /Pages /Count ${pages} /Kids [${kids}] >>`,
  ];
  for (let i = 0; i < pages; i++) {
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>");
  }
  return assemblePdf(objects);
}

function pageEdits(frame: number): { page: number; start: number } {
  const toolbar = findChildWindow(frame, "SUMATRA_VIRT_TOOLBAR");
  assert.ok(toolbar, "toolbar exists");
  const edits: number[] = [];
  enumChildWindows(toolbar, (hwnd) => {
    if (getClassName(hwnd) === "Edit" && isWindowVisible(hwnd)) edits.push(hwnd);
    return true;
  });
  edits.sort((a, b) => getWindowRect(a).left - getWindowRect(b).left);
  assert.equal(edits.length, 2, "page number and book-start inputs are visible");
  return { page: edits[0], start: edits[1] };
}

function enter(hwnd: number, text: string): void {
  sendText(hwnd, text);
  sendMessage(hwnd, WM_CHAR, 13, 0);
}

async function physicalPage(client: ControlClient): Promise<number> {
  const result = await client.request(ControlCommand.TestFavoriteNav, ["page"]);
  assert.equal(result[0], 0);
  const match = /page=(-?\d+)/.exec(String(result[1]));
  assert.ok(match, String(result[1]));
  return Number(match[1]);
}

export async function testit(): Promise<void> {
  const pdf = tmpPath("book-pages.pdf");
  writeFileSync(pdf, bookPdf(), "latin1");
  const appdata = tmpPath(`book-pages-settings-${Date.now()}`);
  mkdirSync(appdata, { recursive: true });
  const settings = join(appdata, "SumatraPDF-settings.txt");
  writeFileSync(
    settings,
    "RestoreSession = false\nRememberStatePerDocument = true\nRememberOpenedFiles = true\n" +
      "CheckForUpdates = false\nUiLanguage = en\nDefaultDisplayMode = single page\nShowToolbar = true\n",
  );

  const first = await launchControlled(["-appdata", appdata, pdf], { saveSettings: true });
  try {
    await first.client.waitForRenderIdle();
    const edits = pageEdits(first.frame);
    assert.equal(getControlText(edits.page), "i", "native PDF labels are initially preserved");
    enter(edits.start, "13");
    enter(edits.page, "1");
    assert.equal(await physicalPage(first.client), 13, "book page 1 maps to file page 13");
    assert.equal(getControlText(edits.page), "1");
    enter(edits.page, "8");
    assert.equal(await physicalPage(first.client), 20, "last book page maps to last file page");
    enter(edits.page, "0");
    assert.equal(await physicalPage(first.client), 12, "front matter remains navigable");
    enter(edits.page, "-11");
    assert.equal(await physicalPage(first.client), 1, "first file page remains navigable");
    for (const invalid of ["abc", "9", "2147483647", "-12"]) {
      enter(edits.page, invalid);
      assert.equal(await physicalPage(first.client), 1, `reject book page ${invalid}`);
    }
    for (const invalid of ["21", "-1", "", "abc"]) {
      enter(edits.start, invalid);
      enter(edits.page, "1");
      assert.equal(await physicalPage(first.client), 13, `reject book start ${invalid}`);
    }
    enter(edits.start, "0");
    enter(edits.page, "i");
    assert.equal(await physicalPage(first.client), 1, "reset restores native PDF labels");
    enter(edits.start, "13");
    enter(edits.page, "1");
    await first.client.waitForRenderIdle();
    captureWindowToPng(first.frame, tmpPath("book-pages.png"));
    await first.client.quit();
    assert.ok(await waitForExit(first.proc));
    assert.equal(await first.proc.exited, 0);
  } finally {
    first.client.close();
    if (first.proc.exitCode === null) await killAndWait(first.proc);
  }
  assert.match(readFileSync(settings, "utf8"), /BookStartPage\s*=\s*13\b/, "saved per document");

  const reopened = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await reopened.client.waitForRenderIdle();
    const edits = pageEdits(reopened.frame);
    assert.equal(getControlText(edits.start), "13", "book start survives reopening");
    assert.equal(getControlText(edits.page), "1", "logical page survives reopening");
    enter(edits.page, "2");
    assert.equal(await physicalPage(reopened.client), 14, "restored mapping controls navigation");
    await reopened.client.quit();
    assert.ok(await waitForExit(reopened.proc));
  } finally {
    reopened.client.close();
    if (reopened.proc.exitCode === null) await killAndWait(reopened.proc);
  }
  console.log("Book page mapping, boundaries, native labels and persistence passed.");
}

if (import.meta.main) {
  await runStandalone(testit);
}
