const express = require('express');
const leaderboardHandler = require("../utils/LeaderboardHandler");
const router = express.Router();

router.post('/get-top-players', async (req, res) => {
    try {
        const from = parseInt(req.body.from) || 0;
        const to = parseInt(req.body.to) || 100;
        const uid = req.body.uid;

        const topPlayers = await leaderboardHandler.getTopPlayers(from, to, uid);
        
        if (topPlayers && topPlayers.length > 0) {
            return res.status(200).json({ players: topPlayers });
        } else {
            return res.status(404).json({ success: false, message: "No players found" });
        }
    } catch (error) {
        console.error("Error in get-top-players:", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/get-top-players-fresh', async (req, res) => {
    try {
        const from = parseInt(req.body.from) || 0;
        const to = parseInt(req.body.to) || 100;
        const uid = "null";

        const topPlayers = await leaderboardHandler.getTopPlayersFresh(from, to, uid);
        
        if (topPlayers && topPlayers.length > 0) {
            return res.status(200).json({ players: topPlayers });
        } else {
            return res.status(404).json({ success: false, message: "No players found" });
        }
    } catch (error) {
        console.error("Error in get-top-players:", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/get-top-clans', async (req, res) => {
    try {
        const from = parseInt(req.body.from) || 0;
        const to = parseInt(req.body.to) || 100;
        const cid = req.body.cid;

        const topClans = await leaderboardHandler.getTopClans(from, to, cid);
        
        if (topClans && topClans.length > 0) {
            return res.status(200).json({ clans: topClans });
        } else {
            return res.status(404).json({ success: false, message: "No clans found" });
        }
    } catch (error) {
        console.error("Error in get-top-clans:", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});


router.post('/get-top-clans-fresh', async (req, res) => {
    try {
        const from = parseInt(req.body.from) || 0;
        const to = parseInt(req.body.to) || 100;
        const cid = "null";

        const topClans = await leaderboardHandler.getTopClansFresh(from, to, cid);
        
        if (topClans && topClans.length > 0) {
            return res.status(200).json({ clans: topClans });
        } else {
            return res.status(404).json({ success: false, message: "No clans found" });
        }
    } catch (error) {
        console.error("Error in get-top-clans:", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});


module.exports = router;
