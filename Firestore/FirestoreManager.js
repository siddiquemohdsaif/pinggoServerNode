const axios = require("axios");
const http = require("http");
const https = require("https");
const { validateDocumentName, validateCollectionName } = require("./Validator");
require('dotenv').config();
let config;
if (process.env.PRODUCTION_TYPE === "release") {
  config = require("./config-cloudsw3.json");
} else {
  config = require("./config-cloudsw3_dev.json");
}



// Create HTTP and HTTPS agents with keepAlive set to true
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

class FirestoreManager {
  constructor() {
    this.baseURL = config.appUrl + "/rest-api/";
    const headers = {
      "Content-Type": "application/json",
    };

    if (config.authorizationToken) {
      headers["Authorization"] = "Bearer " + config.authorizationToken;
    }

    this.instance = axios.create({
      baseURL: this.baseURL,
      headers: headers,
      httpAgent: httpAgent,
      httpsAgent: httpsAgent
    });
  }

  static getInstance() {
    if (!this._instance) {
      this._instance = new FirestoreManager();
    }
    return this._instance;
  }




  /**
 * Creates a new document in the specified Firestore collection.
 *
 * @param {string} collName - The name of the Firestore collection.
 * @param {string} docName - The ID of the document to be created.
 * @param {string} parentPath - The path to the parent document or collection.
 * @param {Object} document - The content of the document to be created.
 *
 * @throws {Error} Throws an error if validation fails or if a server error occurs.
 *
 * @returns {Promise<Object>} Returns a promise that resolves with the created document's result report.
 */
  async createDocument(collName, docName, parentPath, document) {
    validateCollectionName(collName);
    validateDocumentName(docName);

    if (Object.prototype.hasOwnProperty.call(document, "_id")) {
      throw new Error("document class should not have '_id' field.");
    }

    document._id = docName;
    const body = JSON.stringify(document);

    try {
      const response = await this.instance.post(
        `cr?collName=${collName}&parentPath=${parentPath}`,
        body,
        { headers: { "Content-Type": "application/json" } }
      );
      return response.data;
    } catch (error) {
      throw new Error(error.message);
    }
  }





  /**
 * Reads a document from the specified Firestore collection.
 *
 * @param {string} collName - The name of the Firestore collection.
 * @param {string} docName - The ID of the document to be read.
 * @param {string} parentPath - The path to the parent document or collection.
 *
 * @throws {Error} Throws an error if validation fails or if a server error occurs.
 *
 * @returns {Promise<Object>} Returns a promise that resolves with the read document's data.
 */
  async readDocument(collName, docName, parentPath) {
    validateCollectionName(collName);
    validateDocumentName(docName);

    try {
      const response = await this.instance.get(
        `rd?parentPath=${parentPath}&collName=${collName}&docName=${docName}`
      );
      return response.data;
    } catch (error) {
      throw new Error(error.message);
    }
  }


  /**
  * Reads a document from the specified Firestore collection with the specified projection.
  *
  * @param {string} collName - The name of the Firestore collection.
  * @param {string} docName - The ID of the document to be read.
  * @param {string} parentPath - The path to the parent document or collection.
  * @param {Object} projection - An object specifying which fields of the document to return.
  *                              For each field you want to return, set its value to 1.
  *
  * @throws {Error} Throws an error if validation fails, if `projection` is not a valid object, 
  *                 or if a server error occurs.
  *
  * @returns {Promise<Object>} Returns a promise that resolves with the read document's data containing only 
  *                            the fields specified in the `projection`. 
  */
  async readDocumentWithProjection(collName, docName, parentPath, projection) {

    // Use the bulkReadDocuments method to get the document with projection
    const docs = await this.bulkReadDocuments(collName, parentPath, [docName], projection);

    // Return the first (and only) document from the result
    return docs[0];
  }

  /**
   * Reads the IDs of all documents within the specified Firestore collection.
   *
   * @param {string} collName - The name of the Firestore collection.
   * @param {string} parentPath - The path to the parent document or collection.
   *
   * @throws {Error} Throws an error if `collName` is invalid or if a server error occurs.
   *
   * @returns {Promise<string[]>} Returns a promise that resolves with an array of document IDs from the specified collection.
   *
   * @example
   * const collName = "Users";
   * const parentPath = "/";
   * 
   * firestoreManager.readCollectionDocumentIds(collName, parentPath)
   *   .then(docIds => console.log(docIds))
   *   .catch(error => console.error(error));
   * 
   * // Possible output:
   * // ['SWUKNUVXN', 'IRTDIOTAG', 'DRWSPKJLD', ...]
   */
  async readCollectionDocumentIds(collName, parentPath) {
    // Validate inputs
    validateCollectionName(collName);

    // Constructing the GET request URL
    const url = `rcdid?collName=${collName}&parentPath=${parentPath}`;

    // Make the GET request
    try {
      const response = await this.instance.get(url);
      return response.data;
    } catch (error) {
      throw new Error(error.message);
    }
  }


