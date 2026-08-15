const FirestoreManager = require("./Firestore/FirestoreManager");
const db = FirestoreManager.getInstance();


const createNewAppConfig = async (oldAppConfigVersion, newAppConfigVersion) => {


    let document;
    try {
        document = await db.readDocument("AppConfiguration", `AppConfiguration_v_${oldAppConfigVersion}`, "/");
    } catch (error) {
        console.log(error);
        throw new Error(`Failed to read document: ${error.message}`);
    }

    delete document._id;

    await db.createDocument("AppConfiguration", `AppConfiguration_v_${newAppConfigVersion}`, "/", document);

    let newDocument = await db.readDocument("AppConfiguration", `AppConfiguration`, "/");
    if (newDocument) {
        delete newDocument._id;
        let config = newDocument.configs || [];
        config.push(`AppConfiguration_v_${newAppConfigVersion}`);
        newDocument.configs = config;

        await db.updateDocument("AppConfiguration", `AppConfiguration`, "/", newDocument);
    } else {
        console.log(`No document found with ID 'AppConfiguration'`);
    }

    console.log("done");
}

createNewAppConfig("1_1_1", "1_1_2")
