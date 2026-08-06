const express = require('express');
const UserDataModifier = require("../utils/UserDataModifier");
const AES = require("../utils/AES_256");
const userDataModifier = new UserDataModifier();
const router = express.Router();


router.post('/', async (req, res) => {
    try {
        const uid = req.body.UID;
        const stars = req.body.stars;
        const review = req.body.review;
        const cc_id = req.body.cc_id;

        if (!uid || !stars || !review || !cc_id) {
            //console.log(uid +"," + stars +"," + review +"," + cc_id);
            return res.status(400).json({ success: false, message: 'all param are required.' });
        }

        //check auth uid
        if (uid !== AES.getAuthUid(req)) {
            return res.status(401).json({ success: false, message: 'Authorization failed' });
        }

        const result = await userDataModifier.sendReview(uid, stars, review, cc_id);

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