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
    assert.equal(getControlText(edits.start), "i", "calibration shows the current PDF label");
    enter(edits.page, "9");
    assert.equal(await physicalPage(first.client), 13, "preview the printed page before assigning its number");
    enter(edits.start, "1");
    assert.equal(await physicalPage(first.client), 13, "assigning a number does not navigate");
    assert.equal(getControlText(edits.page), "1");
    enter(edits.page, "8");
    assert.equal(await physicalPage(first.client), 20);
    assert.equal(getControlText(edits.start), "8", "calibration follows the visible page");
    enter(edits.page, "-11");
    assert.equal(await physicalPage(first.client), 1);
    for (const invalid of ["abc", "2147483647", "-2147483648"]) {
      enter(edits.start, invalid);
      assert.equal(await physicalPage(first.client), 1, "invalid assignment does not navigate");
      assert.equal(getControlText(edits.page), "-11", `reject printed number ${invalid}`);
    }
    enter(edits.start, "2");
    assert.equal(getControlText(edits.page), "2", "start zero is an explicit mapping");
    enter(edits.page, "3");
    assert.equal(await physicalPage(first.client), 2);
    enter(edits.start, "2");
    assert.equal(getControlText(edits.page), "2", "start one overrides native Roman labels");
    enter(edits.page, "1");
    assert.equal(await physicalPage(first.client), 1);
    enter(edits.start, "");
    assert.equal(getControlText(edits.page), "i", "clear assignment to restore native PDF labels");
    enter(edits.page, "i");
    enter(edits.start, "7");
    assert.equal(getControlText(edits.page), "7", "assigning a later printed number supports negative starts");
    enter(edits.page, "26");
    assert.equal(await physicalPage(first.client), 20);
    enter(edits.page, "7");
    await first.client.waitForRenderIdle();
    captureWindowToPng(first.frame, tmpPath("book-pages.png"));
    await first.client.quit();
    assert.ok(await waitForExit(first.proc));
    assert.equal(await first.proc.exited, 0);
  } finally {
    first.client.close();
    if (first.proc.exitCode === null) await killAndWait(first.proc);
  }
  assert.match(readFileSync(settings, "utf8"), /BookStartPage\s*=\s*-5\b/, "negative start saved per document");

  const reopened = await launchControlled(["-appdata", appdata, pdf], { saveSettings: true });
  try {
    await reopened.client.waitForRenderIdle();
    const edits = pageEdits(reopened.frame);
    assert.equal(getControlText(edits.start), "7", "current printed number survives reopening");
    assert.equal(getControlText(edits.page), "7", "logical page survives reopening");
    enter(edits.page, "8");
    assert.equal(await physicalPage(reopened.client), 2, "restored negative mapping controls navigation");
    enter(edits.start, "");
    enter(edits.page, "i");
    assert.equal(await physicalPage(reopened.client), 1, "clearing restores the original page numbering");
    await reopened.client.quit();
    assert.ok(await waitForExit(reopened.proc));
  } finally {
    reopened.client.close();
    if (reopened.proc.exitCode === null) await killAndWait(reopened.proc);
  }
  assert.match(readFileSync(settings, "utf8"), /BookStartPage\s*=\s*1\b/, "default 1 is saved");
  const reset = await launchControlled(["-appdata", appdata, pdf]);
  try {
    await reset.client.waitForRenderIdle();
    const edits = pageEdits(reset.frame);
    assert.equal(getControlText(edits.start), "i", "native current label survives reopening");
    assert.equal(getControlText(edits.page), "i", "original labels survive clearing");
    await reset.client.quit();
    assert.ok(await waitForExit(reset.proc));
  } finally {
    reset.client.close();
    if (reset.proc.exitCode === null) await killAndWait(reset.proc);
  }
  for (const printed of [2, 1]) {
    const assigned = await launchControlled(["-appdata", appdata, pdf], { saveSettings: true });
    try {
      await assigned.client.waitForRenderIdle();
      const edits = pageEdits(assigned.frame);
      enter(edits.start, String(printed));
      assert.equal(await physicalPage(assigned.client), 1);
      await assigned.client.quit();
      assert.ok(await waitForExit(assigned.proc));
    } finally {
      assigned.client.close();
      if (assigned.proc.exitCode === null) await killAndWait(assigned.proc);
    }
    const restored = await launchControlled(["-appdata", appdata, pdf], { saveSettings: true });
    try {
      await restored.client.waitForRenderIdle();
      const edits = pageEdits(restored.frame);
      assert.equal(getControlText(edits.page), String(printed), "explicit start 0 or 1 survives reopening");
      enter(edits.start, "");
      assert.equal(getControlText(edits.page), "i");
      await restored.client.quit();
      assert.ok(await waitForExit(restored.proc));
    } finally {
      restored.client.close();
      if (restored.proc.exitCode === null) await killAndWait(restored.proc);
    }
  }
  console.log("Visual page assignment, boundaries, native labels and persistence passed.");
}

if (import.meta.main) {
  await runStandalone(testit);
}
