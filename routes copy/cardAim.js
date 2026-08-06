const express = require('express');
const { buyStrikerCards, buyPowerCards, deductAimCards } = require('../utils/CardBuyHandler');
const router = express.Router();
const AES = require("../utils/AES_256");
const UserLock = require('../utils/Lock/UserLock');

router.post('/deduct', async (req, res) => {
    try {
        // Extract the necessary data from the request body
        const { UID, aim1, aim2, aim3 } = req.body;

        // Validate the payload
        if (!UID || aim1 == null || aim2 == null || aim3 == null) {
            return res.status(400).json({
                success: false,
                message: 'All required fields are not provided.'
            });
        }

        // Check auth uid
        if (UID !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        // deduct
        const result = await UserLock.getInstance().run(UID, () =>
            deductAimCards(UID, { 1: aim1, 2: aim2, 3: aim3 })
        );

        return res.status(200).json({ success: true, ...result });
    } catch (error) {
        console.error("Error in deductAimCards:", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }
});



module.exports = router;
