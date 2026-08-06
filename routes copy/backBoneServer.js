const express = require('express');
const clanHandler = require("../utils/ClanHandler");
const router = express.Router();
const UserDataModifier = require("../utils/UserDataModifier");
const userDataModifier = new UserDataModifier();
const UserLock = require('../utils/Lock/UserLock');
const GameEventHandler = require('../utils/GameEventHandler');

router.post('/playerConnected', async (req, res) => {
    try {
        const UID = req.body.UID;
        const cid = req.body.cid;


        // Validation for undefined or null values
        if (UID == null) {
            return res.status(400).json({ success: false, message: 'One or more required fields are undefined or null' });
        }

        await GameEventHandler.getActiveClashData(UID);

        const updatedDocUser = await UserLock.getInstance().run(UID, async () => {
            return await userDataModifier.updateLastSeen(UID, -Date.now(),true);
        });

        if(cid !== "null"){
            const LT = -Date.now(); // lastSeen
            const clan = await clanHandler.clanMemberLastSeenUpdate(UID, cid, LT); // lock handled internally
            return res.status(200).json({clan,updatedDocUser});
        }else{
            return res.status(200).json({updatedDocUser});
        }

    } catch (error) {
        console.error("Error in playerConnected :", error.message);
        return res.status(500).json({ success: false, message: error.message }); // not throw error in statuscode , chance of player leaved the clan
    }
});



router.post('/playerDisconnect', async (req, res) => {
    try {
        const UID = req.body.UID;
        const cid = req.body.cid;


        // Validation for undefined or null values
        if (UID == null) {
            return res.status(400).json({ success: false, message: 'One or more required fields are undefined or null' });
        }

        const updatedDocUser = await UserLock.getInstance().run(UID, async () => {
            return await userDataModifier.updateLastSeen(UID, Date.now());
        });

        if(cid !== "null"){
            const LT = Date.now(); // lastSeen
            const clan = await clanHandler.clanMemberLastSeenUpdate(UID, cid, LT); // lock handled internally
            return res.status(200).json({clan,updatedDocUser});
        }else{
            return res.status(200).json({updatedDocUser});
        }

    } catch (error) {
        //console.error("Error in playerDisconnect :", error.message);
        return res.status(500).json({ success: false, message: error.message }); // not throw error in statuscode,  chance of player leaved the clan
    }
});


module.exports = router;
