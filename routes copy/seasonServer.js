const express = require('express');
const SeasonHandler = require("../utils/SeasonHandler.js");
const router = express.Router();

router.post('/give-rewards-and-set-result', async (req, res) => {
    try {

        const topPlayersCompressString = req.body.topPlayersCompressString;
        const topClansCompressString = req.body.topClansCompressString;
        const rewardUids = req.body.rewardUids;
        const rewardCids = req.body.rewardCids;

        // Validation for undefined or null values
        if (topPlayersCompressString == null || topClansCompressString == null || rewardUids == null || rewardCids == null) {
            return res.status(400).json({ success: false, message: 'One or more required fields are undefined or null' });
        }

        // makeMatch
        await SeasonHandler.giveRewardAndSetPastResult(topPlayersCompressString, topClansCompressString, rewardUids, rewardCids);// lock is inside this

        return res.status(200).json({ success: true, message: "given rewards and set result successfully"});

    } catch (error) {
        console.error("Error in give-rewards-and-set-result :", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});



module.exports = router;