import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const tmp = mkdtempSync(path.join(tmpdir(), "metadata-smoke-"));
const outfile = path.join(tmp, "metadata.cjs");
const require = createRequire(import.meta.url);

try {
  await build({
    entryPoints: ["src/modules/metadata.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile,
    logLevel: "silent",
  });

  const {
    buildFallbackDoubanItem,
    extractDoubanTitle,
    isNoTitleSpecifiedError,
  } = require(outfile);

  const documentWithMeta = createMockDocument({
    title: "Ignored browser title (豆瓣)",
    selectors: {
      'meta[property="og:title"]': { content: " Norwegian Wood " },
      'meta[property="book:author"]': { content: "Haruki Murakami" },
      'meta[property="book:isbn"]': { content: "9780099448822" },
      'meta[property="og:description"]': {
        content: "When he hears her favourite Beatles song...",
      },
    },
  });

  assert.equal(extractDoubanTitle(documentWithMeta), "Norwegian Wood");
  assert.deepEqual(
    buildFallbackDoubanItem(
      documentWithMeta,
      "https://book.douban.com/subject/1355643/",
    ),
    {
      __fallbackDoubanItem: true,
      itemType: "book",
      title: "Norwegian Wood",
      url: "https://book.douban.com/subject/1355643/",
      creators: [
        {
          creatorType: "author",
          lastName: "Haruki Murakami",
          fieldMode: 1,
        },
      ],
      ISBN: "9780099448822",
      abstractNote: "When he hears her favourite Beatles song...",
    },
  );

  const documentWithJSONLD = createMockDocument({
    title: "Fallback title (豆瓣)",
    selectors: {
      'script[type="application/ld+json"]': {
        textContent: JSON.stringify({ "@type": "Book", name: "JSON-LD Title" }),
      },
    },
  });

  assert.equal(extractDoubanTitle(documentWithJSONLD), "JSON-LD Title");
  assert.equal(isNoTitleSpecifiedError(new Error("No title specified")), true);
  assert.equal(isNoTitleSpecifiedError(new Error("Network failed")), false);

  console.log("metadata douban fallback smoke: pass");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function createMockDocument({ title, selectors }) {
  return {
    title,
    querySelector(selector) {
      const value = selectors[selector];
      return Array.isArray(value) ? value[0] || null : value || null;
    },
    querySelectorAll(selector) {
      const value = selectors[selector];
      if (!value) {
        return [];
      }
      return Array.isArray(value) ? value : [value];
    },
  };
}
