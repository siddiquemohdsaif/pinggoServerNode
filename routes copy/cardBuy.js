const express = require('express');
const { buyStrikerCards, buyPowerCards, buyAimCards} = require('../utils/CardBuyHandler');
const router = express.Router();
const AES = require("../utils/AES_256");
const UserLock = require('../utils/Lock/UserLock');

router.post('/striker', async (req, res) => {
    try {
        // Extract the necessary data from the request body
        const { UID, strikerId, noOfCards } = req.body;

        // Validate the payload
        if (!UID || strikerId == null || noOfCards == null) {
            return res.status(400).json({
                success: false,
                message: 'All required fields are not provided.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Upgrade the striker
        const strikerInfo = await UserLock.getInstance().run(UID, async () => {
            return await buyStrikerCards(UID, strikerId,noOfCards);
        });

        // Respond with the updated strikerInfo
        return res.status(200).json(strikerInfo);

    } catch (error) {
        console.error("Error in buyStrikerCards:", error.message);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


router.post('/power', async (req, res) => {
    try {
        // Extract the necessary data from the request body
        const { UID, powerId, noOfCards } = req.body;

        // Validate the payload
        if (!UID || powerId == null || noOfCards == null) {
            return res.status(400).json({
                success: false,
                message: 'All required fields are not provided.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Upgrade the power
        const powerInfo = await UserLock.getInstance().run(UID, async () => {
            return await buyPowerCards(UID, powerId, noOfCards);
        });

        // Respond with the updated powerInfo
        return res.status(200).json(powerInfo);

    } catch (error) {
        console.error("Error in buyPowerCards:", error.message);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});




router.post('/aim', async (req, res) => {
    try {
        // Extract the necessary data from the request body
        const { UID, aimId, noOfCards, isBetweenMatch } = req.body;

        // Validate the payload
        if (!UID || aimId == null || noOfCards == null || isBetweenMatch == null) {
            return res.status(400).json({
                success: false,
                message: 'All required fields are not provided.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // increase aim cards
        const aimInfo = await UserLock.getInstance().run(UID, async () => {
            return await buyAimCards(UID, aimId, noOfCards, isBetweenMatch);
        });

        // Respond with the updated aimInfo
        return res.status(200).json(aimInfo);

    } catch (error) {
        console.error("Error in buyAimCards:", error.message);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


module.exports = router;
