const express = require('express');
const { upgradeStriker, upgradePower, upgradePuck, upgradeTrail } = require('../utils/CardUpgradeHandler');
const router = express.Router();
const AES = require("../utils/AES_256");
const UserLock = require('../utils/Lock/UserLock');

router.post('/striker', async (req, res) => {
    try {
        // Extract the necessary data from the request body
        const { UID, strikerId } = req.body;

        // Validate the payload
        if (!UID || strikerId == null) {
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
            return await upgradeStriker(UID, strikerId);
        });

        // Respond with the updated strikerInfo
        return res.status(200).json(strikerInfo);

    } catch (error) {
        console.error("Error in upgradeStriker:", error.message);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


router.post('/power', async (req, res) => {
    try {
        // Extract the necessary data from the request body
        const { UID, powerId } = req.body;

        // Validate the payload
        if (!UID || powerId == null) {
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
            return await upgradePower(UID, powerId);
        });

        // Respond with the updated powerInfo
        return res.status(200).json(powerInfo);

    } catch (error) {
        console.error("Error in upgradePower:", error.message);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.post('/puck', async (req, res) => {
    try {
        // Extract the necessary data from the request body
        const { UID, puckId } = req.body;

        // Validate the payload
        if (!UID || puckId == null) {
            return res.status(400).json({
                success: false,
                message: 'All required fields are not provided.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Upgrade the puck
        const puckInfo = await UserLock.getInstance().run(UID, async () => {
            // Replace 'upgradePuck' with the actual function to upgrade the puck
            return await upgradePuck(UID, puckId); 
        });

        // Respond with the updated puckInfo
        return res.status(200).json(puckInfo);

    } catch (error) {
        console.error("Error in upgradePuck:", error.message);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


router.post('/trail', async (req, res) => {
    try {
        // Extract the necessary data from the request body
        const { UID, trailId } = req.body;

        // Validate the payload
        if (!UID || trailId == null) {
            return res.status(400).json({
                success: false,
                message: 'All required fields are not provided.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Upgrade the trail
        const trailInfo = await UserLock.getInstance().run(UID, async () => {
            // Replace 'upgradeTrail' with the actual function to upgrade the trail
            return await upgradeTrail(UID, trailId); 
        });

        // Respond with the updated trailInfo
        return res.status(200).json(trailInfo);

    } catch (error) {
        console.error("Error in upgradeTrail:", error.message);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = router;
