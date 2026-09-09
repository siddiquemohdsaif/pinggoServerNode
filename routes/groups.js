const express = require("express");
const groupService = require("../services/groupService");
const FirestoreManager = require("../Firestore/FirestoreManager");
const firestore = FirestoreManager.getInstance();
const router = express.Router();

const accountId = (v) => typeof v === "string" ? v.trim().replace(/^<plus>/, "").replace(/^\+/, "") : "";
const actor = (req) => accountId(req.body.userId || req.body.phoneNumber || req.body.phone || req.body.creatorId);
const wrap = (handler) => async (req, res) => {
  try { const value = await handler(req); res.status(200).json({ success: true, ...value }); }
  catch (error) { res.status(error.statusCode || 400).json({ success: false, message: error.message }); }
};
const encodeMessageCursor = (message) => Buffer.from(JSON.stringify({
  sentTime: Number(message.sentTime) || 0, messageId: String(message.id || ""),
}), "utf8").toString("base64url");
const decodeMessageCursor = (value) => {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (!Number.isFinite(Number(cursor.sentTime)) || !cursor.messageId) throw new Error();
    return { sentTime: Number(cursor.sentTime), messageId: String(cursor.messageId) };
  } catch (_error) {
    const error = new Error("cursor is invalid."); error.statusCode = 400; throw error;
  }
};

router.post("/create", wrap(async (req) => ({ group: groupService.publicGroup(await groupService.createGroup({
  creatorId: actor(req), name: req.body.name, description: req.body.description, icon: req.body.icon,
  memberIds: req.body.memberIds,
})) })));
router.post("/get", wrap(async (req) => { const group = await groupService.readGroup(req.body.groupId);
  groupService.requireMember(group, actor(req)); return { group: groupService.publicGroup(group) }; }));
router.post("/details", wrap(async (req) => {
  const group = await groupService.readGroup(req.body.groupId);
  const requesterId = actor(req);
  const ownMembership = group && group.members && group.members[requesterId];
  if (!group) { const error = new Error("Group not found."); error.statusCode = 404; throw error; }
  if (!ownMembership) { const error = new Error("Group membership required."); error.statusCode = 403; throw error; }
  const members = Object.values(group.members || {}).filter((member) => member.status === "active");
  let users = [];
  try { users = await firestore.bulkReadDocuments("Users", "/", members.map((m) => m.userId), {}); }
  catch (_error) {}
  const profiles = new Map(users.map((user) => {
    const profile = user.profileData || {};
    const id = accountId(profile.phoneNumber || user._id);
    return [id, { serverProfileName: profile.name || profile.displayName || "",
      profilePhotoUrl: profile.profilePhotoUrl || null, about: profile.about || "" }];
  }));
  return { group: { ...groupService.publicGroup(group), ownMembership, members: members.map((member) => ({
    ...member, ...(profiles.get(member.userId) || { serverProfileName: "", profilePhotoUrl: null, about: "" }),
  })) } };
}));
router.post("/messages", wrap(async (req) => { const group = await groupService.readGroup(req.body.groupId);
  const requesterId = actor(req); groupService.requireMember(group, requesterId);
  const membership = group.members[requesterId]; const chat = await groupService.readChat(req.body.groupId);
  const limit = Math.min(100, Math.max(1, Number(req.body.pageSize) || 50));
  const cursor = decodeMessageCursor(req.body.cursor);
  const all = Object.values(chat || {}).filter((m) => m && m.id
      && Number.isFinite(Number(m.sentTime))
      && groupService.memberCanAccessMessage(membership, requesterId, m))
    .sort((a, b) => Number(b.sentTime) - Number(a.sentTime) || String(b.id).localeCompare(String(a.id)));
  const eligible = all.filter((message) => cursor
    ? Number(message.sentTime) < cursor.sentTime
      || (Number(message.sentTime) === cursor.sentTime && String(message.id) < cursor.messageId)
    : true);
  const messages = eligible.slice(0, limit); const hasMore = eligible.length > messages.length;
  return { messages, nextCursor: hasMore && messages.length
    ? encodeMessageCursor(messages[messages.length - 1]) : null, hasMore }; }));
router.post("/update", wrap(async (req) => ({ group: groupService.publicGroup(await groupService.updateGroup(
  req.body.groupId, actor(req), req.body,
)) })));
router.post("/members/add", wrap(async (req) => ({ group: groupService.publicGroup(await groupService.changeMembers(
  req.body.groupId, actor(req), req.body.memberIds, "add",
)) })));
router.post("/members/remove", wrap(async (req) => ({ group: groupService.publicGroup(await groupService.changeMembers(
  req.body.groupId, actor(req), req.body.memberIds, "remove",
)) })));
router.post("/members/role", wrap(async (req) => ({ group: groupService.publicGroup(await groupService.setRole(
  req.body.groupId, actor(req), req.body.memberId, req.body.role,
)) })));
router.post("/leave", wrap(async (req) => ({ groupId: req.body.groupId,
  group: groupService.publicGroup(await groupService.leaveGroup(
    req.body.groupId, actor(req), req.body.successorAdminId)) })));
router.post("/report", wrap(async (req) => {
  const reporterId = actor(req); const groupId = String(req.body.groupId || "").trim();
  const reason = String(req.body.reason || "").trim();
  const group = await groupService.readGroup(groupId); groupService.requireMember(group, reporterId);
  if (!reason) { const error = new Error("reason is required."); error.statusCode = 400; throw error; }
  const reportId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  await firestore.createDocument("GroupReports", reportId, "/", {
    reportId, groupId, reporterId, reason, createdAt: Date.now(),
  });
  return { reportId, groupId };
}));
module.exports = router;
