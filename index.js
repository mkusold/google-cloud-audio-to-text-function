'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const ffmpeg = require('fluent-ffmpeg');
const musicMeta = require('music-metadata');

const speech = require('@google-cloud/speech');
const { Storage } = require("@google-cloud/storage");

// new storage instance
const storage = new Storage();
// new speech instance
const speechClient = new speech.SpeechClient();

const GCLOUD = {
  OUTPUT_BUCKET: 'transcriber-output',
  AUDIO_DURATION_LIMIT_S: 180 * 60,
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
 * Ensures that audio files are in the supported format
 *
 * @param {string} audioFilePath The filepath of the audio file including the extension.
 * @param {string} inputBucketName The GCP bucket in which to load the normalized audio file
 * @returns {object} Resource information on the file that can be transcribed. 
 *                   This info includes the local path as well as the remote path uploaded to Google Storage.
 */
async function validateOrCreateGcpAudioFormat(audioFilePath, inputBucketName){
  const [filePath, ...extension] = audioFilePath.split('.');
  const ext = extension[0].toLowerCase();
  if(ext === 'wav' || ext === 'flac'){
    return {
      localNormalizedFilePath: audioFilePath,
      gcpUri: `gs://${inputBucketName}/${path.basename(audioFilePath)}`,
      isNew: false,
    };
  }
  try{
    const NORMALIZED_FORMAT = 'flac';
    const localNormalizedFilePath = await convertTo(audioFilePath, NORMALIZED_FORMAT);
    const gcpUri = await uploadToGCS(localNormalizedFilePath, inputBucketName);
    return {
      localNormalizedFilePath,
      gcpUri,
      isNew: true,
    };
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
 * Creates the Google Speech API Request to transcribe an audio file
 * @param {string} localAudioFilePath the local path to the temporary download of the audio file that was uploaded to Google Storage
 * @param {string} gcpResourceUri the fully formed URI for the gcp resource that needs to be transcribed
 * @returns {object} the fully configured request to transcribe the audio file uploaded to Google Storage
 */
async function createSpeechToTextRequest(localAudioFilePath, gcpResourceUri){
  const metadata = await musicMeta.parseFile(localAudioFilePath);
  const { duration, sampleRate, bitRate, numberOfChannels } = metadata.format;
  
  if(duration > GCLOUD.AUDIO_DURATION_LIMIT_S){
    throw 'Input file is too large and must be split';
  }
  
  if(bitRate < 32 || bitRate > 320){
    throw 'Bit Rate is not supported';
  }

  if(sampleRate < 8000 || sampleRate > 48000){
    throw 'Sample Rate is not supported';
  }

  if(numberOfChannels !== 1){
    throw `Number of channels is not 1, for the file ${fileName} it is ${numberOfChannels}`;
  }

  console.log(`=== AUDIO METADATA: duration=${duration}`);

  return {
    config: {
      languageCode: 'en-US',
    },
    audio: {
      uri: gcpResourceUri,
    },
  };
}

/**
 * Hits the Google Speech API to transcribe an audio file
 * @param {object} request fully configured request to transcribe the audio file uploaded to Google Storage
 * @returns the resulting transcription text
 */
async function transcribe(request){
  console.log(`=== REQUEST IS`);
  console.log(request);
  const [operation] = await speechClient.longRunningRecognize(request);
  const [response] = await operation.promise();

  const transcription = response.results.map(result => result.alternatives[0].transcript).join('\n');

  console.log('=== Transcription Output Snippet:');
  console.log(`${transcription.substring(0,25)}...`);
  return transcription;
}

/**
 * Createas a local text file of the transcription for an audio file.
 * 
 * @param {string} tmpWorkingDir the temporary directory that's being used to hold files
 * @param {string} audioFileName the file name of the downloaded audio file
 * @param {string} transcription the text transcription of the audio file
 */
function createLocalOutputFile(tmpWorkingDir, audioFileName, transcription){
  if(transcription){
    const transcriptionFileName = `${audioFileName.split('.').slice(0, -1).join('.')}.txt`;
    const tmpFilePath = path.join(tmpWorkingDir, transcriptionFileName);
    
    // write data to temporary File
    fs.writeFileSync(tmpFilePath, transcription);
    return tmpFilePath;
  }
  throw 'No transcription was found!'
}

/**
 * Uploads a local file to GCS
 * @param {string} localFilePath the path of the file we want to upload
 * @returns {string} the fully formed google cloud URI that the new file was uploaded to
 */
async function uploadToGCS(localFilePath, outputBucket=GCLOUD.OUTPUT_BUCKET) {
  const bucket = storage.bucket(outputBucket);
  await bucket.upload(localFilePath);
  return `gs://${outputBucket}/${path.basename(localFilePath)}`;
}

const _formatLogData = (data) => JSON.stringify(data, null, 2);

/**
 * Cloud Function to transcribe audio from a MP3 to text.
 * Meant to be triggered on a Google Storage Upload ('finalize')
 *
 * @param {object} file The Cloud Storage file metadata.
 * @param {object} context The event metadata. s
 */
exports.transcribeFile = async ({bucket, name}, _context) => {
  const { tmpWorkingDir, audioFilePath } = await createLocalCopyOfAudio(bucket, name);
  // normalize all audio files to a GCP supported format
  const { localNormalizedFilePath, gcpUri, isNew } = await validateOrCreateGcpAudioFormat(audioFilePath, bucket);

  // Only process pre-existing files to avoid duplicate processing which costs us money for no reason
  if(isNew){
    console.log('New file was pushed to GCP. This will trigger the flow again. Terminating Process to avoid double processing.');
    return;
  }

  const request = await createSpeechToTextRequest(localNormalizedFilePath, gcpUri);
  const transcription = await transcribe(request);
  const transcriptionFilePath = createLocalOutputFile(tmpWorkingDir, name, transcription);

  if(transcriptionFilePath){
    const transcriptionLocation = await uploadToGCS(transcriptionFilePath);
    console.log(`=== New Transcription was created at ${transcriptionLocation}`);
  }
  
  // remove the temporary directory to clean up
  await fs.remove(tmpWorkingDir);
};
