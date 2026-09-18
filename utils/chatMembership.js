// Conference call membership never grants access to an unrelated direct chat.
function normalize(value) {
  return String(value || "").trim().replace("<plus>", "").replace(/^\+/, "");
}

function isDirectChatParticipant(chatId, userId) {
  const members = String(chatId || "").split("_").map(normalize);
  const user = normalize(userId);
  return Boolean(user) && members.length === 2 && members.every(Boolean)
    && members.includes(user);
}

function filterChatListForUser(list, userId) {
  if (Array.isArray(list)) throw new Error("Chat lists must use per-item fields; migrate legacy arrays first.");
  const allowed = (id) => String(id).startsWith("grp_")
    || isDirectChatParticipant(id, userId);
  return Object.fromEntries(Object.entries(list || {}).filter(([id]) => allowed(id)));
}

function chatEntries(document) {
  if (!document) return {};
  if (Array.isArray(document) || Object.hasOwn(document, "list") || Object.hasOwn(document, "__listStorage"))
    throw new Error("ChatsList must use marker-free per-item fields. Migrate the document first.");
  return Object.fromEntries(Object.entries(document).filter(([id, value]) =>
    (/^\d+_\d+$/.test(id) || id.startsWith("grp_"))
    && value && typeof value === "object" && !Array.isArray(value)));
}

module.exports = { isDirectChatParticipant, filterChatListForUser, chatEntries };