  /**
   * Reads multiple documents from a Firestore collection in bulk.
   *
   * @param {string} collName - The name of the Firestore collection.
   * @param {string} parentPath - The path to the parent document or collection.
   * @param {string[]} docIds - An array of document IDs to be read from the collection.
   * @param {Object} projection - An object specifying which fields of the document to return.
   *                              For each field you want to return, set its value to 1.
   * 
   * @throws {Error} Throws an error if `collName` is invalid, if `docIds` is not an array of strings,
   *                 or if `projection` is not a valid object.
   *
   * @returns {Promise<Object[]>} Returns a promise that resolves with an array of documents read from Firestore.
   *                              Each document in the array will contain only the fields specified in the `projection`.
   *                              If no fields are specified in `projection`, all fields in the document are returned.
   *
   * @example
   * const collName = "Users";
   * const parentPath = "/";
   * const docIds = ["docId1", "docId2", "docId3"];
   * const projection = { "fieldName": 1 };
   * 
   * firestoreManager.bulkReadDocuments(collName, parentPath, docIds, projection)
   *   .then(data => console.log(data))
   *   .catch(error => console.error(error));
   *  
   *  output :
   *  # case 1: if all doc found in server
   *  [{doc1 with no _id},{doc2 with no _id}},{doc3 with no _id}]
   * 
   *  # case 2: if not all doc found in server, in this doc 2 is not found in server
   *  [{doc1 with no _id},{doc3 with no _id}]
   * 
   *  # case 3 : if docId1 and docId2 is equal means same doc
   *  [{doc1 with no _id},{doc1 with no _id},{doc3 with no _id}]
   *  
   * 
   */
  async bulkReadDocuments(collName, parentPath, docIds, projection, inMap) {

    if(inMap){
      return this.bulkReadDocumentsInMap (collName, parentPath, docIds, projection);
    }

    // Validate inputs
    validateCollectionName(collName);
    if (!Array.isArray(docIds)) {
      throw new Error("docIds should be an array of strings.");
    }
    docIds.forEach(validateDocumentName);

    if(docIds.length === 0){
        return [];
    }

    if(!projection){
      projection = {};
    }

    if (typeof projection !== 'object' || Array.isArray(projection)) {
      throw new Error("projection should be an object.");
    }

    // Construct the request body
    const body = JSON.stringify({
      docIds: docIds,
      projection: projection
    });

    // Make the POST request
    try {
      const response = await this.instance.post(
        `rdbulk?collName=${collName}&parentPath=${parentPath}`,
        body,
        { headers: { "Content-Type": "application/json" } }
      );

      // Arrange the response according to the docIds and remove _id field
      const docsDict = {};
      response.data.forEach(doc => {
        docsDict[doc._id] = doc;
      });

      const arrangedDocs = docIds
        .map(docId => {
          const doc = docsDict[docId];
          if (doc) {
            // delete doc._id; // remove the _id field
            return doc;
          }
        })
        .filter(doc => doc); // This will filter out any undefined or null values

      return arrangedDocs;

    } catch (error) {
        // console.log(error)
      throw new Error(error.message);
    }
  }


