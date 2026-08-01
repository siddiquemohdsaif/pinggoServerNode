class UserModel {
    constructor(phoneNumber, profileData, encryptedCredential) {
        this.phoneNumber = phoneNumber;
        this.profileData = profileData;
        this.encryptedCredential = encryptedCredential;
        this.createdAt = Date.now();
        this.lastSeen = Date.now();
    }
}

module.exports = UserModel;
