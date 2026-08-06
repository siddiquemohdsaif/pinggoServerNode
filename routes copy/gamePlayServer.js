const express = require('express');
const gameHandler = require("../utils/GameHandler");
const router = express.Router();
const UserLock = require('../utils/Lock/UserLock');

router.post('/game-over', async (req, res) => {
    try {
        const UID1 = req.body.UID1;
        const UID2 = req.body.UID2;
        const winner = req.body.winner;
        const map = req.body.map;
        const gameId = req.body.gameId;
        const p1PowerMeter = req.body.p1PowerMeter;
        const p2PowerMeter = req.body.p2PowerMeter;

        const p1TrophyWin = req.body.p1TrophyWin;
        const p1TrophyLose = req.body.p1TrophyLose;
        const p2TrophyWin = req.body.p2TrophyWin;
        const p2TrophyLose = req.body.p2TrophyLose;
        const isPlayer1InWar = req.body.isPlayer1InWar;
        const isPlayer2InWar = req.body.isPlayer2InWar;
        const playerExtraInfo1 = JSON.parse(req.body.playerExtraInfo1);
        const playerExtraInfo2 = JSON.parse(req.body.playerExtraInfo2);
        const gameType1 = playerExtraInfo1.gameType;
        const gameType2 = playerExtraInfo2.gameType;

        console.log(UID1,gameType1);
        console.log(UID2,gameType2);

        console.log("gameId:" + gameId)

        // Validation for undefined or null values
        if (UID1 == null || UID2 == null || winner == null || 
            map == null || isPlayer1InWar == null || isPlayer2InWar == null || p1TrophyWin == null || p1TrophyLose == null || 
            p2TrophyWin == null || p2TrophyLose == null || gameType1 == null || gameType2 == null || gameId == null ) {
            return res.status(400).json({ success: false, message: 'One or more required fields are undefined or null' });
        }

        // Call game handler method to process the game over logic with lock on both userProfile
        const result = await UserLock.getInstance().runMultiple([UID1, UID2], async () => {
            return await gameHandler.processGameOver(UID1, UID2, winner, map, p1TrophyWin, p1TrophyLose, p2TrophyWin, p2TrophyLose, isPlayer1InWar, isPlayer2InWar, gameType1, gameType2, gameId, p1PowerMeter, p2PowerMeter);
        });


        if (result) {
            return res.status(200).json({ success: true, message: "Game over processed successfully"});
        } else {
            return res.status(400).json({ success: false, message: "Failed to process game over" });
        }

    } catch (error) {
        console.error("Error in game-over :", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/game-start', async (req, res) => {
    try {
        // Extract relevant data from request body
        const UID1 = req.body.UID1;
        const UID2 = req.body.UID2;
        const map = req.body.map;

        // Validation for undefined or null values
        if (UID1 == null || UID2 == null || map == null) {
            return res.status(400).json({ success: false, message: 'One or more required fields are undefined or null' });
        }

        // Call game handler method to process the game start logic with lock on both userProfile
        const result = await UserLock.getInstance().runMultiple([UID1, UID2], async () => {
            return await gameHandler.processGameStart(UID1, UID2, map);
        });
        

        if (result && result.success) {
            return res.status(200).json({ success: true, message: result.message });
        } else {
            return res.status(400).json({ success: false, message: "Failed to process game start" });
        }

    } catch (error) {
        console.error("Error in /game-start:", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});


module.exports = router;
