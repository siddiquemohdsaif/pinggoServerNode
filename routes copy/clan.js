const express = require('express');
const clanHandler = require("../utils/ClanHandler");
const AES = require("../utils/AES_256");
const router = express.Router();
const UserLock = require('../utils/Lock/UserLock');
const ClanLock = require('../utils/Lock/ClanLock');
const UserAndClanLock = require('../utils/Lock/UserAndClanLock');


// 1
router.post('/createNewClan', async (req, res) => {
    try {
        const uid = req.body.UID;
        const clanName = req.body.clanName;
        const clanLogo = req.body.clanLogo;
        const clanDescription = req.body.clanDescription;
        const clanType = req.body.clanType;
        const requiredTrophy = req.body.requiredTrophy;

        if (!uid || !clanName || !clanLogo || !clanDescription || !clanType || (!requiredTrophy && requiredTrophy != 0)) {
            return res.status(400).json({ success: false, message: 'All clan details are required.' });
        }

        //check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const updatedUserProfileWithNewClanJoin = await UserLock.getInstance().run(uid, async () => {
            return await clanHandler.createNewClan(uid, clanName, clanLogo, clanDescription, clanType, requiredTrophy);
        });

        if (updatedUserProfileWithNewClanJoin) {
            return res.status(200).json(updatedUserProfileWithNewClanJoin);
        } else {
            return res.status(400).json({ success: false, message: "Unable to create new clan." });
        }

    } catch (error) {
        console.error("Error in createNewClan:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});


// 2
router.post('/joinClan', async (req, res) => {
    try {
        const uid = req.body.UID;
        const cid = req.body.cid;

        //check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Validate UID and clanId
        if (!uid || !cid) {
            throw new Error("Both UID and clanId are required.");
        }

        const updatedUserProfileAfterJoinClan = await UserAndClanLock.getInstance().run(uid, cid, async () => {
            return await clanHandler.joinClan(uid, cid);
        });


        if (updatedUserProfileAfterJoinClan) {
            return res.status(200).json(updatedUserProfileAfterJoinClan);
        } else {
            return res.status(400).json({ success: false, message: ("Unable to join the clan.") });
        }

    } catch (error) {
        console.error("Error in join:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});


// 3
router.post('/actionRequestJoin', async (req, res) => {
    try {
        const uid = req.body.UID;
        const cid = req.body.cid;
        const requestMessageId = req.body.requestMessageId;
        const isAccepted = req.body.isAccepted;

        //check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Validate UID, requestMessageId, and isAccepted
        if (!uid || !cid || !requestMessageId || typeof isAccepted !== 'boolean') {
            throw new Error("All fields are required.");
        }

        const response = await UserAndClanLock.getInstance().run(uid, cid, async () => {
            return await clanHandler.handleRequestJoin(uid, cid, requestMessageId, isAccepted);
        });

        if (response) {
            return res.status(200).json(response);
        } else {
            return res.status(400).json({ success: false, message: ("Unable to handle requestJoin.") });
        }

    } catch (error) {
        console.error("Error in actionRequestJoin:", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});


// 4
router.post('/leaveClan', async (req, res) => {
    try {
        const uid = req.body.UID;

        if (!uid) {
            return res.status(400).json({ success: false, message: 'UID is required.' });
        }

        //check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }


        const updatedUserProfileAfterLeavingClan = await UserLock.getInstance().run(uid, async () => {
            return await clanHandler.leaveClan(uid);
        });

        if (updatedUserProfileAfterLeavingClan) {
            return res.status(200).json(updatedUserProfileAfterLeavingClan);
        } else {
            return res.status(400).json({ success: false, message: "Unable to leave the clan." });
        }

    } catch (error) {
        console.error("Error in leaveClan:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});


// 5
router.post('/updateClanDetails', async (req, res) => {
    try {
        const uid = req.body.UID;
        const cid = req.body.cid;
        const clanName = req.body.clanName;
        const clanLogo = req.body.clanLogo;
        const clanDescription = req.body.clanDescription;
        const clanType = req.body.clanType;
        const requiredTrophy = req.body.requiredTrophy;

        if (!cid || !uid) {
            return res.status(400).json({ success: false, message: 'Clan ID and UID is required.' });
        }

        //check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }


        const updateResponse = await ClanLock.getInstance().run(cid, async () => {
            return await clanHandler.updateClanDetails(uid, cid, clanName, clanLogo, clanDescription, clanType, requiredTrophy);
        });

        if (updateResponse.success) {
            return res.status(200).json(updateResponse);
        } else {
            return res.status(400).json({ success: false, message: updateResponse.message });
        }

    } catch (error) {
        console.error("Error in updateClanDetails:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});



// 6
router.post('/promoteMember', async (req, res) => {
    try {
        const promoterUID = req.body.promoterUID;
        const promotingUID = req.body.promotingUID;
        const cid = req.body.cid;

        //check auth uid
        if (promoterUID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Check if all parameters are defined
        if (!promoterUID || !promotingUID || !cid) {
            throw new Error("All parameters are required.");
        }

        const result = await ClanLock.getInstance().run(cid, async () => {
            return await clanHandler.promote(promoterUID, promotingUID, cid);
        });

        return res.status(200).json(result);

    } catch (error) {
        console.error("Error in promote:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});


// 7
router.post('/demoteMember', async (req, res) => {
    try {
        const demoterUID = req.body.demoterUID;
        const demotingUID = req.body.demotingUID;
        const cid = req.body.cid;

        //check auth uid
        if (demoterUID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Check if all parameters are defined
        if (!demoterUID || !demotingUID || !cid) {
            throw new Error("All parameters are required.");
        }

        const result = await ClanLock.getInstance().run(cid, async () => {
            return await clanHandler.demote(demoterUID, demotingUID, cid);
        });

        return res.status(200).json(result);

    } catch (error) {
        console.error("Error in demote:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});


// 8
router.post('/kickMember', async (req, res) => {
    try {
        const kickerUID = req.body.kickerUID;
        const kickingUID = req.body.kickingUID;
        const cid = req.body.cid;

        //check auth uid
        if (kickerUID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Check if all parameters are defined
        if (!kickerUID || !kickingUID || !cid) {
            throw new Error("All parameters are required.");
        }

        const result = await UserAndClanLock.getInstance().run(kickingUID, cid, async () => {
            return await clanHandler.kick(kickerUID, kickingUID, cid);
        });

        return res.status(200).json(result);

    } catch (error) {
        console.error("Error in kick:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});


// 9
router.post('/searchClan', async (req, res) => {
    try {

        const searchName = req.body.searchName;
        const type = req.body.type;
        const minMember = req.body.minMember;
        const minClanTrophy = req.body.minClanTrophy;
        const minClanLevel = req.body.minClanLevel;

        if (!minMember || (!minClanTrophy && minClanTrophy !== 0) || !minClanLevel) {
            return res.status(400).json({ success: false, message: 'All required field is not provided.' });
        }


        const validClanTypes = ["Open", "Closed", "Invite Only"];
        if (type && !validClanTypes.includes(type)) {
            return res.status(400).json({ success: false, message: 'clan type is not correct.' });
        }


        const searchedClanList = await clanHandler.searchClan(searchName, type, minMember, minClanTrophy, minClanLevel);

        if (searchedClanList) {
            return res.status(200).json({ clans: searchedClanList });
        } else {
            return res.status(400).json({ success: false, message: "Clan search failed" });
        }

    } catch (error) {
        console.error("Error in searchClan:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});



// 10
router.post('/clanWarSearch', async (req, res) => {
    try {
        const searcherUID = req.body.UID;
        const selectedPlayersUID = req.body.selectedPlayersUID;
        const clanId = req.body.cid;

        //console.log(selectedPlayersUID);
        // Check auth uid
        if (searcherUID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Check if all parameters are defined
        if (!searcherUID || !selectedPlayersUID || !clanId) {
            throw new Error("All parameters are required.");
        }

        const result = await ClanLock.getInstance().run(clanId, async () => {
            return await clanHandler.clanWarSearch(searcherUID, selectedPlayersUID, clanId);
        });

        return res.status(200).json(result);

    } catch (error) {
        console.error("Error in clanWarSearch:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});


// 11
router.post('/sendClanJoinInviteNotification', async (req, res) => {
    try {
        const senderUID = req.body.senderUID;
        const receiverUID = req.body.receiverUID;
        const clanId = req.body.cid;

        //check auth uid
        if (senderUID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const result = await clanHandler.sendClanJoinInviteNotification(senderUID, receiverUID, clanId);

        return res.status(200).json(result);

    } catch (error) {
        console.error("Error in sendClanJoinInviteNotification:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});



// 12
router.post('/acceptRejectClanJoinInviteNotification', async (req, res) => {
    try {
        const { UID, notificationId, isAccepted } = req.body;

        //check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }


        const result = await UserLock.getInstance().run(UID, async () => {
            return await clanHandler.acceptRejectClanJoinInviteNotification(UID, notificationId, isAccepted);
        });


        return res.status(200).json(result);
    } catch (error) {
        console.error("Error in acceptRejectClanJoinInviteNotification:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});


// 13
router.post('/voiceMessage', async (req, res) => {
    try {
        const uid = req.body.UID;
        const base64audio = req.body.base64audio;
        const cid = req.body.cid;

        if (uid == null || base64audio == null ) {
            return res.status(400).json({ success: false, message: 'UID and Other Data are required.' });
        }

        //check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const result = await ClanLock.getInstance().run(cid, async () => {
            return await clanHandler.clanVoiceMessage(uid, base64audio, cid,req);
        });

        return res.status(200).json(result);

    } catch (error) {
        console.error("Error in voiceMessage:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});



module.exports = router;