  /**
   * Reads multiple documents from a Firestore collection in bulk.
   *
   * @param {string} collName - The name of the Firestore collection.
   * @param {string} parentPath - The path to the parent document or collection.
   * @param {string[]} docIds - An array of document IDs to be read from the collection.
   * @param {Object} projection - An object specifying which fields of the document to return.
   *                              For each field you want to return, set its value to 1.
   * 
   * @throws {Error} Throws an error if `collName` is invalid, if `docIds` is not an array of strings,
   *                 or if `projection` is not a valid object.
   *
   * @returns {Promise<Object[]>} Returns a promise that resolves with an array of documents read from Firestore.
   *                              Each document in the array will contain only the fields specified in the `projection`.
   *                              If no fields are specified in `projection`, all fields in the document are returned.
   *
   * @example
   * const collName = "Users";
   * const parentPath = "/";
   * const docIds = ["docId1", "docId2", "docId3"];
   * const projection = { "fieldName": 1 };
   * 
   * firestoreManager.bulkReadDocuments(collName, parentPath, docIds, projection)
   *   .then(data => console.log(data))
   *   .catch(error => console.error(error));
   *  
   *  output :
   *  # case 1: if all doc found in server
   *  { docId1 : {doc1 with no _id}, docId2 : {doc2 with no _id}, docId3 : {doc3 with no _id} }
   * 
   *  # case 2: if not all doc found in server, in this doc 2 is not found in server
   *  { docId1 : {doc1 with no _id}, docId3 : {doc3 with no _id} }
   * 
   *  # case 3 : if docId1 and docId2 is equal means same doc
   *  { docId1 : {doc1 with no _id}, docId3 : {doc3 with no _id} }
   * 
   */
  async bulkReadDocumentsInMap(collName, parentPath, docIds, projection) {
    // Validate inputs
    validateCollectionName(collName);
    if (!Array.isArray(docIds)) {
      throw new Error("docIds should be an array of strings.");
    }
    docIds.forEach(validateDocumentName);
  
    if(!projection){
      projection = {};
    }
  
    if (typeof projection !== 'object' || Array.isArray(projection)) {
      throw new Error("projection should be an object.");
    }
  
    // Construct the request body
    const body = JSON.stringify({
      docIds: docIds,
      projection: projection
    });
  
    // Make the POST request
    try {
      const response = await this.instance.post(
        `rdbulk?collName=${collName}&parentPath=${parentPath}`,
        body,
        { headers: { "Content-Type": "application/json" } }
      );
  
      // Arrange the response into a map format and remove _id field
      const docsMap = {};
      response.data.forEach(doc => {
        if (doc._id) {
          const docCopy = { ...doc }; // Create a shallow copy of the document
          delete docCopy._id; // remove the _id field
          docsMap[doc._id] = docCopy; 
        }
      });
  
      return docsMap;
  
    } catch (error) {
      throw new Error(error.message);
    }
  }

  /**
 * Reads documents from a Firestore collection with paging support.
 *
 * @param {string} collName - The name of the Firestore collection.
 * @param {string} parentPath - The path to the parent document or collection.
 * @param {string} lastDocId - The ID of the last document from the previous page. Use 'null' for the first page.
 * @param {number} pageSize - The number of documents to read per page.
 * @param {Object} projection - An object specifying which fields of the document to return.
 *                              For each field you want to return, set its value to 1.
 *
 * @throws {Error} Throws an error if validation fails or if a server error occurs.
 *
 * @returns {Promise<Object[]>} Returns a promise that resolves with an array of documents read from Firestore.
 *                              Each document will contain only the fields specified in the `projection`.
 *                              If no fields are specified in `projection`, all fields in the document are returned.
 */
async readCollectionDocumentsWithPaging(collName, parentPath, lastDocId, pageSize, projection) {
  // Validate inputs
  validateCollectionName(collName);
  if(!lastDocId){
    lastDocId = "0";
  }
  if (typeof lastDocId !== 'string') {
    throw new Error("lastDocId should be a string.");
  }
  if (typeof pageSize !== 'number' || pageSize <= 0) {
    throw new Error("pageSize should be a positive number.");
  }

  if (!projection) {
    projection = {};
  }
  if (typeof projection !== 'object' || Array.isArray(projection)) {
    throw new Error("projection should be an object.");
  }

  // Construct the request body
  const body = JSON.stringify({
    lastDocId: lastDocId,
    pageSize: pageSize,
    projection: projection,
  });

  // Make the POST request
  try {
    const response = await this.instance.post(
      `rcdsp?collName=${collName}&parentPath=${parentPath}`,
      body,
      { headers: { "Content-Type": "application/json" } }
    );

    // Get the last document ID before removing _id field
    const newLastDocId = response.data.length > 0 ? response.data[response.data.length - 1]._id : null;

    // Remove _id field from the documents
    const arrangedDocs = response.data.map(doc => {
      delete doc._id; // remove the _id field
      return doc;
    });

    return { docs: arrangedDocs, lastDocId: newLastDocId };

  } catch (error) {
    throw new Error(error.message);
  }
}

/**
 * Reads documents from a Firestore collection.
 *
 * @param {string} collName - The name of the Firestore collection.
 * @param {string} parentPath - The path to the parent document or collection.
 *
 * @throws {Error} Throws an error if validation fails or if a server error occurs.
 *
 * @returns {Promise<Object[]>} Returns a promise that resolves with an array of documents read from Firestore.
 */
async readCollectionDocuments(collName, parentPath) {
    // Validate inputs
    validateCollectionName(collName);
  
    if (typeof parentPath !== 'string') {
      throw new Error("parentPath should be a string.");
    }
  
    // Construct the request URL with query parameters
    const url = `rcds?collName=${encodeURIComponent(collName)}&parentPath=${encodeURIComponent(parentPath)}`;
  
    // Make the GET request
    try {
      const response = await this.instance.get(url, {
        headers: { "Content-Type": "application/json" }
      });
  
      return response.data;
  
    } catch (error) {
      throw new Error(error.message);
    }
  }


