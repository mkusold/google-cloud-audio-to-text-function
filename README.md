# Google Cloud Audio to Text Transcriber

This project has a code that can be deployed to Google Cloud as a Google Function.
It also relies on Google Storage and the Google Speech API.

## Setup

1. Create a Google Cloud account and activate Google Functions, Google Storage, and Google Speech Services.
2. In Google Storage, create two buckets. One called `transcriber_files` and one called `transcriber-output`
3. Download the google cloud sdk
4. Then run `yarn deploy` to deploy this code to a Google Function.

## Usage

To transcribe an audio file, upload the file via the Google Storage UI to the `transcriber_files` bucket.
This will automatically trigger the Google Function. When the function is done, a full transcript will appear in the `transcriber-output` folder. You can download it via the UI and use it however you want.
