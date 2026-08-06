const express = require('express');
const { premiumchestBuy, coinsBuy, coinsBuyFlexible, currentOpenChestFulfillment,getSupportChest, freeChestUnlock, freeChestCompleteRemainingTimeByGems, freeChestOpenNowByGems, tapOpenFreeChest, claimClanWarReward,reduceChestOpeningTime} = require('../utils/ShopHandler');
const router = express.Router();
const AES = require("../utils/AES_256");
const UserLock = require('../utils/Lock/UserLock');

router.post('/buyCoins', async (req, res) => {
    try {
        // Extract the necessary data from the request body
        const { UID, coinsId } = req.body;

        // Validate the payload
        if (!UID || !coinsId) {
            return res.status(400).json({
                success: false,
                message: 'All required fields are not provided.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Process the coins purchase
        const profileData = await UserLock.getInstance().run(UID, async () => {
            return await coinsBuy(UID, coinsId);
        });

        // Respond with the updated profile data
        return res.status(200).json(profileData);

    } catch (error) {
        console.error("Error in coinsBuy:", error.message);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.post('/buyCoinsFlexible', async (req, res) => {
    try {
        // Extract the necessary data from the request body
        const { UID, coins } = req.body;

        // Validate the payload
        if (!UID || !coins) {
            return res.status(400).json({
                success: false,
                message: 'All required fields are not provided.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Process the coins purchase
        const profileData = await UserLock.getInstance().run(UID, async () => {
            return await coinsBuyFlexible(UID, coins);
        });

        // Respond with the updated profile data
        return res.status(200).json(profileData);

    } catch (error) {
        console.error("Error in coinsBuy:", error.message);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.post('/buyPremiumChest', async (req, res) => {
    try {
        // Extract the necessary data from the request body
        const { UID, premiumChestId } = req.body;

        // Validate the payload
        if (!UID || premiumChestId == null) {
            return res.status(400).json({
                success: false,
                message: 'All required fields are not provided.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Process the premiumchestBuy purchase
        const profileData = await UserLock.getInstance().run(UID, async () => {
            return await premiumchestBuy(UID, premiumChestId);
        });

        // Respond with the updated profile data
        return res.status(200).json(profileData);

    } catch (error) {
        console.error("Error in buyPremiumChest:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});



router.post('/getSupportChest', async (req, res) => {
    try {
        // Extract the necessary data from the request body
        const { UID, chestType } = req.body;

        // Validate the payload
        if (!UID || chestType == null) {
            return res.status(400).json({
                success: false,
                message: 'All required fields are not provided.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Process the premiumchestBuy purchase
        const profileData = await UserLock.getInstance().run(UID, async () => {
            return await getSupportChest(UID, chestType);
        });

        // Respond with the updated profile data
        return res.status(200).json(profileData);

    } catch (error) {
        console.error("Error in buyPremiumChest:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});




router.post('/unlockFreeChest', async (req, res) => {
    try {
        // Extract UID and ChestID from the request body
        const { UID, chestId } = req.body;

        // Validate the payload
        if (!UID || chestId === undefined) {
            return res.status(400).json({
                success: false,
                message: 'UID and chestId are required.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Process the unlocking of the free chest
        const profileData = await UserLock.getInstance().run(UID, async () => {
            return await freeChestUnlock(UID, chestId);
        });

        // Respond with the updated profile data
        return res.status(200).json(profileData);

    } catch (error) {
        console.error("Error in unlockFreeChest:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.post('/reduceChestOpeningTime', async (req, res) => {
    try {
        // Extract UID and ChestID from the request body
        const { UID, chestId } = req.body;

        // Validate the payload
        if (!UID || chestId === undefined) {
            return res.status(400).json({
                success: false,
                message: 'UID and chestId are required.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Process the unlocking of the free chest
        const profileData = await UserLock.getInstance().run(UID, async () => {
            return await reduceChestOpeningTime(UID, chestId);
        });

        // Respond with the updated profile data
        return res.status(200).json(profileData);

    } catch (error) {
        console.error("Error in unlockFreeChest:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

router.post('/completeFreeChestRemainingTimeByGems', async (req, res) => {
    try {
        // Extract UID and ChestID from the request body
        const { UID, chestId } = req.body;

        // Validate the payload
        if (!UID || chestId === undefined) {
            return res.status(400).json({
                success: false,
                message: 'UID and chestId are required.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Process the completion of chest unlock using gems
        const updatedProfileData = await UserLock.getInstance().run(UID, async () => {
            return await freeChestCompleteRemainingTimeByGems(UID, chestId);
        });

        // Respond with the updated profile data
        return res.status(200).json(updatedProfileData);

    } catch (error) {
        console.error("Error in completeChestUnlockWithGems:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


router.post('/openFreeChestNowByGems', async (req, res) => {
    try {
        // Extract UID and ChestID from the request body
        const { UID, chestId } = req.body;

        // Validate the payload
        if (!UID || chestId === undefined) {
            return res.status(400).json({
                success: false,
                message: 'UID and chestId are required.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Process the immediate unlocking of the chest using gems
        const updatedProfileData = await UserLock.getInstance().run(UID, async () => {
            return await freeChestOpenNowByGems(UID, chestId);
        });

        // Respond with the updated profile data
        return res.status(200).json(updatedProfileData);

    } catch (error) {
        console.error("Error in openFreeChestNowByGems:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


router.post('/tapOpenFreeChest', async (req, res) => {
    try {
        // Extract UID and ChestID from the request body
        const { UID, chestId } = req.body;

        // Validate the payload
        if (!UID || chestId === undefined) {
            return res.status(400).json({
                success: false,
                message: 'UID and chestId are required.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Process the fulfillment of the free chest
        const profileData = await UserLock.getInstance().run(UID, async () => {
            return await tapOpenFreeChest(UID, chestId);
        });

        // Respond with the updated profile data
        return res.status(200).json(profileData);

    } catch (error) {
        console.error("Error in fulfillFreeChest:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});



router.post('/currentOpenChestFulfillment', async (req, res) => {
    try {
        // Extract the necessary data from the request body
        const { UID } = req.body;

        // Validate the payload
        if (!UID) {
            return res.status(400).json({
                success: false,
                message: 'UID is required.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Process the fulfillment of the premium chest
        const profileData = await UserLock.getInstance().run(UID, async () => {
            return await currentOpenChestFulfillment(UID);
        });

        // Respond with the updated profile data
        return res.status(200).json(profileData);

    } catch (error) {
        console.error("Error in fulfillmentCurrentOpenChest:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


router.post('/clanWarRewardTap', async (req, res) => {
    try {
        // Extract UID from the request body
        const { UID } = req.body;

        // Validate the payload
        if (!UID) {
            return res.status(400).json({
                success: false,
                message: 'UID is required.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // Process the clan war reward claim
        const rewardData = await UserLock.getInstance().run(UID, async () => {
            return await claimClanWarReward(UID);
        });

        // Respond with the reward data
        return res.status(200).json(rewardData);

    } catch (error) {
        console.error("Error in clanWarRewardTap:", error);
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});



module.exports = router;
