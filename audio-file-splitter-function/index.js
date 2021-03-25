'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const ffmpeg = require('fluent-ffmpeg');
const musicMeta = require('music-metadata');
var split = require('audio-split');

const { Storage } = require("@google-cloud/storage");
const { format } = require('path');

// new storage instance
const storage = new Storage();

const GCLOUD = {
  OUTPUT_BUCKET: 'transcriber-processed',
  AUDIO_DURATION_LIMIT_S: 180 * 60,
  FUNCTION_TIMEOUT_LIMIT: (9 * 60), // 9 minute max timeout for google cloud functions
}

/**
 * Converts files to another audio format
 *
 * @param {string} audioFilePath The filepath of the original audio file
 * @param {string} format The intended output audio format
 * @returns {string} The local path to the output audio file
 */
async function convertTo(audioFilePath, format='flac'){
  const [filePath, ...extension] = audioFilePath.split('.');
  const newFilePath = `${filePath}.${format}`;
  
  await new Promise((resolve, reject) => {
    ffmpeg(audioFilePath)
      .toFormat(format)
      .on('error', (err) => {
          reject(err);
      })
      .on('end', () => {
          resolve();
      })
      .save(newFilePath);
  });
  return newFilePath;
}

/**
 * Ensures that audio file is in the flac format
 *
 * @param {string} audioFilePath The filepath of the audio file including the extension.
 * @param {string} inputBucketName The GCP bucket in which to load the normalized audio file
 * @returns local normalized file path to the flac file
 */
async function convertToFlac(audioFilePath){
  const [filePath, ...extension] = audioFilePath.split('.');
  const ext = extension[0].toLowerCase();
  if( ext === 'flac'){
    return audioFilePath;
  }
  try{
    const NORMALIZED_FORMAT = 'flac';
    const localNormalizedFilePath = await convertTo(audioFilePath, NORMALIZED_FORMAT);
    return localNormalizedFilePath;
  } catch(e){
    throw `The .${extension} file format is not supported`;
  }
}

/**
 * Creates a temporary directory to be used throughout this program
 * and downloads the new audio file into that temporary directory
 *
 * @param {string} bucketName The Cloud Storage bucket name of the new file.
 * @param {string} fileName The name of the audio file including the extension.
 * @returns {object} directory and path of where to find the local copy of the audio file
 */
async function createLocalCopyOfAudio(bucketName, fileName){
  const tmpWorkingDir = path.join(os.tmpdir(), 'temp');
  const audioFilePath = path.join(tmpWorkingDir, fileName);

  // Wait for temp directory to be ready
  await fs.ensureDir(tmpWorkingDir);

  const srcBucket = storage.bucket(bucketName);
  await srcBucket.file(fileName).download({
    destination: audioFilePath
  });
  
  return {
    tmpWorkingDir,
    audioFilePath,
  }
}

/**
 * Splits an audio file into several audio files based on desired max duration and uploads them to a GCP bucket with a special file name.
 * @param {string} localAudioFilePath the local path to the temporary download of the audio file that needs splitting
 * @param {number} audioDurationLimitInSeconds the maximum duration of each chunk that should exist after splitting
 */
async function splitFileByDurationAndUpload(localAudioFilePath, audioDurationLimitInSeconds){
  const metadata = await musicMeta.parseFile(localAudioFilePath);
  const { duration } = metadata.format;

  if(duration > GCLOUD.AUDIO_DURATION_LIMIT_S || duration > audioDurationLimitInSeconds){
    console.log('Splitting files...');
    console.log(`The file is ${duration/60} minutes long. The limit is ${audioDurationLimitInSeconds/60} minutes and ${Math.floor(duration / audioDurationLimitInSeconds)} files will be created`)
    const subclipPaths = await new Promise((resolve, reject) => {
      try{
        split({
          filepath: localAudioFilePath,
          minClipLength: 5 * 60,
          maxClipLength: audioDurationLimitInSeconds
        }, (err, subclipPaths) => {
          if(err){
            reject(err);
          } else {
            resolve(subclipPaths);  
          }
        });
      } catch(e){
        reject(e);
      }
    });

    for(let i=0; i<subclipPaths.length; i++){
      const file = subclipPaths[i].filepath;
      const [baseFileNameWithIndex, ...extension] = path.basename(file).split('.');
      const formattedFileName = `${baseFileNameWithIndex}-${subclipPaths.length}.${extension}`;
      const gcpUri = await uploadToGCS(file, formattedFileName);
      console.log(`=== New split audio file was created at ${gcpUri}`);
    }
  }
}

/**
 * Uploads a local file to GCS
 * @param {string} localFilePath the path of the file we want to upload
 * @param {string} uploadedName the file name that should be used for the uploaded file
 * @returns {string} the fully formed google cloud URI that the new file was uploaded to
 */
async function uploadToGCS(localFilePath, uploadedName, outputBucket=GCLOUD.OUTPUT_BUCKET) {
  const bucket = storage.bucket(outputBucket);
  await bucket.upload(localFilePath, {
    destination: uploadedName,
  });
  return `gs://${outputBucket}/${uploadedName}`;
}

/**
 * Cloud Function to convert to flac and split long audio files into 8 minute chunks.
 * Meant to be triggered on a Google Storage Upload ('finalize') to the bucket specified in the 
 * underlying `yarn deploy` function
 *
 * @param {object} file The Cloud Storage file metadata.
 * @param {object} context The event metadata.
 */
exports.fileSplitter = async ({bucket, name}, _context) => {
  const { tmpWorkingDir, audioFilePath } = await createLocalCopyOfAudio(bucket, name);
  // convert to flac if not already
  const localNormalizedFilePath = await convertToFlac(audioFilePath, bucket);

  const audioDurationLimitInSeconds = GCLOUD.FUNCTION_TIMEOUT_LIMIT - (1 * 60); // 1 minute buffer
  await splitFileByDurationAndUpload(localNormalizedFilePath, audioDurationLimitInSeconds)
  
  // remove the temporary directory to clean up
  await fs.remove(tmpWorkingDir);
};
