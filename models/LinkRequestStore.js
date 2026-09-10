"use strict";

const FirestoreManager = require("../Firestore/FirestoreManager");
const firestore = FirestoreManager.getInstance();
const COLLECTION = "DeviceLinkRequests";

function clean(value) { const copy = { ...(value || {}) }; delete copy._id; return copy; }

async function create(request) {
  return firestore.createDocument(COLLECTION, request.linkRequestId, "/", clean(request));
}

async function read(linkRequestId) {
  try { return await firestore.readDocument(COLLECTION, linkRequestId, "/"); }
  catch (_error) { return null; }
}

async function write(linkRequestId, request) {
  return firestore.updateDocument(COLLECTION, linkRequestId, "/", clean(request));
}

module.exports = { create, read, write };
