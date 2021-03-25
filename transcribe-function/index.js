'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const mergeFiles = require('merge-files');
const musicMeta = require('music-metadata');
var rimraf = require("rimraf");

const speech = require('@google-cloud/speech');
const { Storage } = require("@google-cloud/storage");

// new storage instance
const storage = new Storage();
// new speech instance
const speechClient = new speech.SpeechClient();

const GCLOUD = {
  OUTPUT_BUCKET: 'transcriber-output',
  PROCESSED_BUCKET: 'transcriber-processed',
  AUDIO_DURATION_LIMIT_S: 180 * 60,
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
    };
  } else {
    throw `The .${extension} file format is not supported`;
  }
}

/**
 * Creates a temporary directory to be used throughout this program
 * and downloads a GCP file into that temporary directory
 *
 * @param {string} bucketName The Cloud Storage bucket name of the new file.
 * @param {string} fileName The name of the GCP file including the extension.
 * @returns {object} directory and path of where to find the local copy of the file
 */
async function createLocalCopyOfGCPFile(bucketName, fileName, tempDirectory = 'temp'){
  const tmpWorkingDir = path.join(os.tmpdir(), tempDirectory);
  const destinationFilePath = path.join(tmpWorkingDir, fileName);

  // Wait for temp directory to be ready
  await fs.ensureDir(tmpWorkingDir);

  const srcBucket = storage.bucket(bucketName);
  await srcBucket.file(fileName).download({
    destination: destinationFilePath
  });
  
  return {
    tmpWorkingDir,
    destinationFilePath,
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
    // not necessarily an error condition
    console.log(`Number of channels for this file is ${numberOfChannels}`);
  }

  console.log(`=== AUDIO METADATA: duration=${duration}`);

  return {
    config: {
      languageCode: 'en-US',
      audioChannelCount: numberOfChannels,
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
  const [operation] = await speechClient.longRunningRecognize(request);
  operation.on('progress', (metadata, apiResponse) => {
    if (!apiResponse.done) {
      console.log('Still working ...')
    }
  });
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

/**
 * Deletes a file from GCS
 * @param {string} bucketName the bucket where the file resides
 * @param {string} filename the name of the file in the bucket to be deleted
 */
async function deleteFileFromGCS(bucketName, filename) {
  await storage.bucket(bucketName).file(filename).delete();
}

/**
 * Gets a transcription file's series data based on the special file name format
 * that was created in the audio-file-splitter-function.
 * Example: OriginalAudioName-X-Y.flac 
 * where X is series index (eg. 1)
 * and Y is total number of files that were needed to split the original audio file (eg. 13)
 * @param {string} filename the full name of the file with the special format
 * @returns {object} information about the series index and the total in the series
 */
function getSeriesInfo(filename){
  const nameWithoutExtension = path.basename(filename).split('.').slice(0, -1)[0];
  const fileNameParts = nameWithoutExtension.split('-');
  if(fileNameParts.length < 2){
    return;
  }
  const fileIndex = Number(fileNameParts[fileNameParts.length - 2]);
  const totalNumberOfFiles = Number(fileNameParts[fileNameParts.length - 1]);
  return { fileIndex, totalNumberOfFiles };
}

/**
 * Determines if a specific file is the last file in a series of split files
 * based on special file name format:
 * Example: OriginalAudioName-X-Y.flac 
 * where X is series index (eg. 1)
 * and Y is total number of files that were needed to split the original audio file (eg. 13)
 * @param {string} filename the full name of the file with the special format
 * @returns {boolean} whether this file is the last in the series
 */
function isLastFileInSeries(filename){
  const seriesInfo = getSeriesInfo(filename);
  if(!seriesInfo){
    return false;
  }
  const { fileIndex, totalNumberOfFiles } = seriesInfo;
  console.log('is last file in series', fileIndex === totalNumberOfFiles - 1);
  return fileIndex === totalNumberOfFiles - 1;
}


function deleteFolderRecursive(directoryPath) {
  if (fs.existsSync(directoryPath)) {
      fs.readdirSync(directoryPath).forEach((file, index) => {
        const curPath = path.join(directoryPath, file);
        if (fs.lstatSync(curPath).isDirectory()) {
         // recurse
          deleteFolderRecursive(curPath);
        } else {
          // delete file
          fs.unlinkSync(curPath);
        }
      });
      fs.rmdirSync(directoryPath);
    }
  };

async function compileTranscriptions(name){
  console.log('===== Compiling Transcripts to create a Full Transcript');
  const transcriptionBucket = GCLOUD.OUTPUT_BUCKET;
  const { totalNumberOfFiles } = getSeriesInfo(name);
  const nameWithoutExtension = path.basename(name).split('.').slice(0, -1)[0];
  const baseFileName = nameWithoutExtension.split('-')[0];

  // download all of the existing files
  const localTranscriptionFiles = [];
  let localTranscriptionDirectory;
  for(let i=0; i<totalNumberOfFiles; i++){
    const fileNameToDownload = `${baseFileName}-${i}-${totalNumberOfFiles}.txt`;
    const { tmpWorkingDir, destinationFilePath } = await createLocalCopyOfGCPFile(transcriptionBucket, fileNameToDownload, 'transcriptions');
    localTranscriptionFiles.push(destinationFilePath);
    localTranscriptionDirectory = tmpWorkingDir;
  }
  
  // merge them all into one file
  const outputFilePath = `${localTranscriptionDirectory}/${baseFileName}-FullTranscript.txt`;
  const isDone = await mergeFiles(localTranscriptionFiles, outputFilePath);

  if(!isDone){
    console.log('Error Merging Files');
    return;
  }

  console.log('uploading Full Transcript');
  // upload that file to GCP
  await uploadToGCS(outputFilePath);

  // cleanup locally
  try{
    console.log('Cleaning up files...');
    // cleanup in the storage bucket
    for(let i=0; i<totalNumberOfFiles; i++){
      const toDeleteBase = `${baseFileName}-${i}-${totalNumberOfFiles}`;
      console.log(`Deleting ${toDeleteBase} txt and flac files`);
      await deleteFileFromGCS(transcriptionBucket, `${toDeleteBase}.txt`);
      await deleteFileFromGCS(GCLOUD.PROCESSED_BUCKET, `${toDeleteBase}.flac`)
    }
  } catch(e){
    console.error('Caught error', e);
  }
}

/**
 * Cloud Function to transcribe audio from a MP3 to text.
 * Meant to be triggered on a Google Storage Upload ('finalize')
 *
 * @param {object} file The Cloud Storage file metadata.
 * @param {object} context The event metadata. s
 */
exports.transcribeFile = async ({bucket, name}, _context) => {
  const { tmpWorkingDir, destinationFilePath } = await createLocalCopyOfGCPFile(bucket, name);
  // normalize all audio files to a GCP supported format
  const { localNormalizedFilePath, gcpUri } = await validateOrCreateGcpAudioFormat(destinationFilePath, bucket);

  const request = await createSpeechToTextRequest(localNormalizedFilePath, gcpUri);
  const transcription = await transcribe(request);
  const transcriptionFilePath = createLocalOutputFile(tmpWorkingDir, name, transcription);

  if(transcriptionFilePath){
    const transcriptionLocation = await uploadToGCS(transcriptionFilePath);
    console.log(`=== New Transcription was created at ${transcriptionLocation}`);
  }
  
  // check to see if this is the last audio file in the series if it was split up
  if(isLastFileInSeries(name)){
    // if so, bring them all together
    await compileTranscriptions(name);
  }

  // remove the temporary directory to clean up
  deleteFolderRecursive(tmpWorkingDir);
};
