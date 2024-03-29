# Google Cloud Audio to Text Transcriber Functions

This project allows for using GCP (Google Cloud Provider) to create text transcriptions of large audio files. This could be useful for things like podcasts, meeting minutes etc.

This project is code that can be deployed to Google Cloud as two Google Functions.
It also relies on Google Storage and the Google Speech API.

**Note that if you exceed your free introductory stipend by Google, you will have to pay for your usage. However, a decent amount can be transcribed within the introductory free money Google proides.**

## Setup

1. Create a [Google Cloud account](https://console.cloud.google.com/) and activate the `Cloud Functions API`, the `Cloud Pub/Sub API`, the `Cloud Logging API`, the `Cloud Speech-to-Text API` and Google Storage. You can activate the services by clicking 'Go To Console' then using the top search bar to find each service and click 'Enable'.
2. In Google Storage, [create three buckets](https://cloud.google.com/storage/docs/creating-buckets). Name them `transcriber-input`, `transcriber-processed` and `transcriber-output` specifically. (You can technically name them different things, but you'd have to update parts of the code and deployment scripts).
3. Download [Node](https://nodejs.org/en/download/)
4. [Download the google cloud sdk](https://cloud.google.com/sdk/docs/install) and initialize it and log in
5. Then run `yarn deploy` in the `transcribe-function` directory as well as the `audio-file-splitter-function` directory to deploy the two necessary Google Functions.

## Usage

To transcribe an audio file, upload the file via the Google Storage UI to the `transcriber-input` bucket.
This will automatically trigger the Google Function that converts it to the flac format and splits up large files. When the function is done, another function will be triggered to transcribe the audio files to text. When that second function completes, a full transcript will appear in the `transcriber-output` folder. You can download it via the UI and use it however you want.
