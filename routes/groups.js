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

router.post("/create", wrap(async (req) => ({ group: groupService.publicGroup(await groupService.createGroup({
  creatorId: actor(req), name: req.body.name, description: req.body.description, icon: req.body.icon,
  memberIds: req.body.memberIds,
})) })));
router.post("/get", wrap(async (req) => { const group = await groupService.readGroup(req.body.groupId);
  groupService.requireMember(group, actor(req)); return { group: groupService.publicGroup(group) }; }));
router.post("/details", wrap(async (req) => {
  const group = await groupService.readGroup(req.body.groupId);
  groupService.requireMember(group, actor(req));
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
  return { group: { ...groupService.publicGroup(group), members: members.map((member) => ({
    ...member, ...(profiles.get(member.userId) || { serverProfileName: "", profilePhotoUrl: null, about: "" }),
  })) } };
}));
router.post("/messages", wrap(async (req) => { const group = await groupService.readGroup(req.body.groupId);
  groupService.requireMember(group, actor(req)); const chat = await groupService.readChat(req.body.groupId);
  const limit = Math.min(100, Math.max(1, Number(req.body.pageSize) || 50)); const before = Number(req.body.before || Infinity);
  const messages = Object.values(chat || {}).filter((m) => m && m.id && Number(m.sentTime) < before)
    .sort((a, b) => Number(b.sentTime) - Number(a.sentTime)).slice(0, limit);
  return { messages, nextCursor: messages.length === limit ? messages[messages.length - 1].sentTime : null,
    hasMore: messages.length === limit }; }));
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
  group: groupService.publicGroup(await groupService.leaveGroup(req.body.groupId, actor(req))) })));
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
