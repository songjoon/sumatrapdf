# This fork

Windows builds remove other-product promotions from the home page and About
window. Usage tips, project links and license information remain available.
Promotional content in update responses is ignored. The ng home page also
removes these promotions.

## Book page numbers on Windows

The **Book 1 at:** field beside the page-number input specifies the physical
file page corresponding to printed book page 1. The default is **1**.
Press Enter to apply it.
For example, entering **13** makes file page 13 appear as book page 1; entering
**5** in the page-number input then navigates to file page 17.

Negative values are supported for excerpts whose printed numbering starts
later: entering **-5** makes file page 1 appear as book page 7.

The total shows the final book page number and the current physical file position.
Front matter remains accessible using zero and negative page numbers. Setting
**Book 1 at:** to **1** restores the document's original page labels. Escape
discards an unfinished edit. Values after the last file page, malformed input,
and mappings that overflow the page-number range are rejected. Older saved
automatic values of **0** are normalized to **1**.

The mapping is saved per document and in session tabs, subject to the existing
history and per-document state preferences. It changes display and navigation
labels, without rewriting the document. Chapter-based, reflowable books keep
their existing chapter/page controls.

## Build and check

The **Fork Windows build** GitHub Actions workflow builds Windows x64 binaries
without requiring Visual Studio on the user's computer. Its artifact contains
the installer executable and runtime files.

The targeted Windows check is:

```powershell
bun tests/ad-hoc-book-pages.ts --no-build
```

It checks native PDF labels, positive and negative book offsets, front matter,
invalid input, resetting the mapping and persistence after reopening the document.
