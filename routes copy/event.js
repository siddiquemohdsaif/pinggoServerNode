const express = require('express');
const router = express.Router();
const AES = require("../utils/AES_256");
const GameEventHandler = require('../utils/GameEventHandler');

router.post("/joinEvent", async (req, res) => {
    try {
        const UID = req.body.UID;
        const eventId = req.body.eventId;
        const trophy = req.body.trophy;
        const xp = req.body.xp;

        // Validation for undefined or null values
        if (UID == null || eventId == null || trophy == null || xp == null) {
            return res.status(400).json({ success: false, message: 'One or more required fields are undefined or null' });
        }

        //check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const response = await GameEventHandler.joinEvent(UID, trophy, eventId,xp);
        if (response.success) {
            return res.status(200).json(response);
        } else {
            return res.status(400).json(response);
        }

    } catch (error) {
        console.error("Error in game-over :", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});


router.post("/getEventTopPlayers", async (req, res) => {
    try {

        const UID = req.body.UID;
        const eventId = req.body.eventId;

        // Validation for undefined or null values
        if (UID == null || eventId == null) {
            return res.status(400).json({ success: false, message: 'One or more required fields are undefined or null' });
        }

        //check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const response = await GameEventHandler.getTopPlayerofEvent(UID, eventId);
        if (response.success) {
            return res.status(200).json(response);
        } else {
            return res.status(400).json(response);
        }

    } catch (error) {
        console.error("Error in eventData :", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});


router.post("/claimReward", async (req, res) => {
    try {
        // console.log(`[ClaimReward API] START | IP: ${req.ip} | UID: ${req.body.UID} | resultKey: ${req.body.resultKey} | details: ${JSON.stringify(req.body.details)}`);

        const UID = req.body.UID;
        const resultKey = req.body.resultKey;
        const details = req.body.details;

        // Validation for undefined or null values
        if (UID == null || resultKey == null) {
            console.error(`[ClaimReward API] VALIDATION FAILED | Reason: Missing UID or resultKey | UID: ${UID} | resultKey: ${resultKey}`);
            return res.status(400).json({ success: false, message: 'One or more required fields are undefined or null' });
        }

        // Check auth UID
        const authUid = AES.getAuthUid(req);
        if (UID !== authUid) {
            console.error(`[ClaimReward API] AUTH FAILED | Provided UID: ${UID} | Expected UID: ${authUid}`);
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }
        // console.log(`[ClaimReward API] AUTH PASSED | UID verified`);

        // Call GameEventHandler.claimReward
        // console.log(`[ClaimReward API] Calling GameEventHandler.claimReward for UID: ${UID}, resultKey: ${resultKey}`);
        const response = await GameEventHandler.claimReward(UID, resultKey, details);

        // Handle response
        if (response.success) {
            // console.log(`[ClaimReward API] SUCCESS | UID: ${UID} | Reward claimed successfully | Response: ${JSON.stringify(response)}`);
            return res.status(200).json(response.document || response);
        } else {
            console.error(`[ClaimReward API] FAILED | UID: ${UID} | Reason: ${response.message}`);
            return res.status(400).json(response);
        }

    } catch (error) {
        console.error(`[ClaimReward API] ERROR | UID: ${req.body?.UID} | resultKey: ${req.body?.resultKey} | Message: ${error.message} | Stack: ${error.stack}`);
        return res.status(500).json({ success: false, message: error.message });
    }
});



router.post("/activeClashReward", async (req, res) => {
    try {

        const UID = req.body.UID;
        const eventId = req.body.eventId;
        const isAd = req.body.isAd;
        const itemNumber = req.body.itemNumber;


        // Validation for undefined or null values
        if (UID == null || isAd == null || itemNumber == null || eventId == null) {
            return res.status(400).json({ success: false, message: 'One or more required fields are undefined or null' });
        }

        //check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const response = await GameEventHandler.activeClashReward(UID, eventId, isAd, itemNumber);
        if (response.success) {
            return res.status(200).json(response.userData);
        } else {
            return res.status(400).json(response);
        }

    } catch (error) {
        console.error("Error in activeClashReward :", error.message);
        return res.status(500).json(error.message);
    }
});

router.post("/weeklyTournamentRankList", async (req, res) => {
    try {

        const UID = req.body.UID;
        const previousRank = req.body.previousRank;

        // Validation for undefined or null values
        if (UID == null) {
            return res.status(400).json({ success: false, message: 'One required fields are undefined or null' });
        }

        //check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const rankData = await GameEventHandler.getWeeklyTournamentRankNumber(UID);
        const currentRank = rankData.document;
        let isGreater;
        if (previousRank === null) {
            isGreater = true;
        } else {
            isGreater = (previousRank >= currentRank) ? true : false;
        }
        if (previousRank === 0) {
            isGreater = true;
        }
        const response = await GameEventHandler.getWeeklyTournamentRankList(UID, isGreater);
        if (response.success) {
            return res.status(200).json(response.document);
        } else {
            return res.status(400).json(response);
        }

    } catch (error) {
        console.error("Error in eventData :", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});


router.post("/weeklyTournamentRankNumber", async (req, res) => {
    try {

        const UID = req.body.UID;

        // Validation for undefined or null values
        if (UID == null) {
            return res.status(400).json({ success: false, message: 'One required fields are undefined or null' });
        }

        //check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const response = await GameEventHandler.getWeeklyTournamentRankNumber(UID);
        if (response.success) {
            return res.status(200).json(response.document);
        } else {
            return res.status(400).json(response);
        }

    } catch (error) {
        console.error("Error in eventData :", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;