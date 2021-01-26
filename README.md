# Google Cloud Audio to Text Transcriber

This project allows for using GCP (Google Cloud Provider) to create text transcriptions of large audio files. This could be useful for things like podcasts, meeting minutes etc.

This project is code that can be deployed to Google Cloud as a Google Function.
It also relies on Google Storage and the Google Speech API.

**Note that if you exceed your free introductory stipend by Google, you will have to pay for your usage. However, a decent amount can be transcribed within the introductory free money Google proides.**

## Setup

1. Create a [Google Cloud account](https://console.cloud.google.com/) and activate the `Cloud Functions API`, the `Cloud Pub/Sub API`, the `Cloud Logging API`, the `Cloud Speech-to-Text API` and Google Storage. You can activate the services by clicking 'Go To Console' then using the top search bar to find each service and click 'Enable'.
2. In Google Storage, [create two buckets](https://cloud.google.com/storage/docs/creating-buckets). One called `transcriber_files` and one called `transcriber-output`.
3. Download [Node](https://nodejs.org/en/download/)
4. [Download the google cloud sdk](https://cloud.google.com/sdk/docs/install) and initialize it and log in
5. Then run `yarn deploy` to deploy this code to a Google Function.

## Usage

To transcribe an audio file, upload the file via the Google Storage UI to the `transcriber_files` bucket.
This will automatically trigger the Google Function. When the function is done, a full transcript will appear in the `transcriber-output` folder. You can download it via the UI and use it however you want.
