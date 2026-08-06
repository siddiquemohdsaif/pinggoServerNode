const express = require('express');
const matchMaker = require("../utils/ClanHandler/matchMaker");
const resultMaker = require("../utils/ClanHandler/resultMaker");
const router = express.Router();

router.post('/makeMatch', async (req, res) => {
    try {
        const clansWarList = req.body.clansWarList;
        const warStartTime = req.body.warStartTime;

        // Validation for undefined or null values
        if (clansWarList == null || warStartTime == null) {
            return res.status(400).json({ success: false, message: 'One or more required fields are undefined or null' });
        }

        // makeMatch
        await matchMaker.makeMatch(clansWarList, warStartTime); // no need for lock (onGoing create and clan.warState update(not conflict))

        return res.status(200).json({ success: true, message: "makeMatch successfully done"});

    } catch (error) {
        console.error("Error in makeMatch :", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});



router.post('/makeResult', async (req, res) => {
    try {
        const warDoc = req.body.warDoc;

        // Validation for undefined or null warDoc
        if (warDoc == null) {
            return res.status(400).json({ success: false, message: 'One or more required fields are undefined or null' });
        }

        // makeResult
        await resultMaker.makeResult(warDoc); // lock need for and user(reward chest) and ongoing delete ,  not for  clan(warId push)  and  finish war: it implemented inside a ClanHandler

        return res.status(200).json({ success: true, message: "makeResult successfully"});


    } catch (error) {
        console.error("Error in makeResult :", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});


module.exports = router;