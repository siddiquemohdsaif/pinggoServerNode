"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_MEDIA_COUNT,
  DEFAULT_DOCUMENT_COUNT,
  buildMessageTypeSequence,
  demoDocumentAsset,
  readMediaCount,
  readDocumentCount,
  readMessageRange,
} = require("./test1");

test("demo message range provides room for the configured content defaults", () => {
  assert.equal(readMediaCount([]), DEFAULT_MEDIA_COUNT);
  assert.equal(readDocumentCount([]), DEFAULT_DOCUMENT_COUNT);
  assert.equal(
    readMessageRange([]).minimum,
    DEFAULT_MEDIA_COUNT + DEFAULT_DOCUMENT_COUNT,
  );
});

test("message generation uses exact media and document counts", () => {
  const types = buildMessageTypeSequence(30, 4, 4);
  assert.equal(types.length, 30);
  assert.equal(types.filter(type => type === "image" || type === "video").length, 4);
  assert.equal(types.filter(type => type === "file").length, 4);
});

test("media and document CLI values are validated", () => {
  assert.equal(readMediaCount(["--media", "7"]), 7);
  assert.equal(readDocumentCount(["--docs", "6"]), 6);
  assert.throws(() => readMediaCount(["--media", "-1"]), /Media count/);
  assert.throws(() => buildMessageTypeSequence(7, 4, 4), /cannot exceed/);
});

test("document messages upload a real text document instead of relabelled media", () => {
  const document = demoDocumentAsset(2);
  assert.equal(document.name, "pinggo-demo-document-3.txt");
  assert.equal(document.mimeType, "text/plain");
  assert.match(document.buffer.toString("utf8"), /Pinggo demo document 3/);
});
