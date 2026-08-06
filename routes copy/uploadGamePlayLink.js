const express = require('express');
const UserDataModifier = require("../utils/UserDataModifier");
const AES = require("../utils/AES_256");
const userDataModifier = new UserDataModifier();
const router = express.Router();
const UserLock = require('../utils/Lock/UserLock');


router.post('/', async (req, res) => {
    try {
        const uid = req.body.UID;
        const link = req.body.link;


        if (!uid || !link) {
            return res.status(400).json({ success: false, message: 'all param are required.' });
        }

        //check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const result = await userDataModifier.uploadGamePlayLink(uid, link);

        if (result) {
            return res.status(200).json(result);
        } else {
            return res.status(400).json({ success: false, message: "Unable to upload link." });
        }
    } catch (error) {
        console.error("Error in upload link:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});


module.exports = router;