const express = require('express');
const AES = require("../utils/AES_256");
const { getFacebookAccount} = require("../utils/facebookUtils");
const UserLock = require('../utils/Lock/UserLock');

const router = express.Router();

router.post('/', async (req, res) => {
    try {
        const UID  = req.body.UID;
        const ENC  = req.body.ENC;
        const idToken = req.body.idToken;
        const userId = req.body.facebookId;
        
        //AUTH verification
        if(!AES.validateEncryptedCredentialByUID(ENC,UID)){                 
            console.error("Error in loginFromFacebook:", "Not valid");
            return res.status(400).json({ success: false, message: "Not valid" });
        }

        const existingFacebookAccount = await getFacebookAccount(idToken, UID,userId);
        if (existingFacebookAccount) {
            return res.status(200).json({ success: true, UID: existingFacebookAccount.UID , ENC : existingFacebookAccount.ENC });
        } else {
            return res.status(200).json({ success: false, UID: existingFacebookAccount.UID , ENC : existingFacebookAccount.ENC });
        }
    } catch (error) {
        console.error("Error in loginFromFacebook:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }
});

module.exports = router;
