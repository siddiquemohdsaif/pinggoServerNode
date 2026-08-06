const express = require('express');
const { getOthersProfileAndGameData, getOthersProfileAndGameDataBulk, getMemberDetailsList, getOthersProfileAndGameDataWithClan } = require('../utils/GetUsersDataHandler'); 
const AES = require("../utils/AES_256");
const router = express.Router();

router.post('/profileAndGameData', async (req, res) => {
    try {
        const uid = req.body.UID;
        const profileUid = req.body.profileUid;

        // Check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const data = await getOthersProfileAndGameData(uid, profileUid);
        res.status(200).json(data);
    } catch (error) {
        console.error("Error in profileAndGameData:", error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/profileAndGameDataWithClan', async (req, res) => {
    try {
        const uid = req.body.UID;
        const profileUid = req.body.profileUid;

        // Check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const data = await getOthersProfileAndGameDataWithClan(uid, profileUid);
        res.status(200).json(data);
    } catch (error) {
        console.error("Error in profileAndGameDataWithClan:", error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});



router.post('/profileAndGameDataBulk', async (req, res) => {
    try {
        const uid = req.body.UID;
        const uids = req.body.UIDS;
        const projection = req.body.projection;

        // Check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const data = await getOthersProfileAndGameDataBulk(uids, projection);
        res.status(200).json(data);
    } catch (error) {
        console.error("Error in profileAndGameDataBulk:", error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});


router.post('/memberDetailsList', async (req, res) => {
    try {
        const uid = req.body.UID;
        const memberIds = req.body.memberIds;

        // Check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const data = await getMemberDetailsList(uid, memberIds);
        res.status(200).json(data);
    } catch (error) {
        console.error("Error in memberDetailsList:", error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