  /**
   * Updates an existing document in the specified Firestore collection.
   *
   * @param {string} collName - The name of the Firestore collection.
   * @param {string} docName - The ID of the document to be updated.
   * @param {string} parentPath - The path to the parent document or collection.
   * @param {Object} document - The content to update the document with.
   *
   * @throws {Error} Throws an error if validation fails or if a server error occurs.
   *
   * @returns {Promise<Object>} Returns a promise that resolves with the updated document's result report.
   */
  async updateDocument(collName, docName, parentPath, document) {
    validateCollectionName(collName);
    validateDocumentName(docName);
    if (Object.prototype.hasOwnProperty.call(document, "_id")) {
      throw new Error("document class should not have '_id' field.");
    }

    document._id = docName;
    const body = JSON.stringify(document);

    try {
      const response = await this.instance.post(
        `upd?collName=${collName}&parentPath=${parentPath}`,
        body,
        { headers: { "Content-Type": "application/json" } }
      );
      return response.data;
    } catch (error) {
      throw new Error(error.message);
    }
  }





  /**
   * Deletes a document from the specified Firestore collection.
   *
   * @param {string} collName - The name of the Firestore collection.
   * @param {string} docName - The ID of the document to be deleted.
   * @param {string} parentPath - The path to the parent document or collection.
   *
   * @throws {Error} Throws an error if validation fails or if a server error occurs.
   *
   * @returns {Promise<Object>} Returns a promise that resolves with the deleted document's data.
   */
  async deleteDocument(collName, docName, parentPath) {
    validateCollectionName(collName);
    validateDocumentName(docName);
    try {
      const response = await this.instance.get(
        `deld?collName=${collName}&docName=${docName}&parentPath=${parentPath}`
      );
      return response.data;
    } catch (error) {
      throw new Error(error.message);
    }
  }




  /**
   * Deletes a specific field from a document in the specified Firestore collection.
   *
   * @param {string} collName - The name of the Firestore collection.
   * @param {string} parentPath - The path to the parent document or collection.
   * @param {string} docId - The ID of the document.
   * @param {string} fieldName - The name of the field to be deleted.
   *
   * @throws {Error} Throws an error if validation fails or if a server error occurs.
   *
   * @returns {Promise<Object>} Returns a promise that resolves with the result report.
   */
  async deleteField(collName, parentPath, docId, fieldName) {
    validateCollectionName(collName);
    validateDocumentName(docId);

    const body = JSON.stringify({
      "_id": docId,
      "fieldName": fieldName
    });

    try {
      const response = await this.instance.post(
        `dfd?collName=${collName}&parentPath=${parentPath}`,
        body,
        { headers: { "Content-Type": "application/json" } }
      );
      return response.data;
    } catch (error) {
      throw new Error(error.message);
    }
  }


  async deleteCollection(collName, parentPath) {
    validateCollectionName(collName);
    try {
      const response = await this.instance.get(
        `delc?collName=${collName}&parentPath=${parentPath}`,
        { headers: { "Content-Type": "application/json" } }
      );
      return response.data;
    } catch (error) {
      throw new Error(error.message);
    }
  }

      /**
   * Deletes all cache document hence, after that all data get new from mongodb until again it cache,
   * it use if manually update mododb ducuments by using direct api. 
   * if not use this in that case firestore become inconsistent for 1hr
   *
   *
   * @throws {Error} Throws an error if validation fails or if a server error occurs.
   *
   * @returns {Promise<bool>} Returns a promise that resolves with the result report.
   */
    async purgeAllCache() {

        try {
          const response = await this.instance.post(
            `prgche?parentPath=/`,
            { headers: { "Content-Type": "application/json" } }
          );
          return response.data;
        } catch (error) {
          throw new Error(error.message);
        }
    }

}



module.exports = FirestoreManager;